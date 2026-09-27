# sam-ui (Apache-2.0). New file, not from SAM 2.
"""TrackService: seeds, cached tracks and the engines that make them, per video.

The interactive session calls record_points / clear_frame / remove_object as
the user clicks; a Track press calls track(), which runs only the objects that
are untracked or stale for the chosen engine (or the ids given) and caches each
finished track under that engine. The default engine (SAM 2) also serves the
interactive clicks; others (SAM 3) are registered by spec and built on first
use. Locking is the caller's job (the backend's single inference lock).
"""
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

import numpy as np

from tracks import rle
from tracks.engine import Engine
from tracks.jobs import TRACKING, JobRegistry
from tracks.seeds import SeedStore, seeds_hash, video_key
from tracks.store import TRACKED, TrackStore

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


class UnknownEngine(ValueError):
    pass


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
            out.append({"name": name, "model": self._engine_model(name)[1], "default": name == self.default,
                        "available": why is None, "reason": why, "loaded": name in self._engines})
        return out

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

    def prime_mask(self, video: str, obj_id: int, frame: int) -> Optional[Dict]:
        """The mask a first click on this frame should refine: the approved
        seed mask there, else the default engine's cached mask, else None."""
        seed = self.seeds.seeds(video, obj_id).get(frame)
        if seed and seed.get("mask"):
            return seed["mask"]
        # only a current track: a stale one follows old seeds, and refining it
        # would save the wrong region as this frame's approved mask
        if self.object_info(video, obj_id)["state"] != TRACKED:
            return None
        return self.tracks.mask_at(video, obj_id, self.default, frame)

    def remove_object(self, video: str, obj_id: int):
        self.seeds.remove_object(video, obj_id)

    def rename_object(self, video: str, obj_id: int, name: Optional[str]) -> Optional[str]:
        """Metadata only: the seeds, their hash and every track stay as they are."""
        return self.seeds.set_name(video, obj_id, name)

    def object_names(self, video: str) -> Dict[int, str]:
        return self.seeds.names(video)

    def clear_video(self, video: str):
        self.seeds.clear_video(video)

    # -- state -----------------------------------------------------------------
    def _track_state(self, video: str, obj_id: int, name: str, seeds) -> Dict:
        name, model = self._engine_model(name)
        meta = self.tracks.meta(video, obj_id, name)
        state = self.tracks.state(video, obj_id, name, model, seeds_hash(seeds) if seeds else None)
        if obj_id in self.jobs.held(video, name):
            state = TRACKING
        return {"engine": name, "model": model, "state": state,
                "frames": meta["frames"] if meta else None, "n_frames": meta["n_frames"] if meta else 0}

    def object_info(self, video: str, obj_id: int, engine: Optional[str] = None) -> Dict:
        """The object's seeds and its track state for `engine` (default SAM 2),
        plus every engine's state under "tracks"."""
        seeds = self.seeds.seeds(video, obj_id)
        tracks = {n: self._track_state(video, obj_id, n, seeds) for n in self.engine_names()}
        main = tracks[self._engine_model(engine or self.default)[0]]
        return {"object_id": obj_id, **main, "seeds": seeds, "tracks": list(tracks.values())}

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
    def passes(self, video: str, obj_ids: List[int], engine: Optional[str] = None) -> int:
        """How many times a job over obj_ids runs through the clip (an engine
        may split one job into several passes), for its progress total."""
        f = getattr(self.get_engine(engine), "passes", None)
        if f is None:
            return 1
        seeds = {o: self.seeds.seeds(video, o) for o in obj_ids}
        return f({o: s for o, s in seeds.items() if s})

    def track(self, video: str, path: str, obj_ids: List[int], video_handle: Optional[Any] = None,
              result: Optional[JobResult] = None, engine: Optional[str] = None) -> Iterator[FrameRle]:
        """Run `engine` on obj_ids and yield each frame's RLE masks. Each track
        is cached only once the whole job finishes: a cancelled job (the
        consumer stops iterating) caches nothing. The seeds hash is taken at the
        start, so seeds edited mid-job leave the track stale. `result` is filled
        in with what was tracked and what failed to save."""
        result = result if result is not None else JobResult()
        seeds = {o: self.seeds.seeds(video, o) for o in obj_ids}
        seeds = {o: s for o, s in seeds.items() if s}
        result.objects = sorted(seeds)
        if not seeds:
            return
        e = self.get_engine(engine)
        hashes = {o: seeds_hash(s) for o, s in seeds.items()}
        frames: Dict[int, Dict[int, Dict]] = {o: {} for o in seeds}
        t0 = time.perf_counter()
        for frame, masks in e.track(path, seeds, video_handle=video_handle):
            enc = {o: rle.encode(m) for o, m in masks.items()}
            for o, r in enc.items():
                frames[o][frame] = r
            yield frame, enc
        elapsed = time.perf_counter() - t0
        for o in seeds:
            try:
                self.tracks.save(video, o, e.name, e.model, hashes[o], frames[o], elapsed)
                result.tracked.append(o)
            except Exception as err:  # one object's failed save must not lose the others
                logger.exception(f"saving the track of object {o} failed")
                result.failed[o] = f"{type(err).__name__}: {err}"

    def cached(self, video: str, obj_ids: Optional[List[int]] = None,
               engine: Optional[str] = None) -> Iterator[FrameRle]:
        """Stream stored tracks, merged per frame, to repaint them after a reload.
        Stale tracks are sent too; the UI marks them."""
        name = self._engine_model(engine or self.default)[0]
        ids = self.seeds.objects(video) if obj_ids is None else [int(o) for o in obj_ids]
        ids = [o for o in ids if self.seeds.seeds(video, o)]  # no seeds, nothing to show
        by_frame: Dict[int, Dict[int, Dict]] = {}
        for o in ids:
            for frame, r in self.tracks.masks(video, o, name):
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
