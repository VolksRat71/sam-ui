# sam-ui (Apache-2.0). New file, not from SAM 2.
"""HTTP routes for track jobs, streamed in the demo's multipart format (the
same parts /propagate_in_video sends), so the frontend's parser is reused.

POST /track_objects {session_id, object_ids?}: run the untracked and stale
  objects (or exactly object_ids); the Objects-Tracked header lists them.
POST /track_masks {session_id, object_ids?}: stream cached tracks, to repaint
  them after a reload.

The routes get everything through `resolve(session_id)`, so tests can mount
them with a fake engine and no model.
"""
import contextlib
import json
from dataclasses import dataclass, field
from typing import Callable, Iterator, Optional

from flask import Blueprint, Response, request

from inference.multipart import MultipartResponseBuilder
from tracks.service import FrameRle, TrackService

BOUNDARY = "frame"


@dataclass
class TrackContext:
    service: TrackService
    video: str
    path: str
    lock: contextlib.AbstractContextManager = field(default_factory=contextlib.nullcontext)
    autocast: Callable[[], contextlib.AbstractContextManager] = contextlib.nullcontext
    canceled: Callable[[], bool] = lambda: False
    reset_cancel: Callable[[], None] = lambda: None


def part(frame: int, masks) -> bytes:
    body = {"frame_index": int(frame),
            "results": [{"object_id": int(o), "mask": {"size": r["size"], "counts": r["counts"]}}
                        for o, r in sorted(masks.items())]}
    return MultipartResponseBuilder.build(
        boundary=BOUNDARY,
        headers={"Content-Type": "application/json; charset=utf-8", "Frame-Current": "-1",
                 "Frame-Total": "-1", "Mask-Type": "RLE[]"},
        body=json.dumps(body).encode("utf-8"),
    ).get_message()


def _stream(ctx: TrackContext, frames: Callable[[], Iterator[FrameRle]]) -> Iterator[bytes]:
    with ctx.lock, ctx.autocast():
        ctx.reset_cancel()
        it = frames()
        try:
            for frame, masks in it:
                if ctx.canceled():
                    break
                yield part(frame, masks)
        finally:
            it.close()  # a cancel or a dropped client: the job caches nothing


def make_blueprint(resolve: Callable[[str], TrackContext]) -> Blueprint:
    bp = Blueprint("tracks", __name__)

    def _response(body: Iterator[bytes], ids) -> Response:
        r = Response(body, mimetype=f"multipart/x-savi-stream; boundary={BOUNDARY}")
        r.headers["Objects-Tracked"] = ",".join(str(o) for o in ids)
        r.headers["Access-Control-Expose-Headers"] = "Objects-Tracked"
        return r

    @bp.route("/track_objects", methods=["POST"])
    def track_objects() -> Response:
        data = request.json
        ctx = resolve(data["session_id"])
        ids = ctx.service.select(ctx.video, data.get("object_ids"))
        return _response(_stream(ctx, lambda: ctx.service.track(ctx.video, ctx.path, ids)), ids)

    @bp.route("/track_masks", methods=["POST"])
    def track_masks() -> Response:
        data = request.json
        ctx = resolve(data["session_id"])
        ids: Optional[list] = data.get("object_ids")
        shown = ctx.service.seeds.objects(ctx.video) if ids is None else ids
        return _response(_stream(ctx, lambda: ctx.service.cached(ctx.video, ids)), shown)

    return bp
