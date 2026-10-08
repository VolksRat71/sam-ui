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
POST /review_queue {session_id, object_ids?, engine?, flags?, compare?}: the
  audit queue (tracks/audit.py): per object with a track on the engine, a few
  locations worth a look, best first, each {"frame", "start", "end", "score",
  "reasons": [{"kind", "frame", "strength", "detail"}], "reviewed",
  "reviewed_at"}, and every object's in one ranked "queue". flags
  ({"<object_id>": [frame]}) are the studio's review flags; compare names the
  engine whose disagreement counts (default: sam3 for sam2, else sam2).
POST /set_reviewed {session_id, object_id, frame, engine?, reviewed?, span?, reasons?}:
  mark a queue location reviewed ("looks right", tracks/review.py), or with
  reviewed false drop its marks. Metadata only. 404 without a track there.
POST /discover_text {session_id, object_id, text, stride?, engine?}: EXPERIMENTAL
  temporal text discovery (tracks/discovery.py): sample every stride-th frame
  (default 12) with the text engine's detector, group hits into appearances,
  tighten their edges by bisection, and write them as the object's candidate
  ranges from source "text:<prompt>@<engine>". A re-run replaces that
  source's; candidates are one layer, so a later scan paints over the
  overlapping candidates of other sources. Never a seed, mask or track. A job
  (kind "discover", holding no object; frames_done counts detector calls)
  that takes the model lock per detector call; /cancel_track and
  cancelPropagateInVideo cancel it, and nothing is written. Nor is anything
  written for an object removed (or a video cleared) during the scan: it
  answers as canceled. Answers
  {"job_id", "object_id", "text", "engine", "source", "stride", "n_frames",
  "intervals": [{"start", "end", "score", "hits", "best": {"frame", "score",
  "box"}}], "calls", "seconds", "object"}, or {"canceled": true, ...}. 400 on
  no text, a bad stride, or no engine that reads text.
POST /rename_object {session_id, object_id, name}: name an object (trimmed, at
  most 64 characters; empty clears it). Metadata only: no track goes stale.
  Answers {"object_id", "name"}.
POST /object_names {session_id}: {"names": {"<object_id>": name}} for the video.
POST /object_layout {session_id}: {"layout": {"order", "groups"}}, the objects'
  order and groups (tracks/layout.py). A video without one keeps creation order.
POST /set_object_layout {session_id, layout}: store it (400 when malformed).
  Metadata only: no track goes stale and nothing joins the undo history.
  Answers {"layout"} as /object_layout would.
POST /text_prompt {session_id, object_id, frame_index, text, engine?}: seed one
  frame of an object from a phrase (tracks/text.py) with the first engine that
  reads text (SAM 3), or `engine`. Answers {"object_id", "frame_index", "text",
  "engine", "matched", "score", "instances", "box", "mask"}: the best instance's
  mask as RLE, now the frame's approved seed, or matched false and mask null
  when nothing matched (nothing is stored). 400 when no engine reads text, the
  frame is absent, or there is no text.
