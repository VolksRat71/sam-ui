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
An optional <obj_id>/ranges.json holds the object's absent ranges
({"ranges": [{"start", "end", "state": "absent"}]}, see tracks/ranges.py).
Unlike the name, they change what a track job does, so they join the seeds
hash; an object without any keeps the hash it had before ranges existed.
An optional <obj_id>/annotations.json holds its present and candidate ranges
in the same shape (a candidate also has "source" and maybe "score"). They
never change a track, so they stay out of the seeds hash and out of the seed
record: marking a candidate or confirming one present makes no track stale
and is not a seed change to undo. Confirming one absent is: absent ranges
live in ranges.json.

The files above that make the seeds hash (RECORD_FILES) are the object's seed
record: tracks/versions.py snapshots them as they are, for undo.

A frame can be seeded by a text prompt instead of clicks (issue #22,
tracks/text.py): {"points": [], "labels": [], "text": "dog", "mask": RLE}.
Clicks on that frame later refine its mask and keep the text; clearing the
frame drops both. The text joins the hash only where there is some, so
objects without text keep their exact old hash (pinned in test_text.py).

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
from tracks.text import has_prompt, normalize as normalize_text

Seeds = Dict[int, Dict[str, list]]


def _canon(seeds: Seeds) -> Dict:
    canon = {}
    for f, v in seeds.items():
        if not has_prompt(v):
            continue
        c = {"points": [[float(x), float(y)] for x, y in v["points"]], "labels": [int(l) for l in v["labels"]]}
        if v.get("mask"):  # only when present: seeds stored before masks keep their hash
            c["mask"] = v["mask"]["counts"]
        if v.get("text"):  # likewise: seeds without text keep theirs
            c["text"] = v["text"]
        canon[str(int(f))] = c
    return canon


