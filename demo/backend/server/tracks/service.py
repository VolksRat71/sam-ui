# sam-ui (Apache-2.0). New file, not from SAM 2.
"""TrackService: seeds, cached tracks and one engine, per video.

The interactive session calls record_points / clear_frame / remove_object as
the user clicks; a Track press calls track(), which runs only the objects that
are untracked or stale (or the ids given) and caches each finished track.
Locking is the caller's job (the backend's single inference lock).
"""
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Optional, Tuple

from tracks import rle
from tracks.engine import Engine
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


class TrackService:
    def __init__(self, root: str, engine: Engine):
        self.seeds = SeedStore(root)
        self.tracks = TrackStore(root)
        self.engine = engine
        self._keys: Dict[str, Tuple[float, int, str]] = {}

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
        """Drop one seed frame. With none left, the object's track goes too:
        a track with no seeds behind it could never be refreshed."""
        if not self.seeds.clear_frame(video, obj_id, frame):
            self.tracks.clear(video, obj_id)

    def prime_mask(self, video: str, obj_id: int, frame: int) -> Optional[Dict]:
        """The mask a first click on this frame should refine: the approved
        seed mask there, else the cached track's mask, else None."""
        seed = self.seeds.seeds(video, obj_id).get(frame)
        if seed and seed.get("mask"):
            return seed["mask"]
        return self.tracks.mask_at(video, obj_id, self.engine.name, frame)

    def remove_object(self, video: str, obj_id: int):
        self.seeds.remove_object(video, obj_id)

    def clear_video(self, video: str):
        self.seeds.clear_video(video)

    # -- state -----------------------------------------------------------------
    def object_info(self, video: str, obj_id: int) -> Dict:
        seeds = self.seeds.seeds(video, obj_id)
        e = self.engine
        meta = self.tracks.meta(video, obj_id, e.name)
        return {"object_id": obj_id,
                "state": self.tracks.state(video, obj_id, e.name, e.model, seeds_hash(seeds) if seeds else None),
                "engine": e.name, "model": e.model,
                "frames": meta["frames"] if meta else None, "n_frames": meta["n_frames"] if meta else 0,
                "seeds": seeds}

    def objects(self, video: str) -> List[Dict]:
        return [self.object_info(video, o) for o in self.seeds.objects(video)]

    def select(self, video: str, obj_ids: Optional[List[int]] = None) -> List[int]:
        """The objects a Track press runs: the ids given, else every object not
        tracked. Objects without seeds are dropped (there is nothing to track)."""
        known = [o for o in self.seeds.objects(video) if self.seeds.seeds(video, o)]
        if obj_ids is None:
            return [o for o in known if self.object_info(video, o)["state"] != TRACKED]
        return sorted({int(o) for o in obj_ids} & set(known))

    def clear_track(self, video: str, obj_id: int) -> Dict:
        self.tracks.clear(video, obj_id, self.engine.name)
        return self.object_info(video, obj_id)

    # -- jobs ------------------------------------------------------------------
    def track(self, video: str, path: str, obj_ids: List[int], video_handle: Optional[Any] = None,
              result: Optional[JobResult] = None) -> Iterator[FrameRle]:
        """Run the engine on obj_ids and yield each frame's RLE masks. Each
        track is cached only once the whole job finishes: a cancelled job
        (the consumer stops iterating) caches nothing. The seeds hash is taken
        at the start, so seeds edited mid-job leave the track stale. `result`
        is filled in with what was tracked and what failed to save."""
        result = result if result is not None else JobResult()
        seeds = {o: self.seeds.seeds(video, o) for o in obj_ids}
        seeds = {o: s for o, s in seeds.items() if s}
        result.objects = sorted(seeds)
        if not seeds:
            return
        hashes = {o: seeds_hash(s) for o, s in seeds.items()}
        frames: Dict[int, Dict[int, Dict]] = {o: {} for o in seeds}
        t0 = time.perf_counter()
        for frame, masks in self.engine.track(path, seeds, video_handle=video_handle):
            enc = {o: rle.encode(m) for o, m in masks.items()}
            for o, r in enc.items():
                frames[o][frame] = r
            yield frame, enc
        elapsed = time.perf_counter() - t0
        for o in seeds:
            try:
                self.tracks.save(video, o, self.engine.name, self.engine.model, hashes[o], frames[o], elapsed)
                result.tracked.append(o)
            except Exception as err:  # one object's failed save must not lose the others
                logger.exception(f"saving the track of object {o} failed")
                result.failed[o] = f"{type(err).__name__}: {err}"

    def cached(self, video: str, obj_ids: Optional[List[int]] = None) -> Iterator[FrameRle]:
        """Stream stored tracks, merged per frame, to repaint them after a reload.
        Stale tracks are sent too; the UI marks them."""
        ids = self.seeds.objects(video) if obj_ids is None else [int(o) for o in obj_ids]
        ids = [o for o in ids if self.seeds.seeds(video, o)]  # no seeds, nothing to show
        by_frame: Dict[int, Dict[int, Dict]] = {}
        for o in ids:
            for frame, r in self.tracks.masks(video, o, self.engine.name):
                by_frame.setdefault(frame, {})[o] = r
        for frame in sorted(by_frame):
            yield frame, by_frame[frame]
