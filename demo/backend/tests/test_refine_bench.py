# sam-ui (Apache-2.0). New file, not from SAM 2.
"""The refinement benchmark's crop mapping must be exact: a mask made in crop
space and pasted back lands on the source pixels it came from.

The model is stood in for by the crop itself: a known shape is drawn into a
frame, cropped and resized to 1024 like the bench feeds SAM 2, turned into
logits by thresholding the crop, and pasted back. The round trip has to give
the shape again, crops that overhang the frame included, and a moving shape
followed by the bench's own crop trajectories has to stay whole.
"""
import sys
from pathlib import Path

import numpy as np
import pytest
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "tools"))
import refine_bench as rb  # noqa: E402

W, H = 320, 180


def _disk(cx: float, cy: float, r: float, w: int = W, h: int = H) -> np.ndarray:
    yy, xx = np.mgrid[:h, :w]
    return (xx - cx) ** 2 + (yy - cy) ** 2 <= r * r


def _frame(mask: np.ndarray) -> torch.Tensor:
    img = np.full(mask.shape + (3,), 30, np.uint8)
    img[mask] = 230
    return torch.from_numpy(img)


def _round_trip(mask: np.ndarray, box, out: int = 1024) -> np.ndarray:
    crop = rb.crop_image(_frame(mask), box, out=out, fill=(30, 30, 30))
    assert crop.shape == (3, out, out)
    logits = crop[0] - 130.0  # the stand-in model: bright is the object
    return rb.paste_logits(logits, box, mask.shape[1], mask.shape[0])


def _band(mask: np.ndarray, px: int = 1) -> np.ndarray:
    """Pixels within `px` of the mask's edge."""
    t = torch.from_numpy(mask).float()[None, None]
    k = 2 * px + 1
    dil = torch.nn.functional.max_pool2d(t, k, 1, px)[0, 0] > 0
    ero = -torch.nn.functional.max_pool2d(-t, k, 1, px)[0, 0] > 0
    return (dil & ~ero).numpy()


def test_round_trip_at_scale_one_is_exact():
    m = _disk(150, 90, 30)
    box = (100, 40, 128)
    back = _round_trip(m, box, out=128)
    assert np.array_equal(back, m)


@pytest.mark.parametrize("box", [
    (110, 50, 80),     # small crop, 12.8x upscale
    (60, 10, 160),     # 6.4x
    (101, 37, 97),     # odd side and offset
    (-40, -60, 300),   # overhangs top and left
    (200, 100, 200),   # overhangs right and bottom
])
def test_round_trip_through_1024(box):
    cx, cy = box[0] + box[2] / 2, box[1] + box[2] / 2
    m = _disk(np.clip(cx, 40, W - 40), np.clip(cy, 40, H - 40), 25)
    back = _round_trip(m, box)
    x0, y0, s = box
    inside = np.zeros_like(m)
    inside[max(y0, 0):min(y0 + s, H), max(x0, 0):min(x0 + s, W)] = True
    want = m & inside
    # identical away from the edge, and a match overall
    assert np.array_equal(back & ~_band(want), want & ~_band(want))
    assert rb.iou(back, want) > 0.97
    assert not (back & ~inside).any()  # nothing pasted outside the crop


def test_round_trip_keeps_a_one_pixel_offset():
    """A shape moved by one source pixel moves by one pixel after the trip."""
    box = (90, 30, 140)
    a = _round_trip(_disk(160, 100, 20), box)
    b = _round_trip(_disk(161, 100, 20), box)
    assert np.array_equal(np.roll(a, 1, axis=1), b)


def test_centroid_survives_upscaling():
    m = np.zeros((H, W), bool)
    m[70:91, 140:171] = True  # 31 x 21 rectangle
    back = _round_trip(m, (120, 40, 77))
    ys, xs = np.nonzero(m)
    by, bx = np.nonzero(back)
    assert abs(bx.mean() - xs.mean()) < 0.25 and abs(by.mean() - ys.mean()) < 0.25


