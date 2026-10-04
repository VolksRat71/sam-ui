# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
# This source code is licensed under the license found in the
# LICENSE file in the root directory of this source tree.
# Modified by sam-ui: objectTracks query, clearTrack mutation, startSession returns known objects and stays inside DATA_PATH.
# Modified by sam-ui: setObjectRange mutation (absent ranges).
# Modified by sam-ui: undoSeeds, redoSeeds, restoreVersion and moveClicks mutations.
# Modified by sam-ui: setObjectRange by state (present, candidate), setObjectCandidates mutation.

import hashlib
import os
import shutil
import tempfile
from pathlib import Path
from typing import Iterable, List, Optional, Tuple, Union

import av
import strawberry
from app_conf import (
    DATA_PATH,
    DEFAULT_VIDEO_PATH,
    MAX_UPLOAD_VIDEO_DURATION,
    RETAIN_ORIGINAL_UPLOADS,
    UPLOADS_PATH,
    UPLOADS_PREFIX,
)
from data.data_types import (
    AddPointsInput,
    CancelPropagateInVideo,
    CancelPropagateInVideoInput,
    ClearPointsInFrameInput,
    ClearPointsInVideo,
    ClearPointsInVideoInput,
    ClearTrackInput,
    DeleteVideo,
    DeleteVideoInput,
    CloseSession,
    CloseSessionInput,
    MoveClicksInput,
    ObjectTrack,
    RemoveObjectInput,
    RestoreVersionInput,
    RLEMask,
    RLEMaskForObject,
    RLEMaskListOnFrame,
    SeedHistoryInput,
    SetObjectCandidatesInput,
    SetObjectRangeInput,
    StartSession,
    StartSessionInput,
    Video,
)
from data.loader import get_video
from data.store import get_videos
from data.transcoder import get_video_metadata, transcode, VideoMetadata
from inference.data_types import (
    AddPointsRequest,
    CancelPropagateInVideoRequest,
    CancelPropagateInVideoRequest,
    ClearPointsInFrameRequest,
    ClearPointsInVideoRequest,
    CloseSessionRequest,
    RemoveObjectRequest,
    StartSessionRequest,
)
from inference.predictor import InferenceAPI
from strawberry import relay
from strawberry.file_uploads import Upload


@strawberry.type
class Query:

    @strawberry.field
    def default_video(self) -> Video:
        """
        Return the default video.

        The default video can be set with the DEFAULT_VIDEO_PATH environment
        variable. It will return the video that matches this path. If no video
        is found, it will return the first video.
        """
        all_videos = get_videos()

        # Find the video that matches the default path and return that as
        # default video.
        for _, v in all_videos.items():
            if v.path == DEFAULT_VIDEO_PATH:
                return v

        # Fallback is returning the first video
        if not all_videos:  # sam-ui: a clear error, not a bare StopIteration
            raise ValueError(
                "no videos: put an .mp4 in the data folder's gallery/ or upload one"
            )
        return next(iter(all_videos.values()))

    @relay.connection(relay.ListConnection[Video])
    def videos(
        self,
    ) -> Iterable[Video]:
        """
        Return all available videos.
        """
        all_videos = get_videos()
        return all_videos.values()

    @strawberry.field
    def object_tracks(self, session_id: str, info: strawberry.Info) -> List[ObjectTrack]:
        """sam-ui: every object known for the session's video, with its track state."""
        inference_api: InferenceAPI = info.context["inference_api"]
        return [ObjectTrack.from_info(o) for o in inference_api.object_tracks(session_id)]


