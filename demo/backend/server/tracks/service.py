# sam-ui (Apache-2.0). New file, not from SAM 2.
"""TrackService: seeds, cached tracks and the engines that make them, per video.

The interactive session calls record_points / clear_frame / remove_object as
the user clicks; a Track press calls track(), which runs only the objects that
are untracked or stale for the chosen engine (or the ids given) and caches each
finished track under that engine. The default engine (SAM 2) also serves the
interactive clicks; others (SAM 3) are registered by spec and built on first
use. Locking is the caller's job (the backend's single inference lock).

Absent ranges (issue #20, tracks/ranges.py) split an object's timeline into
windows. A job tracks each window with a seed on its own, and stores every
other frame as an empty mask, so a track always covers the whole clip. A
stale track keeps the windows whose inputs did not change (window_key): only
the windows a range or seed edit touched run again.

Text prompts (issue #22, tracks/text.py): text_prompt() asks an engine that
reads text (SAM 3) for a phrase's best instance on one frame, and stores it as
that frame's seed. engines() says which engines read text, and why not.
"""
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

import numpy as np

from tracks import rle
from tracks.engine import WHOLE, Engine, Windows
from tracks.jobs import TRACKING, JobRegistry
from tracks.ranges import ABSENT, Window, absent_at, seeded_windows, window_frames
from tracks.seeds import Seeds, SeedStore, seeds_hash, video_key, window_key
from tracks.store import TRACKED, TrackStore
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


CLICKS_ONLY = "this engine takes clicks only; text prompts need SAM 3"


