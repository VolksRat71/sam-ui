# sam-ui (Apache-2.0). New file, not from SAM 2.
import os
import time
from pathlib import Path

import numpy as np
import pytest

from tracks import rle
from tracks.engine import FakeEngine, Sam2Engine
from tracks.seeds import cleared

REPO = Path(__file__).resolve().parents[3]
CKPT = REPO / "checkpoints" / "sam2.1_hiera_large.pt"
N, H, W, S = 30, 240, 320, 56  # frames, height, width, square side


def test_fake_engine_tracks_only_the_objects_asked_for():
    e = FakeEngine(n_frames=3)
    frames = list(e.track("unused.mp4", {2: {0: {"points": [[0.5, 0.5]], "labels": [1]}}, 5: {}}))
    assert [f for f, _ in frames] == [0, 1, 2]
    assert all(set(m) == {2, 5} for _, m in frames)
    assert e.calls == [[2, 5]]


class _StubPredictor:
    """Just enough of SAM2VideoPredictor to check how Sam2Engine drives it."""

    def __init__(self, n=4):
        self.n, self.added, self.reset = n, [], 0

    def init_state(self, path, offload_video_to_cpu=False):
        return {"obj_ids": []}

    def add_new_points_or_box(self, inference_state, frame_idx, obj_id, points, labels, clear_old_points,
                              normalize_coords):
        assert normalize_coords is False and clear_old_points is True
        self.added.append((obj_id, frame_idx, points.tolist(), labels.tolist()))
        if obj_id not in inference_state["obj_ids"]:
            inference_state["obj_ids"].append(obj_id)

    def add_new_mask(self, inference_state, frame_idx, obj_id, mask):
        self.added.append((obj_id, frame_idx, "mask", int(mask.sum())))
        if obj_id not in inference_state["obj_ids"]:
            inference_state["obj_ids"].append(obj_id)

    def propagate_in_video(self, state, start_frame_idx, max_frame_num_to_track=None, reverse=False):
        import torch
        m = self.n if max_frame_num_to_track is None else max_frame_num_to_track  # SAM 2's bounds
        if reverse:
            frames = range(start_frame_idx, max(start_frame_idx - m, 0) - 1, -1) if start_frame_idx > 0 else []
        else:
            frames = range(start_frame_idx, min(start_frame_idx + m, self.n - 1) + 1)
        for f in frames:
            yield f, list(state["obj_ids"]), torch.ones(len(state["obj_ids"]), 1, 2, 2)

    def reset_state(self, state):
        self.reset += 1


def test_sam2_engine_seeds_only_its_objects_and_yields_each_frame_once():
    p = _StubPredictor(n=4)
    e = Sam2Engine(p, model="stub")
    seeds = {7: {1: {"points": [[0.1, 0.2]], "labels": [1]}}, 9: {1: {"points": [[0.5, 0.5], [0.6, 0.6]], "labels": [1, 0]}}}
    frames = list(e.track("v.mp4", seeds))
    assert sorted(f for f, _ in frames) == [0, 1, 2, 3]  # start frame 1 not repeated by the reverse pass
    assert sorted(a[0] for a in p.added) == [7, 9]
    assert all(set(m) == {7, 9} and all(v.dtype == bool for v in m.values()) for _, m in frames)
    assert p.reset == 1


def test_objects_first_seeded_on_different_frames_track_in_separate_passes():
    """Tracked together, SAM 2 on MPS aborts the process; so each first-seed
    frame gets its own state, and each object still gets every frame once."""
    p = _StubPredictor(n=4)
    e = Sam2Engine(p, model="stub")
    seeds = {7: {2: {"points": [[0.1, 0.2]], "labels": [1]}}, 9: {1: {"points": [[0.5, 0.5], [0.6, 0.6]], "labels": [1, 0]}}}
    assert e.passes(seeds) == 2
    per_obj = {7: [], 9: []}
    for f, m in e.track("v.mp4", seeds):
        assert len(m) == 1  # one group's objects at a time
        for o in m:
            per_obj[o].append(f)
    assert {o: sorted(fs) for o, fs in per_obj.items()} == {7: [0, 1, 2, 3], 9: [0, 1, 2, 3]}
    assert p.reset == 2  # every state released


