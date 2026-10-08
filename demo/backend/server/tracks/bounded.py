# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Bounded re-tracks (issue #19): a correction re-tracks only the stretch of
frames it changes.

A correction on frame c of a stale track (a new or edited seed there) re-runs
a stretch around c and keeps the cached track beyond it. Each new mask is
compared with the cached one on its frame; they agree when their IoU is above
AGREE_IOU.

  - Forward, the pass runs through c and stops once AGREE_RUN frames in a row
    after it agree, at the window's end (an absent range, tracks/ranges.py, or
    the clip's end), or short of the next correction in the window, which
    starts a pass of its own.
  - Backward, it does not run in reverse. A full pass reaches the frames
    before c going forward, from the window's first seed, so the bounded pass
    does too: it starts LEAD frames before c, primed with the cached masks
    just before its start (Sam2Engine.track_stretch), and keeps that start
    only if its first AGREE_RUN frames agree with the cache. Otherwise the
    change reaches further back: the lead doubles and the pass starts again.
    It never starts before the window's first seed (where the engine's full
    pass starts: for SAM 2, the first that is not cleared) or the last frame
    an earlier pass in the window made. Starting at the first seed, it also
    runs back from it, as a full pass does, until AGREE_RUN frames agree.
The pass conditions on every seed of the window, as a full pass does; SAM 2
leaves out cleared seeds and blanks their frames, as its full pass does
(Sam2Engine.track_stretch, engine.strip_cleared).

A cleared seed added or edited on an engine that skips cleared seeds (SAM 2,
Engine.skips_cleared) needs no pass at all: it never conditions the model,
so a full re-track changes its frame only. That frame is blanked, every other
cached frame is kept, and the result is recorded as a bounded pass over the
one frame with "attempts": 0. A real seed that became cleared is a seed
removed from conditioning: its window re-runs whole. An
unchanged seed frame it crosses is not a stop of its own: its mask is the
seed's in both tracks, so it simply counts as an agreeing frame. Each pass
holds one object, so the MPS trap of objects first seeded on different frames
(Sam2Engine.track) never arises.

