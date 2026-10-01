# sam-ui (Apache-2.0). New file, not from SAM 2.
"""What a person marked reviewed in the audit queue (draft 7, tracks/audit.py).

Layout: <root>/<video_key>/<obj_id>/review.json, holding {"marks": [mark]}.
Like annotations.json it stays out of the seeds hash and the seed record:
saying "looks right" never makes a track stale and is not a seed change to
undo. Removing the object removes it with the rest of its directory.

A mark is {"frame", "span": [first, last], "engine", "at", "seeds_hash",
"pass": {"id", "created"} | None, "mask", "reasons": [kind]}: the frame the
person looked at, the stretch of the location it reviewed, which engine's
track it was, the object's seeds hash then, the pass that made that frame
(tracks/bounded.py provenance; a track from before provenance reads as one
legacy pass) and a fingerprint of the mask itself.

A mark stays valid only while the track still holds what was reviewed: the
same pass made that frame (when the mark and the track both say), and the
mask there is the same. So a correction that re-tracks a stretch (#19)
invalidates the marks in that stretch and no others, a full re-track
invalidates them all, and an undo that brings an earlier track back (#18)
brings its marks back too. Invalid marks are kept for that reason, up to
KEEP per object, oldest dropped first.
"""
import hashlib
import json
import os
import time
from pathlib import Path
from typing import Dict, List, Optional, Sequence

KEEP = 500


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


def valid(mark: Dict, engine: str, pass_now: Optional[Dict], mask_now: Optional[str]) -> bool:
    """Whether `mark` still holds for `engine`'s track, whose frame there was
    made by `pass_now` ({"id", "created"}) and holds a mask whose fingerprint
    is `mask_now` (None: no track there)."""
    if mark.get("engine") != engine or mask_now is None:
        return False
    then = mark.get("pass")
    if then is not None and pass_now is not None and (then.get("id"), then.get("created")) != \
            (pass_now.get("id"), pass_now.get("created")):
        return False
    return mark.get("mask") is None or mark["mask"] == mask_now


def covers(mark: Dict, start: int, end: int) -> bool:
    """Whether the mark reviewed a location covering frames start-end."""
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

    def mark(self, video: str, obj_id: int, frame: int, engine: str, *, span: Optional[Sequence[int]],
             seeds_hash: Optional[str], pass_now: Optional[Dict], mask: str, reasons: Sequence[str] = ()) -> Dict:
        """Mark `frame` reviewed on `engine`, replacing any mark there."""
        span = [int(span[0]), int(span[1])] if span is not None else [int(frame), int(frame)]
        m = {"frame": int(frame), "span": [min(span), max(span)], "engine": engine,
             "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "seeds_hash": seeds_hash, "pass": pass_now, "mask": mask,
             "reasons": list(reasons)}
        rest = [x for x in self.marks(video, obj_id) if not (x["engine"] == engine and x["frame"] == m["frame"])]
        self._write(video, obj_id, rest + [m])
        return m

    def unmark(self, video: str, obj_id: int, engine: str, start: int, end: int) -> int:
        """Drop `engine`'s marks reviewing anything in frames start-end; how many went."""
        marks = self.marks(video, obj_id)
        keep = [m for m in marks if not (m["engine"] == engine and covers(m, start, end))]
        self._write(video, obj_id, keep)
        return len(marks) - len(keep)
