# sam-ui (Apache-2.0). New file, not from SAM 2.
"""The seed store: every object's clicks, per video, on disk.

Seeds are the source of truth for an object. The interactive session's SAM 2
state is a cache of them, and a track job rebuilds its own state from them.

Layout: <root>/<video_key>/<obj_id>/seeds.json, holding
{"<frame>": {"points": [[x, y], ...], "labels": [1, 0, ...], "mask": RLE}}.
Points are normalised to 0-1, as the demo's addPoints mutation sends them.
An optional <obj_id>/object.json holds metadata ({"name": ...}); it is kept
apart from seeds.json so a rename never changes the seeds hash (tracks stay
as they were). Objects stored before names existed have none.
An optional <obj_id>/ranges.json holds the object's frame ranges
({"ranges": [{"start", "end", "state"}]}, see tracks/ranges.py). Unlike the
name, ranges change what a track job does, so they join the seeds hash; an
object without any keeps the hash it had before ranges existed.

A seed frame's "mask" is the mask the user approved there: the result of their
last click on that frame. Track jobs condition on it (not on replayed clicks),
because SAM 2 reads a click as a correction only against a mask already on
that frame; replayed alone, a negative click has nothing to subtract from.
The points stay as the record of how the mask was made.
"""
import hashlib
import json
import os
import shutil
from pathlib import Path
from typing import Dict, Iterable, List, Optional

from tracks import ranges as rng
from tracks import rle

Seeds = Dict[int, Dict[str, list]]


def cleared(seed: Dict) -> bool:
    """True for a 'not on this frame' seed: clicks with no positive and an
    approved mask that is empty (or none). A legacy anchor-trimmed seed
    (no positive, non-empty mask) is not cleared."""
    if not seed.get("points") or 1 in [int(l) for l in seed.get("labels", [])]:
        return False
    m = seed.get("mask")
    return m is None or rle.area(m) == 0


def _canon(seeds: Seeds) -> Dict:
    canon = {}
    for f, v in seeds.items():
        if not v["points"]:
            continue
        c = {"points": [[float(x), float(y)] for x, y in v["points"]], "labels": [int(l) for l in v["labels"]]}
        if v.get("mask"):  # only when present: seeds stored before masks keep their hash
            c["mask"] = v["mask"]["counts"]
        canon[str(int(f))] = c
    return canon


