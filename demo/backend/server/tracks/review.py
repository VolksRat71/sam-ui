# sam-ui (Apache-2.0). New file, not from SAM 2.
"""What a person marked reviewed in the audit queue (draft 7, tracks/audit.py).

Layout: <root>/<video_key>/<obj_id>/review.json, holding {"marks": [mark]}.
Like annotations.json it stays out of the seeds hash and the seed record:
saying "looks right" never makes a track stale and is not a seed change to
undo. Removing the object removes it with the rest of its directory.

A mark is {"frame", "span": [first, last], "engine", "at", "seeds_hash",
"pass": {"id", "created"} | None, "passes": [[id, created]], "mask",
"span_mask", "reasons": [kind]}: the frame the person looked at, the stretch
of the location it reviewed, which engine's track it was, the object's seeds
hash then, the pass that made that frame and every pass that made a frame of
the span (tracks/bounded.py provenance; a track from before provenance reads
as one legacy pass), a fingerprint of the frame's mask and a digest of the
whole span's masks.

A mark stays valid only while the track still holds what was reviewed: the
same passes made its span (when the mark and the track both say), and the
masks there are the same, every one of them. So a correction that re-tracks
a stretch (#19) invalidates the marks it reaches and no others, a full
re-track invalidates them all, and an undo that brings an earlier track back
(#18) brings its marks back too. Invalid marks are kept for that reason, up
to KEEP per object, oldest dropped first.

A valid mark reviews a queue location whose peak frame lies in its span: the
peak may move a little as the queue is ranked again, but a location peaking
somewhere nobody looked is never reviewed by a neighbour's mark.
"""
import hashlib
import json
import os
import time
from pathlib import Path
from typing import Dict, List, Optional, Sequence

KEEP = 500
EMPTY = "empty"  # the fingerprint of a frame the track holds no mask for


def fingerprint(rle: Dict) -> str:
    """A short hash of one frame's mask, as stored."""
    raw = f"{rle['size'][0]}x{rle['size'][1]}:{rle['counts']}"
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def _mark_ok(m) -> bool:
    if not isinstance(m, dict) or isinstance(m.get("frame"), bool) or not isinstance(m.get("frame"), int):
        return False
    span = m.get("span")
    return isinstance(m.get("engine"), str) and (
        span is None or (isinstance(span, list) and len(span) == 2 and all(isinstance(x, int) for x in span)))


def digest(fingerprints: Sequence[str]) -> str:
    """One hash of a stretch's masks, from their fingerprints in frame order."""
    return hashlib.sha1("|".join(fingerprints).encode()).hexdigest()[:16]


def valid(mark: Dict, engine: str, now: Optional[Dict]) -> bool:
    """Whether `mark` still holds for `engine`'s track, which looks like `now`
    over the mark's frame and span ({"pass", "passes", "mask", "span_mask"},
    as a mark records them; None: no track there). A field either side lacks
    (an older mark, a track from before provenance) is not compared."""
    if mark.get("engine") != engine or now is None or mark.get("mask") is None:
        return False
    for key in ("mask", "span_mask", "pass", "passes"):
        if mark.get(key) is not None and now.get(key) is not None and mark[key] != now[key]:
            return False
    return True


def reviews(mark: Dict, loc: Dict) -> bool:
    """Whether a valid mark reviews the location: its peak lies in the mark's span."""
    a, b = mark.get("span") or [mark["frame"], mark["frame"]]
    return a <= loc["frame"] <= b


def covers(mark: Dict, start: int, end: int) -> bool:
    """Whether the mark's span touches frames start-end (what unmarking them drops)."""
    a, b = mark.get("span") or [mark["frame"], mark["frame"]]
    return a <= end and start <= b


class ReviewStore:
    def __init__(self, root: str):
        self.root = Path(root)

    def _path(self, video: str, obj_id: int) -> Path:
        return self.root / video / str(int(obj_id)) / "review.json"

    def marks(self, video: str, obj_id: int) -> List[Dict]:
        """The object's marks, oldest first; a damaged or foreign file reads as none."""
        try:
            raw = json.loads(self._path(video, obj_id).read_text())
        except (OSError, ValueError):
            return []
        marks = raw.get("marks") if isinstance(raw, dict) else None
        return [m for m in marks if _mark_ok(m)] if isinstance(marks, list) else []

    def _write(self, video: str, obj_id: int, marks: List[Dict]) -> None:
        p = self._path(video, obj_id)
        if not marks:
            p.unlink(missing_ok=True)
            return
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(json.dumps({"marks": marks[-KEEP:]}, indent=1))
        os.replace(tmp, p)

    def mark(self, video: str, obj_id: int, frame: int, engine: str, *, span: Sequence[int],
             seeds_hash: Optional[str], now: Dict, reasons: Sequence[str] = ()) -> Dict:
        """Mark `frame` reviewed on `engine` over `span`, replacing any mark
        there. `now` is what the track holds there (valid()'s fields)."""
        m = {"frame": int(frame), "span": [int(span[0]), int(span[1])], "engine": engine,
             "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "seeds_hash": seeds_hash,
             **{k: now.get(k) for k in ("pass", "passes", "mask", "span_mask")}, "reasons": list(reasons)}
        rest = [x for x in self.marks(video, obj_id) if not (x["engine"] == engine and x["frame"] == m["frame"])]
        self._write(video, obj_id, rest + [m])
        return m

    def unmark(self, video: str, obj_id: int, engine: str, start: int, end: int) -> int:
        """Drop `engine`'s marks reviewing anything in frames start-end; how many went."""
        marks = self.marks(video, obj_id)
        keep = [m for m in marks if not (m["engine"] == engine and covers(m, start, end))]
        self._write(video, obj_id, keep)
        return len(marks) - len(keep)
