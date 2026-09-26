# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Engines make tracks. The rest of the app only sees this protocol, so SAM 2,
SAM 3 or an external pipeline can fill the same track store.

An engine is given the video and the seeds of the objects to track, and yields
every frame's masks for exactly those objects. It never sees the interactive
session: each track job builds its own state and drops it afterwards.
"""
import contextlib
from collections import OrderedDict
from typing import Any, Callable, Dict, Iterator, List, Optional, Protocol, Tuple

import numpy as np

from tracks import rle
from tracks.seeds import Seeds

FrameMasks = Tuple[int, Dict[int, np.ndarray]]


class Engine(Protocol):
    name: str
    model: str

    def track(self, video_path: str, objects: Dict[int, Seeds],
              video_handle: Optional[Any] = None) -> Iterator[FrameMasks]:
        """Yield (frame_idx, {obj_id: bool mask HxW}) for every frame, each frame
        once. Stopping the iteration early (a cancel) must release the job's state.
        `video_handle` is the caller's already-loaded video, if it has one (for
        SAM 2, the interactive session's state), so a job need not decode it again."""
        ...


# init_state's per-object and per-job keys: a job gets fresh ones. Every other
# key (the decoded frames, sizes, devices) is shared with the session's state.
_JOB_KEYS = {"point_inputs_per_obj": dict, "mask_inputs_per_obj": dict, "cached_features": dict,
             "constants": dict, "obj_id_to_idx": OrderedDict, "obj_idx_to_id": OrderedDict, "obj_ids": list,
             "output_dict_per_obj": dict, "temp_output_dict_per_obj": dict, "frames_tracked_per_obj": dict}


def job_state_like(session_state: Dict) -> Dict:
    """A new SAM 2 inference state that shares the session's decoded video
    (read only) but holds no objects, so a job never decodes the video twice
    (about 12.6 MB a frame at 1024x1024) and never touches the session."""
    missing = set(_JOB_KEYS) - set(session_state)
    if missing:
        raise ValueError(f"not a SAM 2 inference state (missing {sorted(missing)})")
    return {k: (_JOB_KEYS[k]() if k in _JOB_KEYS else v) for k, v in session_state.items()}


class Sam2Engine:
    """SAM 2 video tracking, sharing the model the interactive session loaded.

    SAM 2 propagates every object in an inference state together and refuses
    to run if one of them has no seed, so each job gets a fresh state holding
    only its objects, seeded from the seed store.
    """

    name = "sam2"

    def __init__(self, predictor, model: str, offload_video_to_cpu: bool = False,
                 autocast: Callable[[], contextlib.AbstractContextManager] = contextlib.nullcontext,
                 score_thresh: float = 0.0):
        self.predictor = predictor
        self.model = model
        self.offload_video_to_cpu = offload_video_to_cpu
        self.autocast = autocast
        self.score_thresh = score_thresh

    def track(self, video_path: str, objects: Dict[int, Seeds],
              video_handle: Optional[Dict] = None) -> Iterator[FrameMasks]:
        objects = {o: s for o, s in objects.items() if any(v["points"] for v in s.values())}
        if not objects:
            return
        with self.autocast():
            if video_handle is not None:
                state = job_state_like(video_handle)
            else:
                state = self.predictor.init_state(video_path, offload_video_to_cpu=self.offload_video_to_cpu)
            try:
                # frame-major, so each frame's backbone features serve every object
                for frame, obj_id in sorted((f, o) for o, s in objects.items() for f, v in s.items() if v["points"]):
                    seed_into_state(self.predictor, state, obj_id, frame, objects[obj_id][frame])
                start = min(f for s in objects.values() for f, v in s.items() if v["points"])
                for reverse in (False, True):
                    for frame, obj_ids, masks in self.predictor.propagate_in_video(
                            state, start_frame_idx=start, reverse=reverse):
                        if reverse and frame == start:
                            continue  # the forward pass already yielded it
                        yield frame, {int(o): (masks[k] > self.score_thresh)[0].cpu().numpy()
                                      for k, o in enumerate(obj_ids)}
            finally:
                self.predictor.reset_state(state)


def seed_into_state(predictor, state, obj_id: int, frame: int, seed: Dict) -> None:
    """Condition a SAM 2 state on one seed frame: its approved mask when the
    seed has one, else its clicks (seeds stored before masks were)."""
    if seed.get("mask"):
        predictor.add_new_mask(inference_state=state, frame_idx=frame, obj_id=obj_id, mask=rle.decode(seed["mask"]))
    else:
        # the seed store holds a frame's full point list, so replace
        predictor.add_new_points_or_box(
            inference_state=state, frame_idx=frame, obj_id=obj_id,
            points=np.array(seed["points"], np.float32), labels=np.array(seed["labels"], np.int32),
            clear_old_points=True, normalize_coords=False)


class FakeEngine:
    """A deterministic engine for tests: object k's mask on frame i is a square
    at (4k, i). Records which objects each job was asked for."""

    name = "fake"

    def __init__(self, n_frames: int = 5, shape=(24, 32), model: str = "fake-1"):
        self.n_frames = n_frames
        self.shape = shape
        self.model = model
        self.calls: List[List[int]] = []

    @staticmethod
    def mask(obj_id: int, frame: int, shape=(24, 32)) -> np.ndarray:
        m = np.zeros(shape, bool)
        y, x = (4 * obj_id) % (shape[0] - 4), frame % (shape[1] - 4)
        m[y:y + 4, x:x + 4] = True
        return m

    def track(self, video_path: str, objects: Dict[int, Seeds],
              video_handle: Optional[Any] = None) -> Iterator[FrameMasks]:
        self.calls.append(sorted(objects))
        for i in range(self.n_frames):
            yield i, {o: self.mask(o, i, self.shape) for o in objects}
