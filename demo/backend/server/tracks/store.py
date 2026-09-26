# sam-ui (Apache-2.0). New file, not from SAM 2.
"""The track store: one cached track per object per engine, on disk.

Layout: <root>/<video_key>/<obj_id>/<engine>/track.json (provenance) and
masks.jsonl (one {"frame", "size", "counts"} RLE line per frame). The object
directory is shared with the seed store, so removing an object removes both.

An object's state is derived, never stored:
- untracked: no track from this engine;
- stale: a track exists, but its seeds hash or model differs from now;
- tracked: otherwise.
"""
import json
import os
import shutil
import time
import uuid
from pathlib import Path
from typing import Dict, Iterator, Optional, Tuple, Union

import numpy as np

from tracks import rle

UNTRACKED, STALE, TRACKED = "untracked", "stale", "tracked"


class TrackStore:
    def __init__(self, root: str):
        self.root = Path(root)

    def _dir(self, video: str, obj_id: int, engine: str) -> Path:
        return self.root / video / str(int(obj_id)) / engine

    def save(self, video: str, obj_id: int, engine: str, model: str, seeds_hash: str,
             frames: Dict[int, Union[np.ndarray, Dict]], elapsed_s: float) -> Dict:
        """Write a whole track, atomically: into a temp dir, then swapped in, so
        a crash mid-write leaves the previous track (or none), never half of one."""
        final = self._dir(video, obj_id, engine)
        final.parent.mkdir(parents=True, exist_ok=True)
        tmp = final.with_name(f".{engine}.tmp-{uuid.uuid4().hex}")
        tmp.mkdir()
        try:
            with open(tmp / "masks.jsonl", "w") as f:
                for i in sorted(frames):
                    m = frames[i]  # a bool mask, or RLE already encoded for the stream
                    enc = {"size": m["size"], "counts": m["counts"]} if isinstance(m, dict) else rle.encode(m)
                    f.write(json.dumps({"frame": int(i), **enc}) + "\n")
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        meta = {"object_id": int(obj_id), "engine": engine, "model": model, "seeds_hash": seeds_hash,
                "frames": [min(frames), max(frames)] if frames else None, "n_frames": len(frames),
                "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "elapsed_s": round(float(elapsed_s), 3)}
        (tmp / "track.json").write_text(json.dumps(meta, indent=1))
        old = None
        if final.exists():
            old = final.with_name(f".{engine}.old-{uuid.uuid4().hex}")
            os.replace(final, old)
        os.replace(tmp, final)
        if old is not None:
            shutil.rmtree(old, ignore_errors=True)
        return meta

    def meta(self, video: str, obj_id: int, engine: str) -> Optional[Dict]:
        p = self._dir(video, obj_id, engine) / "track.json"
        return json.loads(p.read_text()) if p.exists() else None

    def masks(self, video: str, obj_id: int, engine: str) -> Iterator[Tuple[int, Dict]]:
        """(frame, rle) for every stored frame, in order. RLE stays encoded: the
        stream sends it as is."""
        p = self._dir(video, obj_id, engine) / "masks.jsonl"
        if not p.exists():
            return
        with open(p) as f:
            for line in f:
                d = json.loads(line)
                yield d["frame"], {"size": d["size"], "counts": d["counts"]}

    def clear(self, video: str, obj_id: int, engine: Optional[str] = None) -> None:
        """Drop an object's track from one engine, or from every engine. Its seeds stay."""
        obj_dir = self.root / video / str(int(obj_id))
        if engine is not None:
            shutil.rmtree(obj_dir / engine, ignore_errors=True)
        elif obj_dir.is_dir():
            for p in obj_dir.iterdir():
                if p.is_dir():
                    shutil.rmtree(p, ignore_errors=True)

    def state(self, video: str, obj_id: int, engine: str, model: str, seeds_hash: Optional[str]) -> str:
        m = self.meta(video, obj_id, engine)
        if m is None:
            return UNTRACKED
        if m["seeds_hash"] != seeds_hash or m["model"] != model:
            return STALE
        return TRACKED
