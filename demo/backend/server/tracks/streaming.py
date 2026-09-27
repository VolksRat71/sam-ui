# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Memory that stays flat however long the clip: frames decoded as tracking
reaches them, and tracking state kept only as far back as the model looks.

Upstream, both engines hold the whole clip. SAM 2's loader decodes every frame
up front as a float tensor (about 12.6 MB a frame at 1024x1024), and SAM 3's
session keeps every frame processed (about 12 MB at 1008x1008). Both also keep
their per-frame tracking outputs for every frame tracked, although a frame's
memory attention only reads the last `num_maskmem` frames (7) and the object
pointers of the last `max_obj_ptrs_in_encoder` (16), plus the seeded frames.
So a clip's length, not its content, set the ceiling (hence Meta's 10 s cap).

Here:
  - Sam2Frames / Sam3Frames stand in for those frame stores. They decode one
    frame on request with exactly upstream's resize and normalisation, keeping
    a few recent ones, so the model sees bit-identical input.
  - prune_behind drops the non-seeded outputs a propagation has moved past by
    more than the model's window. Seeded (cond) frames are never touched, and
    neither are the frames just after the start, which the reverse pass reads.
"""
import threading
from collections import OrderedDict
from typing import Dict, Optional

import torch

KEEP_DECODED = 4  # recent frames kept decoded (tracking asks for each once, in order)


def _tensor(frame) -> torch.Tensor:
    """A decoded HxWx3 uint8 frame as a tensor. decord hands back its own array,
    or a tensor once anything (upstream's loader does) has set its torch bridge
    for the whole process."""
    return frame if isinstance(frame, torch.Tensor) else torch.from_numpy(frame.asnumpy())


class _Lru:
    def __init__(self, keep: int):
        self.keep, self._d = keep, OrderedDict()

    def get(self, k):
        v = self._d.get(k)
        if v is not None:
            self._d.move_to_end(k)
        return v

    def put(self, k, v):
        self._d[k] = v
        self._d.move_to_end(k)
        while len(self._d) > self.keep:
            self._d.popitem(last=False)


class Sam2Frames:
    """SAM 2's `inference_state["images"]`, decoded on request: frame i is
    exactly what upstream's load_video_frames_from_video_file stacks at i
    (decord resize to image_size, /255, minus mean, over std, on the CPU)."""

    def __init__(self, video_path: str, image_size: int, img_mean=(0.485, 0.456, 0.406),
                 img_std=(0.229, 0.224, 0.225), keep: int = KEEP_DECODED):
        import decord

        self._vr = decord.VideoReader(video_path, width=image_size, height=image_size)
        self._n = len(self._vr)
        self._mean = torch.tensor(img_mean, dtype=torch.float32)[:, None, None]
        self._std = torch.tensor(img_std, dtype=torch.float32)[:, None, None]
        self._cache = _Lru(keep)
        self._lock = threading.Lock()  # decord readers are not thread safe; jobs share this

    def __len__(self) -> int:
        return self._n

    def __getitem__(self, i: int) -> torch.Tensor:
        i = int(i)
        if not 0 <= i < self._n:
            raise IndexError(i)
        with self._lock:
            hit = self._cache.get(i)
            if hit is None:
                frame = _tensor(self._vr[i]).permute(2, 0, 1)
                hit = (frame.float() / 255.0 - self._mean) / self._std
                self._cache.put(i, hit)
            return hit


def install_sam2_streaming() -> None:
    """Make SAM 2's init_state use Sam2Frames for a video file (idempotent).
    A JPEG folder, or offloading off (frames meant to live on the GPU), goes
    to upstream's loader unchanged."""
    import sam2.sam2_video_predictor as svp

    if getattr(svp.load_video_frames, "_sam_ui_streaming", False):
        return
    upstream = svp.load_video_frames

    def load_video_frames(video_path, image_size, offload_video_to_cpu, img_mean=(0.485, 0.456, 0.406),
                          img_std=(0.229, 0.224, 0.225), async_loading_frames=False, compute_device=None, **kw):
        if isinstance(video_path, str) and not _is_dir(video_path) and offload_video_to_cpu:
            import decord

            h, w, _ = decord.VideoReader(video_path).next().shape
            return Sam2Frames(video_path, image_size, img_mean, img_std), h, w
        return upstream(video_path, image_size, offload_video_to_cpu, img_mean=img_mean, img_std=img_std,
                        async_loading_frames=async_loading_frames,
                        **({"compute_device": compute_device} if compute_device is not None else {}), **kw)

    load_video_frames._sam_ui_streaming = True
    svp.load_video_frames = load_video_frames


def _is_dir(p: str) -> bool:
    import os

    return os.path.isdir(p)


class Sam3Frames:
    """SAM 3's `session.processed_frames`, processed on request: frame i is what
    the processor's video_processor makes of the whole clip at i (it transforms
    frames independently), stored as the session would store it."""

    def __init__(self, video_path: str, processor, dtype=torch.float32, keep: int = KEEP_DECODED):
        import decord

        self._vr = decord.VideoReader(video_path)
        self._n = len(self._vr)
        self._proc = processor
        self._dtype = dtype
        self._cache = _Lru(keep)
        self._lock = threading.Lock()
        first = _tensor(self._vr[0]).numpy()
        self.height, self.width = first.shape[:2]

    def __len__(self) -> int:
        return self._n

    def __getitem__(self, i: int) -> torch.Tensor:
        i = int(i)
        if not 0 <= i < self._n:
            raise IndexError(i)
        with self._lock:
            hit = self._cache.get(i)
            if hit is None:
                frame = _tensor(self._vr[i]).numpy()
                out = self._proc.video_processor(videos=[frame[None]], return_tensors="pt")
                hit = out.pixel_values_videos[0][0].to("cpu", dtype=self._dtype)
                self._cache.put(i, hit)
            return hit


def window(num_maskmem: int = 7, stride: int = 1, max_obj_ptrs: int = 16) -> int:
    """How many frames behind the current one a propagation still reads, with
    a margin."""
    return max(stride * num_maskmem, max_obj_ptrs) + 2


def prune_behind(non_cond: Dict[int, object], current: int, start: int, reverse: bool, win: int) -> int:
    """Drop, in place, the non-seeded outputs more than `win` frames behind
    `current` in the direction of travel. Forward, the `win` frames after
    `start` stay: the reverse pass that follows reads them. Returns how many
    were dropped."""
    if reverse:
        drop = [k for k in non_cond if k > current + win]
    else:
        drop = [k for k in non_cond if start + win < k < current - win]
    for k in drop:
        del non_cond[k]
    return len(drop)


def sam2_prune(predictor, state: Dict, current: int, start: int, reverse: bool) -> int:
    if "output_dict_per_obj" not in state or not hasattr(predictor, "num_maskmem"):
        return 0  # not a SAM 2 video state (a test stub)
    win = window(predictor.num_maskmem, getattr(predictor, "memory_temporal_stride_for_eval", 1),
                 getattr(predictor, "max_obj_ptrs_in_encoder", 16))
    return sum(prune_behind(d["non_cond_frame_outputs"], current, start, reverse, win)
               for d in state["output_dict_per_obj"].values())


def sam3_prune(model, sess, current: int, start: int, reverse: bool) -> int:
    cfg = model.config
    win = window(getattr(cfg, "num_maskmem", 7), getattr(cfg, "memory_temporal_stride_for_eval", 1),
                 getattr(cfg, "max_object_pointers_in_encoder", 16))
    return sum(prune_behind(d["non_cond_frame_outputs"], current, start, reverse, win)
               for d in sess.output_dict_per_obj.values())


def peak_rss_mb() -> Optional[float]:
    """This process's peak resident memory, MB (for the memory test)."""
    try:
        import resource
        import sys

        r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return r / 2 ** 20 if sys.platform == "darwin" else r / 1024
    except Exception:
        return None


__all__ = ["Sam2Frames", "Sam3Frames", "install_sam2_streaming", "prune_behind", "sam2_prune", "sam3_prune",
           "window", "peak_rss_mb"]
