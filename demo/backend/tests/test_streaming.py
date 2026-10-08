# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Streaming frames and pruned tracking state must not change a single mask.

Fast tests: the lazy frames equal upstream's to the bit, frame i is the i-th
frame a full decode yields (B-frames, a start time other than 0, variable frame
rate, an edit list, no timestamps at all), no file stays open between runs, and
the pruning rule keeps what the model can still read. Slow tests (SAM_UI_SLOW=1, with the
weights): a real track of a clip long enough to prune, run once as upstream
does it and once streamed and pruned, gives identical masks on every frame
while the stored state stays bounded.
"""
import fractions
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pytest
import torch

from tracks import streaming
from tracks.streaming import RUN, Sam2Frames, _PyAVRuns, prune_behind, window

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


def _edge_clip(path: Path, n: int = 60, fmt=None, start: float = 0.0, vfr: bool = False, rate: int = 24) -> Path:
    """A clip that makes frame-accurate seeking hard: B-frames (bf 3), a keyframe
    every 12 frames, optionally a first timestamp other than 0, a frame rate that
    changes halfway, or a container with no timestamps at all (raw h264). Every
    frame differs from its neighbours."""
    import av

    tick = 4  # time base 1/(4 rate): a frame lasts 4 ticks, or 12 once vfr slows it
    out = av.open(str(path), "w", format=fmt)
    st = out.add_stream("libx264", rate=rate, options={"crf": "12", "bf": "3", "g": "12", "keyint_min": "12",
                                                       "sc_threshold": "0"})
    st.width, st.height, st.pix_fmt = 160, 96, "yuv420p"
    tb = fractions.Fraction(1, rate * tick)
    st.codec_context.time_base = tb
    t = int(start * rate * tick)
    for i in range(n):
        img = np.full((96, 160, 3), 90, np.uint8)
        img[10:30, (i * 3) % 130:(i * 3) % 130 + 30] = (220, 40, 40)
        img[60:80, 10 + i % 7 * 20:30 + i % 7 * 20] = (40, 200, 60)
        frame = av.VideoFrame.from_ndarray(img, format="rgb24")
        frame.pts, frame.time_base = t, tb
        t += tick if not vfr or i < n // 2 else 3 * tick
        for pkt in st.encode(frame):
            out.mux(pkt)
    for pkt in st.encode():
        out.mux(pkt)
    out.close()
    return path


def _decode_all(path: Path) -> list:
    """Reference: every frame of a plain sequential decode, in order."""
    import av

    with av.open(str(path)) as c:
        return [f.to_ndarray(format="rgb24") for f in c.decode(video=0)]


def _open_fds_on(path: Path) -> int:
    out = subprocess.run(["lsof", "-p", str(os.getpid())], capture_output=True, text=True).stdout
    return sum(1 for line in out.splitlines() if line.endswith(str(path)))


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


EDGE_CLIPS = {
    "b_frames": dict(),
    "late_start_mp4": dict(start=3.5),
    "late_start_mkv": dict(start=2.0),
    "mpegts": dict(fmt="mpegts", start=1.4),
    "variable_rate": dict(vfr=True),
    "no_timestamps_h264": dict(fmt="h264"),
}


@pytest.mark.parametrize("kind", sorted(EDGE_CLIPS))
def test_frame_i_is_the_ith_decoded_frame(tmp_path, kind):
    ext = {"mpegts": "ts", "h264": "h264"}.get(EDGE_CLIPS[kind].get("fmt"), "mkv" if "mkv" in kind else "mp4")
    clip = _edge_clip(tmp_path / f"c.{ext}", **EDGE_CLIPS[kind])
    want = _decode_all(clip)
    runs = _PyAVRuns(str(clip), run=5)
    assert runs.n == len(want) == 60
    rng = np.random.default_rng(0)
    order = list(range(60)) + list(range(59, -1, -1)) + [int(i) for i in rng.permutation(60)]
    for i in order:  # forward, the reverse pass, then random seeks
        assert np.array_equal(runs.get(i).numpy(), want[i]), i


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="cuts the clip with the ffmpeg CLI")
def test_frames_an_edit_list_hides_are_not_counted(tmp_path):
    """A stream copy cut off a keyframe keeps the packets from that keyframe on
    and hides the ones before the cut with an edit list. decord counted them."""
    src = _edge_clip(tmp_path / "src.mp4", n=60)
    clip = tmp_path / "cut.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "0.3", "-i", str(src), "-c", "copy", str(clip)], check=True)
    want = _decode_all(clip)
    runs = _PyAVRuns(str(clip), run=5)
    assert runs.n == len(want) < 60
    for i in list(range(runs.n)) + list(range(runs.n - 1, -1, -1)):
        assert np.array_equal(runs.get(i).numpy(), want[i]), i
    with pytest.raises(IndexError):
        runs.get(runs.n)


def test_a_stream_cut_mid_gop_counts_only_the_frames_that_decode(tmp_path):
    """A transport stream that starts after a keyframe (a capture joined late,
    a byte cut) opens with packets the decoder drops until the next keyframe."""
    import av

    src = _edge_clip(tmp_path / "src.ts", fmt="mpegts", start=1.4)
    clip = tmp_path / "cut.ts"
    with av.open(str(src)) as i, av.open(str(clip), "w", format="mpegts") as o:
        out = o.add_stream_from_template(i.streams.video[0])
        for k, pkt in enumerate(i.demux(video=0)):
            if pkt.dts is not None and k >= 5:  # the first 5 packets: a keyframe and 4 after it
                pkt.stream = out
                o.mux(pkt)
    want = _decode_all(clip)
    runs = _PyAVRuns(str(clip), run=5)
    assert runs.n == len(want) < 55
    for i in list(range(runs.n)) + list(range(runs.n - 1, -1, -1)):
        assert np.array_equal(runs.get(i).numpy(), want[i]), i


def test_timestamps_that_collide_fall_back_to_decoding_in_order(tmp_path):
    """Matroska stores milliseconds: at 1500 fps several frames share one."""
    clip = _edge_clip(tmp_path / "fast.mkv", n=40, rate=1500)
    want = _decode_all(clip)
    runs = _PyAVRuns(str(clip), run=5)
    assert runs.n == len(want) == 40
    for i in (0, 7, 39, 20, 3):
        assert np.array_equal(runs.get(i).numpy(), want[i]), i


def test_a_frame_that_never_decodes_fails_after_one_pass(tmp_path, monkeypatch):
    """A frame the index promises but the decoder never shows is an error, found
    in one pass: not a missed seek to retry from every earlier keyframe."""
    import av

    clip = _edge_clip(tmp_path / "c.mp4")
    runs = _PyAVRuns(str(clip), run=5)
    runs._pts[40] += 1  # a timestamp no frame has
    opens = []
    real_open = av.open
    monkeypatch.setattr(av, "open", lambda *a, **k: opens.append(a) or real_open(*a, **k))
    with pytest.raises(RuntimeError, match="did not decode"):
        runs.get(38)
    assert len(opens) == 1, len(opens)


@pytest.mark.skipif(shutil.which("lsof") is None, reason="counts open files with lsof")
def test_no_file_stays_open_between_runs(tmp_path):
    clip = _edge_clip(tmp_path / "c.mp4")
    runs = _PyAVRuns(str(clip), 64, 64, run=8)
    for i in (0, 1, 9, 40, 39, 12):
        runs.get(i)
        assert _open_fds_on(clip) == 0, i
    f = Sam2Frames(str(clip), 64)
    f[0], f[30]
    assert _open_fds_on(clip) == 0


def test_a_run_decodes_only_its_frames(tmp_path):
    """Frames outside the current run are not kept (decord's reader kept them all)."""
    clip = _edge_clip(tmp_path / "c.mp4")
    runs = _PyAVRuns(str(clip), run=8)
    runs.get(20)
    assert sorted(runs._raw) == list(range(20, 28))
    runs.get(10)  # moving backwards: the run ends at 10
    assert sorted(runs._raw) == list(range(3, 11))


def test_upstream_loader_and_streaming_run_without_decord(tmp_path):
    """decord is gone: block its import and load a clip both ways."""
    clip = _clip(tmp_path / "c.mp4", n=6)
    code = f"""
import sys
sys.modules["decord"] = None  # any import of decord now raises ImportError
sys.path[:0] = [{str(Path(__file__).resolve().parents[1] / "server")!r}, {str(Path(__file__).resolve().parents[3])!r}]
import torch
from sam2.utils.misc import load_video_frames_from_video_file
from tracks.streaming import Sam2Frames, install_sam2_streaming
import sam2.sam2_video_predictor as svp
want, h, w = load_video_frames_from_video_file({str(clip)!r}, 64, offload_video_to_cpu=True)
install_sam2_streaming()
got, h2, w2 = svp.load_video_frames({str(clip)!r}, 64, offload_video_to_cpu=True)
assert isinstance(got, Sam2Frames) and (h, w) == (h2, w2) == (240, 320) and len(want) == len(got) == 6
assert all(torch.equal(got[i], want[i]) for i in range(6))
print("ok")
"""
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                       env={**os.environ, "DATA_PATH": str(tmp_path)})
    assert r.returncode == 0 and r.stdout.strip().endswith("ok"), r.stderr[-2000:]


