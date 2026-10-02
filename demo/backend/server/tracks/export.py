# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Export tracked objects to a rotoscoping working folder, the layout the
rotoscoping-video-subjects pipeline reads (its reference/working-folder.md and
reference/products.md), so its repair, contours and After Effects handoff
steps run on sam-ui's tracks unchanged:

    <out>/products.json   {"products": [{"id", "shots", "prompt", "color", "status", "meta"}]}
    <out>/anchors.json    {"<pid>": {"points": {"<frame>": [[x, y, label], ...]}}}, full-res pixels
    <out>/shots.json      {"cuts": [1], "unsure": []}: one shot (sam-ui does not know cuts)
    <out>/data/mattes_tracked/<pid>/%05d.png   8-bit 0/255, clip frames 1-based
    <out>/data/review.json {}  (no review flags yet)
    <out>/data/frames/%05d.jpg + data/clip.mp4  only with frames=True
    <out>/notes/sam-ui-export.json  provenance: engine, model, seeds hash per object

`objects` ({obj_id: {"id", "prompt", "color"}}, each field optional) picks
the objects to export and names them; without it every object is exported
with default names (object_<n>, palette colours).

Frames are numbered from 1 in the working folder and from 0 in sam-ui, so
sam-ui frame i is file (i + 1). Only tracked objects are exported unless
include_stale; untracked ones are listed as skipped.

What force gates: products.json / anchors.json / shots.json are decisions a
person confirmed, and data/mattes_tracked/<pid> may hold mattes repaired by
hand, so without force an existing decision file or a non-empty matte folder
of an exported object is a refusal. With force they are replaced (the matte
folder is deleted and refilled). sam-ui's own outputs are always rewritten:
notes/sam-ui-export.json, and with frames the whole data/frames folder, which
is replaced only once ffmpeg succeeds (clip.mp4 and data/review.json are
written only when missing).

