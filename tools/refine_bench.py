# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Benchmark for the refinement pass (issue draft 6): where should the expensive
model run once a cheap rough track exists?

For each object (a Meta gallery clip and a fixed click on frame 0):

  rough      SAM 2.1 tiny, full frame, whole clip. Gives the temporal envelope
             (frames whose mask is non-empty, gaps merged, padded) and the bbox
             trajectory the crop strategies follow.
  reference  SAM 2.1 large, full frame, whole clip. A ground-truth PROXY, not
             human truth: every score below is agreement with large.
  s1         large, full frame, only on the envelope's frames.
  s2         large on padded moving square crops: bbox centre and size smoothed
             over --smooth frames, --pad of the box added on each side,
             resized to the model's 1024 input, masks mapped back to source.
  s3         large on adaptive crops: margin grows with object speed, side
             never below --min-side (caps upscaling at 1024/min-side).
  s4         large on every --keyframe-every'th envelope frame (a sparse video),
             tiny propagating between them from those masks, attending to
             the --s4-cond-frames nearest keyframes.

Each run is its own process, so each peak memory is its own, and takes the GPU
lock (a directory, see --lock) only while a model runs. Masks are cached under
--out, so a rerun only does what is missing; --report-only rebuilds the table.

    python tools/refine_bench.py                       # everything
    python tools/refine_bench.py --objects dog --strategies rough reference s2
    python tools/refine_bench.py --report-only
