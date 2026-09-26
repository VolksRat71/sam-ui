# sam-ui (Apache-2.0). New file, not from SAM 2.
"""HTTP routes for track jobs, streamed in the demo's multipart format (the
same parts /propagate_in_video sends). The closing part also carries
`frame_index: -1` and `results: []`, so a parser that expects every part to be
a frame (Meta's SAM2Model) reads it as an empty frame instead of throwing; a
parser that knows the format checks `done` first.

POST /track_objects {session_id, object_ids?}: run the untracked and stale
  objects (or exactly object_ids). The last part is {"done": true, "objects",
  "tracked", "failed"}, or {"done": false, "error"} when the engine failed or
  the job was cancelled: only that part says what was cached. The
  Objects-Tracked header is the selection made before the job took the lock.
POST /track_masks {session_id, object_ids?}: stream cached tracks, to repaint
  them after a reload.

The routes get everything through `resolve(session_id)`, so tests can mount
them with a fake engine and no model.
"""
import contextlib
import json
import logging
from dataclasses import dataclass, field
from typing import Callable, Iterator, Optional

from flask import Blueprint, Response, request

from inference.multipart import MultipartResponseBuilder
from tracks.service import FrameRle, JobResult, TrackService

BOUNDARY = "frame"
logger = logging.getLogger(__name__)


@dataclass
class TrackContext:
    service: TrackService
    video: str
    path: str
    lock: contextlib.AbstractContextManager = field(default_factory=contextlib.nullcontext)
    autocast: Callable[[], contextlib.AbstractContextManager] = contextlib.nullcontext
    canceled: Callable[[], bool] = lambda: False
    reset_cancel: Callable[[], None] = lambda: None
    video_handle: Optional[object] = None  # the session's loaded video, shared with jobs


def part(frame: int, masks) -> bytes:
    return _part({"frame_index": int(frame),
                  "results": [{"object_id": int(o), "mask": {"size": r["size"], "counts": r["counts"]}}
                              for o, r in sorted(masks.items())]})


def _closing(body: dict) -> bytes:
    return _part({"frame_index": -1, "results": [], **body})


def _part(body: dict) -> bytes:
    return MultipartResponseBuilder.build(
        boundary=BOUNDARY,
        headers={"Content-Type": "application/json; charset=utf-8", "Frame-Current": "-1",
                 "Frame-Total": "-1", "Mask-Type": "RLE[]"},
        body=json.dumps(body).encode("utf-8"),
    ).get_message()


def _stream(ctx: TrackContext, frames: Callable[[], Iterator[FrameRle]],
            result: Optional[JobResult] = None) -> Iterator[bytes]:
    """Stream frames under the inference lock. With `result`, end with a
    closing part saying what the job did."""
    with ctx.lock, ctx.autocast():
        ctx.reset_cancel()
        it = frames()
        try:
            for frame, masks in it:
                if ctx.canceled():
                    it.close()
                    if result is not None:
                        yield _closing({"done": False, "error": "canceled", "objects": result.objects})
                    return
                yield part(frame, masks)
        except Exception as err:
            logger.exception("track job failed")
            if result is not None:
                yield _closing({"done": False, "error": f"{type(err).__name__}: {err}", "objects": result.objects})
            return
        finally:
            it.close()  # a cancel or a dropped client: the job caches nothing
        if result is not None:
            yield _closing({"done": True, "objects": result.objects, "tracked": result.tracked,
                            "failed": {str(o): e for o, e in result.failed.items()}})


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
        wanted = data.get("object_ids")
        result = JobResult()
        # select again once the lock is held: two quick presses must not both run the same objects
        body = _stream(ctx, lambda: ctx.service.track(ctx.video, ctx.path, ctx.service.select(ctx.video, wanted),
                                                      video_handle=ctx.video_handle, result=result), result)
        return _response(body, ctx.service.select(ctx.video, wanted))

    @bp.route("/track_masks", methods=["POST"])
    def track_masks() -> Response:
        data = request.json
        ctx = resolve(data["session_id"])
        ids: Optional[list] = data.get("object_ids")
        shown = ctx.service.seeds.objects(ctx.video) if ids is None else ids
        return _response(_stream(ctx, lambda: ctx.service.cached(ctx.video, ids)), shown)

    return bp
