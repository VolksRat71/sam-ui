# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Track versions and seed undo (issue #18).

A track is cached under the hash of the seeds that made it (tracks/seeds.py),
so an object's earlier tracks stay valid for its earlier seeds. This store
keeps them, so going back to earlier seeds brings their track back from disk
with no track job.

Layout, beside the object's seeds and current tracks:
  <obj>/versions/<key>/snapshot.json   {"files": {"seeds.json": ..., "ranges.json": ...}}
      The object's seed record as it was on disk (SeedStore.RECORD_FILES),
      stored as is rather than reinterpreted, so restoring it gives back the
      exact seeds hash `key`, whatever fields a seed frame holds.
  <obj>/versions/<key>/<engine>/track.json, masks.jsonl, version.json
      One engine's track of those seeds. track.json and masks.jsonl are hard
      links to the files the track job wrote (a copy where links fail), so
      the version the object currently shows costs no extra disk; a version
      costs its masks only once the current track moves on. version.json is
      the summary the version list shows.
  <obj>/history.json   {"undo": [{"key", "at"}], "redo": [...]}
      The object's seed changes, newest last: undo restores the snapshot of
      the last "undo" key and pushes the seeds it replaces onto "redo".

KEEP tracked versions are kept per object and engine, newest first (the one
the object's current track is never evicted); UNDO_DEPTH seed changes per
object. A snapshot no version and no history entry refers to is dropped.
Removing an object removes all of it (the object's directory goes).
"""
import json
import os
import shutil
import time
from pathlib import Path
from typing import Dict, Iterable, List, Optional

KEEP = 10  # tracked versions kept per object and engine
UNDO_DEPTH = 50  # seed changes each object can undo

VERSIONS = "versions"
HISTORY = "history.json"
SNAPSHOT = "snapshot.json"
SUMMARY = "version.json"
TRACK_FILES = ("track.json", "masks.jsonl")


def _write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, sort_keys=True))
    os.replace(tmp, path)


def _read_json(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def link_or_copy(src: Path, dst: Path) -> None:
    """A hard link (no extra disk), or a copy where the filesystem has none."""
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


class VersionStore:
    def __init__(self, root: str):
        self.root = Path(root)

    def _obj(self, video: str, obj_id: int) -> Path:
        return self.root / video / str(int(obj_id))

    def _dir(self, video: str, obj_id: int, key: str) -> Path:
        return self._obj(video, obj_id) / VERSIONS / key

    # -- snapshots of the seed record ----------------------------------------------------
    def put_snapshot(self, video: str, obj_id: int, key: str, files: Dict) -> None:
        p = self._dir(video, obj_id, key) / SNAPSHOT
        if not p.exists():  # a key names one record, so a snapshot never changes
            _write_json(p, {"files": files})

    def snapshot(self, video: str, obj_id: int, key: str) -> Optional[Dict]:
        got = _read_json(self._dir(video, obj_id, key) / SNAPSHOT)
        return got.get("files") if isinstance(got, dict) else None

    # -- tracked versions ------------------------------------------------------------------
    def record(self, video: str, obj_id: int, engine: str, key: str, track_dir: Path, summary: Dict) -> None:
        """Keep the track in `track_dir` as the version of `key` on `engine`,
        replacing an older track of the same seeds (a forced re-track)."""
        final = self._dir(video, obj_id, key) / engine
        tmp = final.with_name(f".{engine}.tmp-{time.time_ns()}")
        tmp.mkdir(parents=True)
        try:
            for name in TRACK_FILES:
                link_or_copy(track_dir / name, tmp / name)
            _write_json(tmp / SUMMARY, {**summary, "saved": time.time_ns()})
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        if final.exists():
            shutil.rmtree(final, ignore_errors=True)
        os.replace(tmp, final)

    def has(self, video: str, obj_id: int, engine: str, key: str) -> bool:
        d = self._dir(video, obj_id, key) / engine
        return all((d / n).exists() for n in TRACK_FILES)

    def track_dir(self, video: str, obj_id: int, engine: str, key: str) -> Optional[Path]:
        return self._dir(video, obj_id, key) / engine if self.has(video, obj_id, engine, key) else None

    def summary(self, video: str, obj_id: int, engine: str, key: str) -> Optional[Dict]:
        return _read_json(self._dir(video, obj_id, key) / engine / SUMMARY)

    def entries(self, video: str, obj_id: int, engine: Optional[str] = None) -> List[Dict]:
        """Every tracked version ({"key", "engine", **summary}), newest first."""
        d = self._obj(video, obj_id) / VERSIONS
        if not d.is_dir():
            return []
        out = []
        for kd in d.iterdir():
            if not kd.is_dir() or kd.name.startswith("."):
                continue
            for ed in kd.iterdir():
                if not ed.is_dir() or ed.name.startswith(".") or (engine is not None and ed.name != engine):
                    continue
                s = _read_json(ed / SUMMARY)
                if isinstance(s, dict) and all((ed / n).exists() for n in TRACK_FILES):
                    out.append({**s, "key": kd.name, "engine": ed.name})
        return sorted(out, key=lambda e: e.get("saved", 0), reverse=True)

    def evict(self, video: str, obj_id: int, engine: str, protect: Iterable[str] = ()) -> None:
        """Keep the KEEP newest versions on `engine` (and any in `protect`)."""
        protect = set(protect)
        for i, e in enumerate(self.entries(video, obj_id, engine)):
            if i >= KEEP and e["key"] not in protect:
                shutil.rmtree(self._dir(video, obj_id, e["key"]) / engine, ignore_errors=True)

    def drop(self, video: str, obj_id: int, engine: Optional[str] = None) -> None:
        """Forget the versions of one engine's tracks, or of every engine's."""
        d = self._obj(video, obj_id) / VERSIONS
        if not d.is_dir():
            return
        for kd in d.iterdir():
            if kd.is_dir():
                for ed in kd.iterdir():
                    if ed.is_dir() and (engine is None or ed.name == engine):
                        shutil.rmtree(ed, ignore_errors=True)

    def gc(self, video: str, obj_id: int) -> None:
        """Drop snapshots that neither a version nor the history refers to."""
        d = self._obj(video, obj_id) / VERSIONS
        if not d.is_dir():
            return
        h = self.history(video, obj_id)
        wanted = {e["key"] for e in h["undo"] + h["redo"]}
        for kd in d.iterdir():
            if not kd.is_dir():
                continue
            if kd.name.startswith("."):
                shutil.rmtree(kd, ignore_errors=True)  # a crashed record()
                continue
            for stray in kd.glob(".*"):
                shutil.rmtree(stray, ignore_errors=True)
            if kd.name not in wanted and not any(p.is_dir() for p in kd.iterdir()):
                shutil.rmtree(kd, ignore_errors=True)

    # -- the undo history ----------------------------------------------------------------
    def history(self, video: str, obj_id: int) -> Dict[str, List[Dict]]:
        got = _read_json(self._obj(video, obj_id) / HISTORY)
        if not isinstance(got, dict):
            got = {}  # an object from before undo existed, or unreadable: nothing to undo
        return {k: [e for e in got.get(k) or [] if isinstance(e, dict) and e.get("key")] for k in ("undo", "redo")}

    def set_history(self, video: str, obj_id: int, h: Dict[str, List[Dict]]) -> None:
        if not self._obj(video, obj_id).is_dir():
            return  # the object is gone
        _write_json(self._obj(video, obj_id) / HISTORY,
                    {"undo": h["undo"][-UNDO_DEPTH:], "redo": h["redo"][-UNDO_DEPTH:]})