Why not run backward from c: on a synthetic clip where a look-alike crosses
the object (tests/test_bounded.py's slow test), reverse propagation from the
corrected frame followed the look-alike once the two separated and never
rejoined the cache, while the full re-track, coming forward, kept the object.

Stopping on agreement is a strong signal, not a guarantee. SAM 2 attends to
every conditioning frame of the window from every frame, so a correction moves
even distant frames a little (by up to a few percent IoU on the gallery dog
clip), which no bounded pass sees. So a track records which pass made each
frame, and the disagreement review lists the stretches bounded passes made.

When a window re-runs whole instead: the track predates seed keys (it was
made before bounded passes existed), a seed of the window was removed (the
pass would have nowhere to start) or, on SAM 2, a real seed became cleared
(or the track does not say whether it was cleared), the window's bounds
changed (a range was edited; a range that only cut a window down, taking none
of its seeds, keeps its frames and runs nothing, TrackService._cut_down), the
object was tracked and is asked for again ("re-track all"), the job asks for
a full re-track, or the engine has no track_stretch (SAM 3 today).

Provenance, in track.json:
  "passes": [{"id", "kind": "full" | "bounded" | "empty", "seeds_hash", "created", ...}]
      A full pass tracked whole windows. An empty one is no model at all:
      the frames outside every seeded window, stored empty.
      A bounded pass also has "window" [lo, hi], "start" (the corrected
      frame), "seed_key" (that seed, so the change it answers is named),
      "frames" [first, last], "attempts" (starts tried) and "stops"
      {"forward", "backward"}: "agreed", or "edge" when it ran to a bound.
  "provenance": [[first, last, pass id], ...], runs over the track's frames.
  "seed_keys": {"<frame>": key}, what the track was made from, so the next
      job can tell which seeds changed.
  "cleared_seeds": [frame, ...], which of those seeds were cleared, so the
      next job can tell a cleared seed edited from a real one cleared.
A track without them (an older sam-ui wrote it) reads as one full pass.
"""
import hashlib
import json
import time
from dataclasses import dataclass
from typing import Callable, Dict, List, Mapping, Optional

import numpy as np

from tracks import rle
from tracks.ranges import Window, in_window
from tracks.seeds import Seeds, _canon, cleared

AGREE_IOU = 0.98  # a new mask this close to the cached one agrees with it
AGREE_RUN = 10  # agreeing frames in a row that end a direction
LEAD = 2 * AGREE_RUN  # how far before the corrected frame a pass first starts
PRIME = 16  # cached frames a pass starting mid-window is primed with (SAM 2's max_obj_ptrs_in_encoder)

FULL, BOUNDED, EMPTY = "full", "bounded", "empty"
AGREED, EDGE = "agreed", "edge"


def seed_key(frame: int, seed: Dict) -> str:
    """One seed frame's clicks and approved mask, hashed as the seeds hash
    sees them (tracks/seeds.py; its format is unchanged)."""
    canon = _canon({frame: seed})
    return hashlib.sha256(json.dumps(canon, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def seed_keys(seeds: Seeds) -> Dict[str, str]:
    return {str(int(f)): seed_key(f, v) for f, v in sorted(seeds.items()) if v["points"]}


def changed_frames(old_keys: Dict[str, str], seeds: Seeds, window: Window) -> Optional[List[int]]:
    """The seed frames in `window` that are new or changed since the track
    whose seed keys are `old_keys`, in order. None when one of the window's
    old seeds is gone."""
    now = seed_keys({f: v for f, v in seeds.items() if in_window(f, window)})
    old = {f: k for f, k in old_keys.items() if in_window(int(f), window)}
    if set(old) - set(now):
        return None
    return sorted(int(f) for f, k in now.items() if old.get(f) != k)


def mask_iou(a: np.ndarray, b: np.ndarray) -> float:
    """IoU of two bool masks; two empty masks agree (1.0)."""
    union = np.logical_or(a, b).sum()
    return 1.0 if union == 0 else float(np.logical_and(a, b).sum() / union)


@dataclass
class Stretch:
    """One bounded pass of one object, conditioned on `seeds` (every seed of
    its window): forward from `start` to `hi`, then, with `reverse`, back from
    `start` to `lo` (frames inclusive). `corrected` is the frame it answers.
    `cached` ({frame: rle}, the track as this job has it so far) primes a
    start that is not a seed frame, never from before `floor` (the window's
    first frame)."""

    obj_id: int
    seeds: Seeds
    start: int
    lo: int
    hi: int
    corrected: Optional[int] = None
    reverse: bool = False
    cached: Optional[Mapping[int, Dict]] = None
    floor: int = 0

    def __post_init__(self):
        if self.corrected is None:
            self.corrected = self.start


class Agreement:
    """The early stop of a bounded pass, called with each frame it makes.

    Forward from the corrected frame on, and on the way back, it answers True
    once `run` frames in a row agreed with the cached track (`cached`: {frame:
    rle}). With `check`, the first `check` frames of the pass (its lead-in)
    must all agree: the first that does not ends the pass as `failed`."""

    def __init__(self, cached: Mapping[int, Dict], start: int = 0, corrected: int = 0, check: int = 0,
                 iou: float = AGREE_IOU, run: int = AGREE_RUN):
        self.cached, self.iou, self.run = cached, iou, run
        self.start, self.corrected, self.check = start, corrected, check
        self.streak = {False: 0, True: 0}
        self.agreed = {False: False, True: False}
        self.failed = False
        self.ious: Dict[int, float] = {}

    def __call__(self, frame: int, reverse: bool, mask: np.ndarray) -> bool:
        old = self.cached.get(frame)
        v = 0.0 if old is None else mask_iou(mask, rle.decode(old))
        self.ious[frame] = v
        agrees = v > self.iou
        if not reverse and frame < self.corrected:  # the lead-in
            if frame < self.start + self.check and not agrees:
                self.failed = True
                return True
            return False
        self.streak[reverse] = self.streak[reverse] + 1 if agrees else 0
        if self.streak[reverse] >= self.run:
            self.agreed[reverse] = True
        return self.agreed[reverse]


# -- provenance -----------------------------------------------------------------------

def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def passes(meta: Optional[Dict]) -> List[Dict]:
    """The track's passes; a track from before provenance is one full pass."""
    if not meta:
        return []
    if meta.get("passes") is not None:
        return list(meta["passes"])
    return [{"id": 0, "kind": FULL, "seeds_hash": meta.get("seeds_hash"), "created": meta.get("created"),
             "legacy": True}]


def frame_passes(meta: Optional[Dict]) -> Dict[int, int]:
    """{frame: id of the pass that made it} over the track's frames."""
    if not meta:
        return {}
    if meta.get("provenance") is not None:
        return {f: p for a, b, p in meta["provenance"] for f in range(a, b + 1)}
    span = meta.get("frames")
    return {} if not span else {f: 0 for f in range(span[0], span[1] + 1)}


def runs(by_frame: Dict[int, int]) -> List[List[int]]:
    """{frame: pass} as [[first, last, pass]] runs of consecutive frames."""
    out: List[List[int]] = []
    for f in sorted(by_frame):
        p = by_frame[f]
        if out and out[-1][2] == p and out[-1][1] == f - 1:
            out[-1][1] = f
        else:
            out.append([f, f, p])
    return out


class Provenance:
    """A job's bookkeeping for one object: the old track's passes, the passes
    this job adds, and which one made each frame."""

    def __init__(self, old_meta: Optional[Dict]):
        self.passes = {p["id"]: p for p in passes(old_meta)}
        self.old = frame_passes(old_meta)
        self.by_frame: Dict[int, int] = {}
        self._next = 1 + max(self.passes, default=-1)
        self._full: Optional[int] = None
        self._empty: Optional[int] = None

    def _add(self, record: Dict) -> int:
        pid, self._next = self._next, self._next + 1
        self.passes[pid] = {"id": pid, **record, "created": _now()}
        return pid

    def full(self, seeds_hash: str) -> int:
        """This job's full pass (one per job): the windows tracked whole."""
        if self._full is None:
            self._full = self._add({"kind": FULL, "seeds_hash": seeds_hash})
        return self._full

    def empty(self, frame: int, seeds_hash: str) -> None:
        """A frame outside every seeded window, stored empty: it keeps the old
        track's empty pass when it had one, else joins this job's."""
        old = self.passes.get(self.old.get(frame))
        if old is not None and old["kind"] == EMPTY:
            self.by_frame[frame] = old["id"]
            return
        if self._empty is None:
            self._empty = self._add({"kind": EMPTY, "seeds_hash": seeds_hash})
        self.by_frame[frame] = self._empty

    def bounded(self, seeds_hash: str, window: Window, corrected: int, seed: Dict) -> int:
        return self._add({"kind": BOUNDED, "seeds_hash": seeds_hash, "window": [window[0], window[1]],
                          "start": corrected, "seed_key": seed_key(corrected, seed)})

    def finish(self, pid: int, frames: List[int], forward_agreed: bool, backward_agreed: bool,
               attempts: int) -> None:
        self.passes[pid].update({"frames": [min(frames), max(frames)] if frames else None, "attempts": attempts,
                                 "stops": {"forward": AGREED if forward_agreed else EDGE,
                                           "backward": AGREED if backward_agreed else EDGE}})

    def made(self, frame: int, pid: int) -> None:
        self.by_frame[frame] = pid

    def kept(self, frame: int) -> None:
        """A frame taken from the old track keeps the pass that made it."""
        if frame in self.old:
            self.by_frame[frame] = self.old[frame]

    def extra(self, seeds: Seeds) -> Dict:
        used = set(self.by_frame.values())
        return {"passes": [p for i, p in sorted(self.passes.items()) if i in used],
                "provenance": runs(self.by_frame), "seed_keys": seed_keys(seeds),
                "cleared_seeds": sorted(int(f) for f, v in seeds.items() if cleared(v))}


def spans(meta: Optional[Dict]) -> List[List[int]]:
    """The [first, last] stretches of a track that bounded passes made."""
    kinds = {p["id"]: p["kind"] for p in passes(meta)}
    return [[a, b] for a, b, p in (meta or {}).get("provenance") or [] if kinds.get(p) == BOUNDED]


StopFn = Callable[[int, bool, np.ndarray], bool]
