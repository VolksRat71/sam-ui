# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
# This source code is licensed under the license found in the
# LICENSE file in the root directory of this source tree.
# Modified by sam-ui: types for per-object tracks (ObjectTrack, SeedFrame, clearTrack).

from dataclasses import dataclass
from typing import Iterable, List, Optional

import strawberry
from app_conf import API_URL
from data.resolver import resolve_videos
from dataclasses_json import dataclass_json
from strawberry import relay


@strawberry.type
class Video(relay.Node):
    """Core type for video."""

    code: relay.NodeID[str]
    path: str
    poster_path: Optional[str]
    width: int
    height: int

    @strawberry.field
    def url(self) -> str:
        return f"{API_URL}/{self.path}"

    @strawberry.field
    def poster_url(self) -> str:
        return f"{API_URL}/{self.poster_path}"

    @classmethod
    def resolve_nodes(
        cls,
        *,
        info: relay.PageInfo,
        node_ids: Iterable[str],
        required: bool = False,
    ):
        return resolve_videos(node_ids, required)


@strawberry.type
class RLEMask:
    """Core type for Onevision GraphQL RLE mask."""

    size: List[int]
    counts: str
    order: str


@strawberry.type
class RLEMaskForObject:
    """Type for RLE mask associated with a specific object id."""

    object_id: int
    rle_mask: RLEMask


@strawberry.type
class RLEMaskListOnFrame:
    """Type for a list of object-associated RLE masks on a specific video frame."""

    frame_index: int
    rle_mask_list: List[RLEMaskForObject]


@strawberry.input
class StartSessionInput:
    path: str


@strawberry.type
class SeedFrame:
    """sam-ui: one frame's clicks for an object (points normalised to 0-1)."""

    frame_index: int
    points: List[List[float]]
    labels: List[int]
    mask: Optional[RLEMask] = None  # the approved mask on this frame, if recorded


@strawberry.type
class EngineTrack:
    """sam-ui: one engine's cached track of an object."""

    engine: str
    model: str
    state: str  # untracked | stale | tracked | tracking
    frames: Optional[List[int]]
    n_frames: int


@strawberry.type
class ObjectTrack:
    """sam-ui: an object's seeds and the state of its cached track (the
    default engine's in the top-level fields, every engine's in `tracks`)."""

    object_id: int
    state: str  # untracked | stale | tracked
    engine: str
    model: str
    frames: Optional[List[int]]  # [first, last] tracked frame, or null
    n_frames: int
    seeds: List[SeedFrame]
    tracks: List[EngineTrack]

    @staticmethod
    def from_info(info: dict) -> "ObjectTrack":
        return ObjectTrack(
            object_id=info["object_id"],
            state=info["state"],
            engine=info["engine"],
            model=info["model"],
            frames=info["frames"],
            n_frames=info["n_frames"],
            seeds=[
                SeedFrame(
                    frame_index=f,
                    points=v["points"],
                    labels=v["labels"],
                    mask=RLEMask(size=v["mask"]["size"], counts=v["mask"]["counts"], order="F")
                    if v.get("mask")
                    else None,
                )
                for f, v in sorted(info["seeds"].items())
            ],
            tracks=[
                EngineTrack(
                    engine=t["engine"],
                    model=t["model"],
                    state=t["state"],
                    frames=t["frames"],
                    n_frames=t["n_frames"],
                )
                for t in info.get("tracks", [])
            ],
        )


@strawberry.input
class DeleteVideoInput:
    """sam-ui: delete an uploaded video (never a gallery one)."""

    path: str  # as `videos` lists it, e.g. uploads/<hash>.mp4
    purge_tracks: bool = True  # also drop its seeds and cached tracks
    close_idle_sessions: bool = False  # first close sessions on it idle > 60 s (tabs that went away)


@strawberry.type
class DeleteVideo:
    path: str
    purged: bool
    sessions_closed: int = 0


@strawberry.input
class ClearTrackInput:
    session_id: str
    object_id: int
    engine: Optional[str] = None  # one engine's track; every engine's when null


@strawberry.type
class StartSession:
    session_id: str
    objects: List[ObjectTrack]  # sam-ui: objects already known for this video


@strawberry.input
class PingInput:
    session_id: str


@strawberry.type
class Pong:
    success: bool


@strawberry.input
class CloseSessionInput:
    session_id: str


@strawberry.type
class CloseSession:
    success: bool


@strawberry.input
class AddPointsInput:
    session_id: str
    frame_index: int
    clear_old_points: bool
    object_id: int
    labels: List[int]
    points: List[List[float]]


@strawberry.input
class ClearPointsInFrameInput:
    session_id: str
    frame_index: int
    object_id: int


@strawberry.input
class ClearPointsInVideoInput:
    session_id: str


@strawberry.type
class ClearPointsInVideo:
    success: bool


@strawberry.input
class RemoveObjectInput:
    session_id: str
    object_id: int


@strawberry.input
class PropagateInVideoInput:
    session_id: str
    start_frame_index: int


@strawberry.input
class CancelPropagateInVideoInput:
    session_id: str


@strawberry.type
class CancelPropagateInVideo:
    success: bool


@strawberry.type
class SessionExpiration:
    session_id: str
    expiration_time: int
    max_expiration_time: int
    ttl: int
