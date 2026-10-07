# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Videos opened in place: a file on disk registered as a session video with
no upload and no transcode, so frame N here is frame N of the file.

An upload goes through transcoder.transcode(), which re-encodes to
VIDEO_ENCODE_FPS, caps the size at 1280x720 and trims to the upload limit.
That is fine for a clip someone drops in, and wrong for footage that has to
line up frame for frame with another program (After Effects). A linked video
is a symlink under DATA_PATH/linked to the original file, named by a hash of
its real path, so every path the backend already takes (start_session's
DATA_PATH/<path>, track jobs, the frame decoders in tracks/streaming.py)
reads the original file's own frames at its own size and rate.

Beside each link, .sources/<id>.json keeps the source record: where the file
came from (the After Effects item, project and timing), its native metadata
as measured here, and its size and mtime when it was linked, so an export
can tell that the file changed underneath it.

Registering is not for the page: it would let a page name any file on disk.
Only the desktop app's main process can, with the per-launch token it hands
the backend in SAM_UI_LINK_TOKEN. Without that variable the route is off.
"""
import hashlib
import hmac
import json
import os
import re
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import av
from app_conf import DATA_PATH, POSTERS_PREFIX
from data.data_types import Video
from flask import Blueprint, abort, jsonify, request, send_from_directory

LINKED_PREFIX = "linked"
LINKED_PATH = DATA_PATH / LINKED_PREFIX
SOURCES_DIR = ".sources"
# what studio's decoder (mediabunny) and the backend's (decord, PyAV) both read
VIDEO_EXTS = {".mp4", ".mov", ".m4v"}
FPS_TOLERANCE = 1e-3
TOKEN_HEADER = "X-Sam-Ui-Link-Token"
# the source fields kept from the caller; anything else it sends is dropped
SOURCE_FIELDS = ("kind", "aeItemId", "aeProjectPath", "name", "path", "width", "height", "pixelAspect",
                 "frameRate", "frames", "duration", "hasAudio")


class LinkRefused(ValueError):
    pass


def native_metadata(path: str) -> Dict:
    """The file's size, rate and frame count, as the decoders index it: the
    frame count is the video stream's packets, counted without decoding
    (what studio and decord both treat as the clip's frames).

    A file trimmed without re-encoding (an mp4 edit list, `ffmpeg -ss ... -c
    copy`) carries packets from before its start: PyAV and After Effects skip
    them, decord does not, so frame N would differ between decoders. Such a
    file is refused rather than counted either way."""
    try:
        with av.open(path) as cont:
            if not cont.streams.video:
                raise LinkRefused("the file has no video stream")
            vs = cont.streams.video[0]
            rate = vs.guessed_rate or vs.average_rate
            fps = float(rate) if rate else None
            width, height = vs.width, vs.height
            start = vs.start_time or 0
            pts = [p.pts for p in cont.demux(vs) if p.pts is not None]
            frames = len(pts)
            before = sum(1 for t in pts if t < start)
            duration = float(cont.duration / av.time_base) if cont.duration else None
    except av.FFmpegError as e:
        raise LinkRefused(f"not a video sam-ui can read ({e})") from e
    if before:
        raise LinkRefused(
            f"the file was trimmed without re-encoding ({before} frames before its start are hidden by an edit list), "
            "so decoders disagree on which frame is which: re-encode or re-export it, then link it again")
    return {"width": width, "height": height, "fps": fps, "frames": frames, "duration": duration}


def check_native(source: Dict, native: Dict) -> List[str]:
    """Where the file as decoded here differs from what the source (After
    Effects) says it is. Any difference means frame N here would not be frame
    N there, so the caller refuses the link."""
    problems = []
    if (source.get("width"), source.get("height")) != (native["width"], native["height"]):
        problems.append(f"size: After Effects has {source.get('width')}x{source.get('height')}, "
                        f"the file decodes at {native['width']}x{native['height']}")
    fr = source.get("frameRate")
    if fr is None or native["fps"] is None or abs(float(fr) - native["fps"]) > FPS_TOLERANCE:
        problems.append(f"frame rate: After Effects has {fr}, the file has {native['fps']}")
    if source.get("frames") != native["frames"]:
        problems.append(f"frame count: After Effects has {source.get('frames')}, the file has {native['frames']}")
    return problems


def link_id(real: str) -> str:
    return hashlib.sha256(real.encode("utf-8")).hexdigest()[:24]


def _sources() -> Path:
    return LINKED_PATH / SOURCES_DIR


def _record_file(name: str) -> Path:
    return _sources() / f"{Path(name).stem}.json"


def _video(link_name: str, record: Dict) -> Video:
    poster = record.get("poster")
    return Video(
        code=f"{LINKED_PREFIX}/{link_name}",
        path=f"{LINKED_PREFIX}/{link_name}",
        poster_path=f"{POSTERS_PREFIX}/{poster}" if poster else None,
        width=record["native"]["width"],
        height=record["native"]["height"],
    )


def _poster(real: str, stem: str) -> Optional[str]:
    """The first frame as a poster (as the gallery gets), or None if ffmpeg fails."""
    import shutil
    import subprocess

    from app_conf import POSTERS_PATH

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        return None
    name = f"linked-{stem}.jpg"
    out = Path(POSTERS_PATH) / name
    subprocess.call([ffmpeg, "-y", "-v", "error", "-i", real, "-frames:v", "1", "-vf", "scale='min(640,iw)':-2",
                     "-update", "1", str(out)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return name if out.exists() else None


def register(path: str, source: Dict, hash_file=None) -> Tuple[Video, Dict]:
    """Link `path` in place. `source` is what the caller knows about it (for
    After Effects: its item's id, project, size, rate and frame count); it is
    checked against the file as decoded here, and the link is refused on any
    difference. Returns the Video (listed at once) and the stored record."""
    if not isinstance(path, str) or not os.path.isabs(path):
        raise LinkRefused("the path must be absolute")
    real = os.path.realpath(path)
    if not os.path.isfile(real):
        raise LinkRefused(f"no file at {path}")
    ext = os.path.splitext(real)[1].lower()
    if ext not in VIDEO_EXTS:
        raise LinkRefused(f"sam-ui opens {', '.join(sorted(VIDEO_EXTS))} footage, not {ext or 'a file with no extension'}")
    native = native_metadata(real)
    problems = check_native(source, native)
    if problems:
        raise LinkRefused("this footage would not line up frame for frame: " + "; ".join(problems))

    lid = link_id(real)
    name = f"{lid}{ext}"
    os.makedirs(_sources(), exist_ok=True)
    link = LINKED_PATH / name
    if link.is_symlink() or link.exists():
        if os.path.realpath(link) != real:
            link.unlink()
    if not link.is_symlink():
        os.symlink(real, link)
    st = os.stat(real)
    if hash_file is None:
        from tracks.seeds import video_key as hash_file  # the key seeds and tracks use
    record = {
        "version": 1,
        "path": f"{LINKED_PREFIX}/{name}",
        "source": {k: source.get(k) for k in SOURCE_FIELDS if k in source},
        "file": {"path": real, "size": st.st_size, "mtime": st.st_mtime},
        "videoHash": hash_file(real),
        "native": native,
        "poster": _poster(real, lid),
        "linked": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    _record_file(name).write_text(json.dumps(record, indent=1))
    video = _video(name, record)
    from data.store import get_videos

    get_videos()[video.code] = video
    return video, record


# exactly the names register() writes: link_id()'s 24 lowercase hex, a lowercased VIDEO_EXTS extension
LINK_NAME = re.compile(r"[0-9a-f]{24}(%s)" % "|".join(re.escape(e) for e in sorted(VIDEO_EXTS)))


def link_file(path: str) -> Optional[Path]:
    """Where the link for a linked video's API path (linked/<id>.<ext>) sits,
    from the path's text alone (never following a link), or None for
    anything that is not exactly a name register() writes: so no second
    folder level, dot name, NUL byte, backslash or drive letter, and no case
    variant (on a case-insensitive disk one would reach the real link)."""
    parts = path.split("/")
    if len(parts) != 2 or parts[0] != LINKED_PREFIX or not LINK_NAME.fullmatch(parts[1]):
        return None
    return LINKED_PATH / parts[1]


def unlink(link: Path) -> None:
    """Remove sam-ui's own files for a linked video: the link itself (os.unlink
    on a symlink removes the link, never the footage it points at), its source
    record and its poster."""
    record = _record_file(link.name)
    try:
        poster = json.loads(record.read_text()).get("poster")
    except (OSError, ValueError, AttributeError):
        poster = None
    os.unlink(link)
    record.unlink(missing_ok=True)
    if poster:
        from app_conf import POSTERS_PATH

        (Path(POSTERS_PATH) / Path(poster).name).unlink(missing_ok=True)


def source_of(path: str) -> Optional[Dict]:
    """The record of a linked video (its API path, linked/<id>.<ext>), with
    `changed` true when the file's size or mtime moved since it was linked,
    and `missing` when it is gone. None for anything that is not linked."""
    link = link_file(path)
    if link is None:
        return None
    f = _record_file(link.name)
    if not f.is_file():
        return None
    record = json.loads(f.read_text())
    try:
        st = os.stat(record["file"]["path"])
        record["missing"] = False
        record["changed"] = (st.st_size, st.st_mtime) != (record["file"]["size"], record["file"]["mtime"])
    except OSError:
        record["missing"], record["changed"] = True, True
    return record


def preload() -> Dict[str, Video]:
    """Linked videos whose file is still there, for the videos list at start-up."""
    out: Dict[str, Video] = {}
    if not _sources().is_dir():
        return out
    for f in sorted(_sources().glob("*.json")):
        try:
            record = json.loads(f.read_text())
            name = record["path"].split("/", 1)[1]
            if os.path.isfile(LINKED_PATH / name):  # follows the link: a dangling one is skipped
                v = _video(name, record)
                out[v.code] = v
        except (OSError, ValueError, KeyError, IndexError):
            continue
    return out


def make_blueprint(token: Optional[str] = None) -> Blueprint:
    """POST /linked (the desktop app's main process, with its token), GET
    /linked/<file> (the video, with range requests, for studio's decoder) and
    GET /linked-source?path= (the record)."""
    bp = Blueprint("linked", __name__)
    token = token if token is not None else os.environ.get("SAM_UI_LINK_TOKEN")

    @bp.route(f"/{LINKED_PREFIX}", methods=["POST"])
    def link_video():
        if not token:
            abort(404)
        sent = request.headers.get(TOKEN_HEADER, "")
        if not hmac.compare_digest(sent.encode(), token.encode()):
            abort(403, description="only the desktop app can open files in place")
        body = request.get_json(silent=True) or {}
        try:
            video, record = register(body.get("path"), body.get("source") or {})
        except LinkRefused as e:
            return jsonify({"error": str(e)}), 422
        return jsonify({"path": video.path, "posterPath": video.poster_path, "width": video.width,
                        "height": video.height, "record": record})

    @bp.route(f"/{LINKED_PREFIX}/<name>", methods=["GET"])
    def send_linked(name: str):
        if name.startswith(".") or os.path.splitext(name)[1].lower() not in VIDEO_EXTS:
            abort(404)
        return send_from_directory(LINKED_PATH, name)

    @bp.route("/linked-source", methods=["GET"])
    def linked_source():
        record = source_of(request.args.get("path", ""))
        if record is None:
            abort(404)
        return jsonify(record)

    return bp