def test_resize_matches_decord_when_it_is_installed(tmp_path):
    """PyAV runs the filter graph decord ran (scale to size, then rgb24), so the
    resized frames match decord's to the bit. Skipped once decord is gone."""
    decord = pytest.importorskip("decord")
    clip = _clip(tmp_path / "c.mp4", n=8)
    for size in (256, 1024):
        vr = decord.VideoReader(str(clip), width=size, height=size)
        want = vr.get_batch(list(range(len(vr)))).asnumpy()
        del vr
        runs = _PyAVRuns(str(clip), size, size)
        assert all(np.array_equal(runs.get(i).numpy(), want[i]) for i in range(8)), size


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
    from transformers import Sam3TrackerVideoProcessor

    from tracks.sam3_engine import weights_path
    from tracks.streaming import Sam3Frames

    clip = _clip(tmp_path / "c.mp4", n=6)
    proc = Sam3TrackerVideoProcessor.from_pretrained(str(weights_path()))
    whole = proc.video_processor(videos=_decode_all(clip), return_tensors="pt").pixel_values_videos[0]
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
def test_sam3_streamed_and_pruned_track_is_identical(tmp_path, monkeypatch, request):
    import tracks.sam3_engine as s3
    from tracks.streaming import Sam3Frames

    clip = str(_clip(tmp_path / "long.mp4", n=70))
    eng = s3.Sam3Engine()
    request.addfinalizer(eng.unload)

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