@strawberry.type
class Mutation:

    @strawberry.mutation
    def upload_video(
        self,
        file: Upload,
        start_time_sec: Optional[float] = None,
        duration_time_sec: Optional[float] = None,
    ) -> Video:
        """
        Receive a video file and store it in the configured S3 bucket.
        """
        max_time = MAX_UPLOAD_VIDEO_DURATION
        filepath, file_key, vm = process_video(
            file,
            max_time=max_time,
            start_time_sec=start_time_sec,
            duration_time_sec=duration_time_sec,
        )

        video = get_video(
            filepath,
            UPLOADS_PATH,
            file_key=file_key,
            width=vm.width,
            height=vm.height,
            generate_poster=False,
        )
        get_videos()[video.code] = video  # sam-ui: list it in `videos` right away
        return video

    @strawberry.mutation
    def start_session(
        self, input: StartSessionInput, info: strawberry.Info
    ) -> StartSession:
        inference_api: InferenceAPI = info.context["inference_api"]

        request = StartSessionRequest(
            type="start_session",
            path=session_video_path(input.path),
        )

        response = inference_api.start_session(request=request)

        return StartSession(
            session_id=response.session_id,
            objects=[
                ObjectTrack.from_info(o)
                for o in inference_api.object_tracks(response.session_id)
            ],
        )

    @strawberry.mutation
    def delete_video(self, input: DeleteVideoInput, info: strawberry.Info) -> DeleteVideo:
        """sam-ui: delete an uploaded video, and with purgeTracks its seeds and
        tracks. Refused for gallery videos and for a video open in a session."""
        from data.uploads import delete_upload

        inference_api: InferenceAPI = info.context["inference_api"]
        out = delete_upload(
            input.path,
            in_use=inference_api.video_in_use,
            purge=inference_api.purge_video,
            do_purge=input.purge_tracks,
            close_idle=inference_api.close_idle_sessions_on if input.close_idle_sessions else None,
        )
        return DeleteVideo(path=out["path"], purged=out["purged"], sessions_closed=out["sessions_closed"])

    @strawberry.mutation
    def clear_track(self, input: ClearTrackInput, info: strawberry.Info) -> ObjectTrack:
        """sam-ui: drop one object's cached track; its seeds stay."""
        inference_api: InferenceAPI = info.context["inference_api"]
        return ObjectTrack.from_info(
            inference_api.clear_track(input.session_id, input.object_id, input.engine)
        )

    @strawberry.mutation
    def set_object_range(self, input: SetObjectRangeInput, info: strawberry.Info) -> ObjectTrack:
        """sam-ui: set frames start-end of an object to a range state, or
        clear them (state null; `clear` limits which states). Marking or
        unmarking absent frames makes its tracks stale (a re-track runs only
        the windows the change touched); present and candidate ranges never do."""
        inference_api: InferenceAPI = info.context["inference_api"]
        return ObjectTrack.from_info(
            inference_api.set_object_range(
                input.session_id, input.object_id, input.start, input.end, input.state,
                source=input.source, score=input.score, clear=input.clear,
            )
        )

    @strawberry.mutation
    def set_object_candidates(self, input: SetObjectCandidatesInput, info: strawberry.Info) -> ObjectTrack:
        """sam-ui: write candidate ranges in bulk; no track goes stale."""
        inference_api: InferenceAPI = info.context["inference_api"]
        cands = [{"start": c.start, "end": c.end, "source": c.source, **({} if c.score is None else {"score": c.score})}
                 for c in input.candidates]
        return ObjectTrack.from_info(
            inference_api.write_object_candidates(input.session_id, input.object_id, cands, input.replace)
        )

    @strawberry.mutation
    def undo_seeds(self, input: SeedHistoryInput, info: strawberry.Info) -> ObjectTrack:
        """sam-ui: undo the object's last seed change (a click, a cleared frame,
        a range). Its earlier track comes back from its version, with no job,
        when it has one. Refused while a job tracks the object."""
        inference_api: InferenceAPI = info.context["inference_api"]
        return ObjectTrack.from_info(inference_api.undo_seeds(input.session_id, input.object_id))

    @strawberry.mutation
    def redo_seeds(self, input: SeedHistoryInput, info: strawberry.Info) -> ObjectTrack:
        """sam-ui: redo the last seed change undone."""
        inference_api: InferenceAPI = info.context["inference_api"]
        return ObjectTrack.from_info(inference_api.redo_seeds(input.session_id, input.object_id))

    @strawberry.mutation
    def restore_version(self, input: RestoreVersionInput, info: strawberry.Info) -> ObjectTrack:
        """sam-ui: go back to one of the object's kept versions (undoable)."""
        inference_api: InferenceAPI = info.context["inference_api"]
        return ObjectTrack.from_info(inference_api.restore_version(input.session_id, input.object_id, input.key))

    @strawberry.mutation
    def move_clicks(self, input: MoveClicksInput, info: strawberry.Info) -> List[ObjectTrack]:
        """sam-ui: move one object's clicks on a frame to another object; one
        undo step per object. Refused into the target's absent range."""
        inference_api: InferenceAPI = info.context["inference_api"]
        return [
            ObjectTrack.from_info(o)
            for o in inference_api.move_clicks(
                input.session_id, input.frame_index, input.from_object_id, input.to_object_id, input.engine
            )
        ]

    @strawberry.mutation
    def close_session(
        self, input: CloseSessionInput, info: strawberry.Info
    ) -> CloseSession:
        inference_api: InferenceAPI = info.context["inference_api"]

        request = CloseSessionRequest(
            type="close_session",
            session_id=input.session_id,
        )
        response = inference_api.close_session(request)
        return CloseSession(success=response.success)

    @strawberry.mutation
    def add_points(
        self, input: AddPointsInput, info: strawberry.Info
    ) -> RLEMaskListOnFrame:
        inference_api: InferenceAPI = info.context["inference_api"]

        request = AddPointsRequest(
            type="add_points",
            session_id=input.session_id,
            frame_index=input.frame_index,
            object_id=input.object_id,
            points=input.points,
            labels=input.labels,
            clear_old_points=input.clear_old_points,
            engine=input.engine,
        )
        reponse = inference_api.add_points(request)

        return RLEMaskListOnFrame(
            frame_index=reponse.frame_index,
            rle_mask_list=[
                RLEMaskForObject(
                    object_id=r.object_id,
                    rle_mask=RLEMask(counts=r.mask.counts, size=r.mask.size, order="F"),
                )
                for r in reponse.results
            ],
        )

    @strawberry.mutation
    def remove_object(
        self, input: RemoveObjectInput, info: strawberry.Info
    ) -> List[RLEMaskListOnFrame]:
        inference_api: InferenceAPI = info.context["inference_api"]

        request = RemoveObjectRequest(
            type="remove_object", session_id=input.session_id, object_id=input.object_id
        )

        response = inference_api.remove_object(request)

        return [
            RLEMaskListOnFrame(
                frame_index=res.frame_index,
                rle_mask_list=[
                    RLEMaskForObject(
                        object_id=r.object_id,
                        rle_mask=RLEMask(
                            counts=r.mask.counts, size=r.mask.size, order="F"
                        ),
                    )
                    for r in res.results
                ],
            )
            for res in response.results
        ]

    @strawberry.mutation
    def clear_points_in_frame(
        self, input: ClearPointsInFrameInput, info: strawberry.Info
    ) -> RLEMaskListOnFrame:
        inference_api: InferenceAPI = info.context["inference_api"]

        request = ClearPointsInFrameRequest(
            type="clear_points_in_frame",
            session_id=input.session_id,
            frame_index=input.frame_index,
            object_id=input.object_id,
        )

        response = inference_api.clear_points_in_frame(request)

        return RLEMaskListOnFrame(
            frame_index=response.frame_index,
            rle_mask_list=[
                RLEMaskForObject(
                    object_id=r.object_id,
                    rle_mask=RLEMask(counts=r.mask.counts, size=r.mask.size, order="F"),
                )
                for r in response.results
            ],
        )

    @strawberry.mutation
    def clear_points_in_video(
        self, input: ClearPointsInVideoInput, info: strawberry.Info
    ) -> ClearPointsInVideo:
        inference_api: InferenceAPI = info.context["inference_api"]

        request = ClearPointsInVideoRequest(
            type="clear_points_in_video",
            session_id=input.session_id,
        )
        response = inference_api.clear_points_in_video(request)
        return ClearPointsInVideo(success=response.success)

    @strawberry.mutation
    def cancel_propagate_in_video(
        self, input: CancelPropagateInVideoInput, info: strawberry.Info
    ) -> CancelPropagateInVideo:
        inference_api: InferenceAPI = info.context["inference_api"]

        request = CancelPropagateInVideoRequest(
            type="cancel_propagate_in_video",
            session_id=input.session_id,
        )
        response = inference_api.cancel_propagate_in_video(request)
        return CancelPropagateInVideo(success=response.success)


