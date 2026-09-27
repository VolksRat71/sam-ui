# sam-ui (Apache-2.0). New file, not from SAM 2.
"""A per-video cache of SAM 2's image-backbone features, shared by the
interactive session and every track job on the same video.

SAM 2 keeps only the most recent frame's features (`cached_features` holds one
frame) and recomputes the backbone on every propagation: 44% of a track job's
time on this Mac (measured on the large model). With this cache, a re-track,
a second object or a click on an already-seen frame skips the backbone.

What is stored, per frame: the projected FPN features (`backbone_fpn`, about
16 MB a frame at 1024x1024 in fp32), on the CPU, exactly as SAM 2 produced them.
`vision_pos_enc` depends only on the feature map shapes, so it is the same on
every frame and is kept once per video (it is the larger part, about 88 MB).
Least recently used frames are dropped past `max_bytes`.
"""
import os
import threading
from collections import OrderedDict
from typing import Dict, List, Optional, Tuple

import torch

VIDEO_KEY = "sam_ui_video"  # set on an inference state to opt it into the cache


def default_cache_gb() -> float:
    """A quarter of this machine's RAM, at most 6 GB: a long clip fills the
    cache, and on a 16 GB Mac 6 GB of it would crowd the models."""
    try:
        ram = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 2 ** 30
    except (ValueError, OSError, AttributeError):
        return 6.0
    return round(min(6.0, ram / 4), 2)


def _nbytes(ts: List[torch.Tensor]) -> int:
    return sum(t.element_size() * t.nelement() for t in ts)


class FeatureCache:
    def __init__(self, max_bytes: int):
        self.max_bytes = max_bytes
        self._frames: "OrderedDict[Tuple[str, int], List[torch.Tensor]]" = OrderedDict()
        self._pos: Dict[str, List[torch.Tensor]] = {}
        self._bytes = 0
        self._lock = threading.Lock()
        self.hits = self.misses = 0

    def get(self, video: str, frame: int, device) -> Optional[Dict[str, list]]:
        with self._lock:
            fpn = self._frames.get((video, frame))
            if fpn is None or video not in self._pos:
                self.misses += 1
                return None
            self._frames.move_to_end((video, frame))
            self.hits += 1
            return {"backbone_fpn": [t.to(device) for t in fpn],
                    "vision_pos_enc": [t.to(device) for t in self._pos[video]]}

    def put(self, video: str, frame: int, backbone_out: Dict[str, list]) -> None:
        fpn = [t.detach().to("cpu") for t in backbone_out["backbone_fpn"]]
        size = _nbytes(fpn)
        if size > self.max_bytes:
            return
        with self._lock:
            if video not in self._pos:
                self._pos[video] = [t.detach().to("cpu") for t in backbone_out["vision_pos_enc"]]
            old = self._frames.pop((video, frame), None)
            if old is not None:
                self._bytes -= _nbytes(old)
            self._frames[(video, frame)] = fpn
            self._bytes += size
            while self._bytes > self.max_bytes and self._frames:
                (v, _), dropped = self._frames.popitem(last=False)
                self._bytes -= _nbytes(dropped)
                if not any(k[0] == v for k in self._frames):
                    self._pos.pop(v, None)

    def has(self, video: str, frame: int) -> bool:
        with self._lock:
            return (video, frame) in self._frames and video in self._pos

    @property
    def nbytes(self) -> int:
        return self._bytes

    def __len__(self) -> int:
        return len(self._frames)


def install(predictor, cache: FeatureCache) -> None:
    """Route the predictor's per-frame feature lookup through `cache`, for
    every inference state carrying VIDEO_KEY. Other states behave as upstream."""
    if getattr(predictor, "_sam_ui_feature_cache", None) is not None:
        predictor._sam_ui_feature_cache = cache
        return
    original = getattr(predictor, "_get_image_feature", None)
    if original is None:  # not a SAM 2 video predictor (a test stub): nothing to cache
        return

    def _get_image_feature(inference_state, frame_idx, batch_size):
        video = inference_state.get(VIDEO_KEY)
        c = predictor._sam_ui_feature_cache
        if video is not None and frame_idx not in inference_state["cached_features"]:
            hit = c.get(video, frame_idx, inference_state["device"])
            if hit is not None:
                image = inference_state["images"][frame_idx].to(inference_state["device"]).float().unsqueeze(0)
                inference_state["cached_features"] = {frame_idx: (image, hit)}
        out = original(inference_state, frame_idx, batch_size)
        if video is not None:
            _, backbone_out = inference_state["cached_features"][frame_idx]
            if not c.has(video, frame_idx):
                c.put(video, frame_idx, backbone_out)
        return out

    predictor._sam_ui_feature_cache = cache
    predictor._get_image_feature = _get_image_feature
