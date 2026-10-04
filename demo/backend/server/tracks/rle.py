# sam-ui (Apache-2.0). New file, not from SAM 2.
"""COCO run-length encoding for masks, as the demo streams them: a dict with
"size" [h, w] and "counts" as a str (pycocotools returns bytes)."""
from typing import Dict

import numpy as np
from pycocotools.mask import area as _area, decode as _decode, encode as _encode


def encode(mask: np.ndarray) -> Dict:
    rle = _encode(np.array(mask, dtype=np.uint8, order="F"))
    return {"size": [int(s) for s in rle["size"]], "counts": rle["counts"].decode()}


def decode(rle: Dict) -> np.ndarray:
    return _decode({"size": rle["size"], "counts": rle["counts"].encode()}) > 0


def area(rle: Dict) -> int:
    """How many pixels the mask covers, without decoding it."""
    return int(_area({"size": rle["size"], "counts": rle["counts"].encode()}))