def test_sam2_engine_skips_objects_without_points_and_releases_state_on_cancel():
    p = _StubPredictor(n=10)
    e = Sam2Engine(p, model="stub")
    seeds = {1: {0: {"points": [[0.5, 0.5]], "labels": [1]}}, 2: {3: {"points": [], "labels": []}}}
    it = e.track("v.mp4", seeds)
    next(it)
    it.close()  # a cancelled job
    assert [a[0] for a in p.added] == [1] and p.reset == 1
    assert list(e.track("v.mp4", {2: {}})) == []  # nothing to seed: no job at all


_ZEROS, _ONES = np.zeros((2, 2), bool), np.ones((2, 2), bool)
_POS = {"points": [[0.5, 0.5]], "labels": [1]}
_CLEARED = {"points": [[0.5, 0.5]], "labels": [0], "mask": rle.encode(_ZEROS)}


def test_cleared_is_a_negatives_only_seed_with_an_empty_or_no_mask():
    assert cleared(_CLEARED)
    assert cleared({"points": [[0.5, 0.5]], "labels": [0]})  # no mask and no positive
    # a legacy anchor-trimmed seed: no positive, but the mask it approved is not empty
    assert not cleared({"points": [[0.5, 0.5]], "labels": [0], "mask": rle.encode(_ONES)})
    assert not cleared({"points": [[0.5, 0.5], [0.2, 0.2]], "labels": [0, 1], "mask": rle.encode(_ZEROS)})
    assert not cleared({"points": [], "labels": [], "mask": rle.encode(_ONES)})  # a text seed


def test_sam2_engine_tracks_through_a_cleared_seed_and_blanks_its_frame():
    """Given as a conditioning frame, an empty seed makes SAM 2 drop the object
    on the frames around it: so it is never fed, and its frame comes out empty."""
    p = _StubPredictor(n=4)
    frames = dict(Sam2Engine(p, model="stub").track("v.mp4", {1: {0: _POS, 2: _CLEARED}}))
    assert [a[:2] for a in p.added] == [(1, 0)]  # frame 2 never reaches the predictor
    assert sorted(frames) == [0, 1, 2, 3]
    assert not frames[2][1].any()
    assert all(frames[f][1].all() for f in (0, 1, 3))


def test_an_object_with_only_a_cleared_seed_yields_nothing():
    p = _StubPredictor(n=4)
    e = Sam2Engine(p, model="stub")
    assert list(e.track("v.mp4", {1: {2: _CLEARED}})) == []
    assert p.added == [] and p.reset == 0


def test_a_cleared_seed_does_not_decide_the_pass_an_object_runs_in():
    """Object 2's first seed with points is the cleared frame 0, but its first
    real seed is frame 2: it runs in its own pass, after object 1's."""
    p = _StubPredictor(n=4)
    e = Sam2Engine(p, model="stub")
    seeds = {1: {0: _POS}, 2: {0: _CLEARED, 2: _POS}}
    assert e.passes(seeds) == 2
    out = list(e.track("v.mp4", seeds))
    assert [set(m) for _, m in out] == [{1}] * 4 + [{2}] * 4
    assert not dict(out[4:])[0][2].any()  # object 2's cleared frame 0 is blank



def test_a_cleared_frame_blanks_only_its_own_object():
    p = _StubPredictor(n=4)
    frames = dict(Sam2Engine(p, model="stub").track("v.mp4", {1: {0: _POS, 2: _CLEARED}, 2: {0: _POS}}))
    assert not frames[2][1].any() and frames[2][2].all()


