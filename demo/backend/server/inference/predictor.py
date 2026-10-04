# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
# This source code is licensed under the license found in the
# LICENSE file in the root directory of this source tree.
# Modified by sam-ui: clicks are recorded as seeds, track jobs run through tracks/, a correction refines the cached track mask, and a positive inside an absent range ends it there (clicks with no positive there are refused); undo, redo and versions of an object's seeds, and moving a frame's clicks to another object. A text prompt's seed mask (SAM 3, /text_prompt) joins the session like a replayed seed.

import contextlib
import logging
import os
import time
import uuid
from pathlib import Path
from threading import Lock
from typing import Any, Dict, Generator, List, Optional

import numpy as np
import torch
from app_conf import APP_ROOT, DATA_PATH, MODEL_SIZE
from inference.data_types import (
    AddMaskRequest,
    AddPointsRequest,
    CancelPorpagateResponse,
    CancelPropagateInVideoRequest,
    ClearPointsInFrameRequest,
    ClearPointsInVideoRequest,
    ClearPointsInVideoResponse,
    CloseSessionRequest,
    CloseSessionResponse,
    Mask,
    PropagateDataResponse,
    PropagateDataValue,
    PropagateInVideoRequest,
    RemoveObjectRequest,
    RemoveObjectResponse,
    StartSessionRequest,
    StartSessionResponse,
)
from pycocotools.mask import decode as decode_masks
from sam2.build_sam import build_sam2_video_predictor
from tracks import rle as track_rle
from tracks.engine import Sam2Engine, seed_into_state
from tracks.features import VIDEO_KEY, FeatureCache, default_cache_gb, install as install_feature_cache
from tracks.streaming import install_sam2_streaming
from tracks.routes import TrackContext
from tracks.seeds import cleared
from tracks import sam3_engine
from tracks.service import EngineSpec, ObjectBusy, TrackService
from tracks.text import has_prompt


logger = logging.getLogger(__name__)

# sam-ui: the refusal a click gets when SAM 2 would be handed a frame with no
# positive; its message starts with "needs_positive: " for the studio to match.
NEEDS_POSITIVE = "needs_positive"
# the engines that take a frame of only negatives as "not here"; every other
# engine (none named, a typo, one this server doesn't know) is held to SAM 2's rule
TAKES_NOT_HERE = ("sam3",)


