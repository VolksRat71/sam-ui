# sam-ui (Apache-2.0). New file, not from SAM 2.
"""The track store: one cached track per object per engine, on disk.

Layout: <root>/<video_key>/<obj_id>/<engine>/track.json (provenance) and
masks.jsonl (one {"frame", "size", "counts"} RLE line per frame). The object
directory is shared with the seed store, so removing an object removes both.

An object's state is derived, never stored:
- untracked: no track from this engine;
- stale: a track exists, but its seeds hash or model differs from now;
- tracked: otherwise.

track.json may also hold "windows" ([{"start", "end", "key"}]): the seeded
windows the track was made of (tracks/ranges.py), so a re-track can keep the
ones whose inputs did not change. Tracks from before windows have none.

<obj_id>/versions/ holds the object's earlier tracks (tracks/versions.py);
clearing an object's tracks here leaves it alone.
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
from tracks.versions import _segment

UNTRACKED, STALE, TRACKED = "untracked", "stale", "tracked"


class TrackStore:
    def __init__(self, root: str):
        self.root = Path(root)

    def _dir(self, video: str, obj_id: int, engine: str) -> Path:
        return self.root / _segment("video key", video) / str(int(obj_id)) / _segment("engine name", engine)

    def save(self, video: str, obj_id: int, engine: str, model: str, seeds_hash: str,
             frames: Dict[int, Union[np.ndarray, Dict]], elapsed_s: float, extra: Optional[Dict] = None) -> Dict:
        """Write a whole track, atomically: into a temp dir, then swapped in, so
        a crash mid-write leaves the previous track (or none), never half of one."""
        final = self._dir(video, obj_id, engine)
        final.parent.mkdir(parents=True, exist_ok=True)
        self._recover(final)
        for stray in final.parent.glob(f".{engine}.*-*"):  # leftovers of a crashed save
            shutil.rmtree(stray, ignore_errors=True)
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
                "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "elapsed_s": round(float(elapsed_s), 3),
                **(extra or {})}
        (tmp / "track.json").write_text(json.dumps(meta, indent=1))
        self._swap(final, tmp)
        return meta

    def adopt(self, video: str, obj_id: int, engine: str, src: Path, extra: Optional[Dict] = None) -> Dict:
        """Make the track in `src` (a kept version: track.json, masks.jsonl)
        the object's track on `engine`, atomically as save() does. The masks
        are linked, not copied; track.json gains `extra`."""
        final = self._dir(video, obj_id, engine)
        final.parent.mkdir(parents=True, exist_ok=True)
        self._recover(final)
        for stray in final.parent.glob(f".{engine}.*-*"):
            shutil.rmtree(stray, ignore_errors=True)
        tmp = final.with_name(f".{engine}.tmp-{uuid.uuid4().hex}")
        tmp.mkdir()
        try:
            try:
                os.link(src / "masks.jsonl", tmp / "masks.jsonl")
            except OSError:
                shutil.copy2(src / "masks.jsonl", tmp / "masks.jsonl")
            meta = {**json.loads((src / "track.json").read_text()), **(extra or {})}
            (tmp / "track.json").write_text(json.dumps(meta, indent=1))
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        self._swap(final, tmp)
        return meta

    def track_dir(self, video: str, obj_id: int, engine: str) -> Path:
        """The current track's dir: the .old one after a crash mid-swap, as meta() reads."""
        return self._live(self._dir(video, obj_id, engine))

    @staticmethod
    def _swap(final: Path, tmp: Path) -> None:
        old = None
        if final.exists():
            old = final.with_name(f".{final.name}.old-{uuid.uuid4().hex}")
            os.replace(final, old)
        os.replace(tmp, final)
        if old is not None:  # out of the .old- name first: a half-deleted one must never look live
            trash = final.with_name(f".{final.name}.trash-{uuid.uuid4().hex}")
            os.replace(old, trash)
            shutil.rmtree(trash, ignore_errors=True)

    @staticmethod
    def _live(final: Path) -> Path:
        """Where the current track is, read-only: `final`, or, between save()'s
        two renames (mid-swap, or a crash there), the .old dir it was moved to.
        Readers take no lock, so they must never rename: one that put .old back
        mid-swap would make the save's second rename fail."""
        if final.exists():
            return final
        try:
            olds = sorted(final.parent.glob(f".{final.name}.old-*"), key=lambda p: p.stat().st_mtime)
        except FileNotFoundError:  # the swap finished and removed it: final is in place
            return final
        return olds[-1] if olds else final

    def _recover(self, final: Path) -> None:
        """Undo a crash between save()'s two renames: the previous track sits
        in an .old dir and nothing in its place. Put it back. Writers only (they
        hold the inference lock); readers use _live."""
        if not final.parent.is_dir():
            return
        live = self._live(final)
        if live != final:
            os.replace(live, final)

    def _open(self, final: Path, name: str):
        """Open `name` in the current track, or None. A swap can move the dir
        between resolving and opening it (to .old-, then .trash-), so a miss
        resolves again; a miss on the same dir twice means there is no track."""
        last = None
        while True:
            d = self._live(final)
            try:
                return open(d / name)
            except FileNotFoundError:
                if d == last:
                    return None
                last = d

    def meta(self, video: str, obj_id: int, engine: str) -> Optional[Dict]:
        f = self._open(self._dir(video, obj_id, engine), "track.json")
        if f is None:
            return None
        with f:
            return json.load(f)

    def masks(self, video: str, obj_id: int, engine: str) -> Iterator[Tuple[int, Dict]]:
        """(frame, rle) for every stored frame, in order. RLE stays encoded: the
        stream sends it as is."""
        f = self._open(self._dir(video, obj_id, engine), "masks.jsonl")
        if f is None:
            return
        with f:
            for line in f:
                d = json.loads(line)
                yield d["frame"], {"size": d["size"], "counts": d["counts"]}

    def mask_at(self, video: str, obj_id: int, engine: str, frame: int) -> Optional[Dict]:
        """The cached track's RLE mask on one frame, or None."""
        for f, r in self.masks(video, obj_id, engine):
            if f == frame:
                return r
        return None

    def clear(self, video: str, obj_id: int, engine: Optional[str] = None) -> None:
        """Drop an object's track from one engine, or from every engine. Its seeds stay."""
        obj_dir = self.root / _segment("video key", video) / str(int(obj_id))
        if engine is not None:
            shutil.rmtree(self._dir(video, obj_id, engine), ignore_errors=True)
            for stray in obj_dir.glob(f".{engine}.*-*"):  # or _recover would bring an old track back
                shutil.rmtree(stray, ignore_errors=True)
        elif obj_dir.is_dir():
            for p in obj_dir.iterdir():
                if p.is_dir() and p.name != "versions":
                    shutil.rmtree(p, ignore_errors=True)

    def state(self, video: str, obj_id: int, engine: str, model: str, seeds_hash: Optional[str]) -> str:
        m = self.meta(video, obj_id, engine)
        if m is None:
            return UNTRACKED
        if m["seeds_hash"] != seeds_hash or m["model"] != model:
            return STALE
        return TRACKED
