# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
# This source code is licensed under the license found in the
# LICENSE file in the root directory of this source tree.
# Modified by sam-ui: types for per-object tracks (ObjectTrack, SeedFrame, clearTrack).
# Modified by sam-ui: frame ranges on an object (ObjectRange, setObjectRange).
# Modified by sam-ui: track versions and seed undo (SeedHistory, TrackVersion, undoSeeds, moveClicks).
# Modified by sam-ui: present and candidate ranges (ObjectRange.source/score, setObjectCandidates).
# Modified by sam-ui: a seed frame's text prompt (SeedFrame.text).

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
    text: Optional[str] = None  # the text prompt that seeded the frame, if any


@strawberry.type
class ObjectRange:
    """sam-ui: a span of an object's frames, inclusive, in a range state
    (tracks/ranges.py): "absent" (confirmed not in the shot: those frames are
    empty and never tracked), "present" (confirmed there) or "candidate" (a
    model or tool thinks it is there; unconfirmed). Frames in no range are
    unknown. Only a candidate has a source and maybe a score (0-1)."""

    start: int
    end: int
    state: str
    source: Optional[str] = None
    score: Optional[float] = None


@strawberry.type
class EngineTrack:
    """sam-ui: one engine's cached track of an object."""

    engine: str
    model: str
    state: str  # untracked | stale | tracked | tracking
    frames: Optional[List[int]]
    n_frames: int


@strawberry.type
class TrackVersion:
    """sam-ui: one kept track of an object's earlier (or current) seeds."""

    key: str  # the seeds hash it was made from
    engine: str
    model: str
    created: Optional[str]  # when it was tracked
    elapsed_s: Optional[float]
    n_frames: Optional[int]
    clicks: int
    seed_frames: int
    bounded: bool  # bounded passes made part of it
    current: bool  # made from the object's current seeds


@strawberry.type
class SeedHistory:
    """sam-ui: what an object can undo or redo, and its kept versions, newest first."""

    can_undo: bool
    can_redo: bool
    versions: List[TrackVersion]

    @staticmethod
    def from_info(h: Optional[dict]) -> "SeedHistory":
        h = h or {}
        return SeedHistory(
            can_undo=bool(h.get("can_undo")),
            can_redo=bool(h.get("can_redo")),
            versions=[
                TrackVersion(key=v["key"], engine=v["engine"], model=v.get("model") or "", created=v.get("created"),
                             elapsed_s=v.get("elapsed_s"), n_frames=v.get("n_frames"), clicks=v.get("clicks") or 0,
                             seed_frames=v.get("seed_frames") or 0, bounded=bool(v.get("bounded")),
                             current=bool(v.get("current")))
                for v in h.get("versions", [])
            ],
        )


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
    ranges: List[ObjectRange]
    history: SeedHistory

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
                    text=v.get("text"),
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
            ranges=[ObjectRange(start=r["start"], end=r["end"], state=r["state"], source=r.get("source"),
                                score=r.get("score")) for r in info.get("ranges", [])],
            history=SeedHistory.from_info(info.get("history")),
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


@strawberry.input
class SetObjectRangeInput:
    """sam-ui: set frames start-end (inclusive) of an object to `state`
    ("absent", "present", or "candidate" with its `source` and optional
    `score`), or clear them (state null): every state, or only those in
    `clear` (["candidate"] rejects a candidate)."""

    session_id: str
    object_id: int
    start: int
    end: int
    state: Optional[str] = None
    source: Optional[str] = None
    score: Optional[float] = None
    clear: Optional[List[str]] = None


@strawberry.input
class CandidateRangeInput:
    """sam-ui: one candidate range: where a model or tool thinks the object is."""

    start: int
    end: int
    source: str
    score: Optional[float] = None


@strawberry.input
class SetObjectCandidatesInput:
    """sam-ui: write candidate ranges in bulk (a discovery job's results);
    `replace` drops the object's old candidates first. All or nothing."""

    session_id: str
    object_id: int
    candidates: List[CandidateRangeInput]
    replace: bool = False


@strawberry.input
class SeedHistoryInput:
    """sam-ui: undo or redo one object's last seed change."""

    session_id: str
    object_id: int


@strawberry.input
class RestoreVersionInput:
    session_id: str
    object_id: int
    key: str  # a TrackVersion's key


@strawberry.input
class MoveClicksInput:
    """sam-ui: move one object's clicks on a frame to another object."""

    session_id: str
    frame_index: int
    from_object_id: int
    to_object_id: int


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
