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

Studio decodes the video in the browser (WebCodecs), which plays H.264, HEVC,
VP8/9 and AV1 but not ProRes, DNxHR, Animation and the other codecs After
Effects footage often comes in. For those, linking also makes an H.264 preview
under .previews/ (sam-ui's own data, never beside the footage) with the same
frames at the same times and size, and GET /linked/<file> serves it to studio.
The backend still tracks and exports from the original.

Registering is not for the page: it would let a page name any file on disk.
Only the desktop app's main process can, with the per-launch token it hands
the backend in SAM_UI_LINK_TOKEN. Without that variable the route is off.
"""
import hashlib
import hmac
import json
import os
import tempfile
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
PREVIEWS_DIR = ".previews"
# what studio's decoder (mediabunny) and the backend's (decord, PyAV) both read
VIDEO_EXTS = {".mp4", ".mov", ".m4v"}
# codecs (PyAV names) studio's WebCodecs decoder plays in desktop Chrome; anything else gets a preview
# ponytail: HEVC counts as playable (macOS Chrome decodes it); on Windows it needs the HEVC extension
BROWSER_CODECS = {"h264", "hevc", "vp8", "vp9", "av1"}
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
            codec = vs.codec_context.name
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
    return {"width": width, "height": height, "fps": fps, "frames": frames, "duration": duration, "codec": codec}


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


def _preview(real: str, video_hash: str, native: Dict) -> Optional[str]:
    """The H.264 preview studio plays in place of footage its browser decoder
    cannot (ProRes and the like), as a file name under .previews/, or None
    when studio plays the original. Made with the frame-exact proxy encoder
    (data/assets, #32) at the native size: every frame at its own time, then
    decoded again and checked frame for frame before it is kept. Named by the
    original's content hash, so a changed file gets a new one.

    This runs whether or not SAM_UI_GENERATE_FRAME_ACCURATE_PROXIES is set:
    that flag holds back proxies as the upload path's inference and playback
    input, while this one is only what studio shows, and without it the
    footage cannot be shown at all. Raises ValueError when no exact preview
    can be made."""
    if native["codec"] in BROWSER_CODECS:
        return None
    from data.assets.proxy_codec import encode_proxy, validate_proxy
    from data.assets.proxy_contract import ProxyRecipe, SourceAsset, effective_recipe
    from data.assets.timing import inspect_source

    name = f"{video_hash[:24]}.mp4"
    out = LINKED_PATH / PREVIEWS_DIR / name
    if out.is_file():  # published only after it validated (below)
        return name
    inspection = inspect_source(Path(real))
    if inspection["timing_status"] != "valid":
        raise ValueError(inspection["diagnostic_code"] or "unsupported_source_timing")
    source = SourceAsset(Path(real), "", video_hash, "", inspection)
    recipe = effective_recipe(source, ProxyRecipe(native["width"], native["height"]))
    if recipe["geometry"]["proxy_raster"] != [native["width"], native["height"]]:
        raise ValueError("odd_frame_size")  # H.264 4:2:0 needs even sides; studio sizes its canvas from this file
    os.makedirs(out.parent, exist_ok=True)
    fd, stage = tempfile.mkstemp(prefix=f".{name}.", suffix=".tmp", dir=out.parent)
    os.close(fd)
    stage = Path(stage)
    try:
        # ponytail: encodes in the link request (#32's single-threaded x264, about 2x real time at 1080p
        # here); move to a background job if long 4K clips hit the desktop app's 10-minute wait
        encode_proxy(source, recipe, stage)
        if validate_proxy(source, recipe, stage)["frame_count"] != native["frames"]:
            raise ValueError("proxy_frame_count_mismatch")
        os.replace(stage, out)
    finally:
        stage.unlink(missing_ok=True)
    return name


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
    if hash_file is None:
        from tracks.seeds import video_key as hash_file  # the key seeds and tracks use
    video_hash = hash_file(real)
    try:
        preview = _preview(real, video_hash, native)
    except (ValueError, OSError, av.FFmpegError) as e:
        raise LinkRefused(f"studio cannot play {native['codec']} footage, and sam-ui could not make "
                          f"a frame-exact preview of it ({e})") from e

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
    record = {
        "version": 1,
        "path": f"{LINKED_PREFIX}/{name}",
        "source": {k: source.get(k) for k in SOURCE_FIELDS if k in source},
        "file": {"path": real, "size": st.st_size, "mtime": st.st_mtime},
        "videoHash": video_hash,
        "native": native,
        "poster": _poster(real, lid),
        "preview": preview,
        "linked": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    _record_file(name).write_text(json.dumps(record, indent=1))
    video = _video(name, record)
    from data.store import get_videos

    get_videos()[video.code] = video
    return video, record


def source_of(path: str) -> Optional[Dict]:
    """The record of a linked video (its API path, linked/<id>.<ext>), with
    `changed` true when the file's size or mtime moved since it was linked,
    and `missing` when it is gone. None for anything that is not linked."""
    parts = path.split("/")
    if len(parts) != 2 or parts[0] != LINKED_PREFIX or ".." in parts or parts[1].startswith("."):
        return None
    f = _record_file(parts[1])
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
    /linked/<file> (the video, or its preview when it has one, with range
    requests, for studio's decoder) and GET /linked-source?path= (the record)."""
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
        try:
            preview = json.loads(_record_file(name).read_text()).get("preview")
        except (OSError, ValueError, AttributeError):
            preview = None
        if preview:
            return send_from_directory(LINKED_PATH / PREVIEWS_DIR, preview)
        return send_from_directory(LINKED_PATH, name)

    @bp.route("/linked-source", methods=["GET"])
    def linked_source():
        record = source_of(request.args.get("path", ""))
        if record is None:
            abort(404)
        return jsonify(record)

    return bp