def _settled_growth(sample, limit: float, tries: int = 3, wait: float = 1.0) -> list:
    """Footprint growth readings, taken again (up to `tries` more, `wait` s
    apart) while the latest is over `limit`. The footprint is the whole
    process's, so something outside the code under test can push one reading
    over (seen once in about 200 full runs: 183 MB against a steady 78 to 81);
    a decoder that holds the clip holds it on every reading."""
    got = [sample()]
    while got[-1] >= limit and len(got) <= tries:
        time.sleep(wait)
        got.append(sample())
    return got


def test_a_footprint_spike_that_passes_is_not_a_held_clip():
    spike, held = iter([183, 79]), iter([300] * 10)
    assert _settled_growth(lambda: next(spike), 150, wait=0) == [183, 79]
    assert _settled_growth(lambda: next(held), 150, wait=0) == [300] * 4  # still over: the caller fails


@pytest.mark.skipif(sys.platform != "darwin", reason="counts decoded-frame blocks with macOS vmmap")
def test_decoding_never_keeps_the_whole_clip(tmp_path):
    """Sam2Frames must only ever hold about one run of decoded frames, however
    far tracking has moved. (decord's reader, once read, decoded the whole clip
    in a background thread and kept every frame; this caught it.)"""

    def vmmap():
        return subprocess.run(["vmmap", "-summary", str(os.getpid())], capture_output=True, text=True).stdout

    def blocks():  # 1024x1024x3 uint8 frames, one malloc region each
        out = subprocess.run(["vmmap", str(os.getpid())], capture_output=True, text=True).stdout
        return sum(1 for l in out.splitlines() if l.startswith("MALLOC_LARGE ") and "3088K" in l)

    def footprint_mb():
        for line in vmmap().splitlines():
            if line.startswith("Physical footprint:"):
                v = line.split()[-1]
                return float(v[:-1]) * {"K": 1 / 1024, "M": 1, "G": 1024}[v[-1]]
        return float("nan")

    clip = _clip(tmp_path / "c.mp4", n=90)
    warm = Sam2Frames(str(clip), 1024)  # first-use allocations are not what this measures
    warm[0]
    del warm
    before, fp_before = blocks(), footprint_mb()
    f = Sam2Frames(str(clip), 1024)
    for i in list(range(0, 40)) + list(range(80, 60, -1)):  # forward, then a reverse stretch
        f[i]
    time.sleep(3)  # long enough for a background decoder to reach the other 50 frames
    held = blocks() - before
    readings = _settled_growth(lambda: footprint_mb() - fp_before, 150)
    print(f"decoded-frame blocks held: {held}; physical footprint grew "
          + ", then ".join(f"{g:.0f}" for g in readings) + " MB")
    assert held <= RUN + 2, held
    # The whole clip at 1024x1024 is 90 x 3 MiB = 270 MiB decoded. One run (48 MiB)
    # plus KEEP_DECODED normalised frames (12 MiB each) is under 100 MiB; about 55 MB
    # is measured alone, about 80 MB in the full suite.
    assert readings[-1] < 150, readings
