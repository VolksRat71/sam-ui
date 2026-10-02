# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Frame ranges on an object's timeline (issue #20).

A range is {"start", "end", "state"}, frames inclusive. The only state today
is "absent": the object is not in the shot there (it left the frame, went
behind something, or is gone after a cut). The state is a field, not a flag,
so later kinds of range (a discovered but unconfirmed one, a shot cut that
splits the track without emptying frames) join the same list.

An absent range:
  - empties its frames: they are never tracked, shown or exported;
  - splits the object's timeline into windows, the frames between ranges.
    Each window is tracked on its own, from the seeds inside it only, so
    nothing the tracker saw before a gap carries into the frames after it.
    A window with no seed is not tracked and stays empty.
Seeds inside an absent range are kept (unmarking the range brings them back)
but play no part in tracking while it stands.
"""
from typing import Dict, Iterable, List, Optional, Tuple

from tracks.text import has_prompt

ABSENT = "absent"
STATES = (ABSENT,)

Range = Dict  # {"start": int, "end": int, "state": str}
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


def normalize(ranges: Iterable[Dict]) -> List[Range]:
    """Validated, sorted, and with ranges of one state that overlap or touch
    merged into one."""
    spans = sorted(_check(r["start"], r["end"], r["state"]) for r in ranges)
    out: List[List] = []
    for s, e, st in spans:
        if out and out[-1][2] == st and s <= out[-1][1] + 1:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e, st])
    return [{"start": s, "end": e, "state": st} for s, e, st in out]


def paint(ranges: Iterable[Dict], start: int, end: int, state: Optional[str]) -> List[Range]:
    """Frames start-end set to `state`, whatever they were before; None
    clears them, so unmarking the middle of a range splits it in two."""
    start, end, _ = _check(start, end, state if state is not None else ABSENT)
    out = []
    for r in normalize(ranges):
        if r["end"] < start or r["start"] > end:
            out.append(r)
            continue
        if r["start"] < start:
            out.append({**r, "end": start - 1})
        if r["end"] > end:
            out.append({**r, "start": end + 1})
    if state is not None:
        out.append({"start": start, "end": end, "state": state})
    return normalize(out)


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
    """The windows that hold at least one seed (clicks or text), each with
    only its own seeds. Seeds inside an absent range belong to no window.

    A cleared seed ('not on this frame': no positive, empty mask) does not
    open a window: a window whose only seeds are cleared is not tracked and
    stays empty. Inside a window opened by another seed it is kept, so the
    window's key changes with it; SAM 2 strips it from conditioning and blanks
    its frame (tracks/engine.py strip_cleared), SAM 3 conditions on it. A text
    seed is never cleared: its mask is the positive."""
    from tracks.seeds import cleared  # seeds imports this module

    out = []
    for w in windows(ranges):
        mine = {f: v for f, v in seeds.items() if has_prompt(v) and in_window(f, w)}
        if any(not cleared(v) for v in mine.values()):
            out.append((w, mine))
    return out