"""
import argparse
import contextlib
import ctypes
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
import torch
import torch.nn.functional as F

REPO = Path(__file__).resolve().parents[1]
WEIGHTS = Path.home() / ".cache/rotoscoping-video-subjects/weights"
MODELS = {
    "tiny": ("sam2.1_hiera_tiny.pt", "configs/sam2.1/sam2.1_hiera_t.yaml"),
    "large": ("sam2.1_hiera_large.pt", "configs/sam2.1/sam2.1_hiera_l.yaml"),
}
GALLERY = REPO / "demo/data/gallery"
IMAGE_SIZE = 1024  # SAM 2.1's input side
MEAN = (0.485, 0.456, 0.406)
STD = (0.229, 0.224, 0.225)

# object -> (clip, seed frame, x, y in source pixels). One click on the object.
OBJECTS: Dict[str, Tuple[str, int, int, int]] = {
    "dog": ("01_dog.mp4", 0, 620, 420),
    "cups_ball": ("02_cups.mp4", 0, 400, 462),
    "blocks_u": ("03_blocks.mp4", 0, 815, 255),
    "coffee_kettle": ("04_coffee.mp4", 0, 560, 470),
    "juggle_ball": ("05_default_juggle.mp4", 0, 650, 320),
    "juggle_person": ("05_default_juggle.mp4", 0, 700, 230),
}
STRATEGIES = ["rough", "reference", "s1", "s2", "s3", "s4"]
Box = Tuple[
    int, int, int
]  # (x0, y0, side): a square crop in source pixels, may overhang the frame


# --------------------------------------------------------------------------
# Envelope and crop geometry (pure, unit-tested in demo/backend/tests)
# --------------------------------------------------------------------------


def envelope_frames(
    nonempty: Sequence[bool],
    pad: int = 2,
    merge_gap: int = 5,
    always: Sequence[int] = (),
) -> List[int]:
    """Frames the refinement runs on: the non-empty frames, with gaps of at
    most `merge_gap` frames filled, each interval grown by `pad` frames on both
    sides, plus `always` (the seed frame)."""
    n = len(nonempty)
    on = [i for i, v in enumerate(nonempty) if v]
    keep = set(int(a) for a in always)
    if on:
        runs = [[on[0], on[0]]]
        for i in on[1:]:
            if i - runs[-1][1] - 1 <= merge_gap:
                runs[-1][1] = i
            else:
                runs.append([i, i])
        for a, b in runs:
            keep.update(range(max(0, a - pad), min(n, b + pad + 1)))
    return sorted(f for f in keep if 0 <= f < n)


def mask_bbox(mask: np.ndarray) -> Optional[Tuple[int, int, int, int]]:
    """(x0, y0, x1, y1), x1/y1 exclusive, of a bool mask; None if empty."""
    ys = np.flatnonzero(mask.any(1))
    if ys.size == 0:
        return None
    xs = np.flatnonzero(mask.any(0))
    return int(xs[0]), int(ys[0]), int(xs[-1]) + 1, int(ys[-1]) + 1


def fill_boxes(boxes: Sequence[Optional[Tuple[int, int, int, int]]]) -> np.ndarray:
    """Per-frame boxes with the missing ones (empty rough mask) taken from the
    nearest frame that has one. Returns n x 4 floats."""
    have = [i for i, b in enumerate(boxes) if b is not None]
    if not have:
        raise ValueError("no frame has a box")
    out = np.zeros((len(boxes), 4))
    for i in range(len(boxes)):
        j = min(have, key=lambda h: (abs(h - i), h))
        out[i] = boxes[j]
    return out


def moving_average(a: np.ndarray, win: int) -> np.ndarray:
    """Centred moving average along axis 0. Near the ends the window shrinks
    symmetrically (a one-sided window would pull the first and last crops
    towards where the object is going or has been)."""
    if win <= 1:
        return np.asarray(a, float).copy()
    a = np.asarray(a, float)
    n, h = len(a), win // 2
    return np.stack(
        [a[i - k : i + k + 1].mean(0) for i in range(n) for k in [min(h, i, n - 1 - i)]]
    )


def rolling_max(a: np.ndarray, win: int) -> np.ndarray:
    a = np.asarray(a, float)
    h = win // 2
    return np.array([a[max(0, i - h) : i + h + 1].max() for i in range(len(a))])


def place_square(cx: float, cy: float, side: float, W: int, H: int) -> Box:
    """An integer square crop of `side` centred on (cx, cy). Along an axis the
    frame is at least `side` long, it is shifted to lie inside the frame; along
    one that is shorter, it stays centred and overhangs (the overhang is padded)."""
    s = max(1, int(round(side)))

    def axis(c: float, n: int) -> int:
        lo = int(round(c - s / 2))
        if s <= n:
            return min(max(lo, 0), n - s)
        return lo

    return axis(cx, W), axis(cy, H), s


def _crop_sizes(boxes: np.ndarray) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    cx = (boxes[:, 0] + boxes[:, 2]) / 2
    cy = (boxes[:, 1] + boxes[:, 3]) / 2
    size = np.maximum(boxes[:, 2] - boxes[:, 0], boxes[:, 3] - boxes[:, 1])
    return cx, cy, size


def fixed_crops(
    boxes: np.ndarray,
    W: int,
    H: int,
    pad: float = 0.25,
    win: int = 9,
    min_side: int = 64,
) -> List[Box]:
    """Strategy 2: bbox centre and size smoothed over `win` frames, `pad` of
    the size added on each side, square."""
    cx, cy, size = _crop_sizes(boxes)
    cx, cy, size = (
        moving_average(cx, win),
        moving_average(cy, win),
        moving_average(size, win),
    )
    side = np.clip(size * (1 + 2 * pad), min_side, max(W, H))
    return [place_square(x, y, s, W, H) for x, y, s in zip(cx, cy, side)]


def adaptive_crops(
    boxes: np.ndarray,
    W: int,
    H: int,
    base_pad: float = 0.15,
    lead: float = 4.0,
    win: int = 9,
    centre_win: int = 5,
    min_side: int = 256,
) -> List[Box]:
    """Strategy 3: size from a rolling max (never under-covers a growing
    object), centre smoothed less (follows fast motion), and a margin of
    `base_pad` of the size plus `lead` frames of the local speed on each side.
    `min_side` caps the upscale at 1024 / min_side and keeps context round
    small objects."""
    cx, cy, size = _crop_sizes(boxes)
    speed = np.r_[0.0, np.hypot(np.diff(cx), np.diff(cy))]
    speed = rolling_max(speed, win)
    size = rolling_max(size, win)
    cx, cy = moving_average(cx, centre_win), moving_average(cy, centre_win)
    side = np.clip(size * (1 + 2 * base_pad) + 2 * lead * speed, min_side, max(W, H))
    return [place_square(x, y, s, W, H) for x, y, s in zip(cx, cy, side)]


def crop_image(
    frame: torch.Tensor, box: Box, out: int = IMAGE_SIZE, fill: Sequence[float] = None
) -> torch.Tensor:
    """The square `box` of an H x W x 3 uint8 frame as a 3 x out x out float
    image in 0..255, overhang filled with `fill` (default the model's mean
    colour, which normalises to 0). Pixel u of the output samples source
    x0 + (u + 0.5) * side / out - 0.5 (align_corners=False)."""
    H, W = frame.shape[:2]
    x0, y0, s = box
    if fill is None:
        fill = [255 * m for m in MEAN]
    canvas = torch.empty(3, s, s, dtype=torch.float32)
    canvas[:] = torch.tensor(fill, dtype=torch.float32)[:, None, None]
    sx0, sy0, sx1, sy1 = max(x0, 0), max(y0, 0), min(x0 + s, W), min(y0 + s, H)
    if sx1 > sx0 and sy1 > sy0:
        canvas[:, sy0 - y0 : sy1 - y0, sx0 - x0 : sx1 - x0] = (
            frame[sy0:sy1, sx0:sx1].permute(2, 0, 1).float()
        )
    if s == out:
        return canvas
    return F.interpolate(
        canvas[None],
        size=(out, out),
        mode="bilinear",
        align_corners=False,
        antialias=s > out,
    )[0]


def paste_logits(logits: torch.Tensor, box: Box, W: int, H: int) -> np.ndarray:
    """A crop's out x out mask logits back into an H x W bool source mask:
    resized to the crop's side (bilinear, the same convention as crop_image),
    thresholded at 0, the part inside the frame placed at the crop's position."""
    x0, y0, s = box
    lg = logits.float()
    if lg.shape[-1] != s or lg.shape[-2] != s:
        lg = F.interpolate(
            lg[None, None], size=(s, s), mode="bilinear", align_corners=False
        )[0, 0]
    m = (lg > 0).cpu().numpy()
    out = np.zeros((H, W), bool)
    sx0, sy0, sx1, sy1 = max(x0, 0), max(y0, 0), min(x0 + s, W), min(y0 + s, H)
    if sx1 > sx0 and sy1 > sy0:
        out[sy0:sy1, sx0:sx1] = m[sy0 - y0 : sy1 - y0, sx0 - x0 : sx1 - x0]
    return out


