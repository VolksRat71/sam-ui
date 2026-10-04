"""Current-frame additive detail records. Never prompts or tracking inputs."""
import copy
import math
import os
import re

import numpy as np
from tracks import rle


class DetailError(ValueError):
    """A public detail error code, safe to return to clients."""


def enabled():
    return os.getenv('SAM_UI_REFINE_DETAIL', '0') == '1'


def validate_detail(value):
    if not isinstance(value, dict) or not re.fullmatch('[0-9a-f]{64}', str(value.get('id', ''))):
        raise DetailError('invalid_detail_id')
    rect, geometry, points = value.get('rect'), value.get('geometry'), value.get('points')
    if (not isinstance(geometry, dict) or geometry.get('version') != 'working-copy-v1'
            or any(type(geometry.get(k)) is not int or not 1 <= geometry[k] <= 16384 for k in ('width', 'height'))):
        raise DetailError('invalid_detail_geometry')
    if (not isinstance(rect, list) or len(rect) != 4 or any(type(n) is not int for n in rect)
            or not 0 <= rect[0] < rect[2] <= geometry['width']
            or not 0 <= rect[1] < rect[3] <= geometry['height']
            or max(rect[2] - rect[0], rect[3] - rect[1]) > 256):
        raise DetailError('invalid_detail_rect')
    if not isinstance(points, list) or not 1 <= len(points) <= 64:
        raise DetailError('invalid_detail_points')
    for p in points:
        if (not isinstance(p, list) or len(p) != 3 or type(p[2]) is not int or p[2] not in (0, 1)
                or any(type(n) not in (int, float) or not math.isfinite(n) or not 0 <= n <= 1 for n in p[:2])):
            raise DetailError('invalid_detail_points')
    if not any(p[2] == 1 for p in points):
        raise DetailError('detail_requires_positive')
    mask = value.get('mask')
    if not isinstance(mask, dict) or mask.get('size') != [rect[3] - rect[1], rect[2] - rect[0]]:
        raise DetailError('invalid_detail_mask')
    # Validate RLE before persisting or composing; the decoded allocation is bounded by rect.
    decoded = rle.decode(mask)
    if decoded.shape != tuple(mask['size']):
        raise DetailError('invalid_detail_mask')
    return copy.deepcopy({k: value[k] for k in ('id', 'rect', 'geometry', 'points', 'mask')})


def effective_mask(base, details):
    """No-details/off returns the exact input, avoiding even an RLE re-encode."""
    if not enabled() or not details or base is None or rle.area(base) == 0:
        return base
    items = [validate_detail(d) for d in details]
    shape = [items[0]['geometry']['height'], items[0]['geometry']['width']]
    if base is not None and list(base['size']) != shape:
        raise DetailError('detail_base_geometry_mismatch')
    out = np.zeros(shape, dtype=bool) if base is None else rle.decode(base).astype(bool)
    for d in items:
        if [d['geometry']['height'], d['geometry']['width']] != shape:
            raise DetailError('detail_geometry_mismatch')
        x0, y0, x1, y1 = d['rect']
        out[y0:y1, x0:x1] |= rle.decode(d['mask']).astype(bool)
    return rle.encode(out)
