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
notes/sam-ui-export.json, and with frames the JPEGs in data/frames (clip.mp4
and data/review.json are written only when missing).

Every path export writes or deletes must resolve, links followed, to inside
the export root, and a matte folder it would delete must not be a link at all;
all of it is checked before anything is written, so a refusal changes nothing.
"""
import json
import os
import re
import shutil
import subprocess
import time
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


def _check_targets(out: Path, out_dir: str, pids: List[str], frames: bool, force: bool) -> None:
    """Refuse before writing: a path that leads outside the root, a linked
    matte folder, or (without force) a decision or matte that would be replaced.
    Refusals name paths relative to out_dir, never where a link points."""
    root = export_root()
    mattes = [f"data/mattes_tracked/{pid}" for pid in pids]
    rels = ["data", "data/mattes_tracked", "notes", "data/review.json", "notes/sam-ui-export.json",
            *DECISIONS, *mattes]
    if frames:
        fdir = out / "data" / "frames"
        # ffmpeg -y writes through whatever already sits at a frame's name
        listed = sorted(fdir.iterdir()) if fdir.is_dir() and _inside(root, fdir) else []
        rels += ["data/clip.mp4", "data/frames", *(f"data/frames/{p.name}" for p in listed)]
    for rel in rels:
        if not _inside(root, out / rel):
            raise ExportError(f"{out_dir!r}: {rel} leads outside the export root")
    for rel in mattes:
        if (out / rel).is_symlink():
            raise ExportError(f"{out_dir!r}: {rel} is a link; sam-ui only replaces its own matte folders")
    if not force:
        clash = [n for n in DECISIONS if (out / n).exists()]
        clash += [rel for rel in mattes if (out / rel).is_dir() and any((out / rel).iterdir())]
        if clash:
            raise ExportError(f"{out_dir!r} already has {clash}; pass force to replace them")


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

    (out / "data" / "mattes_tracked").mkdir(parents=True, exist_ok=True)
    (out / "notes").mkdir(exist_ok=True)
    products, anchors, provenance, n_frames = [], {}, {}, 0
    for o, (spec, info) in specs.items():
        mdir = out / "data" / "mattes_tracked" / spec["id"]
        if mdir.exists():
            shutil.rmtree(mdir)
        mdir.mkdir(parents=True)
        size = None
        for frame, r in service.tracks.masks(video, o, engine):
            m = rle.decode(r)
            size = m.shape
            Image.fromarray((m * 255).astype(np.uint8)).save(mdir / f"{frame + 1:05d}.png")
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

    (out / "products.json").write_text(json.dumps({"products": products}, indent=1))
    (out / "anchors.json").write_text(json.dumps(anchors, indent=1))
    (out / "shots.json").write_text(json.dumps({"cuts": [1], "unsure": []}, indent=1))
    review = out / "data" / "review.json"
    if not review.exists():
        review.write_text("{}")
    manifest = {"exported": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "video": video, "video_path": video_path,
                "products": provenance, "skipped": {str(o): s for o, s in skipped.items()}, "n_frames": n_frames,
                "frames_extracted": False}
    if frames:
        manifest.update(_extract_frames(video_path, out, n_frames))
    (out / "notes" / "sam-ui-export.json").write_text(json.dumps(manifest, indent=1))
    return {"out_dir": str(out), **manifest}


def _extract_frames(video_path: str, out: Path, n_frames: int) -> Dict:
    """data/clip.mp4 and data/frames/%05d.jpg from the very file sam-ui decoded,
    so the mattes line up with the frames pixel for pixel."""
    clip = out / "data" / "clip.mp4"
    if not clip.exists():
        shutil.copy2(video_path, clip)
    fdir = out / "data" / "frames"
    fdir.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(clip), "-an", "-q:v", "2", str(fdir / "%05d.jpg")],
                   check=True)
    got = len(list(fdir.glob("*.jpg")))
    info: Dict = {"frames_extracted": True, "frames_on_disk": got}
    if n_frames and got != n_frames:
        info["warning"] = f"ffmpeg wrote {got} frames but the tracks cover {n_frames}: check the frame alignment"
    return info