def session_video_path(rel: str) -> str:
    """The file a session opens for `rel` (as the page sends it, e.g.
    "gallery/x.mp4"), or ValueError naming only `rel`, never the server's own
    path. `rel` must be one of the listed videos, stay inside DATA_PATH once
    normalised, and exist. The check is on the path's text, not its resolved
    target, so a link the backend made itself under DATA_PATH (an in-place link
    to footage elsewhere) still opens, while an absolute path or a `..` that
    climbs out of DATA_PATH is refused."""
    refused = ValueError(f"not a video path under the data folder: {rel!r}")
    root = os.path.abspath(str(DATA_PATH))  # abspath, not realpath: lexical
    if not rel or os.path.isabs(rel) or "\x00" in rel:
        raise refused
    full = os.path.normpath(os.path.join(root, rel))
    try:
        inside = os.path.commonpath([root, full]) == root and full != root
    except ValueError:  # e.g. another drive on Windows
        inside = False
    if not inside:
        raise refused
    listed = get_videos() or {}  # upstream starts the store as [] until videos are set
    # a lookup, not a walk: an upload on another thread may add to it meanwhile.
    # Videos are keyed by code, which get_video makes equal to the path.
    if listed.get(os.path.normpath(rel)) is None:
        raise ValueError(f"not a listed video: {rel!r}")
    if not os.path.isfile(full):
        raise ValueError(f"no video file for {rel!r}")
    return full