@dataclass
class _ObjectPlan:
    """What a job does with one object: its seeded windows (with their keys),
    the ones the engine must run, and the ones kept from the stale track."""

    seeds: Seeds
    ranges: List[Dict]
    hash: str
    windows: List[Tuple[Window, str]]
    compute: List[Window]
    reuse: Dict[Window, Dict[int, Dict]]  # window -> {frame: rle} from the old track

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
                        "available": why is None, "reason": why, "loaded": name in self._engines,
                        "text": text_why is None, "text_reason": text_why})
        return out

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
        self.seeds.add_points(video, obj_id, frame, points, labels, clear_old_points, mask)

    def clear_frame(self, video: str, obj_id: int, frame: int):
        """Drop one seed frame. With none left, the object's tracks go too:
        a track with no seeds behind it could never be refreshed."""
        if not self.seeds.clear_frame(video, obj_id, frame):
            self.tracks.clear(video, obj_id)

    def set_range(self, video: str, obj_id: int, start: int, end: int, state: Optional[str]) -> Dict:
        """Mark frames start-end of an object with a range state ("absent"), or
        clear them (state None). ValueError on a bad span or state. The seeds
        hash changes, so the object's tracks go stale; a re-track runs only
        the windows the change touched."""
        self.seeds.paint_range(video, obj_id, start, end, state)
        return self.object_info(video, obj_id)

    def end_absence_at(self, video: str, obj_id: int, frame: int) -> None:
        """The object is back at `frame`: the absent range containing it no
        longer covers `frame` or anything after it in that range.

        [s, e] becomes [s, frame-1]; at frame == s the range goes (paint
        never writes [s, s-1]). A seed change like set_range, so the track
        goes stale. No range there: nothing changes."""
        for r in self.seeds.ranges(video, obj_id):
            if r["state"] == ABSENT and r["start"] <= frame <= r["end"]:
                self.seeds.paint_range(video, obj_id, frame, r["end"], None)
                return

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
        self.seeds.clear_video(video)

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
        return {"object_id": obj_id, **main, "seeds": seeds, "ranges": ranges, "tracks": list(tracks.values())}

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
        """Drop the object's track from one engine, or from every engine."""
        self.tracks.clear(video, obj_id, self._engine_model(engine)[0] if engine else None)
        return self.object_info(video, obj_id)

    # -- jobs ------------------------------------------------------------------
    def _plan(self, video: str, e: Engine, obj_ids: List[int], n: Optional[int]) -> Dict[int, _ObjectPlan]:
        plans = {}
        for o in obj_ids:
            seeds = self.seeds.seeds(video, o)
            if not seeds:
                continue
            ranges = self.seeds.ranges(video, o)
            h = seeds_hash(seeds, ranges)
            wins = [(w, window_key(w, mine)) for w, mine in seeded_windows(seeds, ranges)]
            reuse = self._reusable(video, o, e, h, wins, n)
            plans[o] = _ObjectPlan(seeds, ranges, h, wins, [w for w, _ in wins if w not in reuse], reuse)
        return plans

    def _reusable(self, video: str, o: int, e: Engine, h: str, wins: List[Tuple[Window, str]],
                  n: Optional[int]) -> Dict[Window, Dict[int, Dict]]:
        """The windows of a STALE track whose inputs are unchanged, with their
        masks. A tracked object asked for again is re-run whole, and so is
        every track from before windows (it has no window keys)."""
        meta = self.tracks.meta(video, o, e.name)
        if n is None or meta is None or meta["model"] != e.model or meta["seeds_hash"] == h:
            return {}
        old = {seg["key"] for seg in meta.get("windows") or []}
        keep = [w for w, k in wins if k in old]
        if not keep:
            return {}
        frames = {f: r for f, r in self.tracks.masks(video, o, e.name)
                  if any(f in window_frames(w, n) for w in keep)}
        out = {}
        for w in keep:
            got = {f: frames[f] for f in window_frames(w, n) if f in frames}
            if len(got) == len(window_frames(w, n)):  # all of it, or run it again
                out[w] = got
        return out

    @staticmethod
    def _engine_windows(plans: Dict[int, _ObjectPlan]) -> Optional[Windows]:
        """The windows the engine is given; None when every object runs whole
        (no ranges, nothing kept), the call from before windows existed."""
        wins = {o: p.compute for o, p in plans.items() if p.compute}
        return None if all(w == [WHOLE] for w in wins.values()) else wins

    def job_frames(self, video: str, obj_ids: List[int], n_frames: int, engine: Optional[str] = None) -> int:
        """How many frames a job over obj_ids streams, for its progress total:
        each engine pass's window, plus the frames sent from the cache or as
        empty (absent, or in a window with no seed)."""
        e = self.get_engine(engine)
        plans = self._plan(video, e, obj_ids, n_frames)
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
        return computed + filled

    def track(self, video: str, path: str, obj_ids: List[int], video_handle: Optional[Any] = None,
              result: Optional[JobResult] = None, engine: Optional[str] = None,
              n_frames: Optional[int] = None) -> Iterator[FrameRle]:
        """Run `engine` on obj_ids and yield each frame's RLE masks. Each track
        is cached only once the whole job finishes: a cancelled job (the
        consumer stops iterating) caches nothing. The seeds hash is taken at the
        start, so seeds edited mid-job leave the track stale. `result` is filled
        in with what was tracked and what failed to save.

        The engine runs only the windows that need it. The frames it does not
        run (absent, in a window with no seed, or kept from the stale track)
        follow, merged per frame. `n_frames` is the clip's length; without it
        the session's video handle or the engine says, else the frames seen."""
        result = result if result is not None else JobResult()
        e = self.get_engine(engine)
        n = n_frames or _handle_frames(video_handle) or getattr(e, "n_frames", None)
        plans = self._plan(video, e, obj_ids, n)
        result.objects = sorted(plans)
        if not plans:
            return
        frames: Dict[int, Dict[int, Dict]] = {o: {} for o in plans}
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
                yield frame, enc
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
                elif not p.covered(f) and empty is not None:
                    fill[o] = empty
            if fill:
                for o, r in fill.items():
                    frames[o][f] = r
                yield f, fill
        elapsed = time.perf_counter() - t0
        for o, p in plans.items():
            try:
                self.tracks.save(video, o, e.name, e.model, p.hash, frames[o], elapsed,
                                 extra={"windows": [{"start": w[0], "end": w[1], "key": k} for w, k in p.windows]})
                result.tracked.append(o)
            except Exception as err:  # one object's failed save must not lose the others
                logger.exception(f"saving the track of object {o} failed")
                result.failed[o] = f"{type(err).__name__}: {err}"

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
            ious = {}
            for f in sorted(set(ma) & set(mb)):
                x, y = rle.decode(ma[f]), rle.decode(mb[f])
                union = np.logical_or(x, y).sum()
                ious[f] = 1.0 if union == 0 else float(np.logical_and(x, y).sum() / union)
            out["objects"][str(o)] = {"flagged": [f for f, v in ious.items() if v < threshold],
                                      "iou": {str(f): round(v, 4) for f, v in ious.items()},
                                      "mean_iou": round(float(np.mean(list(ious.values()))), 4) if ious else None}
        return out
