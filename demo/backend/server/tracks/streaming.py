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
  - _PyAVRuns decodes RUN frames at a time in the direction tracking moves:
    it seeks to the keyframe before the run, decodes to its end, keeps only
    that run and closes the file. Frame i is the i-th frame a plain decode
    yields, found by timestamp (the packet index built at open), so B-frames,
    a first timestamp other than 0, variable frame rates and edit lists all
    land on the right frame; a stream without usable timestamps (none, or
    two frames sharing one) is decoded from the start instead. (It replaced decord, whose reader, once read, decoded the
    whole clip in a background thread and kept every frame.)
  - prune_behind drops the non-seeded outputs a propagation has moved past by
    more than the model's window. Seeded (cond) frames are never touched, and
    neither are the frames just after the start, which the reverse pass reads.
"""
import bisect
import contextlib
import threading
from collections import OrderedDict
from typing import Dict, List, Optional, Tuple

import numpy as np
import torch

KEEP_DECODED = 4  # recent frames kept decoded (tracking asks for each once, in order)
RUN = 16  # frames decoded per open of the file, which is then closed


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


def _packet_index(video_path: str) -> Tuple[Optional[List[int]], List[int]]:
    """The timestamps of the frames a decode shows, in display order, and of the
    keyframes, from the packets (and the first decoded frame). Packets an edit
    list hides are not shown frames, but their keyframes are where decoding
    starts; packets before the first keyframe, and frames shown before the first
    frame a decode yields, never decode. None for the frames when the stream has
    no timestamps (raw h264) or two frames share one (a millisecond time base at
    a high frame rate): those are decoded in order from the start."""
    import av

    shown, keys = [], []
    with av.open(video_path) as c:
        stream = c.streams.video[0]
        for pkt in c.demux(stream):
            if not pkt.size:
                continue  # the demuxer's end-of-stream packet
            if pkt.pts is None:
                return None, []
            if pkt.is_keyframe:
                keys.append(pkt.pts)
            elif not keys:
                continue  # before the first keyframe (a stream joined mid-GOP)
            if not pkt.is_discard:
                shown.append(pkt.pts)
    if len(set(shown)) != len(shown):
        return None, []
    with av.open(video_path) as c:
        first = next((f.pts for f in c.decode(video=0) if f.pts is not None), None)
    if first is None:
        return None, []
    return sorted(t for t in shown if t >= first), sorted(keys)


def _count_frames(video_path: str) -> int:
    import av

    with av.open(video_path) as c:
        return sum(1 for _ in c.decode(video=0))


class _PyAVRuns:
    """Frames of a video, decoded RUN at a time in the direction the reader is
    moving (so the reverse pass is cheap too), keeping only the current run.
    Each run opens the file, seeks to the keyframe before the run, decodes to
    the run's end and closes it. Same decode and resize as upstream's loader."""

    def __init__(self, video_path: str, width: int = -1, height: int = -1, run: int = RUN):
        self._path, self._w, self._h, self._run = video_path, width, height, run
        self._pts, self._keys = _packet_index(video_path)
        self.n = len(self._pts) if self._pts is not None else _count_frames(video_path)
        self._raw: Dict[int, torch.Tensor] = {}
        self._last = -1

    def get(self, i: int) -> torch.Tensor:
        """Frame i as an HxWx3 uint8 tensor (the caller must not modify it)."""
        if not 0 <= i < self.n:
            raise IndexError(i)
        if i not in self._raw:
            backward = i < self._last
            start, end = (max(0, i - self._run + 1), i + 1) if backward else (i, min(self.n, i + self._run))
            self._raw = {}  # free the old run before decoding the next
            frames = self._decode(start, end)
            batch = torch.from_numpy(np.stack(frames))  # one copy, independent of the decoder's buffers
            self._raw = {start + k: batch[k] for k in range(end - start)}
        self._last = i
        return self._raw[i]

    def _decode(self, start: int, end: int) -> list:
        if self._pts is None:  # no timestamps: count frames from the start
            with self._open() as (c, stream, to_rgb):
                return [to_rgb(f) for k, f in zip(range(end), c.decode(stream)) if k >= start]
        want = {self._pts[k]: k - start for k in range(start, end)}
        first = self._pts[start]
        key = bisect.bisect_right(self._keys, first) - 1  # the last keyframe at or before the run
        while True:
            key_pts = self._keys[key] if key >= 0 else None  # None: from the top of a fresh open
            with self._open() as (c, stream, to_rgb):
                if key_pts is not None:
                    c.seek(key_pts, stream=stream, backward=True, any_frame=False)
                out = self._collect(c.decode(stream), to_rgb, first, want, check_landing=key_pts is not None)
            if out is not None:
                return out
            key -= 1  # the seek missed (mpegts seeks by searching): a keyframe earlier

    @contextlib.contextmanager
    def _open(self):
        import av
        from sam2.utils.misc import pyav_rgb_converter

        with av.open(self._path) as c:
            stream = c.streams.video[0]
            stream.thread_type = "AUTO"
            yield c, stream, pyav_rgb_converter(stream, self._w, self._h)

    def _collect(self, frames, to_rgb, first: int, want: Dict[int, int], check_landing: bool) -> Optional[list]:
        """The run's frames, matched by timestamp, or None when a seek went wrong:
        the first frame after it is already past the run's first frame, or no
        frame came at all (seeking into a transport stream's last GOP can). Once
        it has landed, a frame that does not come is an error, not a retry."""
        out: list = [None] * len(want)
        left = len(want)
        last = max(want)
        landed = not check_landing
        for frame in frames:
            if frame.pts is None:
                continue
            if not landed:
                if frame.pts > first:
                    return None
                landed = True
            k = want.get(frame.pts)
            if k is not None and out[k] is None:
                out[k] = to_rgb(frame)
                left -= 1
                if not left:
                    return out
            if frame.pts > last:
                break  # past the run: what is missing is not coming
        if not landed:
            return None
        raise RuntimeError(f"{self._path}: {left} frame(s) of a run did not decode")


class Sam2Frames:
    """SAM 2's `inference_state["images"]`, decoded on request: frame i is
    exactly what upstream's load_video_frames_from_video_file stacks at i
    (resize to image_size as decord did, /255, minus mean, over std, on the CPU)."""

    def __init__(self, video_path: str, image_size: int, img_mean=(0.485, 0.456, 0.406),
                 img_std=(0.229, 0.224, 0.225), keep: int = KEEP_DECODED):
        self._runs = _PyAVRuns(video_path, image_size, image_size)
        self._n = self._runs.n
        self._mean = torch.tensor(img_mean, dtype=torch.float32)[:, None, None]
        self._std = torch.tensor(img_std, dtype=torch.float32)[:, None, None]
        self._cache = _Lru(keep)
        self._lock = threading.Lock()  # jobs share this

    def __len__(self) -> int:
        return self._n

    def __getitem__(self, i: int) -> torch.Tensor:
        i = int(i)
        if not 0 <= i < self._n:
            raise IndexError(i)
        with self._lock:
            hit = self._cache.get(i)
            if hit is None:
                frame = self._runs.get(i).permute(2, 0, 1)
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
            h, w = _native_size(video_path)
            return Sam2Frames(video_path, image_size, img_mean, img_std), h, w
        return upstream(video_path, image_size, offload_video_to_cpu, img_mean=img_mean, img_std=img_std,
                        async_loading_frames=async_loading_frames,
                        **({"compute_device": compute_device} if compute_device is not None else {}), **kw)

    load_video_frames._sam_ui_streaming = True
    svp.load_video_frames = load_video_frames


def _native_size(video_path: str) -> Tuple[int, int]:
    """The first decoded frame's height and width, as upstream's loader reports."""
    import av

    with av.open(video_path) as c:
        for frame in c.decode(video=0):
            return frame.height, frame.width
    raise RuntimeError(f"no frames decoded from {video_path}")


def _is_dir(p: str) -> bool:
    import os

    return os.path.isdir(p)


class Sam3Frames:
    """SAM 3's `session.processed_frames`, processed on request: frame i is what
    the processor's video_processor makes of the whole clip at i (it transforms
    frames independently), stored as the session would store it."""

    def __init__(self, video_path: str, processor, dtype=torch.float32, keep: int = KEEP_DECODED):
        self._runs = _PyAVRuns(video_path)
        self._n = self._runs.n
        self._proc = processor
        self._dtype = dtype
        self._cache = _Lru(keep)
        self._lock = threading.Lock()
        first = self._runs.get(0).numpy()
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
                frame = self._runs.get(i).numpy()
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
