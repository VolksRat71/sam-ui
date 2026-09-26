# sam-ui (Apache-2.0). New file, not from SAM 2.
"""The seed store: every object's clicks, per video, on disk.

Seeds are the source of truth for an object. The interactive session's SAM 2
state is a cache of them, and a track job rebuilds its own state from them.

Layout: <root>/<video_key>/<obj_id>/seeds.json, holding
{"<frame>": {"points": [[x, y], ...], "labels": [1, 0, ...]}}. Points are
normalised to 0-1, as the demo's addPoints mutation sends them.
"""
import hashlib
import json
import os
import shutil
from pathlib import Path
from typing import Dict, List, Optional

Seeds = Dict[int, Dict[str, list]]


def seeds_hash(seeds: Seeds) -> str:
    """sha256 of the seeds as canonical JSON: independent of dict order, and
    changed by any point, label or frame."""
    canon = {str(int(f)): {"points": [[float(x), float(y)] for x, y in v["points"]],
                           "labels": [int(l) for l in v["labels"]]}
             for f, v in seeds.items() if v["points"]}
    blob = json.dumps(canon, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()


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
        return sorted(int(p.name) for p in d.iterdir()
                      if p.name.isdigit() and (p / "seeds.json").exists())

    def _save(self, video: str, obj_id: int, seeds: Seeds) -> None:
        p = self._path(video, obj_id)
        p.parent.mkdir(parents=True, exist_ok=True)
        _write_json_atomic(p, {str(f): v for f, v in sorted(seeds.items()) if v["points"]})

    def add_points(self, video: str, obj_id: int, frame: int, points: List[List[float]],
                   labels: List[int], clear_old_points: bool) -> Seeds:
        """Mirror SAM 2's add_new_points_or_box: clear_old_points replaces this
        frame's points, otherwise they are appended."""
        seeds = self.seeds(video, obj_id)
        old = {"points": [], "labels": []} if clear_old_points else seeds.get(frame, {"points": [], "labels": []})
        seeds[frame] = {"points": old["points"] + [list(map(float, p)) for p in points],
                        "labels": old["labels"] + [int(l) for l in labels]}
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

    def hash(self, video: str, obj_id: int) -> Optional[str]:
        seeds = self.seeds(video, obj_id)
        return seeds_hash(seeds) if seeds else None
