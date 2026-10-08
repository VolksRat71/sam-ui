# sam-ui (Apache-2.0). New file, not from SAM 2.
"""SAM 3's video tracker as a sam-ui engine, through Hugging Face transformers
(`Sam3TrackerVideoModel`), which runs on Apple's MPS, unlike Meta's own sam3
package (CUDA only).

SAM 3's code and weights are under Meta's SAM License, not Apache-2.0. This
adapter is our code; it imports transformers at run time and loads weights
from a local folder (SAM_UI_SAM3_WEIGHTS, default the rotoscoping skill's
~/.cache/rotoscoping-video-subjects/weights/sam3-hf). Nothing of SAM 3 is
copied into this repository.

Measured on the synthetic squares (MPS, fp32): IoU min 0.989 against SAM 2's
0.974, at 1.43 s/frame against SAM 2's 0.61. Hence opt-in, per track job.
Memory (issue #11, tools/hardware_bench.py, M4 Max): a 5.5 GB peak physical
footprint tracking at fp32, 3.7 to 4.7 GB at fp16, the default on MPS
(SAM_UI_SAM3_DTYPE=fp32 for full precision, see tracks/precision.py).

Absent ranges (issue #20): each window of frames between them gets a session
of its own, seeded only from its seeds, so nothing crosses a gap.

Text prompts (issue #22, tracks/text.py): segment_text runs SAM 3's detector
(`Sam3Model`, image + text in, instances out) on one frame and returns the
best-scoring instance. The tracker (`Sam3TrackerVideoModel`) takes points
and masks only, and transformers' concept-tracking video model
(`Sam3VideoModel`) detects and tracks every instance over the whole clip,
which is discovery, not a prompt. The detector and the tracker share the
checkpoint's ViT backbone (446M parameters, identical weights), so the
detector is loaded on the first text prompt with its backbone swapped for the
tracker's: it adds its text encoder, DETR and heads (394M parameters, about
2 GB of MPS driver memory) instead of a second 840M model; only its own
weights are read (shared_detector). A text seed is stored as a mask, which the
tracker takes like any seed mask.

Idle unloading (issue #11): the detector is dropped once no prompt has used it
for SAM_UI_SAM3_DETECTOR_IDLE_S seconds (default 300), and the whole engine
once nothing has for SAM_UI_SAM3_IDLE_S (default 600); "never" keeps either
loaded. The next prompt or job loads it again (a few seconds). Every job
hands the allocator's cached blocks back when it ends, after emptying
transformers' SAM 3 lru caches, whose few live tensors would pin whole heaps
(tracks/memory.py). None of this changes a mask.
"""
import contextlib
import importlib.util
import json
import os
import threading
import time
import weakref
from pathlib import Path
from typing import Dict, Iterator, List, Optional

from tracks import memory, precision, rle
from tracks.engine import FrameMasks, Unit, Windows, plan_units
from tracks.seeds import Seeds
from tracks.streaming import Sam3Frames, sam3_prune
from tracks.text import THRESHOLD, TextMatch, pick

DEFAULT_WEIGHTS = Path.home() / ".cache/rotoscoping-video-subjects/weights/sam3-hf"

# Idle unloading (issue #11), in seconds; "never" keeps a part loaded.
IDLE_ENV, DEFAULT_IDLE_S = "SAM_UI_SAM3_IDLE_S", 600.0
DETECTOR_IDLE_ENV, DEFAULT_DETECTOR_IDLE_S = "SAM_UI_SAM3_DETECTOR_IDLE_S", 300.0
SHARED = "vision_encoder.backbone."  # the detector's part that is the tracker's


def weights_path() -> Path:
    return Path(os.environ.get("SAM_UI_SAM3_WEIGHTS", str(DEFAULT_WEIGHTS))).expanduser()


def available() -> Optional[str]:
    """None when the engine can run here, else why not."""
    if not (weights_path() / "model.safetensors").exists():
        return f"no SAM 3 weights at {weights_path()}"
    # located, not imported: importing transformers' SAM 3 model takes seconds
    # (7.5 s in the desktop app), and this runs on every GET /engines, which
    # studio waits on at start. A broken install still fails loudly when the
    # engine loads.
    spec = importlib.util.find_spec("transformers")
    if spec is None or spec.origin is None:
        return "transformers is not installed"
    if not (Path(spec.origin).parent / "models" / "sam3_tracker_video").is_dir():
        return "this transformers has no Sam3TrackerVideoModel (it needs 5.x)"
    return None


