# sam-ui (Apache-2.0). New file, not from SAM 2.
"""An anchor click for a correction made only of negative clicks.

SAM 2 empties a frame whose points are all negative, even when the frame
holds a mask to refine (the previous output, or a cached track mask primed in
as one): it was never trained on a mask prompt without a positive click. So a
lone negative click, meant to cut away a false positive, erased the whole
mask. Giving SAM one positive click deep inside the mask it is refining, far
from the user's clicks, makes it cut only the clicked region and keep the rest
(tools/track_cache_e2e.py --correction, and the slow test in
tests/test_inference_api.py, measure it on the real model). The anchor is
SAM's input only: the seed store keeps just the user's clicks.
"""
from typing import List, Optional, Sequence

import numpy as np


def depth(mask: np.ndarray) -> np.ndarray:
    """How many 4-neighbour erosions each mask pixel survives: a cheap
    distance to the mask's edge (the image border counts as an edge)."""
    d = np.zeros(mask.shape, np.int32)
    cur = mask.astype(bool).copy()
    while cur.any():
        d += cur
        e = cur.copy()
        e[1:] &= cur[:-1]
        e[:-1] &= cur[1:]
        e[:, 1:] &= cur[:, :-1]
        e[:, :-1] &= cur[:, 1:]
        e[0] = e[-1] = False
        e[:, 0] = e[:, -1] = False
        cur = e
    return d


def anchor_point(mask: np.ndarray, clicks: Sequence[Sequence[float]]) -> Optional[List[float]]:
    """A point well inside `mask` (at least half its deepest depth) and as far
    as possible from `clicks`, in the same normalized [0, 1] (x, y) terms as
    the clicks. None when the mask is empty."""
    d = depth(mask)
    if d.max() == 0:
        return None
    h, w = mask.shape
    ys, xs = np.nonzero(d * 2 >= d.max())
    if len(clicks):
        c = np.asarray(clicks, np.float64) * (w, h)
        far = np.min(np.hypot(xs[:, None] + 0.5 - c[:, 0], ys[:, None] + 0.5 - c[:, 1]), axis=1)
        i = int(np.argmax(far))
    else:
        i = int(np.argmax(d[ys, xs]))
    return [float((xs[i] + 0.5) / w), float((ys[i] + 0.5) / h)]
