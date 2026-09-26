# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Engines make tracks. The rest of the app only sees this protocol, so SAM 2,
SAM 3 or an external pipeline can fill the same track store.

An engine is given the video and the seeds of the objects to track, and yields
every frame's masks for exactly those objects. It never sees the interactive
session: each track job builds its own state and drops it afterwards.
"""
import contextlib
from typing import Callable, Dict, Iterator, List, Protocol, Tuple

import numpy as np

from tracks.seeds import Seeds

FrameMasks = Tuple[int, Dict[int, np.ndarray]]


class Engine(Protocol):
    name: str
    model: str

    def track(self, video_path: str, objects: Dict[int, Seeds]) -> Iterator[FrameMasks]:
        """Yield (frame_idx, {obj_id: bool mask HxW}) for every frame, each frame
        once. Stopping the iteration early (a cancel) must release the job's state."""
        ...


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

    def track(self, video_path: str, objects: Dict[int, Seeds]) -> Iterator[FrameMasks]:
        objects = {o: s for o, s in objects.items() if any(v["points"] for v in s.values())}
        if not objects:
            return
        with self.autocast():
            state = self.predictor.init_state(video_path, offload_video_to_cpu=self.offload_video_to_cpu)
            try:
                for obj_id, seeds in objects.items():
                    for frame, v in sorted(seeds.items()):
                        if not v["points"]:
                            continue
                        # the seed store holds a frame's full point list, so replace
                        self.predictor.add_new_points_or_box(
                            inference_state=state, frame_idx=frame, obj_id=obj_id,
                            points=np.array(v["points"], np.float32), labels=np.array(v["labels"], np.int32),
                            clear_old_points=True, normalize_coords=False)
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

    def track(self, video_path: str, objects: Dict[int, Seeds]) -> Iterator[FrameMasks]:
        self.calls.append(sorted(objects))
        for i in range(self.n_frames):
            yield i, {o: self.mask(o, i, self.shape) for o in objects}
