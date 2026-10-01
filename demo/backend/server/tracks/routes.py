# sam-ui (Apache-2.0). New file, not from SAM 2.
"""HTTP routes for track jobs, streamed in the demo's multipart format (the
same parts /propagate_in_video sends).

Every track route takes an optional "engine" ("sam2", the default, or "sam3");
an unknown or unavailable engine is a 400. GET /engines lists them.

POST /track_objects {session_id, object_ids?, engine?, full?}: run the untracked
  and stale objects (or the object_ids given) that no other running job on
  that engine holds. A stale object re-tracks only what its edits changed
  (windows, and stretches around corrections: tracks/bounded.py); full: true
  re-tracks every window whole. Headers: Job-Id, Objects-Tracked (the objects
  this job claimed), and Objects-Bounded (those it re-tracks in bounded passes). The job takes
  the model lock one frame at a time, so clicks are served between frames.
  The last part is {"done": true, "job_id", "objects", "tracked", "failed"}, or
  {"done": false, "job_id", "error", "objects"} when the engine failed or the
  job was cancelled; it also carries frame_index -1 and results [], so a
  parser that expects every part to be a frame reads it as an empty frame.
POST /track_masks {session_id, object_ids?, engine?}: stream cached tracks, to repaint
  them after a reload (disk only, no lock).
POST /cancel_track {session_id, job_id}: cancel one job. (cancelPropagateInVideo
  cancels every job of its session.)
POST /track_jobs {session_id}: the running jobs on the session's video, with
  progress and the objects each re-tracks in bounded passes ("bounded").
POST /track_disagreement {session_id, object_ids?, a?, b?, threshold?}: frames
  where two engines' current tracks of an object disagree (IoU < threshold,
  default 0.8; engines default sam2 and sam3), as review flags.
POST /track_provenance {session_id, object_id, engine?}: which pass made each
  frame of the object's track (tracks/bounded.py): {"object_id", "engine",
  "state", "passes", "provenance", "bounded"}, where bounded lists the
  [first, last] stretches bounded passes made. 404 without a track.
POST /rename_object {session_id, object_id, name}: name an object (trimmed, at
  most 64 characters; empty clears it). Metadata only: no track goes stale.
  Answers {"object_id", "name"}.
POST /object_names {session_id}: {"names": {"<object_id>": name}} for the video.
POST /export {session_id, out_dir, objects?, include_stale?, frames?, force?, engine?}:
  write tracked objects as a rotoscoping working folder (see tracks/export.py);
  out_dir must be under SAM_UI_EXPORT_ROOT (default ~/Movies). 400 on a refusal.

The routes get everything through `resolve(session_id)`, so tests can mount
them with a fake engine and no model.
"""
import contextlib
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Callable, Iterator, Optional

from flask import Blueprint, Response, jsonify, request

from inference.multipart import MultipartResponseBuilder
from tracks.export import ExportError, export
from tracks.jobs import Job
from tracks.service import FrameRle, JobResult, TrackService, UnknownEngine

BOUNDARY = "frame"
HANDOFF_S = 0.002  # after a step with no frame, time for a waiting click to take the model lock
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


def _run_job(ctx: TrackContext, job: Job, full: bool = False) -> Iterator[bytes]:
    """Stream one job. The model lock is held per step (one frame, the
    seeding before the first one, or a bounded pass's frame it holds back),
    never across a yield to the client."""
    service, result = ctx.service, JobResult()
    try:
        with ctx.autocast():
            it = service.track(ctx.video, ctx.path, job.objects, video_handle=ctx.video_handle, result=result,
                               engine=job.engine, n_frames=_n_frames(ctx.video_handle), full=full, steps=True)
            try:
                while True:
                    if job.canceled:
                        yield _closing({"done": False, "job_id": job.id, "engine": job.engine, "error": "canceled",
                                    "objects": job.objects})
                        return
                    with ctx.lock:
                        try:
                            item = next(it)
                        except StopIteration:
                            break
                    if item is None:  # a step with no frame: the lock was let go, nothing to send
                        # threading.Lock is not fair: taken straight back, a waiting click
                        # could miss every gap of a run of these steps (seconds, measured)
                        time.sleep(HANDOFF_S)
                        continue
                    frame, masks = item
                    job.frames_done += 1
                    yield part(frame, masks)
            except Exception as err:
                logger.exception(f"track job {job.id} failed")
                yield _closing({"done": False, "job_id": job.id, "engine": job.engine,
                                "error": f"{type(err).__name__}: {err}", "objects": job.objects})
                return
            finally:
                with ctx.lock:
                    it.close()  # a cancel, an error or a dropped client: the job caches nothing
        yield _closing({"done": True, "job_id": job.id, "engine": job.engine, "objects": result.objects,
                        "tracked": result.tracked, "failed": {str(o): e for o, e in result.failed.items()}})
    finally:
        service.jobs.release(job)


