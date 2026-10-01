# sam-ui (Apache-2.0). New file, not from SAM 2.
"""TrackService: seeds, cached tracks and the engines that make them, per video.

The interactive session calls record_points / clear_frame / remove_object as
the user clicks; a Track press calls track(), which runs only the objects that
are untracked or stale for the chosen engine (or the ids given) and caches each
finished track under that engine. The default engine (SAM 2) also serves the
interactive clicks; others (SAM 3) are registered by spec and built on first
use. Locking is the caller's job (the backend's single inference lock).

Present and candidate ranges (draft 5) are annotations on the timeline: they
never change a track or the seeds hash, so they are not seed changes either.

Absent ranges (issue #20, tracks/ranges.py) split an object's timeline into
windows. A job tracks each window with a seed on its own, and stores every
other frame as an empty mask, so a track always covers the whole clip. A
stale track keeps the windows whose inputs did not change (window_key): only
the windows a range or seed edit touched run again.

Inside a window a seed edit touched, a correction re-tracks only the stretch
it changes (issue #19, tracks/bounded.py): a bounded pass from the corrected
frame outward, until the new masks rejoin the cached track, merged into the
cached frames. track.json records which pass made each frame.

The audit queue (draft 7, tracks/audit.py) ranks the frames of each track
worth a look, from the cached masks, ranges, provenance and the engines'
disagreement; what a person marks reviewed is kept in tracks/review.py,
outside the seeds hash, and holds only while the frame's pass and mask do.

Every finished track is also kept as a version of its object (issue #18,
tracks/versions.py), and every seed change (a click, a cleared frame, a range)
goes on the object's undo history. Undo and redo restore an earlier seed
record as stored; where a version holds a track of it, that track becomes
current again with no job, so the object is tracked at once. Without one the
object is stale, as after any seed change. They are refused while a job holds
the object (ObjectBusy): the job would save over the restored track.

Text prompts (issue #22, tracks/text.py): text_prompt() asks an engine that
reads text (SAM 3) for a phrase's best instance on one frame, and stores it as
that frame's seed. engines() says which engines read text, and why not.
"""
import contextlib
import logging
import os
import time
from collections import ChainMap
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

import numpy as np

from tracks import audit
from tracks import bounded as bnd
from tracks import review as rv
from tracks import rle
from tracks.bounded import Agreement, Provenance, Stretch, mask_iou
from tracks.engine import WHOLE, Engine, Windows
from tracks.jobs import TRACKING, JobRegistry
from tracks.layout import Layout, LayoutStore
from tracks.ranges import CANDIDATE, Window, absent_at, seeded_windows, window_frames
from tracks.seeds import Seeds, SeedStore, seeds_hash, video_key, window_key
from tracks.store import STALE, TRACKED, TrackStore
from tracks import versions as ver
from tracks.versions import VersionStore
from tracks.text import normalize as normalize_text

FrameRle = Tuple[int, Dict[int, Dict]]
logger = logging.getLogger(__name__)


@dataclass
class JobResult:
    """What a track job did, for the stream's closing part: the client sees a
    failure instead of a short but well-formed stream."""

    objects: List[int] = field(default_factory=list)
    tracked: List[int] = field(default_factory=list)
    failed: Dict[int, str] = field(default_factory=dict)


@dataclass
class EngineSpec:
    """An engine that is built only when first used (SAM 3 is 466M parameters)."""

    name: str
    model: str
    factory: Callable[[], Engine]
    unavailable: Callable[[], Optional[str]] = lambda: None  # a reason, or None when it can run
    # None: the engine takes clicks only. Else why it cannot read text here,
    # or None when it can (its engine then has segment_text).
    text: Optional[Callable[[], Optional[str]]] = None


class UnknownEngine(ValueError):
    pass


class ObjectBusy(ValueError):
    """A track job holds the object: its seeds and track cannot be swapped now."""


class NothingToUndo(ValueError):
    pass


@dataclass
class _Bounded:
    """A window re-tracked in bounded passes, one per corrected frame."""

    changed: List[int]  # the new or edited seed frames, in order
    seeds: Seeds  # every seed of the window: each pass conditions on them all
    old: Dict[int, Dict]  # the stale track's frames of the window {frame: rle}


CLICKS_ONLY = "this engine takes clicks only; text prompts need SAM 3"


@dataclass
class _ObjectPlan:
    """What a job does with one object: its seeded windows (with their keys),
    the ones the engine must run whole, the ones kept from the stale track, and
    the ones re-tracked in bounded passes."""

    seeds: Seeds
    ranges: List[Dict]
    hash: str
    windows: List[Tuple[Window, str]]
    compute: List[Window]
    reuse: Dict[Window, Dict[int, Dict]]  # window -> {frame: rle} from the old track
    bounded: Dict[Window, _Bounded] = field(default_factory=dict)
    meta: Optional[Dict] = None  # the old track's track.json
    record: Optional[Dict] = None  # the seed record as stored, for the version this job keeps

    def covered(self, frame: int) -> bool:
        return any(w[0] <= frame and (w[1] is None or frame <= w[1]) for w, _ in self.windows)


def _handle_frames(handle) -> Optional[int]:
    try:
        return len(handle["images"])
    except (TypeError, KeyError):
        return None


