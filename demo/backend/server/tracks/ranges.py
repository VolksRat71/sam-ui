# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Frame ranges on an object's timeline (issues #20 and draft 5).

A range is {"start", "end", "state"}, frames inclusive. Every frame of an
object is in one of four kinds:

  unknown    no range: nobody has said anything about it;
  candidate  a model or tool thinks the object is there and nobody has
             confirmed it (a later discovery job writes these). It carries
             where it came from: "source" (e.g. "text:dog@sam3") and an
             optional "score" in 0-1;
  present    confirmed by the user: the object is there;
  absent     confirmed by the user: the object is not in the shot (it left
             the frame, went behind something, or is gone after a cut).

Only absent changes tracking. An absent range:
  - empties its frames: they are never tracked, shown or exported;
  - splits the object's timeline into windows, the frames between ranges.
    Each window is tracked on its own, from the seeds inside it only, so
    nothing the tracker saw before a gap carries into the frames after it.
    A window with no seed is not tracked and stays empty.
Seeds inside an absent range are kept (unmarking the range brings them back)
but play no part in tracking while it stands.

Present and candidate ranges are annotations: they never change a mask or a
window, and stay out of the seeds hash (tracks/seeds.py stores them apart), so
marking or discovering one never makes a track stale.

The states are layers, shown in precedence order: absent over present over
candidate (view()). A confirmed range overrides a candidate under it without
deleting it, so undoing a "confirm absent" shows the candidate again; marking
present clears absent there (seeds.py), so the two confirmed states never
overlap where the user paints them.
"""
import math
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

ABSENT = "absent"
PRESENT = "present"
CANDIDATE = "candidate"
STATES = (ABSENT, PRESENT, CANDIDATE)
CONFIRMED = (ABSENT, PRESENT)
SOURCE_MAX = 128

Range = Dict  # {"start": int, "end": int, "state": str} (+ "source", "score" on a candidate)
Window = Tuple[int, Optional[int]]  # [lo, hi] inclusive; hi None runs to the clip's end


def _int(v, what: str) -> int:
    if isinstance(v, bool) or not isinstance(v, int):
        if isinstance(v, float) and v.is_integer():
            return int(v)
        raise ValueError(f"range {what} must be a whole frame number, got {v!r}")
    return v


def _check(start, end, state) -> Tuple[int, int, str]:
    start, end = _int(start, "start"), _int(end, "end")
    if start < 0 or end < start:
        raise ValueError(f"range {start}-{end}: frames run from 0, and the end may not come before the start")
    if state not in STATES:
        raise ValueError(f"range state must be one of {list(STATES)}, got {state!r}")
    return start, end, state


def _provenance(r: Dict, state: str) -> Tuple[Optional[str], Optional[float]]:
    """A candidate's (source, score); (None, None) for a confirmed range,
    which may carry neither (it is the user's word, not a model's)."""
    source, score = r.get("source"), r.get("score")
    if state != CANDIDATE:
        if source is not None or score is not None:
            raise ValueError(f"a {state} range is the user's: it takes no source or score")
        return None, None
    if not isinstance(source, str) or not source.strip() or len(source.strip()) > SOURCE_MAX:
        raise ValueError(f"a candidate range needs a source (1-{SOURCE_MAX} characters, e.g. \"text:dog@sam3\")")
    if score is not None:
        if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score) \
                or not 0 <= score <= 1:
            raise ValueError(f"a candidate's score must be a number from 0 to 1, got {score!r}")
        score = float(score)
    return source.strip(), score


def _range(s: int, e: int, st: str, source: Optional[str], score: Optional[float]) -> Range:
    out: Range = {"start": s, "end": e, "state": st}
    if source is not None:
        out["source"] = source
    if score is not None:
        out["score"] = score
    return out


def normalize(ranges: Iterable[Dict]) -> List[Range]:
    """Validated, sorted, and with ranges of one state (and, for candidates,
    one source and score) that overlap or touch merged into one. Ranges of
    different states may overlap: they are layers (view() resolves them)."""
    groups: Dict[Tuple, List[Tuple[int, int]]] = {}
    for r in ranges:
        s, e, st = _check(r["start"], r["end"], r["state"])
        source, score = _provenance(r, st)
        groups.setdefault((st, source, score), []).append((s, e))
    out = []
    for (st, source, score), spans in groups.items():
        merged: List[List[int]] = []
        for s, e in sorted(spans):
            if merged and s <= merged[-1][1] + 1:
                merged[-1][1] = max(merged[-1][1], e)
            else:
                merged.append([s, e])
        out += [_range(s, e, st, source, score) for s, e in merged]
    return sorted(out, key=lambda r: (r["start"], r["end"], r["state"], r.get("source") or "", r.get("score") or 0))


def paint(ranges: Iterable[Dict], start: int, end: int, state: Optional[str], source: Optional[str] = None,
          score: Optional[float] = None, over: Optional[Sequence[str]] = None) -> List[Range]:
    """Frames start-end set to `state` (a candidate with its source and
    score), whatever they were before; None clears them, so unmarking the
    middle of a range splits it in two. `over` limits what is replaced to
    ranges of those states (one layer); by default every state is."""
    start, end, _ = _check(start, end, state if state is not None else ABSENT)
    if state is None and (source is not None or score is not None):
        raise ValueError("clearing frames takes no source or score")
    over = STATES if over is None else tuple(over)
    for st in over:
        if st not in STATES:
            raise ValueError(f"range state must be one of {list(STATES)}, got {st!r}")
    new = [_range(start, end, state, *_provenance({"source": source, "score": score}, state))] \
        if state is not None else []
    out = []
    for r in normalize(ranges):
        if r["state"] not in over or r["end"] < start or r["start"] > end:
            out.append(r)
            continue
        if r["start"] < start:
            out.append({**r, "end": start - 1})
        if r["end"] > end:
            out.append({**r, "start": end + 1})
    return normalize(out + new)


def clip(ranges: Iterable[Dict], by: Iterable[Dict]) -> List[Range]:
    """`ranges` less every frame a range of `by` covers."""
    out = normalize(ranges)
    for b in normalize(by):
        out = paint(out, b["start"], b["end"], None)
    return out


def view(absent: Iterable[Dict], annotations: Iterable[Dict]) -> List[Range]:
    """What the timeline shows: one state per frame, absent over present over
    candidate. Frames in no range are unknown."""
    absent = [r for r in normalize(absent) if r["state"] == ABSENT]
    notes = normalize(annotations)
    present = clip([r for r in notes if r["state"] == PRESENT], absent)
    candidates = clip([r for r in notes if r["state"] == CANDIDATE], absent + present)
    return normalize(absent + present + candidates)


def state_at(ranges: Iterable[Dict], frame: int) -> Optional[str]:
    """The state of `frame` in a view(); None is unknown."""
    return next((r["state"] for r in ranges if r["start"] <= frame <= r["end"]), None)


def absent_at(ranges: Iterable[Dict], frame: int) -> bool:
    return any(r["state"] == ABSENT and r["start"] <= frame <= r["end"] for r in ranges)


def windows(ranges: Iterable[Dict]) -> List[Window]:
    """The frames between absent ranges, in order."""
    out, lo = [], 0
    for r in normalize(r for r in ranges if r["state"] == ABSENT):
        if r["start"] > lo:
            out.append((lo, r["start"] - 1))
        lo = r["end"] + 1
    out.append((lo, None))
    return out


def in_window(frame: int, w: Window) -> bool:
    return w[0] <= frame and (w[1] is None or frame <= w[1])


def window_frames(w: Window, n_frames: int) -> range:
    return range(w[0], n_frames if w[1] is None else min(w[1] + 1, n_frames))


def seeded_windows(seeds: Dict[int, Dict], ranges: Iterable[Dict]) -> List[Tuple[Window, Dict[int, Dict]]]:
    """The windows that hold at least one seed with points, each with only its
    own seeds. Seeds inside an absent range belong to no window.

    A cleared seed ('not on this frame': no positive, empty mask) does not
    open a window: a window whose only seeds are cleared is not tracked and
    stays empty. Inside a window opened by another seed it is kept, so the
    window's key changes with it; SAM 2 strips it from conditioning and blanks
    its frame (tracks/engine.py strip_cleared), SAM 3 conditions on it."""
    from tracks.seeds import cleared  # seeds imports this module

    out = []
    for w in windows(ranges):
        mine = {f: v for f, v in seeds.items() if v["points"] and in_window(f, w)}
        if any(not cleared(v) for v in mine.values()):
            out.append((w, mine))
    return out