def point_to_crop(x: float, y: float, box: Box) -> Tuple[float, float]:
    """A source pixel coordinate as the crop's normalised (0..1) coordinate."""
    x0, y0, s = box
    return (x - x0) / s, (y - y0) / s


def outside_fraction(mask: np.ndarray, box: Box) -> float:
    """Share of a mask's pixels outside a crop (the crop clipped the object)."""
    n = int(mask.sum())
    if n == 0:
        return 0.0
    x0, y0, s = box
    H, W = mask.shape
    inside = mask[max(y0, 0) : min(y0 + s, H), max(x0, 0) : min(x0 + s, W)].sum()
    return float(1 - inside / n)


# --------------------------------------------------------------------------
# Metrics
# --------------------------------------------------------------------------


def iou(a: np.ndarray, b: np.ndarray) -> float:
    """IoU of two bool masks; two empty masks agree (1.0)."""
    u = np.logical_or(a, b).sum()
    return 1.0 if u == 0 else float(np.logical_and(a, b).sum() / u)


def _boundary(m: torch.Tensor) -> torch.Tensor:
    # Outside the image is background, including for a full-frame mask.
    padded = F.pad(m[None, None], (1, 1, 1, 1), value=0)
    er = -F.max_pool2d(-padded, 3, 1)[0, 0]
    return (m > 0) & (er <= 0)


def boundary_f(a: np.ndarray, b: np.ndarray, tol: int = 2) -> float:
    """Boundary F-measure: boundary pixels within `tol` px (square
    neighbourhood) of the other mask's boundary. Two empty masks score 1."""
    ta, tb = torch.from_numpy(a).float(), torch.from_numpy(b).float()
    ba, bb = _boundary(ta), _boundary(tb)
    na, nb = int(ba.sum()), int(bb.sum())
    if na == 0 and nb == 0:
        return 1.0
    if na == 0 or nb == 0:
        return 0.0
    k = 2 * tol + 1
    da = F.max_pool2d(ba.float()[None, None], k, 1, tol)[0, 0] > 0
    db = F.max_pool2d(bb.float()[None, None], k, 1, tol)[0, 0] > 0
    p = float((ba & db).sum()) / na
    r = float((bb & da).sum()) / nb
    return 0.0 if p + r == 0 else 2 * p * r / (p + r)


# --------------------------------------------------------------------------
# Mask storage
# --------------------------------------------------------------------------