class TrackService:
    def __init__(self, root: str, engine: Engine, extra: Optional[List[EngineSpec]] = None):
        self.seeds = SeedStore(root)
        self.tracks = TrackStore(root)
        self.versions = VersionStore(root)
        self.layouts = LayoutStore(root)
        self.reviews = rv.ReviewStore(root)
        self.jobs = JobRegistry()
        self._engines: Dict[str, Engine] = {}
        self._specs: Dict[str, EngineSpec] = {s.name: s for s in (extra or [])}
        self.engine = engine
        self._keys: Dict[str, Tuple[float, int, str]] = {}

    # -- engines ---------------------------------------------------------------
    @property
    def engine(self) -> Engine:
        """The default engine: SAM 2, which also serves interactive clicks."""
        return self._engines[self.default]

    @engine.setter
    def engine(self, e: Engine) -> None:
        self.default = e.name
        self._engines[e.name] = e

    def get_engine(self, name: Optional[str] = None) -> Engine:
        name = name or self.default
        if name in self._engines:
            return self._engines[name]
        spec = self._specs.get(name)
        if spec is None:
            raise UnknownEngine(f"unknown engine {name!r}; known: {sorted(set(self._engines) | set(self._specs))}")
        why = spec.unavailable()
        if why:
            raise UnknownEngine(f"engine {name!r} cannot run here: {why}")
        self._engines[name] = spec.factory()
        return self._engines[name]

    def _engine_model(self, name: str) -> Tuple[str, str]:
        if name in self._engines:
            return name, self._engines[name].model
        spec = self._specs.get(name)
        if spec is None:
            raise UnknownEngine(f"unknown engine {name!r}")
        return name, spec.model

    def engine_names(self) -> List[str]:
        return [self.default] + sorted((set(self._engines) | set(self._specs)) - {self.default})

    def engines(self) -> List[Dict]:
        out = []
        for name in self.engine_names():
            spec = self._specs.get(name)
            why = spec.unavailable() if spec and name not in self._engines else None
            text_why = self.text_reason(name)
            out.append({"name": name, "model": self._engine_model(name)[1], "default": name == self.default,
                        "available": why is None, "reason": why, "loaded": self._loaded(name),
                        "text": text_why is None, "text_reason": text_why})
        return out

    def _loaded(self, name: str) -> bool:
        """Whether engine `name` holds its model now: built, and not unloaded
        since (SAM 3 unloads when idle, tracks/sam3_engine.py)."""
        e = self._engines.get(name)
        return e is not None and bool(getattr(e, "loaded", True))

    def text_reason(self, name: str) -> Optional[str]:
        """None when engine `name` can take a text prompt here, else why not.
        Never builds the engine."""
        spec = self._specs.get(name)
        if spec is not None and spec.text is not None:
            return spec.unavailable() or spec.text()
        if spec is None and hasattr(self._engines.get(name), "segment_text"):
            return None
        return CLICKS_ONLY

    def text_engine(self, name: Optional[str] = None) -> Engine:
        """The engine a text prompt runs on: `name`, else the first that reads
        text here. UnknownEngine (a 400) when it cannot."""
        if name is None:
            name = next((n for n in self.engine_names() if self.text_reason(n) is None), None)
            if name is None:
                raise UnknownEngine("no engine here reads text prompts; they need SAM 3 (Help > Set up SAM 3)")
        else:
            self._engine_model(name)  # unknown: its own error
            why = self.text_reason(name)
            if why:
                raise UnknownEngine(f"engine {name!r} cannot take a text prompt: {why}")
        return self.get_engine(name)

    def video_key(self, path: str) -> str:
        st = os.stat(path)
        hit = self._keys.get(path)
        if hit and hit[:2] == (st.st_mtime, st.st_size):
            return hit[2]
        key = video_key(path)
        self._keys[path] = (st.st_mtime, st.st_size, key)
        return key

    # -- seeds, as the user clicks ------------------------------------------
    def record_points(self, video: str, obj_id: int, frame: int, points, labels, clear_old_points: bool,
                      mask: Optional[Dict] = None):
        with self._seed_change(video, obj_id):
            self.seeds.add_points(video, obj_id, frame, points, labels, clear_old_points, mask)

    def clear_frame(self, video: str, obj_id: int, frame: int):
        """Drop one seed frame. With none left, the object's tracks go too:
        a track with no seeds behind it could never be refreshed. Their
        versions stay, so an undo brings the last click back with its track."""
        with self._seed_change(video, obj_id):
            if not self.seeds.clear_frame(video, obj_id, frame):
                self.tracks.clear(video, obj_id)

    def set_range(self, video: str, obj_id: int, start: int, end: int, state: Optional[str],
                  source: Optional[str] = None, score: Optional[float] = None,
                  clear: Optional[List[str]] = None) -> Dict:
        """Set frames start-end of an object to a range state, or clear them
        (state None: every state, or those in `clear`). ValueError on a bad
        span, state or provenance. A candidate needs a `source` (and may have a
        `score`). Only a change of absent frames changes the seeds hash: the
        object's tracks go stale, a re-track runs only the windows the change
        touched, and it goes on the undo history. Present and candidate ranges
        are annotations: no track goes stale and there is nothing to undo."""
        with self._seed_change(video, obj_id):
            self.seeds.paint_range(video, obj_id, start, end, state, source, score, clear)
        return self.object_info(video, obj_id)

    def write_candidates(self, video: str, obj_id: int, candidates: List[Dict], replace: bool = False) -> Dict:
        """Write candidate ranges in bulk, each {"start", "end", "source",
        "score"?} (a discovery job's results); `replace` drops the object's
        old candidates. All or nothing (ValueError). Never a seed change."""
        self.seeds.write_candidates(video, obj_id, candidates, replace)
        return self.object_info(video, obj_id)

    def is_absent(self, video: str, obj_id: int, frame: int) -> bool:
        return absent_at(self.seeds.ranges(video, obj_id), frame)

    def prime_mask(self, video: str, obj_id: int, frame: int) -> Optional[Dict]:
        """The mask a first click on this frame should refine: the approved
        seed mask there, else the default engine's cached mask, else None.
        An empty mask is None too: there is nothing to refine, and so is any
        frame inside an absent range (the object is not there).

        A stale track counts. The first correction makes the track stale (its
        seeds changed), and the other frames flagged in the same review are
        corrected against that same track, which the studio still shows, until
        the re-track. Refusing it made every correction after the first start
        from nothing."""
        if self.is_absent(video, obj_id, frame):
            return None
        seed = self.seeds.seeds(video, obj_id).get(frame)
        if seed and seed.get("mask"):
            return seed["mask"] if rle.area(seed["mask"]) else None
        cached = self.tracks.mask_at(video, obj_id, self.default, frame)
        return cached if cached is not None and rle.area(cached) else None

    def remove_object(self, video: str, obj_id: int):
        self.seeds.remove_object(video, obj_id)
        self.layouts.remove_object(video, obj_id)  # out of the order and its group

    def text_prompt(self, video: str, path: str, obj_id: int, frame: int, text: str,
                    engine: Optional[str] = None) -> Dict:
        """Seed one frame of an object from a phrase: the text engine's best
        instance there becomes the frame's approved mask (its clicks go). A
        phrase that matches nothing stores nothing. ValueError on no text, a
        bad frame, or a frame inside an absent range; UnknownEngine when no
        engine (or not `engine`) reads text. The answer has "mask" as RLE, or
        None on a miss."""
        text = normalize_text(text)
        if isinstance(frame, bool) or not isinstance(frame, int) or frame < 0:
            raise ValueError(f"frame_index must be a frame number, got {frame!r}")
        if self.is_absent(video, obj_id, frame):
            raise ValueError(f"frame {frame} is inside a range where object {obj_id} is marked absent; "
                             "unmark that part of the range to prompt here")
        e = self.text_engine(engine)
        match = e.segment_text(path, frame, text)
        mask = None
        if match.mask is not None:
            mask = rle.encode(np.asarray(match.mask, bool))
            self.seeds.set_text(video, obj_id, frame, text, mask)
        return {"object_id": obj_id, "frame_index": frame, "text": text, "engine": e.name,
                "matched": mask is not None, "score": round(float(match.score), 4), "instances": int(match.instances),
                "box": None if match.box is None else [round(float(v), 1) for v in match.box], "mask": mask}

    def rename_object(self, video: str, obj_id: int, name: Optional[str]) -> Optional[str]:
        """Metadata only: the seeds, their hash and every track stay as they are."""
        return self.seeds.set_name(video, obj_id, name)

    def object_names(self, video: str) -> Dict[int, str]:
        return self.seeds.names(video)

    def clear_video(self, video: str):
        self.seeds.clear_video(video)  # layout.json too: it sits in the video's directory

    # -- the object layout (issue #21): order and groups, never in a seeds hash -----
    def layout(self, video: str) -> Layout:
        return self.layouts.get(video, self.seeds.objects(video))

    def set_layout(self, video: str, raw) -> Layout:
        """Store a layout (LayoutError when malformed); answers it as layout() reads it."""
        self.layouts.set(video, raw)
        return self.layout(video)

    # -- versions and undo (issue #18) ----------------------------------------------
    def _record(self, video: str, obj_id: int) -> Tuple[str, Dict]:
        files = self.seeds.record(video, obj_id)
        return self.seeds.record_key(files), files

    def _remember(self, video: str, obj_id: int, key: str, files: Dict) -> None:
        """Keep the seed record `files` (key `key`) so it can be restored, and
        keep as a version any current track made from it that has none (one
        written before versions existed, or one a crash kept from its version)."""
        self.versions.put_snapshot(video, obj_id, key, files)
        for name in self.engine_names():
            meta = self.tracks.meta(video, obj_id, name)
            if meta is not None and meta["seeds_hash"] == key and not self.versions.has(video, obj_id, name, key):
                self._keep_version(video, obj_id, name, key, files, meta)

    def _keep_version(self, video: str, obj_id: int, engine: str, key: str, files: Dict, meta: Dict) -> None:
        seeds = (files.get("seeds.json") or {}).values()
        self.versions.put_snapshot(video, obj_id, key, files)
        self.versions.record(video, obj_id, engine, key, self.tracks.track_dir(video, obj_id, engine), {
            "model": meta["model"], "created": meta.get("created"), "elapsed_s": meta.get("elapsed_s"),
            "n_frames": meta.get("n_frames"), "clicks": sum(len(v.get("points") or []) for v in seeds),
            "seed_frames": len(seeds), "bounded": bool(bnd.spans(meta))})
        self.versions.evict(video, obj_id, engine, protect=[key])

    @contextlib.contextmanager
    def _seed_change(self, video: str, obj_id: int):
        """Around a change of the object's seed record: the record before it
        goes on the undo history (if the change changed anything), and redo
        is cleared, as in any editor. Seeds a version keeps get its track."""
        key, files = self._record(video, obj_id)
        self._remember(video, obj_id, key, files)
        yield
        after, now_files = self._record(video, obj_id)
        if after != key:
            # back on seeds a version keeps (a click taken off by hand): their
            # track comes back too. Never under a running job, which would save
            # over it; the object is then stale until its job ends, as before.
            if (now_files.get("seeds.json") or {}) and obj_id not in self.jobs.held(video):
                self._adopt_versions(video, obj_id, after)
            h = self.versions.history(video, obj_id)
            h["undo"].append({"key": key, "at": ver.now()})
            h["redo"] = []
            self.versions.set_history(video, obj_id, h)
        self.versions.gc(video, obj_id)

    def _check_free(self, video: str, obj_id: int) -> None:
        if obj_id in self.jobs.held(video):
            raise ObjectBusy(f"object {obj_id} is being tracked: wait for its job to finish, or cancel it, "
                             "then undo")

    def _apply(self, video: str, obj_id: int, files: Dict) -> None:
        """Make `files` the object's seed record, and for each engine with a
        version of it, make that version the current track (no job). An engine
        without one keeps its current track, which is now stale."""
        self.seeds.put_record(video, obj_id, files)
        if not (files.get("seeds.json") or {}):
            self.tracks.clear(video, obj_id)  # no seeds, no track (as clear_frame does); versions stay
            return
        self._adopt_versions(video, obj_id, self.seeds.record_key(files))

    def _adopt_versions(self, video: str, obj_id: int, key: str) -> None:
        """For each engine with a kept track of seeds `key`, make it current."""
        for name in self.engine_names():
            src = self.versions.track_dir(video, obj_id, name, key)
            if src is None:
                continue
            model = self._engine_model(name)[1]
            meta = self.tracks.meta(video, obj_id, name)
            if meta is not None and meta["seeds_hash"] == key and meta["model"] == model:
                continue  # already the current track
            if (self.versions.summary(video, obj_id, name, key) or {}).get("model") != model:
                continue  # made by another model: it would be stale anyway
            self.tracks.adopt(video, obj_id, name, src, extra={"restored": {"at": ver.now(), "from": "versions"}})
            self.versions.touch(video, obj_id, name, key)

    def _step(self, video: str, obj_id: int, src: str, dst: str) -> Dict:
        self._check_free(video, obj_id)
        h = self.versions.history(video, obj_id)
        files = None
        while h[src] and files is None:
            files = self.versions.snapshot(video, obj_id, h[src][-1]["key"])
            if files is None:
                logger.warning(f"object {obj_id}: the snapshot of {h[src][-1]['key']} is missing; skipped")
                h[src].pop()
        if files is None:
            self.versions.set_history(video, obj_id, h)
            raise NothingToUndo(f"object {obj_id} has nothing to {src}")
        key, cur = self._record(video, obj_id)
        self._remember(video, obj_id, key, cur)
        try:
            self._apply(video, obj_id, files)
        except BaseException:
            self.seeds.put_record(video, obj_id, cur)  # as it was: the history still says so
            raise
        h[src].pop()
        h[dst].append({"key": key, "at": ver.now()})
        self.versions.set_history(video, obj_id, h)
        self.versions.gc(video, obj_id)
        return self.object_info(video, obj_id)

    def undo(self, video: str, obj_id: int) -> Dict:
        """Put back the object's seeds from before its last seed change. Its
        track comes back from its version when it has one: tracked, no job."""
        return self._step(video, obj_id, "undo", "redo")

    def redo(self, video: str, obj_id: int) -> Dict:
        return self._step(video, obj_id, "redo", "undo")

    def restore_version(self, video: str, obj_id: int, key: str) -> Dict:
        """Go back to a version from the list: a seed change like any other,
        so it can be undone. KeyError for a version the object does not keep."""
        self._check_free(video, obj_id)
        files = self.versions.snapshot(video, obj_id, key)
        if files is None:
            raise KeyError(f"object {obj_id} keeps no version {key}")
        with self._seed_change(video, obj_id):
            self._apply(video, obj_id, files)
        return self.object_info(video, obj_id)

    def versions_info(self, video: str, obj_id: int) -> Dict:
        """What the object can undo and redo, and its kept versions, the most
        recently made or restored first: when each was tracked, by which engine and model, from how
        many clicks, and whether it is the object's current seeds."""
        current = self.seeds.hash(video, obj_id)
        h = self.versions.history(video, obj_id)
        keep = ("key", "engine", "model", "created", "elapsed_s", "n_frames", "clicks", "seed_frames", "bounded")
        return {"can_undo": bool(h["undo"]), "can_redo": bool(h["redo"]),
                "versions": [{**{k: e.get(k) for k in keep}, "current": e["key"] == current}
                             for e in self.versions.entries(video, obj_id)]}

    # -- state -----------------------------------------------------------------
    def _track_state(self, video: str, obj_id: int, name: str, seeds, ranges) -> Dict:
        name, model = self._engine_model(name)
        meta = self.tracks.meta(video, obj_id, name)
        state = self.tracks.state(video, obj_id, name, model, seeds_hash(seeds, ranges) if seeds else None)
        if obj_id in self.jobs.held(video, name):
            state = TRACKING
        return {"engine": name, "model": model, "state": state,
                "frames": meta["frames"] if meta else None, "n_frames": meta["n_frames"] if meta else 0}

    def object_info(self, video: str, obj_id: int, engine: Optional[str] = None) -> Dict:
        """The object's seeds and its track state for `engine` (default SAM 2),
        plus every engine's state under "tracks"."""
        seeds = self.seeds.seeds(video, obj_id)
        ranges = self.seeds.ranges(video, obj_id)
        tracks = {n: self._track_state(video, obj_id, n, seeds, ranges) for n in self.engine_names()}
        main = tracks[self._engine_model(engine or self.default)[0]]
        # "ranges" is the timeline: absent, present and candidate (tracks/ranges.py view())
        return {"object_id": obj_id, **main, "seeds": seeds, "ranges": self.seeds.timeline(video, obj_id),
                "tracks": list(tracks.values()),
                "history": self.versions_info(video, obj_id)}

    def objects(self, video: str, engine: Optional[str] = None) -> List[Dict]:
        return [self.object_info(video, o, engine) for o in self.seeds.objects(video)]

    def select(self, video: str, obj_ids: Optional[List[int]] = None, engine: Optional[str] = None) -> List[int]:
        """The objects a Track press runs on `engine`: the ids given, else every
        object not tracked by it. Objects without seeds are dropped (there is
        nothing to track), and so are objects a running job on it holds."""
        name = self._engine_model(engine or self.default)[0]
        held = self.jobs.held(video, name)
        known = [o for o in self.seeds.objects(video) if self.seeds.seeds(video, o) and o not in held]
        if obj_ids is None:
            return [o for o in known if self.object_info(video, o, name)["state"] not in (TRACKED, TRACKING)]
        return sorted({int(o) for o in obj_ids} & set(known))

    def clear_track(self, video: str, obj_id: int, engine: Optional[str] = None) -> Dict:
        """Drop the object's track from one engine, or from every engine, and
        that engine's versions: a cleared track is not brought back by an undo."""
        name = self._engine_model(engine)[0] if engine else None
        self.tracks.clear(video, obj_id, name)
        self.versions.drop(video, obj_id, name)
        self.versions.gc(video, obj_id)
        return self.object_info(video, obj_id)

    # -- jobs ------------------------------------------------------------------
    def _plan(self, video: str, e: Engine, obj_ids: List[int], n: Optional[int],
              full: bool = False) -> Dict[int, _ObjectPlan]:
        plans = {}
        for o in obj_ids:
            seeds = self.seeds.seeds(video, o)
            if not seeds:
                continue
            ranges = self.seeds.ranges(video, o)
            h = seeds_hash(seeds, ranges)
            seeded = seeded_windows(seeds, ranges)
            wins = [(w, window_key(w, mine)) for w, mine in seeded]
            meta = self.tracks.meta(video, o, e.name)
            reuse, bounded = ({}, {}) if full else self._from_stale(video, o, e, h, meta, seeds, seeded, wins, n)
            compute = [w for w, _ in wins if w not in reuse and w not in bounded]
            plans[o] = _ObjectPlan(seeds, ranges, h, wins, compute, reuse, bounded, meta, self.seeds.record(video, o))
        return plans

    def _from_stale(self, video: str, o: int, e: Engine, h: str, meta: Optional[Dict], seeds: Seeds,
                    seeded: List[Tuple[Window, Seeds]], wins: List[Tuple[Window, str]],
                    n: Optional[int]) -> Tuple[Dict[Window, Dict[int, Dict]], Dict[Window, _Bounded]]:
        """What a STALE track still gives: the windows whose inputs are
        unchanged, with their masks, and the windows a correction touched that
        a bounded pass can re-track (tracks/bounded.py says when one cannot).
        A tracked object asked for again is re-run whole, and so is every
        track from before windows (it has no window keys)."""
        if n is None or meta is None or meta["model"] != e.model or meta["seeds_hash"] == h:
            return {}, {}
        old_keys = {seg["key"] for seg in meta.get("windows") or []}
        keep = [w for w, k in wins if k in old_keys]
        touched: Dict[Window, List[int]] = {}
        if callable(getattr(e, "track_stretch", None)) and meta.get("seed_keys") is not None:
            old_bounds = {(seg["start"], seg["end"]) for seg in meta.get("windows") or []}
            for w, k in wins:
                if k not in old_keys and w in old_bounds:
                    changed = bnd.changed_frames(meta["seed_keys"], seeds, w)
                    if changed:
                        touched[w] = changed
        if not keep and not touched:
            return {}, {}
        wanted = set(keep) | set(touched)
        frames = {f: r for f, r in self.tracks.masks(video, o, e.name)
                  if any(f in window_frames(w, n) for w in wanted)}
        whole = {}
        for w in wanted:
            got = {f: frames[f] for f in window_frames(w, n) if f in frames}
            if len(got) == len(window_frames(w, n)):  # all of it, or run it again
                whole[w] = got
        mine = dict(seeded)
        reuse = {w: whole[w] for w in keep if w in whole}
        bounded = {w: _Bounded(touched[w], mine[w], whole[w]) for w in touched if w in whole}
        return reuse, bounded

    @staticmethod
    def _engine_windows(plans: Dict[int, _ObjectPlan]) -> Optional[Windows]:
        """The windows the engine is given; None when every object runs whole
        (no ranges, nothing kept), the call from before windows existed."""
        wins = {o: p.compute for o, p in plans.items() if p.compute}
        return None if all(w == [WHOLE] for w in wins.values()) else wins

    def job_frames(self, video: str, obj_ids: List[int], n_frames: int, engine: Optional[str] = None,
                   full: bool = False) -> int:
        """How many frames a job over obj_ids streams, for its progress total:
        each engine pass's window, each bounded window's frames (every one is
        sent once, re-tracked or kept), plus the frames sent from the cache or
        as empty (absent, or in a window with no seed)."""
        return self.job_outline(video, obj_ids, n_frames, engine, full)["frames"]

    def bounded_objects(self, video: str, obj_ids: List[int], n_frames: Optional[int],
                        engine: Optional[str] = None, full: bool = False) -> List[int]:
        """The objects a job over obj_ids re-tracks, at least in part, in
        bounded passes (for the studio's progress chip)."""
        return self.job_outline(video, obj_ids, n_frames, engine, full)["bounded"]

    def job_outline(self, video: str, obj_ids: List[int], n_frames: Optional[int], engine: Optional[str] = None,
                    full: bool = False) -> Dict:
        """{"frames": job_frames, "bounded": bounded_objects}, planned once."""
        e = self.get_engine(engine)
        # the clip's length as track() finds it, so both plan alike; the total
        # stays unknown (None) when the caller cannot say it
        plans = self._plan(video, e, obj_ids, n_frames or getattr(e, "n_frames", None), full)
        bounded = sorted(o for o, p in plans.items() if p.bounded)
        if not n_frames:
            return {"frames": n_frames, "bounded": bounded}
        run = {o: p.seeds for o, p in plans.items() if p.compute}
        wins = self._engine_windows(plans)
        plan = getattr(e, "plan", None)  # an engine that does not say runs the clip once
        if not run:
            computed = 0
        elif plan is None:
            computed = n_frames
        else:
            computed = sum(u.n_frames(n_frames) for u in plan(run, wins))
        filled = sum(1 for f in range(n_frames)
                     if any(not p.covered(f) or any(w[0] <= f and (w[1] is None or f <= w[1]) for w in p.reuse)
                            for p in plans.values()))
        in_bounded = sum(len(window_frames(w, n_frames)) for p in plans.values() for w in p.bounded)
        return {"frames": computed + in_bounded + filled, "bounded": bounded}

    def track(self, video: str, path: str, obj_ids: List[int], video_handle: Optional[Any] = None,
              result: Optional[JobResult] = None, engine: Optional[str] = None,
              n_frames: Optional[int] = None, full: bool = False, steps: bool = False) -> Iterator[Optional[FrameRle]]:
        """Run `engine` on obj_ids and yield each frame's RLE masks. Each track
        is cached only once the whole job finishes: a cancelled job (the
        consumer stops iterating) caches nothing. The seeds hash is taken at the
        start, so seeds edited mid-job leave the track stale. `result` is filled
        in with what was tracked and what failed to save.

        The engine runs only the windows that need it, whole, then each
        bounded window's passes, each object's followed by the rest of that
        window from the cache. The frames no pass runs (absent, in a window
        with no seed, or kept from the stale track) follow, merged per frame.
        `n_frames` is the clip's length; without it the session's video handle
        or the engine says, else the frames seen. `full` re-tracks every
        window whole, keeping nothing from a stale track.

        With `steps`, a bounded pass also yields None between frames it holds
        back or throws away (its lead-in, a failed start, the seeding and
        priming of its state): steps with no frame, so a caller that takes
        the model lock per item (routes._run_job) holds it one frame at a
        time. Without, those are skipped."""
        result = result if result is not None else JobResult()
        e = self.get_engine(engine)
        n = n_frames or _handle_frames(video_handle) or getattr(e, "n_frames", None)
        plans = self._plan(video, e, obj_ids, n, full)
        result.objects = sorted(plans)
        if not plans:
            return
        frames: Dict[int, Dict[int, Dict]] = {o: {} for o in plans}
        prov = {o: Provenance(p.meta) for o, p in plans.items()}
        run = {o: p.seeds for o, p in plans.items() if p.compute}
        t0 = time.perf_counter()
        if run:
            wins = self._engine_windows(plans)
            it = e.track(path, run, video_handle=video_handle) if wins is None else \
                e.track(path, run, video_handle=video_handle, windows=wins)
            for frame, masks in it:
                enc = {o: rle.encode(m) for o, m in masks.items()}
                for o, r in enc.items():
                    frames[o][frame] = r
                    prov[o].made(frame, prov[o].full(plans[o].hash))
                yield frame, enc
        for o, p in plans.items():
            for w, b in p.bounded.items():
                for item in self._bounded(e, path, video_handle, o, p, w, b, n, frames[o], prov[o]):
                    if item is not None or steps:
                        yield item
        if n is None:
            n = 1 + max([f for fs in frames.values() for f in fs] +
                        [f for p in plans.values() for got in p.reuse.values() for f in got] or [-1])
        size = self._mask_size(plans, frames, video_handle)
        empty = rle.encode(np.zeros(size, bool)) if size else None
        for f in range(n):
            fill = {}
            for o, p in plans.items():
                kept = next((got[f] for got in p.reuse.values() if f in got), None)
                if kept is not None:
                    fill[o] = kept
                    prov[o].kept(f)
                elif not p.covered(f) and empty is not None:
                    fill[o] = empty
                    prov[o].empty(f, p.hash)
            if fill:
                for o, r in fill.items():
                    frames[o][f] = r
                yield f, fill
        elapsed = time.perf_counter() - t0
        for o, p in plans.items():
            try:
                meta = self.tracks.save(video, o, e.name, e.model, p.hash, frames[o], elapsed,
                                        extra={"windows": [{"start": w[0], "end": w[1], "key": k}
                                                           for w, k in p.windows], **prov[o].extra(p.seeds)})
                result.tracked.append(o)
            except Exception as err:  # one object's failed save must not lose the others
                logger.exception(f"saving the track of object {o} failed")
                result.failed[o] = f"{type(err).__name__}: {err}"
                continue
            if o not in self.seeds.objects(video):
                continue  # removed while the job ran: keep no version of it
            try:  # the track is saved; a version that fails to keep only costs an undo
                self._keep_version(video, o, e.name, p.hash, p.record, meta)
                self.versions.gc(video, o)
            except Exception:
                logger.exception(f"keeping a version of object {o}'s track failed")

    @staticmethod
    def _bounded(e: Engine, path: str, video_handle, o: int, p: _ObjectPlan, w: Window, b: _Bounded, n: int,
                 frames: Dict[int, Dict], prov: Provenance) -> Iterator[Optional[FrameRle]]:
        """One window's bounded passes, one per corrected frame in order, then
        the window's other frames from the cache (tracks/bounded.py has the
        algorithm). A pass that fails its lead-in check is dropped before any
        of its frames is sent, so every frame still goes out once. Each
        engine step that sends nothing yields None (see track's `steps`)."""
        span = window_frames(w, n)
        first_seed = min(b.seeds)
        made = set()
        reached = span[0] - 1  # the last frame an earlier pass in this window made
        for i, c in enumerate(b.changed):
            hi = b.changed[i + 1] - 1 if i + 1 < len(b.changed) else span[-1]
            floor = reached + 1
            anchor = max(floor, first_seed)  # no pass starts before it (c is a seed, so c >= first_seed)
            pid = prov.bounded(p.hash, w, c, b.seeds[c])
            lead, attempts = bnd.LEAD, 0
            while True:
                attempts += 1
                start = max(c - lead, anchor)
                at_anchor = start == anchor
                stretch = Stretch(o, b.seeds, start, floor, hi, corrected=c,
                                  reverse=at_anchor and start == first_seed and start > floor,
                                  cached=ChainMap(frames, b.old), floor=span[0])
                stop = Agreement(b.old, start, c, check=0 if at_anchor else bnd.AGREE_RUN)
                held, ran = [], []
                for item in e.track_stretch(path, stretch, stop, video_handle=video_handle):
                    if item is None:  # seeding or priming: no frame yet
                        yield None
                        continue
                    if stop.failed:
                        yield None  # the failed frame was a step too; the next start follows
                        break
                    f, masks = item
                    r = rle.encode(masks[o])
                    ran.append((f, r))
                    if f < start + stop.check:  # held until the lead-in check has passed
                        held.append((f, r))
                        yield None
                        continue
                    for hf, hr in held:
                        yield hf, {o: hr}
                    held = []
                    yield f, {o: r}
                if not stop.failed:
                    break
                lead *= 2  # the change reaches further back: start earlier
            for hf, hr in held:  # a pass shorter than its lead-in check
                yield hf, {o: hr}
            for f, r in ran:
                frames[f] = r
                prov.made(f, pid)
                made.add(f)
            done = [f for f, _ in ran]
            prov.finish(pid, done, stop.agreed[False], not at_anchor or stop.agreed[True], attempts)
            reached = max(done + [c])
        for f in span:
            if f not in made:
                frames[f] = b.old[f]
                prov.kept(f)
                yield f, {o: b.old[f]}

    @staticmethod
    def _mask_size(plans: Dict[int, _ObjectPlan], frames: Dict[int, Dict[int, Dict]], handle) -> Optional[List[int]]:
        """[h, w] of the clip's masks, for the empty frames: from anything
        tracked or kept, a seed's mask, or the session's video."""
        for fs in frames.values():
            for r in fs.values():
                return list(r["size"])
        for p in plans.values():
            for got in p.reuse.values():
                for r in got.values():
                    return list(r["size"])
            for v in p.seeds.values():
                if v.get("mask"):
                    return list(v["mask"]["size"])
        try:
            return [int(handle["video_height"]), int(handle["video_width"])]
        except (TypeError, KeyError, ValueError):
            return None

    def cached(self, video: str, obj_ids: Optional[List[int]] = None,
               engine: Optional[str] = None) -> Iterator[FrameRle]:
        """Stream stored tracks, merged per frame, to repaint them after a reload.
        Stale tracks are sent too; the UI marks them. Frames inside an absent
        range go out empty, even from a track made before the range was marked."""
        name = self._engine_model(engine or self.default)[0]
        ids = self.seeds.objects(video) if obj_ids is None else [int(o) for o in obj_ids]
        ids = [o for o in ids if self.seeds.seeds(video, o)]  # no seeds, nothing to show
        by_frame: Dict[int, Dict[int, Dict]] = {}
        for o in ids:
            ranges = self.seeds.ranges(video, o)
            for frame, r in self.tracks.masks(video, o, name):
                if ranges and absent_at(ranges, frame):  # a stale track, marked since: never shown
                    r = rle.encode(np.zeros(r["size"], bool))
                by_frame.setdefault(frame, {})[o] = r
        for frame in sorted(by_frame):
            yield frame, by_frame[frame]

    def provenance(self, video: str, obj_id: int, engine: Optional[str] = None) -> Optional[Dict]:
        """Which pass made each frame of the object's track on `engine`, or
        None without one. A track from before provenance reads as one full pass."""
        name = self._engine_model(engine or self.default)[0]
        meta = self.tracks.meta(video, obj_id, name)
        if meta is None:
            return None
        by_frame = bnd.frame_passes(meta)
        return {"object_id": obj_id, "engine": name, "state": self.object_info(video, obj_id, name)["state"],
                "passes": bnd.passes(meta), "provenance": bnd.runs(by_frame), "bounded": bnd.spans(meta)}

    # -- engine disagreement -----------------------------------------------------
    def disagreement(self, video: str, obj_ids: Optional[List[int]] = None, a: Optional[str] = None,
                     b: str = "sam3", threshold: float = 0.8) -> Dict:
        """Frames where two engines' current tracks of an object disagree (mask
        IoU below `threshold`): review flags. Only objects both engines track
        with their current seeds are compared; the rest are listed with why."""
        a = self._engine_model(a or self.default)[0]
        b = self._engine_model(b)[0]
        ids = self.seeds.objects(video) if obj_ids is None else [int(o) for o in obj_ids]
        out: Dict[str, Dict] = {"engines": [a, b], "threshold": threshold, "objects": {}, "skipped": {}}
        for o in ids:
            states = {t["engine"]: t["state"] for t in self.object_info(video, o)["tracks"]}
            if states.get(a) != TRACKED or states.get(b) != TRACKED:
                out["skipped"][str(o)] = {a: states.get(a), b: states.get(b)}
                continue
            ma, mb = dict(self.tracks.masks(video, o, a)), dict(self.tracks.masks(video, o, b))
            ious = {f: mask_iou(rle.decode(ma[f]), rle.decode(mb[f])) for f in sorted(set(ma) & set(mb))}
            out["objects"][str(o)] = {"flagged": [f for f, v in ious.items() if v < threshold],
                                      "iou": {str(f): round(v, 4) for f, v in ious.items()},
                                      "mean_iou": round(float(np.mean(list(ious.values()))), 4) if ious else None,
                                      # stretches a bounded pass made: agreement there is a strong
                                      # signal, not a guarantee, so the review covers them too
                                      "bounded": {x: bnd.spans(self.tracks.meta(video, o, x)) for x in (a, b)}}
        return out

    # -- the audit queue (draft 7) ------------------------------------------------------
    def _compare_engine(self, name: str, compare: Optional[str]) -> Optional[str]:
        """The engine a queue on `name` compares with: `compare`, else SAM 3
        for the default engine and the default for any other."""
        other = compare or ("sam3" if name == self.default else self.default)
        return other if other != name and other in self.engine_names() else None

    def review_queue(self, video: str, obj_ids: Optional[List[int]] = None, engine: Optional[str] = None,
                     flags: Optional[Dict[int, List[int]]] = None, compare: Optional[str] = None) -> Dict:
        """The audit queue of each object `engine` has a track of (tracked or
        stale): its locations, best first, each with its reasons, score and
        whether a valid mark reviewed it, and every object's in one "queue".
        `flags` ({obj: [frame]}) are the user's review flags, which the studio
        keeps. Objects with no track are listed under "skipped"."""
        name = self._engine_model(engine or self.default)[0]
        other = self._compare_engine(name, compare)
        ids = self.seeds.objects(video) if obj_ids is None else [int(o) for o in obj_ids]
        flags = {int(k): [int(f) for f in v] for k, v in (flags or {}).items()}
        out: Dict[str, Any] = {"engine": name, "compare": other, "weights": dict(audit.WEIGHTS), "objects": {},
                               "skipped": {}}
        by_object: Dict[int, List[Dict]] = {}
        for o in ids:
            info = self.object_info(video, o, name)
            if info["state"] not in (TRACKED, STALE):
                out["skipped"][str(o)] = info["state"]
                continue
            meta = self.tracks.meta(video, o, name)
            masks = dict(self.tracks.masks(video, o, name))
            n = max(int(meta.get("n_frames") or 0), 1 + max(masks, default=-1))
            stats = {f: audit.frame_stats(r) for f, r in masks.items()}
            ious: Dict[int, float] = {}
            if other is not None:
                d = self.disagreement(video, [o], name, other)["objects"].get(str(o))
                ious = {int(f): v for f, v in (d or {}).get("iou", {}).items()}
            absent = self.seeds.ranges(video, o)
            reasons = audit.signals(stats, n, absent=absent,
                                    candidates=[r for r in info["ranges"] if r["state"] == CANDIDATE],
                                    disagreement=ious, pair=(name, other or ""), bounded=bnd.spans(meta),
                                    flags=flags.get(o, []),
                                    seeds=[f for f, v in info["seeds"].items() if v.get("points")])
            locs = audit.locations(reasons, n, absent)
            marks = self._valid_marks(video, o, name, meta, masks)
            for loc in locs:
                hit = next((m for m in reversed(marks) if rv.reviews(m, loc)), None)
                loc["reviewed"] = hit is not None
                loc["reviewed_at"] = hit["at"] if hit else None
            by_object[o] = locs
            out["objects"][str(o)] = {"state": info["state"], "n_frames": n, "locations": locs,
                                      "unreviewed": sum(1 for loc in locs if not loc["reviewed"])}
        out["queue"] = audit.rank(by_object)
        return out

    @staticmethod
    def _review_now(meta: Optional[Dict], by_frame: Dict[int, int], masks: Dict[int, Dict], n: int, frame: int,
                    span: Tuple[int, int]) -> Optional[Dict]:
        """What the track holds over a mark's frame and span, in tracks/review.py's
        terms; None when the frame is outside it. A frame with no stored mask is empty."""
        if meta is None or not 0 <= frame < n:
            return None
        passes = {p["id"]: p for p in bnd.passes(meta)}

        def pass_of(f):
            p = passes.get(by_frame.get(f))
            return None if p is None else {"id": p["id"], "created": p.get("created")}

        def fp(f):
            return rv.fingerprint(masks[f]) if f in masks else rv.EMPTY

        a, b = max(0, span[0]), min(n - 1, span[1])
        frames = range(a, b + 1)
        seen = sorted({(p["id"], p["created"]) for p in map(pass_of, frames) if p is not None},
                      key=lambda x: (x[0], x[1] or ""))
        return {"pass": pass_of(frame), "passes": [list(p) for p in seen] or None, "mask": fp(frame),
                "span_mask": rv.digest([fp(f) for f in frames])}

    def _valid_marks(self, video: str, o: int, name: str, meta: Optional[Dict], masks: Dict[int, Dict]) -> List[Dict]:
        by_frame = bnd.frame_passes(meta)
        n = max(int((meta or {}).get("n_frames") or 0), 1 + max(masks, default=-1))
        out = []
        for m in self.reviews.marks(video, o):
            span = tuple(m.get("span") or (m["frame"], m["frame"]))
            if rv.valid(m, name, self._review_now(meta, by_frame, masks, n, m["frame"], span)):
                out.append(m)
        return out

    def set_reviewed(self, video: str, obj_id: int, frame: int, engine: Optional[str] = None, reviewed: bool = True,
                     span: Optional[Tuple[int, int]] = None, reasons: Optional[List[str]] = None) -> Dict:
        """Mark the queue location at `frame` (covering `span`) reviewed on
        `engine`'s track ("looks right"), or with reviewed False drop the marks
        on it. Metadata only: no track goes stale and nothing joins the undo
        history. KeyError when the engine has no track of the object there."""
        name = self._engine_model(engine or self.default)[0]
        frame = int(frame)
        if not reviewed:
            a, b = span if span is not None else (frame, frame)
            self.reviews.unmark(video, obj_id, name, int(a), int(b))
            return {"object_id": int(obj_id), "frame": frame, "engine": name, "reviewed": False}
        meta = self.tracks.meta(video, obj_id, name)
        masks = dict(self.tracks.masks(video, obj_id, name)) if meta is not None else {}
        n = max(int((meta or {}).get("n_frames") or 0), 1 + max(masks, default=-1))
        span = (int(span[0]), int(span[1])) if span is not None else (frame, frame)
        span = (min(span), max(span))
        now = self._review_now(meta, bnd.frame_passes(meta), masks, n, frame, span)
        if now is None:
            raise KeyError(f"object {obj_id} has no {name} track on frame {frame}")
        m = self.reviews.mark(video, obj_id, frame, name, span=span, seeds_hash=self.seeds.hash(video, obj_id),
                              now=now, reasons=reasons or [])
        return {"object_id": int(obj_id), "frame": frame, "engine": name, "reviewed": True, "at": m["at"]}
