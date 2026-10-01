# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Temporal text discovery (draft 4), EXPERIMENTAL: find WHEN the thing a
phrase names is in the clip, as candidate ranges (draft 5), never as seeds.

The text primitive (tracks/text.py) runs SAM 3's detector on one frame. This
runs it on a few frames and nothing else, with no tracker anywhere:

1. sample_frames(): every `stride`-th frame, and the last one;
2. group(): consecutive hits form an appearance, and one missed sample inside
   one is taken for the detector blinking, not the object leaving. Two or
   more misses in a row end it, so an object that leaves and comes back is
   two appearances: nothing carries anything across the gap;
3. bisect(): each appearance's entry is tightened between the miss before it
   and its first hit, and its exit between its last hit and the miss after
   it, halving until hit and miss are at most `tol` frames apart. The
   boundary is the hit side, so it is at most tol - 1 frames inside the true
   one (the detector permitting);
4. each appearance becomes a candidate {"start", "end", "source", "score"}:
   source "text:<prompt>@<engine>", score the mean of its hits' scores. Its
   best hit (frame, score, box) comes back as a suggested seed, unstored.

What it gets wrong by design: an absence shorter than about 2 * stride frames
is bridged by step 2, and one shorter than stride can fall between samples.
Appearances that only blink into a single sample are kept (score says how
sure). Bisection assumes the detector is steady between a hit and a miss.

scan() is the whole plan as a generator that yields the frames to probe and is
sent what the detector found, so the order of calls is pure and tested;
drive() feeds it a detector one call at a time, so a caller can take the
model lock per call (as track jobs take it per frame, issue #19) and cancel
between calls.
"""
import contextlib
import time
from dataclasses import dataclass
from typing import Callable, ContextManager, Dict, Generator, List, Optional, Sequence, Tuple

DEFAULT_STRIDE = 12
DEFAULT_TOL = 2
GAP = 1  # missed samples an appearance may hold
SOURCE_PREFIX = "text:"


class Canceled(Exception):
    pass


@dataclass
class Probe:
    """What the detector found on one frame: whether the phrase matched (the
    best instance reached the threshold), the best score, and its box."""

    hit: bool
    score: float
    box: Optional[List[float]] = None


def sample_frames(n_frames: int, stride: int) -> List[int]:
    """Every stride-th frame from 0, and the last frame, so the tail is seen."""
    if n_frames <= 0:
        return []
    stride = max(1, int(stride))
    out = list(range(0, n_frames, stride))
    if out[-1] != n_frames - 1:
        out.append(n_frames - 1)
    return out


def group(hits: Sequence[bool], gap: int = GAP) -> List[Tuple[int, int]]:
    """[first, last] sample indices of each run of hits, where a run may hold
    up to `gap` misses in a row; more end it."""
    out: List[Tuple[int, int]] = []
    first = last = None
    for i, hit in enumerate(hits):
        if not hit:
            continue
        if last is not None and i - last - 1 <= gap:
            last = i
            continue
        if first is not None:
            out.append((first, last))
        first = last = i
    if first is not None:
        out.append((first, last))
    return out


def bisect(miss: int, hit: int, tol: int = DEFAULT_TOL) -> Generator[int, bool, int]:
    """Yield frames between a miss and a hit (either order) to probe, each
    sent back as hit or not, halving until they are at most `tol` apart.
    Returns the hit side: the first frame of an entry, the last of an exit."""
    tol = max(1, int(tol))
    while abs(hit - miss) > tol:
        mid = (miss + hit) // 2
        if (yield mid):
            hit = mid
        else:
            miss = mid
    return hit


def scan(n_frames: int, stride: int = DEFAULT_STRIDE, tol: int = DEFAULT_TOL,
         gap: int = GAP) -> Generator[int, Probe, List[Dict]]:
    """The discovery plan: yields each frame to probe (never one twice) and is
    sent its Probe. Returns the appearances, in frame order, each
    {"start", "end", "score", "hits", "best": {"frame", "score", "box"}}."""
    seen: Dict[int, Probe] = {}

    def probe(f: int):
        if f not in seen:
            seen[f] = yield f
        return seen[f]

    samples = sample_frames(n_frames, stride)
    for f in samples:
        yield from probe(f)
    runs = group([seen[f].hit for f in samples], gap)
    out = []
    for i, j in runs:
        start, end = samples[i], samples[j]
        if i > 0:  # tighten the entry: between the miss before and the first hit
            b = bisect(samples[i - 1], start, tol)
            try:
                f = next(b)
                while True:
                    p = yield from probe(f)
                    f = b.send(p.hit)
            except StopIteration as stop:
                start = stop.value
        if j < len(samples) - 1:  # and the exit: between the last hit and the miss after
            b = bisect(samples[j + 1], end, tol)
            try:
                f = next(b)
                while True:
                    p = yield from probe(f)
                    f = b.send(p.hit)
            except StopIteration as stop:
                end = stop.value
        hits = sorted(f for f, p in seen.items() if p.hit and start <= f <= end)
        best = max(hits, key=lambda f: seen[f].score)
        out.append({"start": start, "end": end,
                    "score": round(sum(seen[f].score for f in hits) / len(hits), 4), "hits": len(hits),
                    "best": {"frame": best, "score": round(float(seen[best].score), 4), "box": seen[best].box}})
    return out


def drive(plan: Generator[int, Probe, List[Dict]], detect: Callable[[int], Probe],
          step: Callable[[], ContextManager] = contextlib.nullcontext,
          canceled: Callable[[], bool] = lambda: False, handoff_s: float = 0.0) -> Tuple[List[Dict], int]:
    """Run a plan with `detect`, one call per `step()` (the model lock), and
    check `canceled` before each (Canceled). Returns (appearances, calls)."""
    calls = 0
    try:
        f = next(plan)
        while True:
            if canceled():
                plan.close()
                raise Canceled()
            with step():
                p = detect(f)
            calls += 1
            if handoff_s:
                time.sleep(handoff_s)  # threading.Lock is unfair: let a waiting click in
            f = plan.send(p)
    except StopIteration as stop:
        return stop.value, calls


def source(text: str, engine: str, limit: int = 128) -> str:
    """A candidate's source, "text:<prompt>@<engine>", the prompt cut to fit."""
    tail = f"@{engine}"
    return SOURCE_PREFIX + text[:max(1, limit - len(SOURCE_PREFIX) - len(tail))] + tail