def _sha(canon) -> str:
    return hashlib.sha256(json.dumps(canon, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def seeds_hash(seeds: Seeds, ranges: Optional[Iterable[Dict]] = None) -> str:
    """sha256 of the seeds (and the object's absent ranges) as canonical JSON:
    independent of dict order, and changed by any point, label, frame or
    absent range. Ranges join only when there are some, so objects without
    any keep the hash they had before ranges existed (and their tracks stay
    tracked). Present and candidate ranges are left out, whatever is passed."""
    canon = _canon(seeds)
    # only absent ranges change a track; present and candidate ones never join
    ranges = [r for r in rng.normalize(ranges or []) if r["state"] == rng.ABSENT]
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
        # an object with ranges (or candidates) and no clicks yet is listed too, so they show
        return sorted(int(p.name) for p in d.iterdir()
                      if p.name.isdigit() and any((p / f).exists() for f in ("seeds.json", "ranges.json",
                                                                               "annotations.json")))

    def _save(self, video: str, obj_id: int, seeds: Seeds) -> None:
        p = self._path(video, obj_id)
        p.parent.mkdir(parents=True, exist_ok=True)
        _write_json_atomic(p, {str(f): v for f, v in sorted(seeds.items()) if has_prompt(v)})

    def add_points(self, video: str, obj_id: int, frame: int, points: List[List[float]],
                   labels: List[int], clear_old_points: bool, mask: Optional[Dict] = None) -> Seeds:
        """Mirror SAM 2's add_new_points_or_box: clear_old_points replaces this
        frame's points, otherwise they are appended. `mask` (RLE) is the mask
        the click produced; it replaces the frame's approved mask. A text
        prompt on the frame stays: the clicks refine the mask it made."""
        seeds = self.seeds(video, obj_id)
        text = seeds.get(frame, {}).get("text")
        old = {"points": [], "labels": []} if clear_old_points else seeds.get(frame, {"points": [], "labels": []})
        seeds[frame] = {"points": old["points"] + [list(map(float, p)) for p in points],
                        "labels": old["labels"] + [int(l) for l in labels]}
        if text:
            seeds[frame]["text"] = text
        if mask is not None:
            seeds[frame]["mask"] = {"size": list(mask["size"]), "counts": mask["counts"]}
        self._save(video, obj_id, seeds)
        return seeds

    def set_text(self, video: str, obj_id: int, frame: int, text: str, mask: Dict) -> Seeds:
        """Seed this frame from a text prompt: the frame's clicks go, and
        `mask` (RLE, the engine's pick for the text) is its approved mask."""
        seeds = self.seeds(video, obj_id)
        seeds[frame] = {"points": [], "labels": [], "text": normalize_text(text),
                        "mask": {"size": list(mask["size"]), "counts": mask["counts"]}}
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

    def _annotations_path(self, video: str, obj_id: int) -> Path:
        return self.root / video / str(int(obj_id)) / "annotations.json"

    @staticmethod
    def _read_ranges(p: Path) -> List[Dict]:
        if not p.exists():
            return []
        return rng.normalize(json.loads(p.read_text()).get("ranges", []))

    @staticmethod
    def _write_ranges(p: Path, ranges: List[Dict]) -> None:
        if not ranges:
            p.unlink(missing_ok=True)  # none left: the object is exactly as before it had any
            return
        p.parent.mkdir(parents=True, exist_ok=True)
        _write_json_atomic(p, {"ranges": ranges})

    def ranges(self, video: str, obj_id: int) -> List[Dict]:
        """The object's absent ranges: what tracking reads."""
        return [r for r in self._read_ranges(self._ranges_path(video, obj_id)) if r["state"] == rng.ABSENT]

    def set_ranges(self, video: str, obj_id: int, ranges: Iterable[Dict]) -> List[Dict]:
        """Replace the object's absent ranges (validated and merged). None
        left: the file goes, so the object is exactly as it was before it had any."""
        ranges = rng.normalize(ranges)
        if any(r["state"] != rng.ABSENT for r in ranges):
            raise ValueError("ranges.json holds absent ranges only: present and candidate ones are annotations")
        self._write_ranges(self._ranges_path(video, obj_id), ranges)
        return ranges

    def annotations(self, video: str, obj_id: int) -> List[Dict]:
        """The object's present and candidate ranges, as stored (layers: a
        candidate may lie under a present range; view() resolves them)."""
        return [r for r in self._read_ranges(self._annotations_path(video, obj_id)) if r["state"] != rng.ABSENT]

    def set_annotations(self, video: str, obj_id: int, ranges: Iterable[Dict]) -> List[Dict]:
        ranges = rng.normalize(ranges)
        if any(r["state"] == rng.ABSENT for r in ranges):
            raise ValueError("an absent range changes tracking: it belongs in ranges.json")
        self._write_ranges(self._annotations_path(video, obj_id), ranges)
        return ranges

    def timeline(self, video: str, obj_id: int) -> List[Dict]:
        """Every range the object's timeline shows, one state per frame (tracks/ranges.py view())."""
        return rng.view(self.ranges(video, obj_id), self.annotations(video, obj_id))

    def paint_range(self, video: str, obj_id: int, start: int, end: int, state: Optional[str],
                    source: Optional[str] = None, score: Optional[float] = None,
                    clear: Optional[Iterable[str]] = None) -> List[Dict]:
        """Set frames start-end to `state`, or clear them (None): every state
        by default (the frames become unknown), or only the states in `clear`
        (["candidate"] rejects a candidate). Absent wins over the
        annotations under it without removing them; present clears absent
        there; a candidate goes under whatever is confirmed. Answers timeline()."""
        absent, notes = self.ranges(video, obj_id), self.annotations(video, obj_id)
        if state is not None and clear is not None:
            raise ValueError("clear picks the states to clear: it goes with no state")
        if state is None:
            clear = set(rng.STATES if clear is None else clear)
            bad = clear - set(rng.STATES)
            if bad:
                raise ValueError(f"range state must be one of {list(rng.STATES)}, got {sorted(bad)!r}")
            new_absent = rng.paint(absent, start, end, None) if rng.ABSENT in clear else absent
            new_notes = rng.paint(notes, start, end, None, over=tuple(clear - {rng.ABSENT})) \
                if clear - {rng.ABSENT} else notes
        elif state == rng.ABSENT:
            new_absent, new_notes = rng.paint(absent, start, end, rng.ABSENT, source, score), notes
        elif state == rng.PRESENT:
            new_absent = rng.paint(absent, start, end, None)
            new_notes = rng.paint(notes, start, end, rng.PRESENT, source, score, over=(rng.PRESENT,))
        else:
            new_absent = absent
            new_notes = rng.paint(notes, start, end, state, source, score, over=(rng.CANDIDATE,))
        # everything is validated above: write only what changed
        if new_absent != absent:
            self.set_ranges(video, obj_id, new_absent)
        if new_notes != notes:
            self.set_annotations(video, obj_id, new_notes)
        return self.timeline(video, obj_id)

    def write_candidates(self, video: str, obj_id: int, candidates: Iterable[Dict],
                         replace: bool = False) -> List[Dict]:
        """Write many candidate ranges at once (what a discovery job makes),
        each {"start", "end", "source", "score"?}, in order: a later one wins
        where two overlap. `replace` drops the object's candidates first.
        All or nothing: one bad candidate (ValueError) writes none.
        Confirmed ranges stay and still win. Answers timeline()."""
        notes = self.annotations(video, obj_id)
        if replace:
            notes = [r for r in notes if r["state"] != rng.CANDIDATE]
        for c in candidates:
            if c.get("state", rng.CANDIDATE) != rng.CANDIDATE:
                raise ValueError(f"write_candidates writes candidates only, got a {c.get('state')!r} range")
            notes = rng.paint(notes, c["start"], c["end"], rng.CANDIDATE, c.get("source"), c.get("score"),
                              over=(rng.CANDIDATE,))
        self.set_annotations(video, obj_id, notes)
        return self.timeline(video, obj_id)

    # -- the seed record, for versions and undo (tracks/versions.py) ---------------
    # every file the seeds hash reads; annotations.json is not one (it never makes a track stale)
    RECORD_FILES = ("seeds.json", "ranges.json")

    def record(self, video: str, obj_id: int) -> Dict[str, object]:
        """The object's seed record as stored: each file's JSON, None where absent."""
        d = self.root / video / str(int(obj_id))
        out: Dict[str, object] = {}
        for name in self.RECORD_FILES:
            try:
                out[name] = json.loads((d / name).read_text())
            except FileNotFoundError:
                out[name] = None
        return out

    def put_record(self, video: str, obj_id: int, files: Dict[str, object]) -> None:
        """Write a seed record back as it was recorded (absent files removed).
        A record from before the object's first click still writes an empty
        seeds.json, so the object stays listed, with its history to redo."""
        d = self.root / video / str(int(obj_id))
        d.mkdir(parents=True, exist_ok=True)
        for name in self.RECORD_FILES:
            if name == "seeds.json" and files.get(name) is None:
                _write_json_atomic(d / name, {})
            elif files.get(name) is None:
                (d / name).unlink(missing_ok=True)
            else:
                _write_json_atomic(d / name, files[name])

    @staticmethod
    def record_key(files: Dict[str, object]) -> str:
        """The seeds hash of a seed record, also for one with no seeds (which
        hash() calls None): the key its version and undo entries go under."""
        seeds = {int(f): v for f, v in (files.get("seeds.json") or {}).items()}
        ranges = (files.get("ranges.json") or {}).get("ranges", [])
        return seeds_hash(seeds, ranges)

    def hash(self, video: str, obj_id: int) -> Optional[str]:
        seeds = self.seeds(video, obj_id)
        return seeds_hash(seeds, self.ranges(video, obj_id)) if seeds else None