def text_available() -> Optional[str]:
    """None when SAM 3 can take text prompts here, else why not. As cheap as
    available(): nothing is imported, and the weights' config is only read."""
    why = available()
    if why:
        return why
    spec = importlib.util.find_spec("transformers")
    if not (Path(spec.origin).parent / "models" / "sam3").is_dir():
        return "this transformers has no Sam3Model (SAM 3's detector), which text prompts need"
    try:
        config = json.loads((weights_path() / "config.json").read_text())
    except (OSError, ValueError):
        return f"no readable config.json in {weights_path()}"
    if "detector_config" not in config and "Sam3Model" not in (config.get("architectures") or []):
        return "these SAM 3 weights have no detector (tracker only), which text prompts need"
    return None


def shared_detector(backbone, device, dtype):
    """SAM 3's detector (transformers' Sam3Model) with `backbone`, the
    tracker's, as its vision backbone. The model is built on the meta device
    (no memory), the backbone put in, and only the detector's own weights
    (text encoder, DETR, heads: 394M of its 840M parameters) read from the
    checkpoint, one tensor at a time, straight onto `device` in `dtype`, the
    dtypes Sam3Model.from_pretrained(dtype=...) gives them (outside the
    backbone the detector has no float buffers, only int position ids). That
    would read all 840M, and at any dtype but the checkpoint's fp32 convert
    each one on the CPU, only for the backbone to be thrown away."""
    import torch
    from safetensors import safe_open
    from transformers import Sam3Config, Sam3Model

    cfg = Sam3Config.from_pretrained(str(weights_path()))
    with torch.device("meta"):
        det = Sam3Model(cfg)
    det.vision_encoder.backbone = backbone
    own = [k for k in det.state_dict() if not k.startswith(SHARED)]
    sd = {}
    with safe_open(str(weights_path() / "model.safetensors"), framework="pt", device="cpu") as f:
        for k in own:
            t = f.get_tensor(f"{det.base_model_prefix}.{k}")
            sd[k] = t.to(device, dtype) if t.is_floating_point() else t.to(device)
    missing, unexpected = det.load_state_dict(sd, strict=False, assign=True)
    missing = [k for k in missing if not k.startswith(SHARED)]
    if missing or unexpected:
        raise RuntimeError(f"SAM 3 detector weights do not match its model: missing {missing[:5]}, "
                           f"unexpected {unexpected[:5]}")
    # buffers that are not saved (only the text encoder's position ids, outside
    # the backbone) are made as the model makes them
    for name, buf in list(det.named_buffers()):
        if buf.device.type != "meta":
            continue
        if not name.endswith("position_ids"):
            raise RuntimeError(f"SAM 3 detector buffer {name} is not in the checkpoint")
        mod_name, _, leaf = name.rpartition(".")
        mod = det.get_submodule(mod_name)
        mod.register_buffer(leaf, torch.arange(buf.shape[-1], device=device).expand(buf.shape), persistent=False)
    left = [n for n, p in list(det.named_parameters()) + list(det.named_buffers()) if p.device.type == "meta"]
    if left:
        raise RuntimeError(f"SAM 3 detector left unloaded: {left[:5]}")
    return det.eval()


