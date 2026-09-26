# sam-ui (Apache-2.0). New file, not from SAM 2.
"""HTTP routes for track jobs, streamed in the demo's multipart format (the
same parts /propagate_in_video sends).

POST /track_objects {session_id, object_ids?}: run the untracked and stale
  objects (or the object_ids given) that no other running job holds. Headers:
  Job-Id, and Objects-Tracked (the objects this job claimed). The job takes
  the model lock one frame at a time, so clicks are served between frames.
  The last part is {"done": true, "job_id", "objects", "tracked", "failed"}, or
  {"done": false, "job_id", "error", "objects"} when the engine failed or the
  job was cancelled; it also carries frame_index -1 and results [], so a
  parser that expects every part to be a frame reads it as an empty frame.
POST /track_masks {session_id, object_ids?}: stream cached tracks, to repaint
  them after a reload (disk only, no lock).
POST /cancel_track {session_id, job_id}: cancel one job. (cancelPropagateInVideo
  cancels every job of its session.)
POST /track_jobs {session_id}: the running jobs on the session's video, with
  progress.

The routes get everything through `resolve(session_id)`, so tests can mount
them with a fake engine and no model.
"""
import contextlib
import json
import logging
from dataclasses import dataclass, field
from typing import Callable, Iterator, Optional

from flask import Blueprint, Response, jsonify, request

from inference.multipart import MultipartResponseBuilder
from tracks.jobs import Job
from tracks.service import FrameRle, JobResult, TrackService

BOUNDARY = "frame"
logger = logging.getLogger(__name__)


@dataclass
class TrackContext:
    service: TrackService
    video: str
    path: str
    session_id: str = ""
    lock: contextlib.AbstractContextManager = field(default_factory=contextlib.nullcontext)
    autocast: Callable[[], contextlib.AbstractContextManager] = contextlib.nullcontext
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


def _n_frames(handle) -> Optional[int]:
    try:
        return len(handle["images"])
    except (TypeError, KeyError):
        return None


def _run_job(ctx: TrackContext, job: Job) -> Iterator[bytes]:
    """Stream one job. The model lock is held per step (one frame, or the
    seeding before the first one), never across a yield to the client."""
    service, result = ctx.service, JobResult()
    try:
        with ctx.autocast():
            it = service.track(ctx.video, ctx.path, job.objects, video_handle=ctx.video_handle, result=result)
            try:
                while True:
                    if job.canceled:
                        yield _closing({"done": False, "job_id": job.id, "error": "canceled", "objects": job.objects})
                        return
                    with ctx.lock:
                        try:
                            frame, masks = next(it)
                        except StopIteration:
                            break
                    job.frames_done += 1
                    yield part(frame, masks)
            except Exception as err:
                logger.exception(f"track job {job.id} failed")
                yield _closing({"done": False, "job_id": job.id, "error": f"{type(err).__name__}: {err}",
                                "objects": job.objects})
                return
            finally:
                with ctx.lock:
                    it.close()  # a cancel, an error or a dropped client: the job caches nothing
        yield _closing({"done": True, "job_id": job.id, "objects": result.objects, "tracked": result.tracked,
                        "failed": {str(o): e for o, e in result.failed.items()}})
    finally:
        service.jobs.release(job)


def _stream_cached(frames: Iterator[FrameRle]) -> Iterator[bytes]:
    for frame, masks in frames:
        yield part(frame, masks)


def make_blueprint(resolve: Callable[[str], TrackContext]) -> Blueprint:
    bp = Blueprint("tracks", __name__)

    def _response(body: Iterator[bytes], ids, job: Optional[Job] = None) -> Response:
        r = Response(body, mimetype=f"multipart/x-savi-stream; boundary={BOUNDARY}")
        r.headers["Objects-Tracked"] = ",".join(str(o) for o in ids)
        expose = ["Objects-Tracked"]
        if job is not None:
            r.headers["Job-Id"] = job.id
            expose.append("Job-Id")
        r.headers["Access-Control-Expose-Headers"] = ", ".join(expose)
        return r

    @bp.route("/track_objects", methods=["POST"])
    def track_objects() -> Response:
        data = request.json
        ctx = resolve(data["session_id"])
        with ctx.lock:  # a consistent read of the seeds and tracks
            ids = ctx.service.select(ctx.video, data.get("object_ids"))
        job = ctx.service.jobs.claim(ctx.session_id, ctx.video, ids, _n_frames(ctx.video_handle))
        r = _response(_run_job(ctx, job), job.objects, job)
        r.call_on_close(lambda: ctx.service.jobs.release(job))  # also if the stream never started
        return r

    @bp.route("/track_masks", methods=["POST"])
    def track_masks() -> Response:
        data = request.json
        ctx = resolve(data["session_id"])
        ids: Optional[list] = data.get("object_ids")
        shown = ctx.service.seeds.objects(ctx.video) if ids is None else ids
        return _response(_stream_cached(ctx.service.cached(ctx.video, ids)), shown)

    @bp.route("/cancel_track", methods=["POST"])
    def cancel_track() -> Response:
        data = request.json
        return jsonify({"canceled": resolve(data["session_id"]).service.jobs.cancel(data["job_id"])})

    @bp.route("/track_jobs", methods=["POST"])
    def track_jobs() -> Response:
        ctx = resolve(request.json["session_id"])
        return jsonify({"jobs": ctx.service.jobs.running(ctx.video)})

    return bp