def _sha(canon) -> str:
    return hashlib.sha256(json.dumps(canon, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def seeds_hash(seeds: Seeds, ranges: Optional[Iterable[Dict]] = None) -> str:
    """sha256 of the seeds (and the object's ranges) as canonical JSON:
    independent of dict order, and changed by any point, label, frame or
    range. Ranges join only when there are some, so objects without any keep
    the hash they had before ranges existed (and their tracks stay tracked)."""
    canon = _canon(seeds)
    ranges = rng.normalize(ranges or [])
    if ranges:  # frame keys are digits, so this key never collides with one
        canon["ranges"] = [[r["start"], r["end"], r["state"]] for r in ranges]
    return _sha(canon)


def window_key(window: "rng.Window", seeds: Seeds) -> str:
    """What one window of a track was made from: its bounds and its own seeds.
    Equal keys mean equal inputs, so a re-track may keep that window's masks."""
    return _sha({"window": [window[0], window[1]], "seeds": _canon(seeds)})


def video_key(path: str) -> str:
    """sha256 of the video file's bytes. Uploads are already named by it; the
    gallery's files are not, so key every video the same way."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def _write_json_atomic(path: Path, data) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, sort_keys=True))
    os.replace(tmp, path)


class SeedStore:
    def __init__(self, root: str):
        self.root = Path(root)

    def _path(self, video: str, obj_id: int) -> Path:
        return self.root / video / str(int(obj_id)) / "seeds.json"

    def seeds(self, video: str, obj_id: int) -> Seeds:
        p = self._path(video, obj_id)
        if not p.exists():
            return {}
        return {int(f): v for f, v in json.loads(p.read_text()).items()}

    def objects(self, video: str) -> List[int]:
        d = self.root / video
        if not d.is_dir():
            return []
        # an object with ranges and no clicks yet is listed too, so its ranges show
        return sorted(int(p.name) for p in d.iterdir()
                      if p.name.isdigit() and ((p / "seeds.json").exists() or (p / "ranges.json").exists()))

    def _save(self, video: str, obj_id: int, seeds: Seeds) -> None:
        p = self._path(video, obj_id)
        p.parent.mkdir(parents=True, exist_ok=True)
        _write_json_atomic(p, {str(f): v for f, v in sorted(seeds.items()) if v["points"]})

    def add_points(self, video: str, obj_id: int, frame: int, points: List[List[float]],
                   labels: List[int], clear_old_points: bool, mask: Optional[Dict] = None) -> Seeds:
        """Mirror SAM 2's add_new_points_or_box: clear_old_points replaces this
        frame's points, otherwise they are appended. `mask` (RLE) is the mask
        the click produced; it replaces the frame's approved mask."""
        seeds = self.seeds(video, obj_id)
        old = {"points": [], "labels": []} if clear_old_points else seeds.get(frame, {"points": [], "labels": []})
        seeds[frame] = {"points": old["points"] + [list(map(float, p)) for p in points],
                        "labels": old["labels"] + [int(l) for l in labels]}
        if mask is not None:
            seeds[frame]["mask"] = {"size": list(mask["size"]), "counts": mask["counts"]}
        self._save(video, obj_id, seeds)
        return seeds

    def clear_frame(self, video: str, obj_id: int, frame: int) -> Seeds:
        seeds = self.seeds(video, obj_id)
        seeds.pop(frame, None)
        self._save(video, obj_id, seeds)
        return seeds

    def remove_object(self, video: str, obj_id: int) -> None:
        """Forget the object entirely: its seeds and all of its tracks."""
        shutil.rmtree(self.root / video / str(int(obj_id)), ignore_errors=True)

    def clear_video(self, video: str) -> None:
        shutil.rmtree(self.root / video, ignore_errors=True)

    # -- metadata (names) -------------------------------------------------------
    NAME_MAX = 64

    def _meta_path(self, video: str, obj_id: int) -> Path:
        return self.root / video / str(int(obj_id)) / "object.json"

    def name(self, video: str, obj_id: int) -> Optional[str]:
        p = self._meta_path(video, obj_id)
        try:
            name = json.loads(p.read_text()).get("name")
        except (OSError, ValueError, AttributeError):
            return None  # no metadata (an older object), or unreadable: no name
        return name if isinstance(name, str) and name else None

    def names(self, video: str) -> Dict[int, str]:
        """Every named object of the video: {obj_id: name}."""
        d = self.root / video
        if not d.is_dir():
            return {}
        out = {}
        for p in d.iterdir():
            if p.name.isdigit() and (n := self.name(video, int(p.name))) is not None:
                out[int(p.name)] = n
        return dict(sorted(out.items()))

    def set_name(self, video: str, obj_id: int, name: Optional[str]) -> Optional[str]:
        """Name an object (trimmed, at most NAME_MAX characters); an empty or
        missing name removes it, so the object shows its default name."""
        name = (name or "").strip()[:self.NAME_MAX].strip()
        p = self._meta_path(video, obj_id)
        if not name:
            p.unlink(missing_ok=True)
            return None
        p.parent.mkdir(parents=True, exist_ok=True)
        _write_json_atomic(p, {"name": name})
        return name

    # -- ranges ------------------------------------------------------------------
    def _ranges_path(self, video: str, obj_id: int) -> Path:
        return self.root / video / str(int(obj_id)) / "ranges.json"

    def ranges(self, video: str, obj_id: int) -> List[Dict]:
        p = self._ranges_path(video, obj_id)
        if not p.exists():
            return []
        return rng.normalize(json.loads(p.read_text()).get("ranges", []))

    def set_ranges(self, video: str, obj_id: int, ranges: Iterable[Dict]) -> List[Dict]:
        """Replace the object's ranges (validated and merged). None left: the
        file goes, so the object is exactly as it was before it had any."""
        ranges = rng.normalize(ranges)
        p = self._ranges_path(video, obj_id)
        if not ranges:
            p.unlink(missing_ok=True)
            return []
        p.parent.mkdir(parents=True, exist_ok=True)
        _write_json_atomic(p, {"ranges": ranges})
        return ranges

    def paint_range(self, video: str, obj_id: int, start: int, end: int, state: Optional[str]) -> List[Dict]:
        """Set frames start-end to `state` ("absent"), or clear them (None)."""
        return self.set_ranges(video, obj_id, rng.paint(self.ranges(video, obj_id), start, end, state))

    def hash(self, video: str, obj_id: int) -> Optional[str]:
        seeds = self.seeds(video, obj_id)
        return seeds_hash(seeds, self.ranges(video, obj_id)) if seeds else None