def save_masks(
    path: Path, masks: Dict[int, np.ndarray], n: int, H: int, W: int, **extra
) -> None:
    packed = np.zeros((n, (H * W + 7) // 8), np.uint8)
    for f, m in masks.items():
        packed[f] = np.packbits(m.reshape(-1))
    np.savez_compressed(
        path,
        packed=packed,
        shape=np.array([n, H, W]),
        **{k: np.asarray(v) for k, v in extra.items()},
    )


def load_masks(path: Path) -> Tuple[np.ndarray, Dict]:
    z = np.load(path)
    n, H, W = (int(v) for v in z["shape"])
    extra = {k: z[k] for k in z.files if k not in ("packed", "shape")}
    return z["packed"], {"n": n, "H": H, "W": W, **extra}


def unpack(packed: np.ndarray, f: int, H: int, W: int) -> np.ndarray:
    return np.unpackbits(packed[f], count=H * W).reshape(H, W).astype(bool)


# --------------------------------------------------------------------------
# Running the models (child process)
# --------------------------------------------------------------------------


class SubVideo:
    """A video SAM 2 can track (it stands in for inference_state["images"]):
    a chosen list of source frames, each whole (resized to 1024 by decord, as
    upstream and tracks.streaming do) or a square crop of it (cropped at native
    resolution, then resized). Masks come out at the source size for whole
    frames and at 1024 x 1024 for crops (paste_logits maps them back)."""

    def __init__(
        self,
        video_path: str,
        frames: Sequence[int],
        boxes: Optional[Sequence[Box]] = None,
    ):
        from tracks.streaming import _DecordRuns

        self.frames = list(frames)
        self.boxes = list(boxes) if boxes is not None else None
        if self.boxes is not None and len(self.boxes) != len(self.frames):
            raise ValueError("one box per frame")
        native = _DecordRuns(video_path)
        h, w = native.get(0).shape[:2]
        self.source_hw = (int(h), int(w))
        if self.boxes is None:
            del native
            self._runs = _DecordRuns(video_path, IMAGE_SIZE, IMAGE_SIZE)
            self.height, self.width = self.source_hw
        else:
            self._runs = native
            self.height = self.width = IMAGE_SIZE
        self._mean = torch.tensor(MEAN)[:, None, None]
        self._std = torch.tensor(STD)[:, None, None]
        self._last: Tuple[int, Optional[torch.Tensor]] = (-1, None)

    def __len__(self) -> int:
        return len(self.frames)

    def __getitem__(self, i: int) -> torch.Tensor:
        i = int(i)
        if self._last[0] == i:
            return self._last[1]
        raw = self._runs.get(self.frames[i])
        if self.boxes is None:
            img = raw.permute(2, 0, 1).float()
        else:
            img = crop_image(raw, self.boxes[i])
        img = (img / 255.0 - self._mean) / self._std
        self._last = (i, img)
        return img


def install_subvideo() -> None:
    """Let init_state take a SubVideo as its video_path (other paths go to
    the streaming loader, as in the app)."""
    import sam2.sam2_video_predictor as svp
    from tracks.streaming import install_sam2_streaming

    install_sam2_streaming()
    if getattr(svp.load_video_frames, "_refine_bench", False):
        return
    inner = svp.load_video_frames

    def load_video_frames(video_path, *a, **kw):
        if isinstance(video_path, SubVideo):
            return video_path, video_path.height, video_path.width
        return inner(video_path, *a, **kw)

    load_video_frames._refine_bench = True
    svp.load_video_frames = load_video_frames


class Peak:
    """Peak MPS driver memory, sampled after each frame."""

    def __init__(self):
        self.mps = 0

    def sample(self):
        if torch.backends.mps.is_available():
            self.mps = max(self.mps, torch.mps.driver_allocated_memory())


def footprint_mb() -> Dict[str, float]:
    """This process's peak physical footprint (macOS proc_pid_rusage
    ri_lifetime_max_phys_footprint, what Activity Monitor's Memory column
    peaks at; it counts MPS buffers) and peak RSS."""
    out = {}
    try:
        import resource

        r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        out["peak_rss_mb"] = r / 2**20 if sys.platform == "darwin" else r / 1024
    except Exception:
        pass
    if sys.platform == "darwin":
        try:
            buf = (ctypes.c_uint64 * 64)()
            libc = ctypes.CDLL("/usr/lib/libSystem.dylib")
            if libc.proc_pid_rusage(os.getpid(), 4, buf) == 0:  # RUSAGE_INFO_V4
                # 16-byte uuid, then uint64 fields: [2+7] ri_phys_footprint, [2+28] ri_lifetime_max_phys_footprint
                out["footprint_now_mb"] = buf[2 + 7] / 2**20
                out["peak_footprint_mb"] = buf[2 + 28] / 2**20
        except Exception:
            pass
    return out


def _device() -> str:
    return (
        "mps"
        if torch.backends.mps.is_available()
        else ("cuda" if torch.cuda.is_available() else "cpu")
    )


def _build(model: str):
    from sam2.build_sam import build_sam2_video_predictor

    ckpt, cfg = MODELS[model]
    return build_sam2_video_predictor(cfg, str(WEIGHTS / ckpt), device=_device())


def _propagate(
    pred,
    video,
    start: int,
    peak: Peak,
    point: Optional[Tuple[float, float]] = None,
    masks: Optional[Dict[int, np.ndarray]] = None,
):
    """Yield (position, logits on the video's output grid) for every frame of
    `video`, seeded with a normalised click at `start` or with masks at given
    positions. Same pruning as tracks.engine.Sam2Engine."""
    from tracks.streaming import sam2_prune

    state = pred.init_state(video, offload_video_to_cpu=True)
    try:
        if masks:
            for pos in sorted(masks):
                pred.add_new_mask(
                    inference_state=state, frame_idx=pos, obj_id=1, mask=masks[pos]
                )
        else:
            pred.add_new_points_or_box(
                inference_state=state,
                frame_idx=start,
                obj_id=1,
                points=np.array([point], np.float32),
                labels=np.array([1], np.int32),
                clear_old_points=True,
                normalize_coords=False,
            )
        for reverse in (False, True):
            for f, _ids, out in pred.propagate_in_video(
                state, start_frame_idx=start, reverse=reverse
            ):
                sam2_prune(pred, state, f, start, reverse)
                if reverse and f == start:
                    continue
                peak.sample()
                yield f, out[0, 0]
    finally:
        pred.reset_state(state)


def run_child(spec: Dict) -> Dict:
    """One model batch. spec: kind, clip, out, seed (frame, x, y), and per kind
    frames / boxes / keyframes."""
    sys.path.insert(0, str(REPO / "demo/backend/server"))
    install_subvideo()
    kind, clip, seed_f, sx, sy = spec["kind"], spec["clip"], *spec["seed"]
    peak = Peak()
    t_load = time.perf_counter()
    if kind == "track":
        pred = _build(spec["model"])
    else:
        pred = _build("large")
    tiny = _build("tiny") if kind == "keyframe" else None
    if tiny is not None and spec.get("cond_frames", -1) > 0:
        # attend to the nearest keyframes only: with every keyframe (upstream's
        # -1) each frame's memory attention grows with the number of keyframes
        tiny.max_cond_frames_in_attn = spec["cond_frames"]
    load_s = time.perf_counter() - t_load
    masks: Dict[int, np.ndarray] = {}
    extra: Dict = {}
    t0 = time.perf_counter()
    large_frames = tiny_frames = 0
    if kind == "track":
        # the app's own engine, whole clip, full frame
        from tracks.engine import Sam2Engine

        probe = SubVideo(clip, [0])
        H, W = probe.source_hw
        import decord

        n = len(decord.VideoReader(clip))
        e = Sam2Engine(
            pred, model=spec["model"], offload_video_to_cpu=_device() == "mps"
        )
        seeds = {1: {seed_f: {"points": [[sx / W, sy / H]], "labels": [1]}}}
        for f, by_obj in e.track(clip, seeds):
            peak.sample()
            masks[f] = by_obj[1]
        if spec["model"] == "large":
            large_frames = len(masks)
        else:
            tiny_frames = len(masks)
    else:
        frames = spec["frames"]
        n, H, W = spec["n"], spec["H"], spec["W"]
        start = frames.index(seed_f)
        if kind == "full":
            v = SubVideo(clip, frames)
            for pos, lg in _propagate(pred, v, start, peak, point=(sx / W, sy / H)):
                masks[frames[pos]] = (lg > 0).cpu().numpy()
            large_frames = len(frames)
        elif kind == "crop":
            boxes = [tuple(b) for b in spec["boxes"]]
            v = SubVideo(clip, frames, boxes)
            for pos, lg in _propagate(
                pred, v, start, peak, point=point_to_crop(sx, sy, boxes[start])
            ):
                masks[frames[pos]] = paste_logits(lg, boxes[pos], W, H)
            large_frames = len(frames)
            extra["boxes"] = np.array(boxes)
            extra["box_frames"] = np.array(frames)
        elif kind == "keyframe":
            keypos = spec["keypos"]
            kv = SubVideo(clip, [frames[p] for p in keypos])
            kstart = keypos.index(start)
            key_masks = {}
            for kp, lg in _propagate(pred, kv, kstart, peak, point=(sx / W, sy / H)):
                key_masks[keypos[kp]] = (lg > 0).cpu().numpy()
            large_frames = len(keypos)
            t_large = time.perf_counter() - t0
            v = SubVideo(clip, frames)
            for pos, lg in _propagate(tiny, v, start, peak, masks=key_masks):
                # keyframes keep large's mask as is (tiny's cond output would be
                # that mask squeezed through 256 x 256)
                masks[frames[pos]] = (
                    key_masks[pos] if pos in key_masks else (lg > 0).cpu().numpy()
                )
            tiny_frames = len(frames)
            extra["large_s"] = t_large
        else:
            raise ValueError(kind)
    track_s = time.perf_counter() - t0
    save_masks(Path(spec["out"]), masks, n, H, W, **extra)
    meta = {
        "kind": kind,
        "load_s": round(load_s, 2),
        "track_s": round(track_s, 2),
        "large_frames": large_frames,
        "tiny_frames": tiny_frames,
        "n": n,
        "H": H,
        "W": W,
        "peak_mps_driver_mb": round(peak.mps / 2**20),
        **{k: round(v) for k, v in footprint_mb().items()},
    }
    if "large_s" in extra:
        meta["large_s"] = round(float(extra["large_s"]), 2)
    return meta


# --------------------------------------------------------------------------
# Orchestration (parent)
# --------------------------------------------------------------------------


@contextlib.contextmanager
def gpu_lock(
    path: Optional[Path],
    wait_s: int = 60,
    max_wait_s: int = 45 * 60,
    job: str = "refinement benchmark",
):
    """mkdir lock shared with other agents; held only around one model batch."""
    if path is None:
        yield
        return
    waited = 0
    while True:
        try:
            path.mkdir()
            break
        except FileExistsError:
            try:
                holder = (path / "owner").read_text().strip()
            except FileNotFoundError:
                holder = "owner file not yet available"
            if waited >= max_wait_s:
                raise TimeoutError(f"GPU lock {path} held for {waited}s: {holder}")
            print(f"  gpu lock held by {holder}, waiting ({waited}s)", flush=True)
            time.sleep(wait_s)
            waited += wait_s
    started = datetime.now(timezone.utc)
    owner = path / "owner"
    identity = json.dumps(
        {
            "who": "refine_bench",
            "pid": os.getpid(),
            "job": job,
            "started": started.isoformat(),
            "expected_end": (started + timedelta(minutes=45)).isoformat(),
        },
        indent=1,
    )
    try:
        owner.write_text(identity)
        yield
    finally:
        # Never remove a lock that somebody else has taken over.
        if owner.exists() and owner.read_text() == identity:
            owner.unlink()
            path.rmdir()


def memory_free_pct() -> Optional[int]:
    try:
        out = subprocess.run(
            ["memory_pressure"], capture_output=True, text=True, timeout=30
        ).stdout
        m = re.search(r"free percentage:\s*(\d+)%", out)
        return int(m.group(1)) if m else None
    except Exception:
        return None


def wait_for_memory(min_free: int, max_wait_s: int = 30 * 60) -> Optional[int]:
    waited = 0
    while True:
        free = memory_free_pct()
        if free is None or free >= min_free or waited >= max_wait_s:
            return free
        print(f"  memory free {free}% < {min_free}%, waiting", flush=True)
        time.sleep(60)
        waited += 60


def child(spec: Dict, lock: Optional[Path], min_free: int) -> Dict:
    free = wait_for_memory(min_free)
    # A failed replacement must not leave old masks looking like a successful
    # run of the new spec. Metadata is the success marker, written last.
    Path(spec["out"]).with_suffix(".json").unlink(missing_ok=True)
    spec_path = Path(spec["out"]).with_suffix(".spec.json")
    spec_path.write_text(json.dumps(spec))
    env = {**os.environ, "PYTORCH_ENABLE_MPS_FALLBACK": "1", "TQDM_DISABLE": "1"}
    with gpu_lock(lock, job=f"{spec['kind']}: {spec['out']}"):
        r = subprocess.run(
            [sys.executable, __file__, "--_child", str(spec_path)],
            capture_output=True,
            text=True,
            env=env,
            cwd=REPO,
        )
    lines = [l for l in r.stdout.splitlines() if l.startswith("{")]
    if r.returncode != 0 or not lines:
        raise RuntimeError(f"child {spec['kind']} failed:\n{r.stderr[-3000:]}")
    meta = json.loads(lines[-1])
    meta["memory_free_pct_before"] = free
    Path(spec["out"]).with_suffix(".json").write_text(json.dumps(meta, indent=1))
    return meta


def plan_object(name: str, a, out: Path, lock: Optional[Path]) -> None:
    clip_name, seed_f, sx, sy = OBJECTS[name]
    clip = str(GALLERY / clip_name)
    d = out / name
    d.mkdir(parents=True, exist_ok=True)
    seed = [seed_f, sx, sy]

    def run(strategy: str, spec: Dict):
        path = d / f"{strategy}.npz"
        wanted = {"clip": clip, "seed": seed, "out": str(path), **spec}
        if path.exists() and path.with_suffix(".json").exists():
            try:
                cached = json.loads(path.with_suffix(".spec.json").read_text())
            except (OSError, ValueError):
                cached = None
            if cached == wanted:
                return
        print(f"{name}: {strategy}", flush=True)
        meta = child(wanted, lock, a.min_free)
        print(f"  {json.dumps(meta)}", flush=True)

    want = set(a.strategies)
    run("rough", {"kind": "track", "model": "tiny"})
    if "reference" in want:
        run("reference", {"kind": "track", "model": "large"})
    packed, info = load_masks(d / "rough.npz")
    n, H, W = info["n"], info["H"], info["W"]
    nonempty = [bool(packed[f].any()) for f in range(n)]
    frames = envelope_frames(nonempty, a.env_pad, a.merge_gap, always=[seed_f])
    boxes = None
    if want & {"s2", "s3"}:
        if any(nonempty):
            boxes = fill_boxes(
                [
                    mask_bbox(unpack(packed, f, H, W)) if nonempty[f] else None
                    for f in frames
                ]
            )
        else:
            for strategy in sorted(want & {"s2", "s3"}):
                # An older successful crop must not appear in this run's report.
                (d / f"{strategy}.json").unlink(missing_ok=True)
                print(
                    f"{name}: skipping {strategy}: no rough mask for a crop trajectory",
                    flush=True,
                )
    base = {"frames": frames, "n": n, "H": H, "W": W}
    (d / "envelope.json").write_text(json.dumps({"frames": frames, "n": n}))
    if "s1" in want:
        run("s1", {"kind": "full", **base})
    if "s2" in want and boxes is not None:
        crops = fixed_crops(boxes, W, H, pad=a.pad, win=a.smooth)
        run("s2", {"kind": "crop", "boxes": [list(c) for c in crops], **base})
    if "s3" in want and boxes is not None:
        crops = adaptive_crops(boxes, W, H, win=a.smooth, min_side=a.min_side)
        run("s3", {"kind": "crop", "boxes": [list(c) for c in crops], **base})
    if "s4" in want:
        keypos = sorted(
            set(range(0, len(frames), a.keyframe_every))
            | {len(frames) - 1, frames.index(seed_f)}
        )
        run(
            "s4",
            {
                "kind": "keyframe",
                "keypos": keypos,
                "cond_frames": a.s4_cond_frames,
                **base,
            },
        )


def edge_strength(frame: np.ndarray) -> torch.Tensor:
    """Sobel gradient magnitude of an H x W x 3 uint8 frame's luminance."""
    g = torch.from_numpy(frame).float() @ torch.tensor([0.299, 0.587, 0.114])
    k = torch.tensor([[-1.0, 0.0, 1.0], [-2.0, 0.0, 2.0], [-1.0, 0.0, 1.0]])
    gx = F.conv2d(g[None, None], k[None, None], padding=1)[0, 0]
    gy = F.conv2d(g[None, None], k.T[None, None], padding=1)[0, 0]
    return torch.hypot(gx, gy)


def boundary_edge(mask: np.ndarray, grad: torch.Tensor) -> float:
    """Mean image gradient on a mask's boundary pixels: a no-reference signal
    of whether the boundary sits on an image edge."""
    b = _boundary(torch.from_numpy(mask).float())
    return float(grad[b].mean()) if b.any() else float("nan")


def score_object(name: str, strategies: Sequence[str], out: Path) -> List[Dict]:
    """Every cached strategy of one object against the reference, the clip
    decoded once (for the boundary-edge signal)."""
    import av

    d = out / name
    if not all((d / f"reference.{ext}").exists() for ext in ("npz", "json")):
        return []
    have = [
        s
        for s in strategies
        if (d / f"{s}.npz").exists() and (d / f"{s}.json").exists()
    ]
    ref, info = load_masks(d / "reference.npz")
    n, H, W = info["n"], info["H"], info["W"]
    ref_meta = json.loads((d / "reference.json").read_text())
    runs = {}
    for s in have:
        got, ginfo = load_masks(d / f"{s}.npz")
        boxes = {}
        if "boxes" in ginfo:
            boxes = {
                int(f): tuple(int(v) for v in b)
                for f, b in zip(ginfo["box_frames"], ginfo["boxes"])
            }
        runs[s] = {
            "got": got,
            "boxes": boxes,
            "meta": json.loads((d / f"{s}.json").read_text()),
            "iou": [],
            "f": [],
            "spill": 0,
            "missed": 0,
            "extra": 0,
            "edge": [],
            "edge_ref": [],
        }
    c = av.open(str(GALLERY / OBJECTS[name][0]))
    try:
        for f, fr in enumerate(c.decode(video=0)):
            if f >= n:
                break
            r = unpack(ref, f, H, W)
            grad = edge_strength(fr.to_ndarray(format="rgb24")) if r.any() else None
            er = boundary_edge(r, grad) if grad is not None else None
            for s, st in runs.items():
                g = unpack(st["got"], f, H, W)
                st["iou"].append(iou(r, g))
                st["f"].append(boundary_f(r, g, 2))
                st["missed"] += int(r.any() and not g.any())
                st["extra"] += int(g.any() and not r.any())
                if f in st["boxes"] and outside_fraction(r, st["boxes"][f]) > 0.001:
                    st["spill"] += 1
                if grad is not None and g.any():
                    st["edge"].append(boundary_edge(g, grad))
                    st["edge_ref"].append(er)
    finally:
        c.close()
    rows = []
    present = sum(1 for f in range(n) if ref[f].any())
    for s, st in runs.items():
        meta, ious = st["meta"], np.array(st["iou"])
        proc = meta["large_frames"] + meta["tiny_frames"]
        rows.append(
            {
                "object": name,
                "strategy": s,
                "n": n,
                "ref_present": present,
                "large_frames": meta["large_frames"],
                "tiny_frames": meta["tiny_frames"],
                "track_s": meta["track_s"],
                "s_per_frame": round(meta["track_s"] / max(proc, 1), 3),
                "time_vs_ref": round(meta["track_s"] / ref_meta["track_s"], 3),
                "peak_mps_driver_mb": meta.get("peak_mps_driver_mb"),
                "peak_footprint_mb": meta.get("peak_footprint_mb"),
                "peak_rss_mb": meta.get("peak_rss_mb"),
                "iou_min": round(float(ious.min()), 4),
                "iou_p5": round(float(np.percentile(ious, 5)), 4),
                "iou_mean": round(float(ious.mean()), 4),
                "f2_mean": round(float(np.mean(st["f"])), 4),
                "below_0_9": int((ious < 0.9).sum()),
                "missed": st["missed"],
                "extra": st["extra"],
                "crop_spill": st["spill"] if st["boxes"] else None,
                "edge_vs_ref": (
                    round(float(np.nanmean(st["edge"]) / np.nanmean(st["edge_ref"])), 3)
                    if st["edge"]
                    else None
                ),
            }
        )
    return rows


COLS = [
    ("object", "object"),
    ("strategy", "strategy"),
    ("large_frames", "large fr"),
    ("tiny_frames", "tiny fr"),
    ("track_s", "track s"),
    ("s_per_frame", "s/frame"),
    ("time_vs_ref", "time vs ref"),
    ("peak_mps_driver_mb", "MPS peak MB"),
    ("peak_footprint_mb", "footprint peak MB"),
    ("iou_min", "IoU min"),
    ("iou_p5", "IoU p5"),
    ("iou_mean", "IoU mean"),
    ("f2_mean", "F@2px"),
    ("below_0_9", "IoU<0.9"),
    ("missed", "missed"),
    ("extra", "extra"),
    ("crop_spill", "spill"),
    ("edge_vs_ref", "edge vs ref"),
]


def table(rows: List[Dict]) -> str:
    head = "| " + " | ".join(h for _, h in COLS) + " |"
    sep = "|" + "|".join("---" for _ in COLS) + "|"
    body = [
        "| " + " | ".join("" if r.get(k) is None else str(r[k]) for k, _ in COLS) + " |"
        for r in rows
    ]
    return "\n".join([head, sep, *body])


def totals(rows: List[Dict]) -> List[Dict]:
    out = []
    for s in STRATEGIES:
        rs = [r for r in rows if r["strategy"] == s]
        if not rs:
            continue
        frames = sum(r["n"] for r in rs)
        ts = sum(r["track_s"] for r in rs)
        proc = sum(r["large_frames"] + r["tiny_frames"] for r in rs)
        ref_ts = sum(r["track_s"] / r["time_vs_ref"] for r in rs if r["time_vs_ref"])
        out.append(
            {
                "object": f"all ({len(rs)})",
                "strategy": s,
                "large_frames": sum(r["large_frames"] for r in rs),
                "tiny_frames": sum(r["tiny_frames"] for r in rs),
                "track_s": round(ts, 1),
                "s_per_frame": round(ts / max(proc, 1), 3),
                "time_vs_ref": round(ts / ref_ts, 3) if ref_ts else None,
                "peak_mps_driver_mb": max(r["peak_mps_driver_mb"] or 0 for r in rs),
                "peak_footprint_mb": max(r["peak_footprint_mb"] or 0 for r in rs),
                "iou_min": min(r["iou_min"] for r in rs),
                "iou_p5": min(r["iou_p5"] for r in rs),
                "iou_mean": round(sum(r["iou_mean"] * r["n"] for r in rs) / frames, 4),
                "f2_mean": round(sum(r["f2_mean"] * r["n"] for r in rs) / frames, 4),
                "below_0_9": sum(r["below_0_9"] for r in rs),
                "missed": sum(r["missed"] for r in rs),
                "extra": sum(r["extra"] for r in rs),
                "crop_spill": (
                    sum(r["crop_spill"] for r in rs)
                    if rs[0]["crop_spill"] is not None
                    else None
                ),
                "edge_vs_ref": round(
                    float(np.mean([r["edge_vs_ref"] for r in rs if r["edge_vs_ref"]])),
                    3,
                ),
            }
        )
    return out


def report(objects: List[str], out: Path) -> str:
    rows = [r for o in objects for r in score_object(o, STRATEGIES, out)]
    (out / "results.json").write_text(json.dumps(rows, indent=1))
    text = (
        table(rows)
        + "\n\nTotals per strategy (IoU mean and F weighted by frames; min and p5 are the worst object):\n\n"
        + table(totals(rows))
    )
    (out / "results.md").write_text(text + "\n")
    return text


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--objects", nargs="*", default=list(OBJECTS), choices=list(OBJECTS)
    )
    ap.add_argument(
        "--strategies",
        nargs="*",
        default=STRATEGIES,
        choices=STRATEGIES,
        help="rough always runs (the others need it)",
    )
    ap.add_argument(
        "--out",
        default=str(Path(tempfile.gettempdir()) / "sam-ui-refine-bench"),
        help="mask cache and results (default %(default)s)",
    )
    ap.add_argument(
        "--lock",
        default=str(Path.home() / "Movies/sam2-poc-data/.gpu-lock"),
        help="GPU lock directory, taken with mkdir around each model batch",
    )
    ap.add_argument("--no-lock", action="store_true", help="do not take the GPU lock")
    ap.add_argument(
        "--min-free",
        type=int,
        default=20,
        help="wait (up to 30 min) until memory_pressure reports this free %% before a batch",
    )
    ap.add_argument(
        "--env-pad",
        type=int,
        default=2,
        help="frames added on each side of an envelope interval",
    )
    ap.add_argument(
        "--merge-gap",
        type=int,
        default=5,
        help="absent runs this short stay inside the envelope",
    )
    ap.add_argument(
        "--pad",
        type=float,
        default=0.25,
        help="s2: share of the box added on EACH side",
    )
    ap.add_argument(
        "--smooth", type=int, default=9, help="s2/s3: smoothing window, frames"
    )
    ap.add_argument(
        "--min-side", type=int, default=256, help="s3: smallest crop side, px"
    )
    ap.add_argument(
        "--keyframe-every",
        type=int,
        default=5,
        help="s4: large on every Nth envelope frame",
    )
    ap.add_argument(
        "--s4-cond-frames",
        type=int,
        default=2,
        help="s4: keyframes tiny attends to per frame, the nearest ones (-1: all, upstream's default)",
    )
    ap.add_argument(
        "--report-only",
        action="store_true",
        help="only rebuild the table from the cache",
    )
    ap.add_argument("--_child", help=argparse.SUPPRESS)
    a = ap.parse_args()
    if a._child:
        print(json.dumps(run_child(json.loads(Path(a._child).read_text()))), flush=True)
        return
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    lock = None if a.no_lock else Path(a.lock)
    if not a.report_only:
        for name in a.objects:
            plan_object(name, a, out, lock)
    print(report(a.objects, out))


if __name__ == "__main__":
    main()