def test_point_to_crop_and_crop_pixels_agree():
    """A click mapped into the crop lands on the source pixel it named."""
    m = np.zeros((H, W), bool)
    m[95, 170] = True
    frame = _frame(m)
    box = (150, 60, 64)
    u, v = rb.point_to_crop(170 + 0.5, 95 + 0.5, box)  # pixel centre
    crop = rb.crop_image(frame, box, out=64)  # scale one: pixel for pixel
    assert crop[0, int(v * 64), int(u * 64)] == 230


def test_overhang_is_filled_and_not_pasted():
    frame = _frame(np.ones((H, W), bool))
    crop = rb.crop_image(frame, (-50, 0, 100), out=100, fill=(7, 7, 7))
    assert (crop[:, :, :50] == 7).all() and (crop[:, :, 50:] == 230).all()


def test_place_square_shifts_inside_or_centres():
    assert rb.place_square(5, 5, 50, W, H) == (0, 0, 50)
    assert rb.place_square(W - 1, H - 1, 50, W, H) == (W - 50, H - 50, 50)
    assert rb.place_square(160, 90, 40, W, H) == (140, 70, 40)
    x0, y0, s = rb.place_square(160, 90, 250, W, H)  # taller than the frame
    assert s == 250 and x0 == 35 and y0 == 90 - 125


def test_moving_shape_survives_the_bench_crops():
    """A disk moving and growing across the frame, followed by strategy 2's
    and strategy 3's trajectories built from its own masks, comes back whole."""
    n = 40
    masks = [_disk(30 + 6 * i, 60 + 2 * i, 10 + i / 4) for i in range(n)]
    boxes = rb.fill_boxes([rb.mask_bbox(m) for m in masks])
    for crops in (rb.fixed_crops(boxes, W, H, pad=0.25, win=9, min_side=32),
                  rb.adaptive_crops(boxes, W, H, min_side=64)):
        for m, box in zip(masks, crops):
            assert rb.outside_fraction(m, box) == 0.0
            assert rb.iou(_round_trip(m, box), m) > 0.97


def test_envelope_merges_short_gaps_and_pads():
    on = [False] * 30
    for i in list(range(5, 10)) + list(range(13, 16)) + list(range(25, 27)):
        on[i] = True
    # 10..12 is a 3-frame gap (merged), 16..24 is 9 (kept apart)
    assert rb.envelope_frames(on, pad=2, merge_gap=5) == list(range(3, 18)) + list(range(23, 29))
    assert rb.envelope_frames(on, pad=0, merge_gap=0, always=[0]) == [0, 5, 6, 7, 8, 9, 13, 14, 15, 25, 26]
    assert rb.envelope_frames([False] * 4, always=[0]) == [0]


def test_fill_boxes_holds_the_nearest():
    b = rb.fill_boxes([None, (1, 1, 2, 2), None, None, (5, 5, 6, 6), None])
    assert b[0].tolist() == [1, 1, 2, 2] and b[2].tolist() == [1, 1, 2, 2]
    assert b[3].tolist() == [5, 5, 6, 6] and b[5].tolist() == [5, 5, 6, 6]


def test_metrics():
    a = _disk(100, 90, 20)
    assert rb.iou(a, a) == 1.0 and rb.boundary_f(a, a) == 1.0
    empty = np.zeros_like(a)
    assert rb.iou(empty, empty) == 1.0 and rb.iou(a, empty) == 0.0
    assert rb.boundary_f(a, np.roll(a, 2, axis=1), tol=2) == 1.0
    assert rb.boundary_f(a, np.roll(a, 6, axis=1), tol=2) < 0.7


def test_mask_storage_round_trip(tmp_path):
    m = {0: _disk(10, 10, 5), 3: _disk(200, 100, 30)}
    rb.save_masks(tmp_path / "x.npz", m, 5, H, W)
    packed, info = rb.load_masks(tmp_path / "x.npz")
    assert (info["n"], info["H"], info["W"]) == (5, H, W)
    for f in range(5):
        want = m.get(f, np.zeros((H, W), bool))
        assert np.array_equal(rb.unpack(packed, f, H, W), want)