POST /export {session_id, out_dir, objects?, include_stale?, frames?, force?, engine?, union?, flags?}:
  write tracked objects as a rotoscoping working folder (see tracks/export.py),
  in the layout's order, with a folder per group (union: a union matte each);
  out_dir (a string) must be under SAM_UI_EXPORT_ROOT (default ~/Movies/sam-ui),
  and so must every path written or deleted inside it, links followed. force
  replaces decision files and existing mattes; 400 on a refusal. The reply
  gives out_dir back as asked and leaves out the source video's path (it stays
  in the export's notes/sam-ui-export.json).
  data/review.json carries the audit queue (flags: the studio's review flags).

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
from tracks import rle
from tracks.discovery import Canceled
from tracks.export import ExportError, export
from tracks.jobs import Job
from tracks.layout import LayoutError
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
    # tells the interactive session of a new seed mask (obj_id, frame, HxW bool),
    # so a click on that frame refines it; called under `lock`
    seed_mask: Optional[Callable[[int, int, object], None]] = None


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


def _flags(data: dict) -> Optional[dict]:
    """A body's review flags, {"<object_id>": [frame]}, as {int: [int]}; None when malformed."""
    flags = data.get("flags") or {}
    if not isinstance(flags, dict) or not all(isinstance(v, list) for v in flags.values()):
        return None
    try:
        return {int(k): [int(f) for f in v] for k, v in flags.items()}
    except (TypeError, ValueError):
        return None


def _stream_cached(frames: Iterator[FrameRle]) -> Iterator[bytes]:
    for frame, masks in frames:
        yield part(frame, masks)


def make_blueprint(resolve: Callable[[str], TrackContext], service: Optional[TrackService] = None) -> Blueprint:
    """`service` serves the routes that need no session (GET /engines)."""
    bp = Blueprint("tracks", __name__)
    from tracks.detail_routes import register_detail_routes
    register_detail_routes(bp, resolve)

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
        reader = ctx.service.cached_base if data.get("base_only") is True else ctx.service.cached
        frames = reader(ctx.video, ids, data.get("engine"))
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

    @bp.route("/review_queue", methods=["POST"])
    def review_queue() -> Response:
        data = request.json
        ctx = resolve(data["session_id"])
        flags = _flags(data)
        if flags is None:
            return jsonify({"error": "flags must map object ids to lists of frames"}), 400
        # disk only, as /track_disagreement: a job's save swaps a whole track in at once
        return jsonify(ctx.service.review_queue(ctx.video, data.get("object_ids"), data.get("engine"), flags,
                                                data.get("compare")))

    @bp.route("/set_reviewed", methods=["POST"])
    def set_reviewed() -> Response:
        data = request.json
        ctx = resolve(data["session_id"])
        span = data.get("span")
        if span is not None and not (isinstance(span, list) and len(span) == 2):
            return jsonify({"error": "span is [first, last]"}), 400
        try:
            got = ctx.service.set_reviewed(ctx.video, int(data["object_id"]), int(data["frame"]), data.get("engine"),
                                           bool(data.get("reviewed", True)), tuple(span) if span else None,
                                           data.get("reasons"))
        except KeyError as err:
            return jsonify({"error": str(err)}), 404
        return jsonify(got)
    @bp.route("/text_prompt", methods=["POST"])
    def text_prompt() -> Response:
        data = request.json
        ctx = resolve(data["session_id"])
        try:
            obj = int(data["object_id"])
            with ctx.lock, ctx.autocast():  # the model, and a consistent write of the seeds
                out = ctx.service.text_prompt(ctx.video, ctx.path, obj, data.get("frame_index"), data.get("text"),
                                              data.get("engine"))
                if out["mask"] is not None and ctx.seed_mask is not None:
                    ctx.seed_mask(obj, out["frame_index"], rle.decode(out["mask"]))
        except UnknownEngine:
            raise
        except (ValueError, KeyError, TypeError) as err:
            return jsonify({"error": str(err)}), 400
        return jsonify(out)

    @bp.route("/discover_text", methods=["POST"])
    def discover_text() -> Response:
        data = request.json
        ctx = resolve(data["session_id"])
        try:
            obj = int(data["object_id"])
            stride = data.get("stride")
            if stride is not None and (isinstance(stride, bool) or not isinstance(stride, int)):
                raise ValueError(f"stride must be a whole number of frames, got {stride!r}")
            engine = ctx.service.text_engine(data.get("engine")).name  # 400 now, before a job
        except UnknownEngine:
            raise
        except (ValueError, KeyError, TypeError) as err:
            return jsonify({"error": str(err)}), 400
        # listed and cancellable like a track job, but holding no object: it writes
        # only candidate ranges, so clicks, undo and tracking go on around it
        job = ctx.service.jobs.claim(ctx.session_id, ctx.video, [], None, engine, kind="discover")

        @contextlib.contextmanager
        def step():
            with ctx.lock, ctx.autocast():
                yield

        def progress():  # detector calls, for /track_jobs
            job.frames_done += 1

        try:
            out = ctx.service.discover_text(ctx.video, ctx.path, obj, data.get("text"), stride, engine,
                                            _n_frames(ctx.video_handle), step, lambda: job.canceled, HANDOFF_S,
                                            progress)
        except Canceled:
            return jsonify({"canceled": True, "job_id": job.id, "object_id": obj, "intervals": []})
        except UnknownEngine:
            raise
        except ValueError as err:
            return jsonify({"error": str(err)}), 400
        finally:
            ctx.service.jobs.release(job)
        return jsonify({"job_id": job.id, **out})

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

    @bp.route("/object_layout", methods=["POST"])
    def object_layout() -> Response:
        ctx = resolve(request.json["session_id"])
        return jsonify({"layout": ctx.service.layout(ctx.video)})

    @bp.route("/set_object_layout", methods=["POST"])
    def set_object_layout() -> Response:
        data = request.json
        ctx = resolve(data["session_id"])
        try:
            return jsonify({"layout": ctx.service.set_layout(ctx.video, data.get("layout"))})
        except LayoutError as err:
            return jsonify({"error": str(err)}), 400

    @bp.route("/export", methods=["POST"])
    def export_route() -> Response:
        data = request.json
        ctx = resolve(data["session_id"])
        if not isinstance(data.get("out_dir"), str):
            return jsonify({"error": "out_dir must be a string"}), 400
        flags = _flags(data)
        if flags is None:
            return jsonify({"error": "flags must map object ids to lists of frames"}), 400
        try:
            manifest = export(ctx.service, ctx.video, ctx.path, data["out_dir"], objects=data.get("objects"),
                              include_stale=bool(data.get("include_stale")), frames=bool(data.get("frames")),
                              force=bool(data.get("force")), engine=data.get("engine"),
                              union=bool(data.get("union")), flags=flags)
        except ExportError as err:
            return jsonify({"error": str(err)}), 400
        # the server's own paths stay on the server
        reply = {k: v for k, v in manifest.items() if k != "video_path"}
        reply["out_dir"] = data["out_dir"]
        return jsonify(reply)

    return bp
