# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Engines make tracks. The rest of the app only sees this protocol, so SAM 2,
SAM 3 or an external pipeline can fill the same track store.

An engine is given the video and the seeds of the objects to track, and yields
every frame's masks for exactly those objects. It never sees the interactive
session: each track job builds its own state and drops it afterwards.

`windows` (issue #20) confines an object to spans of frames: the frames
between its absent ranges (tracks/ranges.py). Each window is tracked on its
own, in a fresh state seeded only from the seeds inside it, so no memory
crosses a gap, and the engine runs on no frame outside them.

`track_stretch` (issue #19, tracks/bounded.py), where an engine has it, runs
one bounded pass: one object, over a stretch around a corrected frame, until
the caller says the new masks have rejoined the cached track. SAM 3 has none yet,
so its corrections re-track the window whole.
"""
import contextlib
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterator, List, Optional, Protocol, Tuple

import numpy as np

from tracks import rle
from tracks.bounded import PRIME, StopFn, Stretch
from tracks.ranges import Window, in_window
from tracks.seeds import Seeds, cleared
from tracks.streaming import sam2_prune
from tracks.text import has_prompt

FrameMasks = Tuple[int, Dict[int, np.ndarray]]
Windows = Dict[int, List[Window]]
WHOLE: Window = (0, None)


class Engine(Protocol):
    name: str
    model: str

    def track(self, video_path: str, objects: Dict[int, Seeds], video_handle: Optional[Any] = None,
              windows: Optional[Windows] = None) -> Iterator[FrameMasks]:
        """Yield (frame_idx, {obj_id: bool mask HxW}) for every frame, each frame
        once. Stopping the iteration early (a cancel) must release the job's state.
        `video_handle` is the caller's already-loaded video, if it has one (for
        SAM 2, the interactive session's state), so a job need not decode it again.
        With `windows`, an object listed there is tracked only inside its
        windows, each on its own from its own seeds, and yields nothing
        elsewhere; an object not listed has the whole clip."""
        ...


@dataclass
class Unit:
    """One tracking pass: a window of frames and the objects tracked in it,
    each with only its seeds inside the window."""

    lo: int
    hi: Optional[int]
    objects: Dict[int, Seeds]

    @property
    def start(self) -> int:
        """The first seeded frame: forward from here to hi, then back to lo."""
        return min(f for s in self.objects.values() for f in s)

    def n_frames(self, clip_frames: int) -> int:
        return max(0, (clip_frames if self.hi is None else min(self.hi + 1, clip_frames)) - self.lo)


def plan_units(objects: Dict[int, Seeds], windows: Optional[Windows] = None,
               by_first_seed: bool = True) -> List[Unit]:
    """Split a job into passes. Every (object, window) with a seed inside the
    window joins the unit of objects sharing that window (and, with
    by_first_seed, the same first seeded frame in it: SAM 2 on MPS needs that,
    see Sam2Engine.track). Without windows every object has the whole clip,
    which is the plan from before windows existed."""
    by: Dict[Tuple, Dict[int, Seeds]] = {}
    for o, s in objects.items():
        for w in (windows or {}).get(o, [WHOLE]):
            mine = {f: v for f, v in s.items() if has_prompt(v) and in_window(f, w)}
            if not mine:
                continue
            key = (w[0], min(mine) if by_first_seed else 0, float("inf") if w[1] is None else w[1])
            by.setdefault(key, {})[o] = mine
    return [Unit(k[0], None if k[2] == float("inf") else int(k[2]), by[k]) for k in sorted(by)]


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
                 score_thresh: float = 0.0, prime: int = PRIME):
        self.predictor = predictor
        self.model = model
        self.offload_video_to_cpu = offload_video_to_cpu
        self.autocast = autocast
        self.score_thresh = score_thresh
        self.prime = prime  # cached frames a bounded pass starting mid-window is primed with

    def track(self, video_path: str, objects: Dict[int, Seeds], video_handle: Optional[Dict] = None,
              windows: Optional[Windows] = None) -> Iterator[FrameMasks]:
        """Objects whose first seed is on different frames run in separate
        states, one per first-seed frame, one after another: tracked together,
        SAM 2 on MPS aborts the whole process (an MPSNDArrayMatrixMultiplication
        datatype assertion in memory attention). A frame can so be yielded once
        per group, each time with that group's objects. The backbone features
        are cached per video, so the extra passes do not re-encode frames.
        Each window of an object is a unit of its own, grouped the same way
        within the window. Cleared seeds are stripped before planning (see
        strip_cleared), so they neither open nor condition a unit, and each
        object's output is blanked on its cleared frames in every unit, in
        both directions."""
        blank = strip_cleared(objects)[1]
        for unit in self.plan(objects, windows):
            for frame, masks in self._track_group(video_path, unit, video_handle):
                yield frame, blanked(frame, masks, blank)

    def plan(self, objects: Dict[int, Seeds], windows: Optional[Windows] = None) -> List[Unit]:
        """The passes a job over `objects` makes, in order. Cleared seeds are
        left out, as track() leaves them out, so a window whose only seed is
        cleared makes no pass and an object's first seed is its first kept one."""
        return plan_units(strip_cleared(objects)[0], windows, by_first_seed=True)

    def passes(self, objects: Dict[int, Seeds], windows: Optional[Windows] = None) -> int:
        """How many times a job over `objects` runs (one per unit)."""
        return max(1, len(self.plan(objects, windows)))

    def _track_group(self, video_path: str, unit: Unit, video_handle: Optional[Dict] = None) -> Iterator[FrameMasks]:
        objects, start = unit.objects, unit.start
        # forward to the window's end, back to its start (None: the clip's ends)
        limits = {False: None if unit.hi is None else unit.hi - start, True: None if unit.lo == 0 else start - unit.lo}
        with self.autocast():
            if video_handle is not None:
                state = job_state_like(video_handle)
            else:
                state = self.predictor.init_state(video_path, offload_video_to_cpu=self.offload_video_to_cpu)
            try:
                # frame-major, so each frame's backbone features serve every object
                for frame, obj_id in sorted((f, o) for o, s in objects.items() for f in s):
                    seed_into_state(self.predictor, state, obj_id, frame, objects[obj_id][frame])
                for reverse in (False, True):
                    bound = {} if limits[reverse] is None else {"max_frame_num_to_track": limits[reverse]}
                    for frame, obj_ids, masks in self.predictor.propagate_in_video(
                            state, start_frame_idx=start, reverse=reverse, **bound):
                        # outputs the model will not read again go, so memory stays flat
                        sam2_prune(self.predictor, state, frame, start, reverse)
                        if reverse and frame == start:
                            continue  # the forward pass already yielded it
                        yield frame, {int(o): (masks[k] > self.score_thresh)[0].cpu().numpy()
                                      for k, o in enumerate(obj_ids)}
            finally:
                self.predictor.reset_state(state)


    def track_stretch(self, video_path: str, stretch: Stretch, stop: StopFn,
                      video_handle: Optional[Dict] = None) -> Iterator[FrameMasks]:
        """One bounded pass (tracks/bounded.py): a fresh state holding only
        stretch.obj_id, conditioned on every seed of its window as a full pass
        is, propagated forward from stretch.start to stretch.hi and then, with
        stretch.reverse, back to stretch.lo. `stop(frame, reverse, mask)` is
        asked after each frame and True ends that direction (the frame is
        still yielded).

        A start that is not a seed frame is primed: the cached masks of the
        `prime` frames before it become the memory a full pass would have on
        reaching it (prime_from_cache). Without that the pass would start from
        the seeds alone, which no frame of a full pass ever does mid-window.
        One object per state, so the MPS trap of objects first seeded on
        different frames (see track) cannot arise.

        It also yields None, a step with no frame, after each seed and each
        primed frame: a point where the caller may let go of the model lock,
        which it otherwise holds from one yield to the next."""
        o, start = stretch.obj_id, stretch.start
        with self.autocast():
            if video_handle is not None:
                state = job_state_like(video_handle)
            else:
                state = self.predictor.init_state(video_path, offload_video_to_cpu=self.offload_video_to_cpu)
            try:
                for frame in sorted(stretch.seeds):
                    seed_into_state(self.predictor, state, o, frame, stretch.seeds[frame])
                    yield None
                if self.prime and stretch.cached and start not in stretch.seeds:
                    for _ in prime_from_cache(self.predictor, state, o, stretch, self.prime):
                        yield None
                limits = {False: stretch.hi - start, True: start - stretch.lo}
                for reverse in ((False, True) if stretch.reverse else (False,)):
                    if reverse and limits[True] <= 0:
                        continue  # forward always runs: it yields the start frame
                    for frame, obj_ids, masks in self.predictor.propagate_in_video(
                            state, start_frame_idx=start, reverse=reverse, max_frame_num_to_track=limits[reverse]):
                        sam2_prune(self.predictor, state, frame, start, reverse)
                        if reverse and frame == start:
                            continue
                        m = (masks[list(obj_ids).index(o)] > self.score_thresh)[0].cpu().numpy()
                        done = stop(frame, reverse, m)
                        yield frame, {o: m}
                        if done:
                            break
            finally:
                self.predictor.reset_state(state)


def strip_cleared(objects: Dict[int, Seeds]) -> Tuple[Dict[int, Seeds], Dict[int, set]]:
    """The objects without their cleared seeds, and each object's cleared frames.

    sam-ui: a 'not on this frame' seed is output, not input. Given as a
    conditioning frame, SAM 2 drops the object on the frames around it
    (measured: IoU 0 on frames 9-19), so SAM 2 tracks through it and its
    output there is blanked. SAM 3 conditions on it safely."""
    blank = {o: {f for f, v in s.items() if cleared(v)} for o, s in objects.items()}
    return {o: {f: v for f, v in s.items() if f not in blank[o]} for o, s in objects.items()}, blank


def blanked(frame: int, masks: Dict[int, np.ndarray], blank: Dict[int, set]) -> Dict[int, np.ndarray]:
    """One frame's masks with each object's cleared frame (strip_cleared) emptied."""
    return {o: np.zeros_like(m) if frame in blank.get(o, ()) else m for o, m in masks.items()}


def groups_by_first_seed(objects: Dict[int, Seeds]) -> List[Dict[int, Seeds]]:
    """Objects grouped by the frame of their first seed with points, earliest
    group first (objects without one are dropped)."""
    by: Dict[int, Dict[int, Seeds]] = {}
    for o, s in objects.items():
        seeded = [f for f, v in s.items() if has_prompt(v)]
        if seeded:
            by.setdefault(min(seeded), {})[o] = s
    return [by[f] for f in sorted(by)]


def prime_from_cache(predictor, state, obj_id: int, stretch: Stretch, n: int) -> Iterator[int]:
    """Give a bounded pass the memory a full pass would have on reaching
    stretch.start: the cached masks of the `n` frames before it (never before
    stretch.floor, never a seed frame) become non-conditioning outputs, made
    by SAM 2 from each mask as a mask prompt (the frame's object pointer
    included) and encoded by its memory encoder, as add_new_mask's frames
    are. Yields each frame once it is primed.

    Under torch.inference_mode, as upstream runs every caller of
    _run_single_frame_inference: a job is not inside one (autocast is a no-op
    off CUDA), and outside it the CPU refuses the cached backbone features
    (inference tensors) and MPS keeps an autograd graph per primed frame."""
    import torch

    obj_idx = predictor._obj_id_to_idx(state, obj_id)
    out_dict = state["output_dict_per_obj"][obj_idx]
    for f in range(max(stretch.floor, stretch.start - n), stretch.start):
        if f in stretch.seeds or f not in stretch.cached:
            continue
        with torch.inference_mode():  # per frame: never held across the yield
            m = torch.from_numpy(rle.decode(stretch.cached[f]))[None, None].float().to(state["device"])
            size = predictor.image_size
            if tuple(m.shape[-2:]) != (size, size):  # as add_new_mask resizes it
                m = torch.nn.functional.interpolate(m, size=(size, size), align_corners=False, mode="bilinear",
                                                    antialias=True)
                m = (m >= 0.5).float()
            out, _ = predictor._run_single_frame_inference(
                inference_state=state, output_dict=out_dict, frame_idx=f, batch_size=1, is_init_cond_frame=False,
                point_inputs=None, mask_inputs=m, reverse=False, run_mem_encoder=True)
            out_dict["non_cond_frame_outputs"][f] = out
        yield f


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
    at (4k, i). Records which objects each job was asked for, the windows it
    was given, each unit it ran: (lo, hi, {obj: its seed frames}), and each
    bounded pass: (obj, start, lo, hi, [frames, in the order made]).

    With `influence`, a seed frame whose clicks include a negative (a
    correction) moves the square down a row on the frames closer to it than
    `influence`, in full and bounded passes alike."""

    name = "fake"

    def __init__(self, n_frames: int = 5, shape=(24, 32), model: str = "fake-1", influence: int = 0):
        self.n_frames = n_frames
        self.shape = shape
        self.model = model
        self.influence = influence
        self.calls: List[List[int]] = []
        self.windows: List[Optional[Windows]] = []
        self.units: List[Tuple] = []
        self.stretches: List[Tuple] = []

    @staticmethod
    def mask(obj_id: int, frame: int, shape=(24, 32)) -> np.ndarray:
        m = np.zeros(shape, bool)
        y, x = (4 * obj_id) % (shape[0] - 4), frame % (shape[1] - 4)
        m[y:y + 4, x:x + 4] = True
        return m

    def _mask(self, obj_id: int, frame: int, seeds: Dict) -> np.ndarray:
        m = self.mask(obj_id, frame, self.shape)
        if any(0 in v.get("labels", []) and abs(f - frame) < self.influence for f, v in seeds.items()):
            m = np.roll(m, 1, axis=0)
        return m

    def plan(self, objects: Dict[int, Seeds], windows: Optional[Windows] = None) -> List[Unit]:
        return plan_units(objects, windows, by_first_seed=False)

    def track(self, video_path: str, objects: Dict[int, Seeds], video_handle: Optional[Any] = None,
              windows: Optional[Windows] = None) -> Iterator[FrameMasks]:
        self.calls.append(sorted(objects))
        self.windows.append(windows)
        if windows is None:  # as before windows: every object, every frame, seeded or not
            for i in range(self.n_frames):
                yield i, {o: self._mask(o, i, objects[o]) for o in objects}
            return
        for u in self.plan(objects, windows):
            self.units.append((u.lo, u.hi, {o: sorted(s) for o, s in u.objects.items()}))
            for i in range(u.lo, u.lo + u.n_frames(self.n_frames)):
                yield i, {o: self._mask(o, i, u.objects[o]) for o in u.objects}

    def track_stretch(self, video_path: str, stretch: Stretch, stop: StopFn,
                      video_handle: Optional[Any] = None) -> Iterator[FrameMasks]:
        o, ran = stretch.obj_id, []
        self.stretches.append((o, stretch.start, stretch.lo, stretch.hi, ran))
        halves = [(range(stretch.start, stretch.hi + 1), False)]
        if stretch.reverse:
            halves.append((range(stretch.start - 1, stretch.lo - 1, -1), True))
        for frames, reverse in halves:
            for i in frames:
                m = self._mask(o, i, stretch.seeds)
                ran.append(i)
                done = stop(i, reverse, m)
                yield i, {o: m}
                if done:
                    break