def get_file_hash(video_path_or_file) -> str:
    if isinstance(video_path_or_file, str):
        with open(video_path_or_file, "rb") as in_f:
            result = hashlib.sha256(in_f.read()).hexdigest()
    else:
        video_path_or_file.seek(0)
        result = hashlib.sha256(video_path_or_file.read()).hexdigest()
    return result


def _get_start_sec_duration_sec(
    start_time_sec: Union[float, None],
    duration_time_sec: Union[float, None],
    max_time: float,
) -> Tuple[float, float]:
    default_seek_t = int(os.environ.get("VIDEO_ENCODE_SEEK_TIME", "0"))
    if start_time_sec is None:
        start_time_sec = default_seek_t

    if duration_time_sec is not None:
        duration_time_sec = min(duration_time_sec, max_time)
    else:
        duration_time_sec = max_time
    return start_time_sec, duration_time_sec


def process_video(
    file: Upload,
    max_time: float,
    start_time_sec: Optional[float] = None,
    duration_time_sec: Optional[float] = None,
) -> Tuple[Optional[str], str, str, VideoMetadata]:
    """
    Process file upload including video trimming and content moderation checks.

    Returns the filepath, s3_file_key, hash & video metaedata as a tuple.
    """
    with tempfile.TemporaryDirectory() as tempdir:
        in_path = f"{tempdir}/in.mp4"
        out_path = f"{tempdir}/out.mp4"
        with open(in_path, "wb") as in_f:
            in_f.write(file.read())

        try:
            video_metadata = get_video_metadata(in_path)
        except av.InvalidDataError:
            raise Exception("not valid video file")

        if video_metadata.num_video_streams == 0:
            raise Exception("video container does not contain a video stream")
        if video_metadata.width is None or video_metadata.height is None:
            raise Exception("video container does not contain width or height metadata")

        if video_metadata.duration_sec in (None, 0):
            raise Exception("video container does time duration metadata")

        start_time_sec, duration_time_sec = _get_start_sec_duration_sec(
            max_time=max_time,
            start_time_sec=start_time_sec,
            duration_time_sec=duration_time_sec,
        )

        # Transcode video to make sure videos returned to the app are all in
        # the same format, duration, resolution, fps.
        transcode(
            in_path,
            out_path,
            video_metadata,
            seek_t=start_time_sec,
            duration_time_sec=duration_time_sec,
        )

        out_video_metadata = get_video_metadata(out_path)
        if out_video_metadata.num_video_frames == 0:
            raise Exception(
                "transcode produced empty video; check seek time or your input video"
            )

        filepath = None
        file_key = None
        with open(out_path, "rb") as file_data:
            file_hash = get_file_hash(file_data)
            file_data.seek(0)

            file_key = UPLOADS_PREFIX + "/" + f"{file_hash}.mp4"
            filepath = os.path.join(UPLOADS_PATH, f"{file_hash}.mp4")

        assert filepath is not None and file_key is not None
        if RETAIN_ORIGINAL_UPLOADS:
            from data.assets import retain_upload

            retain_upload(
                Path(in_path), root=DATA_PATH / "assets",
                working_copy_sha256=file_hash,
                start_time_sec=start_time_sec,
                duration_time_sec=duration_time_sec,
            )
        os.remove(in_path)
        shutil.move(out_path, filepath)

        return filepath, file_key, out_video_metadata


schema = strawberry.Schema(
    query=Query,
    mutation=Mutation,
)
