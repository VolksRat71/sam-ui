# sam-ui (Apache-2.0). New file, not from SAM 2.
"""The anchor click given to SAM 2 with a correction made only of negatives."""
import numpy as np

from tracks.anchor import anchor_point, depth


def at(m, p):
    h, w = m.shape
    return m[int(p[1] * h), int(p[0] * w)]


def test_an_empty_mask_has_no_anchor():
    assert anchor_point(np.zeros((8, 8), bool), [[0.5, 0.5]]) is None


def test_depth_counts_erosions_to_the_edge():
    m = np.zeros((7, 7), bool)
    m[1:6, 1:6] = True
    assert depth(m)[3, 3] == 3 and depth(m)[1, 1] == 1 and depth(m)[0, 0] == 0


def test_the_anchor_sits_in_the_half_of_a_bar_away_from_the_click():
    m = np.zeros((60, 120), bool)
    m[10:50, 10:110] = True  # a bar; the click is on its right half
    p = anchor_point(m, [[90 / 120, 30 / 60]])
    assert at(m, p) and p[0] * 120 < 60


def test_the_anchor_picks_the_other_blob_over_the_clicked_one():
    m = np.zeros((60, 120), bool)
    m[10:50, 5:45] = True  # the object
    m[20:40, 80:100] = True  # a false positive, clicked
    p = anchor_point(m, [[90 / 120, 30 / 60]])
    assert at(m, p) and p[0] * 120 < 45


def test_the_anchor_skips_a_clicked_blob_thicker_than_the_object():
    m = np.zeros((80, 160), bool)
    m[10:70, 10:18] = True  # a thin object, 8 px wide
    m[10:70, 60:150] = True  # a thick false positive, clicked
    p = anchor_point(m, [[100 / 160, 40 / 80]])
    assert at(m, p) and p[0] * 160 < 18


def test_the_anchor_falls_back_to_the_whole_mask_when_every_piece_is_clicked():
    m = np.zeros((60, 120), bool)
    m[10:50, 10:110] = True
    p = anchor_point(m, [[90 / 120, 30 / 60]])
    assert at(m, p)
