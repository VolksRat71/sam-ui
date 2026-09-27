# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Streaming frames and pruned tracking state must not change a single mask.

Fast tests: the lazy frames equal upstream's to the bit, and the pruning rule
keeps what the model can still read. Slow tests (SAM_UI_SLOW=1, with the
weights): a real track of a clip long enough to prune, run once as upstream
does it and once streamed and pruned, gives identical masks on every frame
while the stored state stays bounded.
"""
import os
from pathlib import Path

import numpy as np
import pytest
import torch

from tracks import streaming
from tracks.streaming import Sam2Frames, prune_behind, window

WEIGHTS = Path.home() / ".cache/rotoscoping-video-subjects/weights"
SLOW = os.environ.get("SAM_UI_SLOW") == "1"


def _clip(path: Path, n: int = 90, w: int = 320, h: int = 240) -> Path:
    import av

    rng = np.random.default_rng(3)
    bg = rng.integers(80, 150, (h, w, 3), dtype=np.uint8)
    out = av.open(str(path), "w")
    st = out.add_stream("libx264", rate=24, options={"crf": "12"})
    st.width, st.height, st.pix_fmt = w, h, "yuv420p"
    for i in range(n):
        img = bg.copy()
        x = 10 + (i * 3) % (w - 70)
        img[40:90, x:x + 50] = (220, 40, 40)
        img[150:200, w - 60 - x // 2:w - 10 - x // 2] = (40, 200, 60)
        for pkt in st.encode(av.VideoFrame.from_ndarray(img, format="rgb24")):
            out.mux(pkt)
    for pkt in st.encode():
        out.mux(pkt)
    out.close()
    return path


# --- fast ---------------------------------------------------------------------

def test_sam2_frames_are_bit_identical_to_upstream(tmp_path):
    from sam2.utils.misc import load_video_frames_from_video_file

    clip = _clip(tmp_path / "c.mp4", n=12)
    want, h, w = load_video_frames_from_video_file(str(clip), 256, offload_video_to_cpu=True)
    got = Sam2Frames(str(clip), 256)
    assert len(got) == len(want) == 12 and (h, w) == (240, 320)
    for i in (0, 5, 11, 3, 3):  # in order, out of order, repeated
        assert torch.equal(got[i], want[i]), i
    with pytest.raises(IndexError):
        got[12]


def test_install_routes_video_files_only_and_is_idempotent(tmp_path, monkeypatch):
    import sam2.sam2_video_predictor as svp

    monkeypatch.setattr(svp, "load_video_frames", svp.load_video_frames)  # restored after the test
    streaming.install_sam2_streaming()
    once = svp.load_video_frames
    streaming.install_sam2_streaming()
    assert svp.load_video_frames is once
    clip = _clip(tmp_path / "c.mp4", n=4)
    images, h, w = svp.load_video_frames(str(clip), 64, offload_video_to_cpu=True)
    assert isinstance(images, Sam2Frames) and len(images) == 4 and (h, w) == (240, 320)
    # frames meant for the GPU keep upstream's loader
    images, _, _ = svp.load_video_frames(str(clip), 64, offload_video_to_cpu=False, compute_device=torch.device("cpu"))
    assert isinstance(images, torch.Tensor)


def test_prune_keeps_the_window_the_start_run_and_nothing_else():
    win = window()  # 18
    forward = {k: k for k in range(10, 101)}  # tracked 10..100, start 10
    prune_behind(forward, current=100, start=10, reverse=False, win=win)
    kept = sorted(forward)
    assert kept == list(range(10, 10 + win + 1)) + list(range(100 - win, 101))
    back = {k: k for k in range(0, 60)}  # reverse from 59 down to 0
    prune_behind(back, current=0, start=59, reverse=True, win=win)
    assert sorted(back) == list(range(0, win + 1))


def test_window_covers_memory_and_object_pointers():
    assert window(num_maskmem=7, stride=1, max_obj_ptrs=16) >= 16
    assert window(num_maskmem=7, stride=4, max_obj_ptrs=16) >= 28


def _sam3_ok() -> bool:
    from tracks.sam3_engine import weights_path

    return (weights_path() / "model.safetensors").exists()


@pytest.mark.skipif(not _sam3_ok(), reason="needs the SAM 3 processor files")
def test_sam3_frames_match_processing_the_whole_clip(tmp_path):
    import decord
    from transformers import Sam3TrackerVideoProcessor

    from tracks.sam3_engine import weights_path
    from tracks.streaming import Sam3Frames

    clip = _clip(tmp_path / "c.mp4", n=6)
    proc = Sam3TrackerVideoProcessor.from_pretrained(str(weights_path()))
    vr = decord.VideoReader(str(clip))
    from tracks.streaming import _tensor

    whole = proc.video_processor(videos=[_tensor(vr[i]).numpy() for i in range(len(vr))], return_tensors="pt").pixel_values_videos[0]
    lazy = Sam3Frames(str(clip), proc)
    assert len(lazy) == 6 and (lazy.height, lazy.width) == (240, 320)
    for i in range(6):
        assert torch.equal(lazy[i], whole[i].to(torch.float32)), i


# --- slow: real models ------------------------------------------------------------

SEEDS = {1: {30: {"points": [[0.35, 0.27]], "labels": [1]}, 55: {"points": [[0.62, 0.27]], "labels": [1]}},
         2: {40: {"points": [[0.62, 0.73]], "labels": [1]}}}


def _sam2_ckpt():
    for name, cfg in (("sam2.1_hiera_tiny.pt", "configs/sam2.1/sam2.1_hiera_t.yaml"),
                      ("sam2.1_hiera_large.pt", "configs/sam2.1/sam2.1_hiera_l.yaml")):
        if (WEIGHTS / name).exists():
            return WEIGHTS / name, cfg
    return None, None


@pytest.mark.slow
@pytest.mark.skipif(not SLOW or _sam2_ckpt()[0] is None, reason="set SAM_UI_SLOW=1 with a SAM 2.1 checkpoint")
def test_sam2_streamed_and_pruned_track_is_identical_and_bounded(tmp_path, monkeypatch):
    import sam2.sam2_video_predictor as svp
    from sam2.build_sam import build_sam2_video_predictor

    import tracks.engine as engine_mod
    from tracks.engine import Sam2Engine

    ckpt, cfg = _sam2_ckpt()
    dev = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
    pred = build_sam2_video_predictor(cfg, str(ckpt), device=dev)
    e = Sam2Engine(pred, model=ckpt.stem, offload_video_to_cpu=True)
    clip = str(_clip(tmp_path / "long.mp4"))

    upstream_loader = svp.load_video_frames
    monkeypatch.setattr(engine_mod, "sam2_prune", lambda *a, **k: 0)
    want = dict(e.track(clip, SEEDS))

    monkeypatch.setattr(svp, "load_video_frames", upstream_loader)
    streaming.install_sam2_streaming()
    peak = [0]

    def measured(predictor, state, current, start, reverse):
        n = streaming.sam2_prune(predictor, state, current, start, reverse)
        assert isinstance(state["images"], Sam2Frames)
        peak[0] = max(peak[0], max(len(d["non_cond_frame_outputs"]) for d in state["output_dict_per_obj"].values()))
        return n

    monkeypatch.setattr(engine_mod, "sam2_prune", measured)
    got = dict(e.track(clip, SEEDS))

    assert sorted(got) == sorted(want) == list(range(90))
    for f in want:
        for o in want[f]:
            assert np.array_equal(got[f][o], want[f][o]), (f, o)
    win = window(pred.num_maskmem, pred.memory_temporal_stride_for_eval, pred.max_obj_ptrs_in_encoder)
    assert 0 < peak[0] <= 2 * win + 3, peak[0]  # upstream keeps one per tracked frame (about 85 here)


@pytest.mark.slow
@pytest.mark.skipif(not SLOW or not _sam3_ok(), reason="set SAM_UI_SLOW=1 with the SAM 3 weights")
def test_sam3_streamed_and_pruned_track_is_identical(tmp_path, monkeypatch):
    import tracks.sam3_engine as s3
    from tracks.streaming import Sam3Frames

    clip = str(_clip(tmp_path / "long.mp4", n=70))
    eng = s3.Sam3Engine()

    class Eager(Sam3Frames):
        """Every frame processed up front, as upstream's session holds them."""

        def __init__(self, *a, **k):
            super().__init__(*a, **k)
            self._all = [super(Eager, self).__getitem__(i) for i in range(len(self))]

        def __getitem__(self, i):
            return self._all[int(i)]

    monkeypatch.setattr(s3, "Sam3Frames", Eager)
    monkeypatch.setattr(s3, "sam3_prune", lambda *a, **k: 0)
    want = dict(eng.track(clip, SEEDS))
    monkeypatch.undo()
    got = dict(eng.track(clip, SEEDS))
    assert sorted(got) == sorted(want) == list(range(70))
    for f in want:
        for o in want[f]:
            assert np.array_equal(got[f][o], want[f][o]), (f, o)


def test_objects_first_seeded_on_different_frames_run_as_separate_groups():
    from tracks.engine import groups_by_first_seed

    pts = {"points": [[0.5, 0.5]], "labels": [1]}
    objects = {1: {30: pts, 55: pts}, 2: {40: pts}, 3: {30: pts}, 4: {10: {"points": [], "labels": []}}}
    assert [sorted(g) for g in groups_by_first_seed(objects)] == [[1, 3], [2]]  # 4 has no points
