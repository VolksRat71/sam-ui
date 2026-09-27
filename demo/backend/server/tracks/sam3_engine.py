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
"""
import importlib.util
import os
import threading
from pathlib import Path
from typing import Dict, Iterator, Optional

import numpy as np

from tracks import rle
from tracks.engine import FrameMasks
from tracks.seeds import Seeds
from tracks.streaming import Sam3Frames, sam3_prune

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


class Sam3Engine:
    name = "sam3"
    model = "sam3-tracker"

    def __init__(self, device: Optional[str] = None):
        self.device = device
        self._loaded = None
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

    def track(self, video_path: str, objects: Dict[int, Seeds], video_handle=None) -> Iterator[FrameMasks]:
        import torch

        objects = {o: s for o, s in objects.items() if any(v["points"] for v in s.values())}
        if not objects:
            return
        proc, model, dev = self._load()
        # frames processed as tracking reaches them, not the whole clip up front
        frames = Sam3Frames(video_path, proc, dtype=torch.float32)
        h, w = frames.height, frames.width
        with torch.inference_mode():
            sess = proc.init_video_session(inference_device=dev, video_storage_device="cpu", dtype=torch.float32)
            sess.processed_frames = frames
            sess.video_height, sess.video_width = h, w
            by_frame: Dict[int, list] = {}
            for o, seeds in objects.items():
                for f, v in seeds.items():
                    if v["points"]:
                        by_frame.setdefault(f, []).append(o)
            # Frame-major, one forward per seeded frame. Replaying in frame order
            # also means an object joins the session only at its first seed frame:
            # a forward runs every registered object, and one with no conditioning
            # output yet (its seed comes later) would need memory it lacks.
            for f in sorted(by_frame):
                for o in sorted(by_frame[f]):
                    seed = objects[o][f]
                    if seed.get("mask"):
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
            start = min(by_frame)
            for reverse in (False, True):
                for out in model.propagate_in_video_iterator(sess, start_frame_idx=start, reverse=reverse):
                    sam3_prune(model, sess, out.frame_idx, start, reverse)
                    if reverse and out.frame_idx == start:
                        continue
                    masks = proc.post_process_masks([out.pred_masks], original_sizes=[[h, w]], binarize=True)[0]
                    masks = masks.reshape(len(sess.obj_ids), -1, h, w)[:, 0].cpu().numpy().astype(bool)
                    yield out.frame_idx, {int(o): masks[k] for k, o in enumerate(sess.obj_ids)}