def test_a_legacy_anchor_trimmed_seed_still_reaches_the_predictor():
    """No positive but a non-empty approved mask: a real seed, not a cleared one."""
    p = _StubPredictor(n=4)
    trimmed = {"points": [[0.5, 0.5]], "labels": [0], "mask": rle.encode(_ONES)}
    frames = dict(Sam2Engine(p, model="stub").track("v.mp4", {1: {0: _POS, 2: trimmed}}))
    assert (1, 2, "mask", 4) in p.added
    assert frames[2][1].all()


def test_inside_a_window_a_cleared_seed_is_stripped_and_blanked_in_both_directions():
    """Absent ranges split the track into units; each unit strips its cleared
    seeds and blanks their frames, forward and back from the unit's start."""
    p = _StubPredictor(n=12)
    e = Sam2Engine(p, model="stub")
    seeds = {1: {1: _POS, 4: _CLEARED, 5: _POS, 7: _CLEARED, 10: _CLEARED}}
    windows = {1: [(0, 1), (3, 8)]}  # 2 and 9-11 absent
    assert e.passes(seeds, windows) == 2 and [u.start for u in e.plan(seeds, windows)] == [1, 5]
    frames = {}
    for f, m in e.track("v.mp4", seeds, windows=windows):
        assert f not in frames
        frames[f] = m[1]
    assert [a[:2] for a in p.added] == [(1, 1), (1, 5)]  # no cleared frame reaches the predictor
    assert sorted(frames) == [0, 1, 3, 4, 5, 6, 7, 8]
    assert not frames[4].any() and not frames[7].any()  # behind the start (4) and ahead of it (7)
    assert all(frames[f].all() for f in (0, 1, 3, 5, 6, 8))
    assert p.reset == e.passes(seeds, windows)


def test_a_window_whose_only_seed_is_cleared_makes_no_pass():
    p = _StubPredictor(n=12)
    e = Sam2Engine(p, model="stub")
    seeds = {1: {2: _CLEARED, 9: _POS}, 2: {1: _POS}}
    windows = {1: [(0, 4), (8, None)], 2: [(0, 4)]}
    assert [(u.lo, sorted(u.objects)) for u in e.plan(seeds, windows)] == [(0, [2]), (8, [1])]
    out = list(e.track("v.mp4", seeds, windows=windows))
    assert all(1 not in m for f, m in out if f <= 4)  # object 1 has nothing in (0, 4)
    assert sorted(f for f, m in out if 1 in m) == [8, 9, 10, 11]
    assert p.reset == e.passes(seeds, windows) == 2
    assert list(e.track("v.mp4", {1: {2: _CLEARED}}, windows={1: [(0, 4)]})) == []

def _synthetic_video(path):
    """Two squares moving across a noisy background: no footage involved."""
    import av
    rng = np.random.default_rng(0)
    bg = rng.integers(90, 140, (H, W, 3), dtype=np.uint8)
    truth = {1: [], 2: []}
    out = av.open(str(path), "w")
    st = out.add_stream("libx264", rate=24, options={"crf": "12"})
    st.width, st.height, st.pix_fmt = W, H, "yuv420p"
    for i in range(N):
        img = bg.copy()
        for obj, (y, x0, color) in {1: (40, 10, (220, 40, 40)), 2: (140, 250, (40, 60, 220))}.items():
            x = x0 + 5 * i if obj == 1 else x0 - 5 * i
            img[y:y + S, x:x + S] = color
            m = np.zeros((H, W), bool)
            m[y:y + S, x:x + S] = True
            truth[obj].append(m)
        for pkt in st.encode(av.VideoFrame.from_ndarray(img, format="rgb24")):
            out.mux(pkt)
    for pkt in st.encode():
        out.mux(pkt)
    out.close()
    return truth


@pytest.mark.slow
@pytest.mark.skipif(not CKPT.exists() or os.environ.get("SAM_UI_SLOW") != "1",
                    reason="set SAM_UI_SLOW=1 with the large checkpoint in checkpoints/")