class Sam3Engine:
    name = "sam3"
    model = "sam3-tracker"
    skips_cleared = False  # SAM 3 conditions on a cleared seed safely (engine.strip_cleared)

    def __init__(self, device: Optional[str] = None):
        self.device = device
        self.dtype = None  # set at load, from SAM_UI_SAM3_DTYPE (tracks/precision.py)
        self._loaded = None
        self._detector = None
        self._load_lock = threading.RLock()
        # idle unloading (issue #11): how long each part may sit unused
        self.idle_s = memory.idle_seconds(IDLE_ENV, DEFAULT_IDLE_S)
        self.detector_idle_s = memory.idle_seconds(DETECTOR_IDLE_ENV, DEFAULT_DETECTOR_IDLE_S)
        self._busy = 0
        self._used = {"engine": 0.0, "detector": 0.0}
        self._timer: Optional[threading.Timer] = None
        self._timer_finalizer = None

    @property
    def loaded(self) -> bool:
        return self._loaded is not None

    @property
    def detector_loaded(self) -> bool:
        return self._detector is not None

    def _load(self):
        with self._load_lock:
            if self._loaded is None:
                import torch
                from transformers import Sam3TrackerVideoModel, Sam3TrackerVideoProcessor

                dev = self._device()
                self.dtype = precision.sam3_dtype(torch.device(dev).type)
                proc = Sam3TrackerVideoProcessor.from_pretrained(str(weights_path()))
                model = Sam3TrackerVideoModel.from_pretrained(str(weights_path()), dtype=self.dtype).to(dev).eval()
                self._loaded = (proc, model, dev)
        return self._loaded

    def _load_detector(self):
        """(detector, tokenizer), loaded on first use, sharing the tracker's
        backbone: only the detector's own weights are read, straight onto the
        device, so no second backbone is ever in memory (shared_detector)."""
        proc, model, dev = self._load()
        with self._load_lock:
            if self._detector is None:
                from transformers import AutoTokenizer

                det = shared_detector(model.vision_encoder.backbone, dev, self.dtype)
                tok = AutoTokenizer.from_pretrained(str(weights_path()))
                self._detector = (det, tok)
        return self._detector

    # -- idle unloading ------------------------------------------------------------------

    def _device(self) -> str:
        import torch

        return self.device or ("mps" if torch.backends.mps.is_available()
                               else "cuda" if torch.cuda.is_available() else "cpu")

    @contextlib.contextmanager
    def _using(self, part: str):
        """Mark the engine busy for one job or prompt, with autocast off; when
        it ends, arm the idle timer. Jobs also return allocator cache;
        prompts keep it warm for the next interaction. Jobs and prompts run
        inside the routes' autocast, which is SAM 2's (SAM_UI_SAM2_DTYPE, and bf16 on CUDA): SAM 3 runs at
        its own SAM_UI_SAM3_DTYPE, so it turns that off."""
        import torch

        with self._load_lock:
            self._busy += 1
            self._cancel_timer()
        try:
            with torch.autocast(self._device(), enabled=False):
                yield
        finally:
            with self._load_lock:
                self._busy -= 1
                now = time.monotonic()
                self._used["engine"] = now
                if part == "detector":
                    self._used["detector"] = now
            if not self.release_idle():  # an unload releases the cache itself
                memory.clear_lru_caches()
                if part == "engine":
                    memory.release_cached()

    def _cancel_timer(self):
        # Called under _load_lock. Detach so cancelled timers are not retained
        # by the finalizer registry until the engine itself is collected.
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
        if self._timer_finalizer is not None:
            self._timer_finalizer.detach()
            self._timer_finalizer = None

    @staticmethod
    def _release_idle_weak(engine_ref):
        engine = engine_ref()
        if engine is not None:
            engine.release_idle()

    def release_idle(self, now: Optional[float] = None) -> List[str]:
        """Unload what has sat unused past its idle time (the detector after
        detector_idle_s, the whole engine after idle_s), and re-arm the timer
        for what is left. Never while a job or prompt runs. Returns what was
        unloaded."""
        dropped = []
        with self._load_lock:
            if self._busy:
                return dropped
            now = time.monotonic() if now is None else now
            if self._detector is not None and self.detector_idle_s is not None and \
                    now - self._used["detector"] >= self.detector_idle_s:
                self._detector = None
                dropped.append("detector")
            if self._loaded is not None and self.idle_s is not None and now - self._used["engine"] >= self.idle_s:
                self._detector = None
                self._loaded = None
                dropped.append("engine")
            due = [self._used[k] + s - now for k, s, on in (
                ("detector", self.detector_idle_s, self._detector is not None),
                ("engine", self.idle_s, self._loaded is not None)) if on and s is not None]
            self._cancel_timer()
            if due:
                self._timer = threading.Timer(max(0.05, min(due)), Sam3Engine._release_idle_weak,
                                              args=(weakref.ref(self),))
                self._timer_finalizer = weakref.finalize(self, self._timer.cancel)
                self._timer.daemon = True
                self._timer.start()
        if dropped:
            memory.clear_lru_caches()
            memory.release_cached()
        return dropped

    def unload(self) -> None:
        """Drop the tracker and the detector now (the next use loads them again)."""
        with self._load_lock:
            if self._busy:
                raise RuntimeError("SAM 3 is in use")
            self._detector = self._loaded = None
            self._cancel_timer()
        memory.clear_lru_caches()
        memory.release_cached()

    def segment_text(self, video_path: str, frame: int, text: str, threshold: float = THRESHOLD) -> TextMatch:
        """The phrase's best-scoring instance on one frame (mask at the video's
        size), how many instances reach `threshold`, and its box in pixels."""
        import torch

        with self._using("detector"):
            proc, _, dev = self._load()
            det, tok = self._load_detector()
            frames = Sam3Frames(video_path, proc, dtype=self.dtype)
            if not 0 <= frame < len(frames):
                raise ValueError(f"frame {frame} is outside the video (0-{len(frames) - 1})")
            h, w = frames.height, frames.width
            with torch.inference_mode():
                ids = tok(text, return_tensors="pt", padding="max_length", max_length=32, truncation=True).to(dev)
                out = det(pixel_values=frames[frame][None].to(dev), input_ids=ids.input_ids,
                          attention_mask=ids.attention_mask)
                scores = out.pred_logits.sigmoid()[0]
                if out.presence_logits is not None:
                    scores = scores * out.presence_logits.sigmoid()[0]
                best, n, score = pick(scores.float().cpu().tolist(), threshold)
                if best is None:
                    return TextMatch(mask=None, score=score, instances=0, box=None)
                logits = torch.nn.functional.interpolate(out.pred_masks[0, best][None, None].float(), size=(h, w),
                                                         mode="bilinear", align_corners=False)[0, 0]
                box = (out.pred_boxes[0, best].float().cpu() * torch.tensor([w, h, w, h])).tolist()  # xyxy, 0-1
                return TextMatch(mask=(logits > 0).cpu().numpy(), score=score, instances=n, box=box)

    def plan(self, objects: Dict[int, Seeds], windows: Optional[Windows] = None) -> List[Unit]:
        """One session per window, all of the window's objects together (SAM 3
        has no MPS trap to split them by first seed)."""
        return plan_units(objects, windows, by_first_seed=False)

    def track(self, video_path: str, objects: Dict[int, Seeds], video_handle=None,
              windows: Optional[Windows] = None) -> Iterator[FrameMasks]:
        units = self.plan(objects, windows)
        if not units:
            return
        with self._using("engine"):
            proc, model, dev = self._load()
            # frames processed as tracking reaches them, not the whole clip up front;
            # shared by every window's session
            frames = Sam3Frames(video_path, proc, dtype=self.dtype)
            for unit in units:
                yield from self._track_unit(proc, model, dev, frames, unit)

    def _track_unit(self, proc, model, dev, frames, unit: Unit) -> Iterator[FrameMasks]:
        """A fresh session for one window, seeded only from its seeds, tracked
        forward to the window's end and back to its start."""
        import torch

        objects, start = unit.objects, unit.start
        h, w = frames.height, frames.width
        limits = {False: None if unit.hi is None else unit.hi - start, True: None if unit.lo == 0 else start - unit.lo}
        with torch.inference_mode():
            sess = proc.init_video_session(inference_device=dev, video_storage_device="cpu", dtype=self.dtype)
            sess.processed_frames = frames
            sess.video_height, sess.video_width = h, w
            by_frame: Dict[int, list] = {}
            for o, seeds in objects.items():
                for f in seeds:
                    by_frame.setdefault(f, []).append(o)
            # Frame-major, one forward per seeded frame. Replaying in frame order
            # also means an object joins the session only at its first seed frame:
            # a forward runs every registered object, and one with no conditioning
            # output yet (its seed comes later) would need memory it lacks.
            for f in sorted(by_frame):
                for o in sorted(by_frame[f]):
                    seed = objects[o][f]
                    if seed.get("mask"):  # every text seed has one

                        proc.add_inputs_to_inference_session(sess, frame_idx=f, obj_ids=[o],
                                                             input_masks=[rle.decode(seed["mask"])])
                    else:
                        pts = [[[[x * w, y * h] for x, y in seed["points"]]]]
                        proc.add_inputs_to_inference_session(sess, frame_idx=f, obj_ids=[o], input_points=pts,
                                                             input_labels=[[list(map(int, seed["labels"]))]])
                # each add_inputs call REPLACES the new-inputs list (transformers
                # 5.17), so name every object seeded on this frame before the forward
                sess.obj_with_new_inputs = sorted(by_frame[f])
                model(inference_session=sess, frame_idx=f)
            for reverse in (False, True):
                bound = {} if limits[reverse] is None else {"max_frame_num_to_track": limits[reverse]}
                for out in model.propagate_in_video_iterator(sess, start_frame_idx=start, reverse=reverse, **bound):
                    sam3_prune(model, sess, out.frame_idx, start, reverse)
                    if reverse and out.frame_idx == start:
                        continue
                    masks = proc.post_process_masks([out.pred_masks.float()], original_sizes=[[h, w]], binarize=True)[0]
                    masks = masks.reshape(len(sess.obj_ids), -1, h, w)[:, 0].cpu().numpy().astype(bool)
                    yield out.frame_idx, {int(o): masks[k] for k, o in enumerate(sess.obj_ids)}
