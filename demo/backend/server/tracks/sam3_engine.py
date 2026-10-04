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
0.974, at 1.43 s/frame against SAM 2's 0.61, with about 20 GB of MPS driver
memory. Hence opt-in, per track job.

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
2 GB of MPS driver memory) instead of a second 840M model. It stays loaded
with the tracker. A text seed is stored as a mask, which the tracker takes
like any seed mask.
"""
import importlib.util
import json
import os
import threading
from pathlib import Path
from typing import Dict, Iterator, List, Optional

from tracks import rle
from tracks.engine import FrameMasks, Unit, Windows, plan_units
from tracks.seeds import Seeds
from tracks.streaming import Sam3Frames, sam3_prune
from tracks.text import THRESHOLD, TextMatch, pick

DEFAULT_WEIGHTS = Path.home() / ".cache/rotoscoping-video-subjects/weights/sam3-hf"


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


class Sam3Engine:
    name = "sam3"
    model = "sam3-tracker"
    skips_cleared = False  # SAM 3 conditions on a cleared seed safely (engine.strip_cleared)

    def __init__(self, device: Optional[str] = None):
        self.device = device
        self._loaded = None
        self._detector = None
        self._load_lock = threading.Lock()

    @property
    def loaded(self) -> bool:
        return self._loaded is not None

    def _load(self):
        with self._load_lock:
            if self._loaded is None:
                import torch
                from transformers import Sam3TrackerVideoModel, Sam3TrackerVideoProcessor

                dev = self.device or ("mps" if torch.backends.mps.is_available()
                                      else "cuda" if torch.cuda.is_available() else "cpu")
                proc = Sam3TrackerVideoProcessor.from_pretrained(str(weights_path()))
                model = Sam3TrackerVideoModel.from_pretrained(str(weights_path())).to(dev).eval()
                self._loaded = (proc, model, dev)
        return self._loaded

    def _load_detector(self):
        """(detector, tokenizer), loaded on first use, sharing the tracker's
        backbone. Loaded on the CPU first, so the second backbone never
        reaches the GPU."""
        proc, model, dev = self._load()
        with self._load_lock:
            if self._detector is None:
                from transformers import AutoTokenizer, Sam3Model

                det = Sam3Model.from_pretrained(str(weights_path())).eval()
                det.vision_encoder.backbone = model.vision_encoder.backbone
                tok = AutoTokenizer.from_pretrained(str(weights_path()))
                self._detector = (det.to(dev), tok)
        return self._detector

    def segment_text(self, video_path: str, frame: int, text: str, threshold: float = THRESHOLD) -> TextMatch:
        """The phrase's best-scoring instance on one frame (mask at the video's
        size), how many instances reach `threshold`, and its box in pixels."""
        import torch

        proc, _, dev = self._load()
        det, tok = self._load_detector()
        frames = Sam3Frames(video_path, proc, dtype=torch.float32)
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
        import torch

        units = self.plan(objects, windows)
        if not units:
            return
        proc, model, dev = self._load()
        # frames processed as tracking reaches them, not the whole clip up front;
        # shared by every window's session
        frames = Sam3Frames(video_path, proc, dtype=torch.float32)
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
            sess = proc.init_video_session(inference_device=dev, video_storage_device="cpu", dtype=torch.float32)
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
                    masks = proc.post_process_masks([out.pred_masks], original_sizes=[[h, w]], binarize=True)[0]
                    masks = masks.reshape(len(sess.obj_ids), -1, h, w)[:, 0].cpu().numpy().astype(bool)
                    yield out.frame_idx, {int(o): masks[k] for k, o in enumerate(sess.obj_ids)}