def test_sam2_engine_tracks_a_synthetic_square_and_reports_backbone_share(tmp_path):
    import torch
    from sam2.build_sam import build_sam2_video_predictor

    truth = _synthetic_video(tmp_path / "squares.mp4")
    dev = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
    pred = build_sam2_video_predictor("configs/sam2.1/sam2.1_hiera_l.yaml", str(CKPT), device=dev)
    sync = {"mps": torch.mps.synchronize, "cuda": torch.cuda.synchronize}.get(dev, lambda: None)

    backbone_s = [0.0]
    orig = pred.forward_image

    def timed_forward_image(img):
        sync()
        t0 = time.perf_counter()
        out = orig(img)
        sync()
        backbone_s[0] += time.perf_counter() - t0
        return out

    pred.forward_image = timed_forward_image
    e = Sam2Engine(pred, model="hiera_l", offload_video_to_cpu=dev == "mps")
    seeds = {1: {0: {"points": [[(10 + S / 2) / W, (40 + S / 2) / H]], "labels": [1]}}}
    t0 = time.perf_counter()
    frames = dict(e.track(str(tmp_path / "squares.mp4"), seeds))
    total = time.perf_counter() - t0

    ious = []
    for i in range(N):
        a, b = frames[i][1], truth[1][i]
        ious.append((a & b).sum() / (a | b).sum())
    print(f"\nsam2 engine: {N} frames in {total:.1f} s, backbone {backbone_s[0]:.1f} s "
          f"({100 * backbone_s[0] / total:.0f}%), min IoU {min(ious):.3f}, mean {np.mean(ious):.3f}")
    assert sorted(frames) == list(range(N)) and set(frames[0]) == {1}
    assert min(ious) > 0.9


@pytest.mark.slow
@pytest.mark.skipif(not CKPT.exists() or os.environ.get("SAM_UI_SLOW") != "1",
                    reason="set SAM_UI_SLOW=1 with the large checkpoint in checkpoints/")
def test_feature_cache_makes_a_retrack_faster_with_the_same_masks(tmp_path):
    import torch
    from sam2.build_sam import build_sam2_video_predictor
    from tracks.engine import job_state_like
    from tracks.features import VIDEO_KEY, FeatureCache, install

    truth = _synthetic_video(tmp_path / "squares.mp4")
    dev = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
    pred = build_sam2_video_predictor("configs/sam2.1/sam2.1_hiera_l.yaml", str(CKPT), device=dev)
    cache = FeatureCache(4 << 30)
    install(pred, cache)
    session = pred.init_state(str(tmp_path / "squares.mp4"), offload_video_to_cpu=dev == "mps")
    session[VIDEO_KEY] = "squares"
    e = Sam2Engine(pred, model="hiera_l")
    seeds = {1: {0: {"points": [[(10 + S / 2) / W, (40 + S / 2) / H]], "labels": [1]}},
             2: {0: {"points": [[(250 + S / 2) / W, (140 + S / 2) / H]], "labels": [1]}}}
    runs = []
    for _ in range(2):
        t0 = time.perf_counter()
        runs.append((dict(e.track("unused", seeds, video_handle=session)), time.perf_counter() - t0))
    (a, t_cold), (b, t_warm) = runs
    ious = [((a[i][o] & b[i][o]).sum() / max((a[i][o] | b[i][o]).sum(), 1)) for i in range(N) for o in (1, 2)]
    print(f"\nfeature cache: cold {t_cold:.1f} s, warm {t_warm:.1f} s ({100 * (1 - t_warm / t_cold):.0f}% faster); "
          f"{len(cache)} frames, {cache.nbytes / 2**20:.0f} MB; hits {cache.hits}; min IoU cold vs warm {min(ious):.4f}")
    assert len(cache) == N and cache.hits >= N
    assert t_warm < 0.8 * t_cold
    assert min(ious) > 0.99
    assert min(((b[i][1] & truth[1][i]).sum() / (b[i][1] | truth[1][i]).sum()) for i in range(N)) > 0.9