class InferenceAPI:

    def __init__(self, predictor=None, device=None, tracks_root=None) -> None:
        """sam-ui: predictor, device and tracks_root can be injected (tests use a
        stub predictor); by default the model is built as upstream does."""
        super(InferenceAPI, self).__init__()

        self.session_states: Dict[str, Any] = {}
        self.score_thresh = 0
        if predictor is not None:
            self.device = device or torch.device("cpu")
            self.predictor = predictor
            self.inference_lock = Lock()
            self._init_tracks(tracks_root)
            return

        if MODEL_SIZE == "tiny":
            checkpoint = Path(APP_ROOT) / "checkpoints/sam2.1_hiera_tiny.pt"
            model_cfg = "configs/sam2.1/sam2.1_hiera_t.yaml"
        elif MODEL_SIZE == "small":
            checkpoint = Path(APP_ROOT) / "checkpoints/sam2.1_hiera_small.pt"
            model_cfg = "configs/sam2.1/sam2.1_hiera_s.yaml"
        elif MODEL_SIZE == "large":
            checkpoint = Path(APP_ROOT) / "checkpoints/sam2.1_hiera_large.pt"
            model_cfg = "configs/sam2.1/sam2.1_hiera_l.yaml"
        else:  # base_plus (default)
            checkpoint = Path(APP_ROOT) / "checkpoints/sam2.1_hiera_base_plus.pt"
            model_cfg = "configs/sam2.1/sam2.1_hiera_b+.yaml"

        # select the device for computation
        force_cpu_device = os.environ.get("SAM2_DEMO_FORCE_CPU_DEVICE", "0") == "1"
        if force_cpu_device:
            logger.info("forcing CPU device for SAM 2 demo")
        if torch.cuda.is_available() and not force_cpu_device:
            device = torch.device("cuda")
        elif torch.backends.mps.is_available() and not force_cpu_device:
            device = torch.device("mps")
        else:
            device = torch.device("cpu")
        logger.info(f"using device: {device}")

        if device.type == "cuda":
            # turn on tfloat32 for Ampere GPUs (https://pytorch.org/docs/stable/notes/cuda.html#tensorfloat-32-tf32-on-ampere-devices)
            if torch.cuda.get_device_properties(0).major >= 8:
                torch.backends.cuda.matmul.allow_tf32 = True
                torch.backends.cudnn.allow_tf32 = True
        elif device.type == "mps":
            logging.warning(
                "\nSupport for MPS devices is preliminary. SAM 2 is trained with CUDA and might "
                "give numerically different outputs and sometimes degraded performance on MPS. "
                "See e.g. https://github.com/pytorch/pytorch/issues/84936 for a discussion."
            )

        self.device = device
        self.predictor = build_sam2_video_predictor(
            model_cfg, checkpoint, device=device
        )
        self.inference_lock = Lock()
        self._init_tracks(None)

    def _init_tracks(self, tracks_root) -> None:
        """sam-ui: seeds and cached tracks, per video, under DATA_PATH/tracks;
        and a backbone-feature cache shared by sessions and jobs on a video
        (SAM_UI_FEATURE_CACHE_GB, default a quarter of RAM up to 6; 0 turns it
        off). Frames are decoded as tracking reaches them (tracks/streaming.py),
        so a clip's length no longer sets its memory."""
        install_sam2_streaming()
        cache_gb = float(os.environ.get("SAM_UI_FEATURE_CACHE_GB", default_cache_gb()))
        if cache_gb > 0:
            install_feature_cache(self.predictor, FeatureCache(int(cache_gb * (1 << 30))))
        self.tracks = TrackService(
            str(tracks_root or DATA_PATH / "tracks"),
            Sam2Engine(
                self.predictor,
                model=MODEL_SIZE,
                offload_video_to_cpu=self.device.type == "mps",
                autocast=self.autocast_context,
                score_thresh=self.score_thresh,
            ),
            # SAM 3, opt-in per track job; built on first use, and only if its
            # weights and transformers are present (sam3_engine.available)
            extra=[
                EngineSpec(
                    name=sam3_engine.Sam3Engine.name,
                    model=sam3_engine.Sam3Engine.model,
                    factory=sam3_engine.Sam3Engine,
                    unavailable=sam3_engine.available,
                    text=sam3_engine.text_available,  # its detector reads text prompts
                )
            ],
        )

    def autocast_context(self):
        if self.device.type == "cuda":
            return torch.autocast("cuda", dtype=torch.bfloat16)
        else:
            return contextlib.nullcontext()

    def start_session(self, request: StartSessionRequest) -> StartSessionResponse:
        with self.autocast_context(), self.inference_lock:
            self._expire_idle_sessions()
            session_id = str(uuid.uuid4())
            # for MPS devices, we offload the video frames to CPU by default to avoid
            # memory fragmentation in MPS (which sometimes crashes the entire process)
            offload_video_to_cpu = self.device.type == "mps"
            inference_state = self.predictor.init_state(
                request.path,
                offload_video_to_cpu=offload_video_to_cpu,
            )
            # sam-ui: replay the stored seeds (their approved masks), so a reload
            # keeps its objects and a click on a seed frame refines its mask.
            # Frame-major: each frame's backbone features serve every object.
            # A cleared ('not on this frame') seed is skipped: SAM 2 never conditions on one.
            video = self.tracks.video_key(request.path)
            inference_state[VIDEO_KEY] = video  # opts the session (and its jobs) into the feature cache
            seeds = {o: self.tracks.seeds.seeds(video, o) for o in self.tracks.seeds.objects(video)}
            for frame_idx, obj_id in sorted(
                (f, o) for o, s in seeds.items() for f, v in s.items() if has_prompt(v) and not cleared(v)
            ):
                seed_into_state(self.predictor, inference_state, obj_id, frame_idx, seeds[obj_id][frame_idx])
            self.session_states[session_id] = {
                "canceled": False,
                "state": inference_state,
                "video": video,
                "path": request.path,
                "last_used": time.time(),
            }
            return StartSessionResponse(session_id=session_id)

    def close_session(self, request: CloseSessionRequest) -> CloseSessionResponse:
        is_successful = self.__clear_session_state(request.session_id)
        return CloseSessionResponse(success=is_successful)

    def add_points(
        self, request: AddPointsRequest, test: str = ""
    ) -> PropagateDataResponse:
        with self.autocast_context(), self.inference_lock:
            session = self.__get_session(request.session_id)
            frame_idx, object_ids, masks_binary = self._add_points_locked(
                session, request.frame_index, request.object_id, request.points, request.labels,
                request.clear_old_points, request.engine)
            rle_mask_list = self.__get_rle_mask_list(
                object_ids=object_ids, masks=masks_binary
            )

            return PropagateDataResponse(
                frame_index=frame_idx,
                results=rle_mask_list,
            )

    def _add_points_locked(self, session, frame_idx, obj_id, points, labels, clear_old_points, engine=None):
        """sam-ui: add_points' work, with the inference lock held: SAM 2's
        answer on the frame, recorded as the object's seed there. `engine` is
        the one the studio tracks with; none is held to SAM 2's rule."""
        inference_state = session["state"]

        # sam-ui: SAM 2 was trained on a positive first, then corrections; given
        # only negatives it empties the frame, and an empty frame saved as a seed
        # erases the object on the frames around it (measured). So on SAM 2 a frame
        # whose clicks have no positive is refused; SAM 3 takes it as "not here".
        # An unknown engine is treated as SAM 2, so a typo can't poison a seed.
        if clear_old_points:
            user_labels = [int(l) for l in labels]
        else:
            old = self.tracks.seeds.seeds(session["video"], obj_id).get(frame_idx) or {}
            user_labels = [int(l) for l in old.get("labels", [])] + [int(l) for l in labels]
        if user_labels and 1 not in user_labels and engine not in TAKES_NOT_HERE:
            raise ValueError(f"{NEEDS_POSITIVE}: SAM 2 needs a positive click to keep part of object {obj_id} "
                             f"on frame {frame_idx}")

        # sam-ui: the object is marked absent here. Clicks with no positive
        # have nothing to point at and are refused; the studio says so
        # before it sends. A positive says the object is back: the absence
        # ends at this frame (Nate, 2026-10-02), once the click has gone
        # through, so a failed click leaves the range whole.
        absent = self.tracks.is_absent(session["video"], obj_id, frame_idx)
        if absent and 1 not in user_labels:
            raise ValueError(
                f"frame {frame_idx} is inside a range where object {obj_id} is marked absent; "
                "unmark that part of the range to click here"
            )

        # sam-ui: a first click on a frame SAM 2 holds no mask for (a frame
        # tracked by a job, not in this state) refines that frame's cached
        # mask, as a correction should, instead of starting from nothing.
        # Not on a frame that was absent: a cached mask there predates the
        # range, and is what the user said was not the object.
        primed = False
        if not absent and not self.__has_output(inference_state, obj_id, frame_idx):
            prime = self.tracks.prime_mask(session["video"], obj_id, frame_idx)
            if prime is not None:
                self.predictor.add_new_mask(
                    inference_state=inference_state,
                    frame_idx=frame_idx,
                    obj_id=obj_id,
                    mask=track_rle.decode(prime),
                )
                primed = True

        # add new prompts and instantly get the output on the same frame
        try:
            frame_idx, object_ids, masks = self.predictor.add_new_points_or_box(
                inference_state=inference_state,
                frame_idx=frame_idx,
                obj_id=obj_id,
                points=points,
                labels=labels,
                clear_old_points=clear_old_points,
                normalize_coords=False,
            )
        except Exception:
            if primed:  # keep the session in step with the seed store, which records nothing
                self.predictor.clear_all_prompts_in_frame(inference_state, frame_idx, obj_id)
            raise

        masks_binary = (masks > self.score_thresh)[:, 0].cpu().numpy()
        # a positive inside an absent range ends it here, in the same seed
        # change as the click: one undo step puts both back (issue #18)
        self.tracks.record_points(
            session["video"],
            obj_id,
            frame_idx,
            points,
            labels,
            clear_old_points,
            mask=track_rle.encode(masks_binary[list(object_ids).index(obj_id)]),
            end_absence=absent,
        )
        return frame_idx, object_ids, masks_binary

    def add_mask(self, request: AddMaskRequest) -> PropagateDataResponse:
        """
        Add new points on a specific video frame.
        - mask is a numpy array of shape [H_im, W_im] (containing 1 for foreground and 0 for background).
        Note: providing an input mask would overwrite any previous input points on this frame.
        """
        with self.autocast_context(), self.inference_lock:
            session_id = request.session_id
            frame_idx = request.frame_index
            obj_id = request.object_id
            rle_mask = {
                "counts": request.mask.counts,
                "size": request.mask.size,
            }

            mask = decode_masks(rle_mask)

            logger.info(
                f"add mask on frame {frame_idx} in session {session_id}: {obj_id=}, {mask.shape=}"
            )
            session = self.__get_session(session_id)
            inference_state = session["state"]

            frame_idx, obj_ids, video_res_masks = self.model.add_new_mask(
                inference_state=inference_state,
                frame_idx=frame_idx,
                obj_id=obj_id,
                mask=torch.tensor(mask > 0),
            )
            masks_binary = (video_res_masks > self.score_thresh)[:, 0].cpu().numpy()

            rle_mask_list = self.__get_rle_mask_list(
                object_ids=obj_ids, masks=masks_binary
            )

            return PropagateDataResponse(
                frame_index=frame_idx,
                results=rle_mask_list,
            )

    def clear_points_in_frame(
        self, request: ClearPointsInFrameRequest
    ) -> PropagateDataResponse:
        """
        Remove all input points in a specific frame.
        """
        with self.autocast_context(), self.inference_lock:
            session_id = request.session_id
            frame_idx = request.frame_index
            obj_id = request.object_id

            logger.info(
                f"clear inputs on frame {frame_idx} in session {session_id}: {obj_id=}"
            )
            session = self.__get_session(session_id)
            inference_state = session["state"]
            frame_idx, obj_ids, video_res_masks = (
                self.predictor.clear_all_prompts_in_frame(
                    inference_state, frame_idx, obj_id
                )
            )
            self.tracks.clear_frame(session["video"], obj_id, request.frame_index)
            masks_binary = (video_res_masks > self.score_thresh)[:, 0].cpu().numpy()

            rle_mask_list = self.__get_rle_mask_list(
                object_ids=obj_ids, masks=masks_binary
            )

            return PropagateDataResponse(
                frame_index=frame_idx,
                results=rle_mask_list,
            )

    def clear_points_in_video(
        self, request: ClearPointsInVideoRequest
    ) -> ClearPointsInVideoResponse:
        """
        Remove all input points in all frames throughout the video.
        """
        with self.autocast_context(), self.inference_lock:
            session_id = request.session_id
            logger.info(f"clear all inputs across the video in session {session_id}")
            session = self.__get_session(session_id)
            inference_state = session["state"]
            self.predictor.reset_state(inference_state)
            self.tracks.clear_video(session["video"])  # "start over" forgets the cache too
            return ClearPointsInVideoResponse(success=True)

    def remove_object(self, request: RemoveObjectRequest) -> RemoveObjectResponse:
        """
        Remove an object id from the tracking state.
        """
        with self.autocast_context(), self.inference_lock:
            session_id = request.session_id
            obj_id = request.object_id
            logger.info(f"remove object in session {session_id}: {obj_id=}")
            session = self.__get_session(session_id)
            inference_state = session["state"]
            new_obj_ids, updated_frames = self.predictor.remove_object(
                inference_state, obj_id
            )
            self.tracks.remove_object(session["video"], obj_id)

            results = []
            for frame_index, video_res_masks in updated_frames:
                masks = (video_res_masks > self.score_thresh)[:, 0].cpu().numpy()
                rle_mask_list = self.__get_rle_mask_list(
                    object_ids=new_obj_ids, masks=masks
                )
                results.append(
                    PropagateDataResponse(
                        frame_index=frame_index,
                        results=rle_mask_list,
                    )
                )

            return RemoveObjectResponse(results=results)

    def propagate_in_video(
        self, request: PropagateInVideoRequest
    ) -> Generator[PropagateDataResponse, None, None]:
        session_id = request.session_id
        start_frame_idx = request.start_frame_index
        propagation_direction = "both"
        max_frame_num_to_track = None

        """
        Propagate existing input points in all frames to track the object across video.
        """

        # Note that as this method is a generator, we also need to use autocast_context
        # in caller to this method to ensure that it's called under the correct context
        # (we've added `autocast_context` to `gen_track_with_mask_stream` in app.py).
        with self.autocast_context(), self.inference_lock:
            logger.info(
                f"propagate in video in session {session_id}: "
                f"{propagation_direction=}, {start_frame_idx=}, {max_frame_num_to_track=}"
            )

            try:
                session = self.__get_session(session_id)
                session["canceled"] = False

                inference_state = session["state"]
                if propagation_direction not in ["both", "forward", "backward"]:
                    raise ValueError(
                        f"invalid propagation direction: {propagation_direction}"
                    )

                # First doing the forward propagation
                if propagation_direction in ["both", "forward"]:
                    for outputs in self.predictor.propagate_in_video(
                        inference_state=inference_state,
                        start_frame_idx=start_frame_idx,
                        max_frame_num_to_track=max_frame_num_to_track,
                        reverse=False,
                    ):
                        if session["canceled"]:
                            return None

                        frame_idx, obj_ids, video_res_masks = outputs
                        masks_binary = (
                            (video_res_masks > self.score_thresh)[:, 0].cpu().numpy()
                        )

                        rle_mask_list = self.__get_rle_mask_list(
                            object_ids=obj_ids, masks=masks_binary
                        )

                        yield PropagateDataResponse(
                            frame_index=frame_idx,
                            results=rle_mask_list,
                        )

                # Then doing the backward propagation (reverse in time)
                if propagation_direction in ["both", "backward"]:
                    for outputs in self.predictor.propagate_in_video(
                        inference_state=inference_state,
                        start_frame_idx=start_frame_idx,
                        max_frame_num_to_track=max_frame_num_to_track,
                        reverse=True,
                    ):
                        if session["canceled"]:
                            return None

                        frame_idx, obj_ids, video_res_masks = outputs
                        masks_binary = (
                            (video_res_masks > self.score_thresh)[:, 0].cpu().numpy()
                        )

                        rle_mask_list = self.__get_rle_mask_list(
                            object_ids=obj_ids, masks=masks_binary
                        )

                        yield PropagateDataResponse(
                            frame_index=frame_idx,
                            results=rle_mask_list,
                        )
            finally:
                # Log upon completion (so that e.g. we can see if two propagations happen in parallel).
                # Using `finally` here to log even when the tracking is aborted with GeneratorExit.
                logger.info(
                    f"propagation ended in session {session_id}; {self.__get_session_stats()}"
                )

    # -- sam-ui: videos ----------------------------------------------------------
    def video_in_use(self, path: str) -> bool:
        """Whether an open session holds this video file."""
        target = Path(path).resolve()
        return any(Path(s["path"]).resolve() == target for s in self.session_states.values())

    def close_idle_sessions_on(self, path: str, idle_s: float = 60.0) -> int:
        """Close sessions on this video untouched for `idle_s` seconds and with no
        running track job: tabs that went away without closeSession. A session
        used within the last minute is someone's, and is left alone."""
        target, now = Path(path).resolve(), time.time()
        stale = [
            sid
            for sid, s in self.session_states.items()
            if Path(s["path"]).resolve() == target
            and now - s.get("last_used", now) > idle_s
            and not self.tracks.jobs.session_busy(sid)
        ]
        for sid in stale:
            self.session_states.pop(sid, None)
        return len(stale)

    def purge_video(self, path: str) -> None:
        """Drop a video's seeds and cached tracks (keyed by its sha256)."""
        with self.inference_lock:
            self.tracks.clear_video(self.tracks.video_key(path))

    # -- sam-ui: per-object tracks -------------------------------------------
    def object_tracks(self, session_id: str) -> List[Dict]:
        session = self.__get_session(session_id)
        return self.tracks.objects(session["video"])

    def set_object_range(self, session_id: str, object_id: int, start: int, end: int, state=None,
                         source=None, score=None, clear=None) -> Dict:
        """Set frames start-end of an object to a range state ("absent",
        "present", or "candidate" with its source and score), or clear them
        (None: every state, or the states in `clear`)."""
        with self.inference_lock:  # not while a job reads the seeds
            session = self.__get_session(session_id)
            return self.tracks.set_range(session["video"], object_id, start, end, state, source, score, clear)

    def write_object_candidates(self, session_id: str, object_id: int, candidates, replace: bool = False) -> Dict:
        """Write candidate ranges in bulk ({"start", "end", "source", "score"?}
        each); `replace` drops the old ones. They never make a track stale."""
        with self.inference_lock:
            session = self.__get_session(session_id)
            return self.tracks.write_candidates(session["video"], object_id, list(candidates), replace)

    def clear_track(self, session_id: str, object_id: int, engine=None) -> Dict:
        with self.inference_lock:  # not while a job is writing
            session = self.__get_session(session_id)
            return self.tracks.clear_track(session["video"], object_id, engine)

    # -- sam-ui: undo, versions and moving clicks (issue #18) ---------------------
    def undo_seeds(self, session_id: str, object_id: int) -> Dict:
        """Undo the object's last seed change; its earlier track comes back
        from its version when it has one (tracks/service.py)."""
        return self.__seed_step(session_id, object_id, self.tracks.undo)

    def redo_seeds(self, session_id: str, object_id: int) -> Dict:
        return self.__seed_step(session_id, object_id, self.tracks.redo)

    def restore_version(self, session_id: str, object_id: int, key: str) -> Dict:
        return self.__seed_step(session_id, object_id, lambda v, o: self.tracks.restore_version(v, o, key))

    def object_versions(self, session_id: str, object_id: int) -> Dict:
        return self.tracks.versions_info(self.__get_session(session_id)["video"], object_id)

    def __seed_step(self, session_id: str, object_id: int, step) -> Dict:
        with self.autocast_context(), self.inference_lock:  # not while a job reads the seeds or saves
            session = self.__get_session(session_id)
            before = self.tracks.seeds.seeds(session["video"], object_id)
            info = step(session["video"], object_id)
            self.__resync(session["state"], object_id, before, info["seeds"])
            return info

    def __resync(self, inference_state, obj_id: int, before: Dict, after: Dict) -> None:
        """Bring the session's SAM 2 state in step with seeds that changed
        under it: each frame that differs is cleared, then seeded again from
        the restored seed (its approved mask), as start_session replays one."""
        for frame in sorted(set(before) | set(after)):
            old, new = before.get(frame), after.get(frame)
            if old == new:
                continue
            self.__forget_frame(inference_state, obj_id, frame)
            # a cleared ('not on this frame') seed is skipped, as start_session does
            if new and (new.get("mask") or new.get("points")) and not cleared(new):
                seed_into_state(self.predictor, inference_state, obj_id, frame, new)

    def __forget_frame(self, inference_state, obj_id: int, frame: int) -> None:
        """Drop the object's inputs and every output SAM 2 holds on this frame.
        clear_all_prompts_in_frame keeps a consolidated output as a
        non-conditioning one, which a later click would refine (and
        __has_output would count) instead of priming from the cached track."""
        idx = inference_state["obj_id_to_idx"].get(obj_id)
        if idx is None:
            return
        self.predictor.clear_all_prompts_in_frame(inference_state, frame, obj_id, need_output=False)
        for d in (inference_state["output_dict_per_obj"].get(idx, {}),
                  inference_state["temp_output_dict_per_obj"].get(idx, {})):
            for k in ("cond_frame_outputs", "non_cond_frame_outputs"):
                d.get(k, {}).pop(frame, None)
        inference_state.get("frames_tracked_per_obj", {}).get(idx, {}).pop(frame, None)

    def move_clicks(self, session_id: str, frame_index: int, from_id: int, to_id: int,
                    engine: Optional[str] = None) -> List[Dict]:
        """Move one object's clicks on a frame to another object (clicks that
        landed on the wrong one). The source loses the frame; the target gets
        the clicks after its own on that frame, segmented as a click there
        would be. Each object's change is one undo step of its own. Refused
        into the target's absent range, and while a job holds either object.
        `engine` is the one the studio shows: the target's clicks are held to
        its rule, as a click would be (none, or any but SAM 3, is SAM 2's)."""
        with self.autocast_context(), self.inference_lock:
            if from_id == to_id:
                raise ValueError("cannot move clicks to the object itself")
            session = self.__get_session(session_id)
            video, state = session["video"], session["state"]
            held = self.tracks.jobs.held(video)
            for o in (from_id, to_id):
                if o in held:
                    raise ObjectBusy(f"object {o} is being tracked: wait for its job to finish, or cancel it")
            seed = self.tracks.seeds.seeds(video, from_id).get(frame_index)
            if not seed or not seed.get("points"):
                raise ValueError(f"object {from_id} has no clicks on frame {frame_index}")
            if self.tracks.is_absent(video, to_id, frame_index):
                raise ValueError(
                    f"frame {frame_index} is inside a range where object {to_id} is marked absent; "
                    "unmark that part of its range to move clicks there"
                )
            target = self.tracks.seeds.seeds(video, to_id).get(frame_index) or {"points": [], "labels": []}
            # the target first: if SAM 2 fails on it, the source still has its clicks
            self._add_points_locked(session, frame_index, to_id, target["points"] + seed["points"],
                                    target["labels"] + seed["labels"], True, engine)
            self.__forget_frame(state, from_id, frame_index)
            self.tracks.clear_frame(video, from_id, frame_index)
            return [self.tracks.object_info(video, from_id), self.tracks.object_info(video, to_id)]

    def track_context(self, session_id: str) -> TrackContext:
        session = self.__get_session(session_id)

        def seed_mask(obj_id: int, frame_idx: int, mask) -> None:
            # a text prompt's mask replaces the frame's inputs in the session, as
            # start_session replays a seed, so a click there refines it
            self.predictor.add_new_mask(
                inference_state=session["state"], frame_idx=frame_idx, obj_id=obj_id, mask=mask
            )

        return TrackContext(
            service=self.tracks,
            video=session["video"],
            path=session["path"],
            session_id=session_id,
            lock=self.inference_lock,
            autocast=self.autocast_context,
            video_handle=session["state"],
            seed_mask=seed_mask,
        )

    @staticmethod
    def __has_output(inference_state, obj_id: int, frame_idx: int) -> bool:
        """Whether SAM 2 holds a mask for this object on this frame (so a click
        there refines it)."""
        obj_idx = inference_state["obj_id_to_idx"].get(obj_id)
        if obj_idx is None:
            return False
        for d in (inference_state["temp_output_dict_per_obj"].get(obj_idx, {}),
                  inference_state["output_dict_per_obj"].get(obj_idx, {})):
            for k in ("cond_frame_outputs", "non_cond_frame_outputs"):
                if frame_idx in d.get(k, {}):
                    return True
        return False

    def cancel_propagate_in_video(
        self, request: CancelPropagateInVideoRequest
    ) -> CancelPorpagateResponse:
        session = self.__get_session(request.session_id)
        session["canceled"] = True
        self.tracks.jobs.cancel_session(request.session_id)  # sam-ui: and its track jobs
        return CancelPorpagateResponse(success=True)

    def __get_rle_mask_list(
        self, object_ids: List[int], masks: np.ndarray
    ) -> List[PropagateDataValue]:
        """
        Return a list of data values, i.e. list of object/mask combos.
        """
        return [
            self.__get_mask_for_object(object_id=object_id, mask=mask)
            for object_id, mask in zip(object_ids, masks)
        ]

    def __get_mask_for_object(
        self, object_id: int, mask: np.ndarray
    ) -> PropagateDataValue:
        """
        Create a data value for an object/mask combo.
        """
        mask_rle = track_rle.encode(mask)
        return PropagateDataValue(
            object_id=object_id,
            mask=Mask(
                size=mask_rle["size"],
                counts=mask_rle["counts"],
            ),
        )

    def __get_session(self, session_id: str):
        session = self.session_states.get(session_id, None)
        if session is None:
            raise RuntimeError(
                f"Cannot find session {session_id}; it might have expired"
            )
        session["last_used"] = time.time()
        return session

    def _expire_idle_sessions(self) -> List[str]:
        """sam-ui: free sessions idle longer than SAM_UI_SESSION_TTL_MIN (default
        30; 0 keeps them forever). Each holds its whole decoded video, and a
        closed browser tab never calls closeSession. A session with a running
        track job is kept: the job reads its video."""
        ttl = float(os.environ.get("SAM_UI_SESSION_TTL_MIN", "30")) * 60
        if ttl <= 0:
            return []
        now = time.time()
        expired = [
            sid
            for sid, s in self.session_states.items()
            if now - s.get("last_used", now) > ttl and not self.tracks.jobs.session_busy(sid)
        ]
        for sid in expired:
            self.session_states.pop(sid, None)
            logger.info(f"expired idle session {sid}")
        return expired

    def __get_session_stats(self):
        """Get a statistics string for live sessions and their GPU usage."""
        # print both the session ids and their video frame numbers
        live_session_strs = [
            f"'{session_id}' ({session['state']['num_frames']} frames, "
            f"{len(session['state']['obj_ids'])} objects)"
            for session_id, session in self.session_states.items()
        ]
        session_stats_str = (
            "Test String Here - -"
            f"live sessions: [{', '.join(live_session_strs)}], GPU memory: "
            f"{torch.cuda.memory_allocated() // 1024**2} MiB used and "
            f"{torch.cuda.memory_reserved() // 1024**2} MiB reserved"
            f" (max over time: {torch.cuda.max_memory_allocated() // 1024**2} MiB used "
            f"and {torch.cuda.max_memory_reserved() // 1024**2} MiB reserved)"
        )
        return session_stats_str

    def __clear_session_state(self, session_id: str) -> bool:
        session = self.session_states.pop(session_id, None)
        if session is None:
            logger.warning(
                f"cannot close session {session_id} as it does not exist (it might have expired); "
                f"{self.__get_session_stats()}"
            )
            return False
        else:
            logger.info(f"removed session {session_id}; {self.__get_session_stats()}")
            return True