Every path export writes or deletes must resolve, links followed, to inside
the export root, and a matte folder it would delete must not be a link at all
(nor a broken link where a folder belongs). All of it is checked before
anything is written, so a refusal changes nothing, and checked again as each
folder is used. Each file is written to a temp name beside it and os.replace'd
into place, so a link or hard link planted meanwhile is replaced, never written
through. ffmpeg fills a fresh mkdtemp folder that then takes data/frames' place
by rename, so it never writes into, and export never clears, a data/frames that
could have been swapped for a link. (What remains is the instant between a
folder's re-check and its use, for data, notes and the matte folders: a link
swapped in there could redirect that one mkdir, rmtree or write. Closing it
needs dir-fd syscalls.)
"""
import contextlib
import functools
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
from PIL import Image

from tracks import rle
from tracks.store import STALE, TRACKED

PALETTE = ["#b4ff00", "#ff4fa3", "#3fd0ff", "#ffb020", "#9b6bff", "#2fe38a", "#ff5a36", "#f2f25a"]
ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]*")
DECISIONS = ("products.json", "anchors.json", "shots.json")


class ExportError(ValueError):
    pass


def export_root() -> Path:
    """Where exports may write: SAM_UI_EXPORT_ROOT, else ~/Movies/sam-ui (the
    folder studio suggests). The desktop app sets it to the user's home, since
    only its own window can reach that backend; a backend on a network keeps
    the narrow default, so `force` cannot replace files across ~/Movies."""
    default = Path.home() / "Movies" / "sam-ui"
    return Path(os.environ.get("SAM_UI_EXPORT_ROOT", str(default))).expanduser().resolve()


def _inside(root: Path, p: Path) -> bool:
    """p, links followed, is root or under it (root is already resolved)."""
    try:
        real = p.resolve()
    except (OSError, RuntimeError):  # a link loop: refused, not a 500
        return False
    return real == root or root in real.parents


def _check_out(out_dir: str) -> Path:
    out = Path(out_dir).expanduser().resolve()
    if not _inside(export_root(), out):
        # name only the folder asked for, never the server's own root
        raise ExportError(f"export folder {out_dir!r} is outside the export root (set SAM_UI_EXPORT_ROOT)")
    return out


def _guard(root: Path, out: Path, out_dir: str, p: Path) -> Path:
    """p, or a refusal naming it relative to out_dir if it leads outside the root."""
    if not _inside(root, p):
        raise ExportError(f"{out_dir!r}: {p.relative_to(out).as_posix()} leads outside the export root")
    return p


def _matte_folder(root: Path, out: Path, out_dir: str, pid: str) -> Path:
    """data/mattes_tracked/<pid>, which export deletes and refills: inside the
    root and not a link, wherever the link points."""
    mdir = _guard(root, out, out_dir, out / "data" / "mattes_tracked" / pid)
    if mdir.is_symlink():
        raise ExportError(f"{out_dir!r}: data/mattes_tracked/{pid} is a link; "
                          "sam-ui only replaces its own matte folders")
    return mdir


def _check_targets(out: Path, out_dir: str, pids: List[str], frames: bool, force: bool) -> None:
    """Refuse before writing: a path that leads outside the root, a linked
    matte folder, a file where a folder belongs (or the reverse), or (without
    force) a decision or matte that would be replaced. Refusals name paths
    relative to out_dir, never where a link points."""
    root = export_root()
    mattes = [f"data/mattes_tracked/{pid}" for pid in pids]
    folders = ["data", "data/mattes_tracked", "notes", *mattes] + (["data/frames"] if frames else [])
    files = ["data/review.json", "notes/sam-ui-export.json", *DECISIONS] + (["data/clip.mp4"] if frames else [])
    for rel in folders + files:
        p = _guard(root, out, out_dir, out / rel)
        if rel in folders and p.is_symlink() and not p.exists():
            raise ExportError(f"{out_dir!r}: {rel} is a broken link")  # mkdir(exist_ok) would raise on it
        if p.exists() and p.is_dir() != (rel in folders):
            raise ExportError(f"{out_dir!r}: {rel} is {'a file, not a folder' if rel in folders else 'a folder'}")
    if frames and (out / "data" / "frames").is_dir():
        for p in (out / "data" / "frames").iterdir():
            _guard(root, out, out_dir, p)
    for pid in pids:
        _matte_folder(root, out, out_dir, pid)
    if not force:
        clash = [n for n in DECISIONS if (out / n).exists()]
        clash += [rel for rel in mattes if (out / rel).is_dir() and any((out / rel).iterdir())]
        if clash:
            # studio's checkbox for force is "Replace existing"
            raise ExportError(f"{out_dir!r} already has {clash}; tick Replace existing (force) to replace them")


@contextlib.contextmanager
def _replacing(path: Path):
    """A temp name beside path, os.replace'd onto path on success: a link or a
    hard link already at path is replaced, never written through."""
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        yield tmp
        os.replace(tmp, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            tmp.unlink()


def _write_atomic(path: Path, data: bytes) -> None:
    with _replacing(path) as tmp:
        # O_EXCL: a fresh file, never one (or a link) already at the temp name
        with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666), "wb") as f:
            f.write(data)


def _spec(obj_id: int, given: Optional[Dict], index: int) -> Dict:
    given = given or {}
    pid = given.get("id") or f"object_{obj_id}"
    if not ID_RE.fullmatch(pid):
        raise ExportError(f"object {obj_id}: id {pid!r} must be letters, digits, '_' or '-'")
    color = given.get("color") or PALETTE[index % len(PALETTE)]
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
        raise ExportError(f"object {obj_id}: colour must be #rrggbb, got {color!r}")
    return {"id": pid, "prompt": given.get("prompt") or pid.replace("_", " "), "color": color}


def export(service, video: str, video_path: str, out_dir: str, objects: Optional[Dict[int, Dict]] = None,
           include_stale: bool = False, frames: bool = False, force: bool = False,
           engine: Optional[str] = None) -> Dict:
    out = _check_out(out_dir)
    engine = service.get_engine(engine).name if engine else service.default
    wanted = sorted(int(o) for o in objects) if objects else service.seeds.objects(video)
    ok_states = (TRACKED, STALE) if include_stale else (TRACKED,)
    specs, skipped = {}, {}
    for i, o in enumerate(wanted):
        info = service.object_info(video, o, engine)
        if info["state"] not in ok_states:
            skipped[o] = info["state"]
            continue
        specs[o] = (_spec(o, (objects or {}).get(o) or (objects or {}).get(str(o)), i), info)
    ids = [s["id"] for s, _ in specs.values()]
    if len(set(ids)) != len(ids):
        raise ExportError(f"duplicate product ids {ids}")
    _check_targets(out, out_dir, ids, frames, force)

    # checked again as each folder is used: a link planted since is refused
    root = export_root()
    guard = functools.partial(_guard, root, out, out_dir)

    def write(path: Path, data: bytes) -> None:
        guard(path.parent)
        _write_atomic(path, data)

    out.mkdir(parents=True, exist_ok=True)  # resolved and checked by _check_out
    for d in (out / "data", out / "data" / "mattes_tracked", out / "notes"):
        guard(d).mkdir(exist_ok=True)
    products, anchors, provenance, n_frames = [], {}, {}, 0
    for o, (spec, info) in specs.items():
        mdir = _matte_folder(root, out, out_dir, spec["id"])
        if mdir.exists():
            shutil.rmtree(mdir)
        mdir.mkdir()
        size = None
        for frame, r in service.tracks.masks(video, o, engine):
            m = rle.decode(r)
            size = m.shape
            png = io.BytesIO()
            Image.fromarray((m * 255).astype(np.uint8)).save(png, format="PNG")
            write(mdir / f"{frame + 1:05d}.png", png.getvalue())
            n_frames = max(n_frames, frame + 1)
        h, w = size if size else (None, None)
        points = {}
        for frame, seed in sorted(info["seeds"].items()):
            if w is None:
                break
            points[str(frame + 1)] = [[round(x * w), round(y * h), int(lab)]
                                      for (x, y), lab in zip(seed["points"], seed["labels"])]
        if points:
            anchors[spec["id"]] = {"points": points}
        products.append({"id": spec["id"], "shots": [1], "prompt": spec["prompt"], "color": spec["color"],
                         "status": "confirmed", "meta": {"sam_ui_object": o}})
        provenance[spec["id"]] = {"object_id": o, "state": info["state"], "engine": info["engine"],
                                  "model": info["model"], "frames": info["frames"], "n_frames": info["n_frames"]}

    write(out / "products.json", json.dumps({"products": products}, indent=1).encode())
    write(out / "anchors.json", json.dumps(anchors, indent=1).encode())
    write(out / "shots.json", json.dumps({"cuts": [1], "unsure": []}, indent=1).encode())
    review = out / "data" / "review.json"
    if not review.exists():
        write(review, b"{}")
    manifest = {"exported": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "video": video, "video_path": video_path,
                "products": provenance, "skipped": {str(o): s for o, s in skipped.items()}, "n_frames": n_frames,
                "frames_extracted": False}
    if frames:
        manifest.update(_extract_frames(video_path, out, n_frames, guard))
    write(out / "notes" / "sam-ui-export.json", json.dumps(manifest, indent=1).encode())
    return {"out_dir": str(out), **manifest}


def _extract_frames(video_path: str, out: Path, n_frames: int, guard) -> Dict:
    """data/clip.mp4 and data/frames/%05d.jpg from the very file sam-ui decoded,
    so the mattes line up with the frames pixel for pixel."""
    clip = out / "data" / "clip.mp4"
    if not clip.exists():
        guard(clip.parent)
        with _replacing(clip) as tmp:
            shutil.copy2(video_path, tmp)
    # ffmpeg -y writes through whatever sits at a frame's name, so it never
    # writes into data/frames: it fills a fresh folder (mkdtemp: a new name,
    # 0700), which then takes data/frames' place by rename. Renames move a
    # link rather than follow it. On a failure the old frames stay as they were.
    data = guard(out / "data")
    new = Path(tempfile.mkdtemp(dir=data, prefix=".frames."))
    try:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(clip), "-an", "-q:v", "2", str(new / "%05d.jpg")],
                       check=True)
        got = len(list(new.glob("*.jpg")))
        os.chmod(new, 0o755)  # as a plain mkdir would leave it
        fdir = data / "frames"
        if fdir.is_symlink() or fdir.exists():
            old = data / f".frames.old.{uuid.uuid4().hex}"
            os.rename(fdir, old)
            try:
                shutil.rmtree(old)
            except OSError:
                if not old.is_symlink():  # rmtree refuses a link: drop the link, never its target
                    raise
                old.unlink()
        os.rename(new, fdir)
    except BaseException:
        shutil.rmtree(new, ignore_errors=True)
        raise
    info: Dict = {"frames_extracted": True, "frames_on_disk": got}
    if n_frames and got != n_frames:
        info["warning"] = f"ffmpeg wrote {got} frames but the tracks cover {n_frames}: check the frame alignment"
    return info