def _stream_cached(frames: Iterator[FrameRle]) -> Iterator[bytes]:
    for frame, masks in frames:
        yield part(frame, masks)


def make_blueprint(resolve: Callable[[str], TrackContext], service: Optional[TrackService] = None) -> Blueprint:
    """`service` serves the routes that need no session (GET /engines)."""
    bp = Blueprint("tracks", __name__)

    def _response(body: Iterator[bytes], ids, job: Optional[Job] = None) -> Response:
        r = Response(body, mimetype=f"multipart/x-savi-stream; boundary={BOUNDARY}")
        r.headers["Objects-Tracked"] = ",".join(str(o) for o in ids)
        expose = ["Objects-Tracked"]
        if job is not None:
            r.headers["Job-Id"] = job.id
            r.headers["Objects-Bounded"] = ",".join(str(o) for o in job.bounded)
            expose += ["Job-Id", "Objects-Bounded"]
        r.headers["Access-Control-Expose-Headers"] = ", ".join(expose)
        return r

    @bp.errorhandler(UnknownEngine)
    def unknown_engine(err):
        return jsonify({"error": str(err)}), 400

    @bp.route("/engines", methods=["GET"])
    def engines() -> Response:
        if service is None:
            return jsonify({"error": "no track service"}), 404
        return jsonify({"engines": service.engines()})

    @bp.route("/track_objects", methods=["POST"])
    def track_objects() -> Response:
        data = request.json
        ctx = resolve(data["session_id"])
        engine = ctx.service.get_engine(data.get("engine")).name  # 400 now if it can't run, not mid-stream
        full = bool(data.get("full"))
        with ctx.lock:  # a consistent read of the seeds and tracks
            ids = ctx.service.select(ctx.video, data.get("object_ids"), engine)
            # frames: every frame part the job sends (None without the session's video)
            outline = ctx.service.job_outline(ctx.video, ids, _n_frames(ctx.video_handle), engine, full)
        job = ctx.service.jobs.claim(ctx.session_id, ctx.video, ids, outline["frames"], engine, outline["bounded"])
        r = _response(_run_job(ctx, job, full), job.objects, job)
        r.call_on_close(lambda: ctx.service.jobs.release(job))  # also if the stream never started
        return r

    @bp.route("/track_masks", methods=["POST"])
    def track_masks() -> Response:
        data = request.json
        ctx = resolve(data["session_id"])
        ids: Optional[list] = data.get("object_ids")
        shown = ctx.service.seeds.objects(ctx.video) if ids is None else ids
        frames = ctx.service.cached(ctx.video, ids, data.get("engine"))
        return _response(_stream_cached(frames), shown)

    @bp.route("/cancel_track", methods=["POST"])
    def cancel_track() -> Response:
        data = request.json
        return jsonify({"canceled": resolve(data["session_id"]).service.jobs.cancel(data["job_id"])})

    @bp.route("/track_jobs", methods=["POST"])
    def track_jobs() -> Response:
        ctx = resolve(request.json["session_id"])
        return jsonify({"jobs": ctx.service.jobs.running(ctx.video)})

    @bp.route("/track_disagreement", methods=["POST"])
    def track_disagreement() -> Response:
        data = request.json
        ctx = resolve(data["session_id"])
        return jsonify(ctx.service.disagreement(ctx.video, data.get("object_ids"), data.get("a"),
                                                data.get("b", "sam3"), float(data.get("threshold", 0.8))))

    @bp.route("/track_provenance", methods=["POST"])
    def track_provenance() -> Response:
        data = request.json
        ctx = resolve(data["session_id"])
        got = ctx.service.provenance(ctx.video, int(data["object_id"]), data.get("engine"))
        if got is None:
            return jsonify({"error": "no track"}), 404
        return jsonify(got)

    @bp.route("/rename_object", methods=["POST"])
    def rename_object() -> Response:
        data = request.json
        ctx = resolve(data["session_id"])
        name = data.get("name")
        if name is not None and not isinstance(name, str):
            return jsonify({"error": "name must be a string"}), 400
        obj = int(data["object_id"])
        return jsonify({"object_id": obj, "name": ctx.service.rename_object(ctx.video, obj, name)})

    @bp.route("/object_names", methods=["POST"])
    def object_names() -> Response:
        ctx = resolve(request.json["session_id"])
        return jsonify({"names": {str(o): n for o, n in ctx.service.object_names(ctx.video).items()}})

    @bp.route("/export", methods=["POST"])
    def export_route() -> Response:
        data = request.json
        ctx = resolve(data["session_id"])
        try:
            manifest = export(ctx.service, ctx.video, ctx.path, data["out_dir"], objects=data.get("objects"),
                              include_stale=bool(data.get("include_stale")), frames=bool(data.get("frames")),
                              force=bool(data.get("force")), engine=data.get("engine"))
        except ExportError as err:
            return jsonify({"error": str(err)}), 400
        return jsonify(manifest)

    return bp
