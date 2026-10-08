# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Footage opened in place (data/linked.py): no transcode, so the backend's
frame N is the file's frame N at the file's own size and rate, and a source
that disagrees with the file is refused."""
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from flask import Flask

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")

FPS, W, H, N = 30, 400, 300, 30  # not 24 fps and not 1280x720: what an upload would be turned into


@pytest.fixture(autouse=True)
def video_list():
    """The in-memory videos list, as app.py sets it at start-up."""
    from data.store import get_videos, set_videos

    saved = get_videos()
    set_videos({})
    yield
    set_videos(saved)


def moving_square(path: Path, fps=FPS, frames=N, size=(W, H), codec="libx264"):
    """A white 40 px square moving 10 px right per frame on black: on frame i
    its left edge is at x = 10 * i. The frames are drawn here and piped in raw,
    so which frame is which does not depend on an ffmpeg filter's counter."""
    import numpy as np

    w, h = size
    raw = bytearray()
    for i in range(frames):
        f = np.zeros((h, w, 3), np.uint8)
        f[100:140, 10 * i:10 * i + 40] = 255
        raw += f.tobytes()
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(fps),
         "-i", "-", "-c:v", codec, "-pix_fmt", "yuv420p", str(path)],
        input=bytes(raw), check=True)
    return path


def source_for(path: Path, **over):
    s = {"kind": "afterEffects", "aeItemId": 12, "aeProjectPath": "/tmp/p.aep", "name": path.name, "path": str(path),
         "width": W, "height": H, "pixelAspect": 1, "frameRate": FPS, "frames": N, "duration": N / FPS}
    s.update(over)
    return s


def test_an_in_place_open_keeps_the_native_rate_size_and_frame_count(tmp_path):
    from app_conf import DATA_PATH
    from data.linked import register
    from data.store import get_videos

    clip = moving_square(tmp_path / "hero.mov")
    video, record = register(str(clip), source_for(clip), hash_file=lambda p: "h")
    assert video.path.startswith("linked/") and video.path.endswith(".mov")
    assert (video.width, video.height) == (W, H)
    assert record["native"]["frames"] == N and abs(record["native"]["fps"] - FPS) < 1e-6
    assert record["source"]["aeItemId"] == 12 and record["file"]["path"] == os.path.realpath(clip)
    link = Path(DATA_PATH) / video.path
    assert link.is_symlink() and os.path.realpath(link) == os.path.realpath(clip)  # the file itself: nothing re-encoded
    assert get_videos()[video.code] is video


def test_the_backends_frame_n_is_the_files_frame_n(tmp_path):
    """Through the link, decord (the decoder tracks/streaming.py uses) sees the
    file's own frames: the square on frame i sits at x = 10 * i."""
    decord = pytest.importorskip("decord")
    import numpy as np
    from app_conf import DATA_PATH
    from data.linked import register

    clip = moving_square(tmp_path / "square.mp4")
    video, _ = register(str(clip), source_for(clip), hash_file=lambda p: "h")
    vr = decord.VideoReader(str(Path(DATA_PATH) / video.path))
    assert len(vr) == N
    for i in (0, 1, 13, N - 1):
        frame = vr[i].asnumpy()
        assert frame.shape[:2] == (H, W)
        cols = np.where(frame[120, :, 0] > 128)[0]
        assert (cols.min(), cols.max()) == (10 * i, 10 * i + 39), i
    del vr


@pytest.mark.parametrize("over, says", [
    ({"frames": N + 1}, "frame count"),
    ({"frameRate": 24}, "frame rate"),
    ({"width": 1920, "height": 1080}, "size"),
])
def test_a_source_that_disagrees_with_the_file_is_refused(tmp_path, over, says):
    from data.linked import LinkRefused, register

    clip = moving_square(tmp_path / "c.mp4")
    with pytest.raises(LinkRefused, match=says):
        register(str(clip), source_for(clip, **over), hash_file=lambda p: "h")


def test_an_ntsc_rate_matches_within_tolerance(tmp_path):
    from data.linked import register

    clip = moving_square(tmp_path / "ntsc.mp4", fps="24000/1001", frames=24)
    _, record = register(str(clip), source_for(clip, frameRate=23.9760246276855, frames=24),
                         hash_file=lambda p: "h")
    assert abs(record["native"]["fps"] - 23.976) < 1e-3


def test_a_file_trimmed_with_an_edit_list_is_refused(tmp_path):
    from data.linked import LinkRefused, native_metadata

    full = moving_square(tmp_path / "full.mp4")
    cut = tmp_path / "cut.mp4"
    # a stream copy from mid-GOP keeps the GOP's earlier packets behind an edit list
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(7 / FPS), "-i", str(full), "-c", "copy", str(cut)],
                   check=True)
    with pytest.raises(LinkRefused, match="edit list"):
        native_metadata(str(cut))
    assert native_metadata(str(full))["frames"] == N


def test_a_variable_frame_rate_file_is_refused_and_a_constant_one_links(tmp_path):
    """Frames 0-14 at 30 fps, then 15-29 at 15 fps: still 30 frames, but frame
    20 is at 0.83 s, not 20/30 s, so a key at 20/30 s in After Effects would
    land on another frame."""
    from data.linked import LinkRefused, register

    cfr = moving_square(tmp_path / "cfr.mp4")
    vfr = tmp_path / "vfr.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(cfr), "-vf", "setpts='if(lt(N,15),N/30,0.5+(N-15)/15)/TB'",
                    "-fps_mode", "passthrough", "-c:v", "libx264", str(vfr)], check=True)
    with pytest.raises(LinkRefused, match="variable frame rate.*conform it to a constant frame rate"):
        register(str(vfr), source_for(vfr), hash_file=lambda p: "h")
    _, record = register(str(cfr), source_for(cfr), hash_file=lambda p: "h")
    assert record["native"]["frames"] == N


def cfr_pts(fps, timescale, n, jitter=None):
    """Integer timestamps a muxer would write for n frames at `fps` in a
    1/timescale time base, each rounded to a tick, plus an optional per-frame
    offset in seconds."""
    return [round((i / fps + (jitter(i) if jitter else 0)) * timescale) for i in range(n)]


def drift_ok(pts):
    from data.linked import rate_drift

    drift, limit = rate_drift(pts)
    return drift <= limit


@pytest.mark.parametrize("timescale", [600, 1000])
@pytest.mark.parametrize("fps", [24000 / 1001, 30000 / 1001, 60000 / 1001, 120000 / 1001, 240])
def test_constant_rate_rounded_to_coarse_ticks_is_not_variable(fps, timescale):
    """Rounding to a coarse tick (a quarter of a 240 fps frame at 1/1000) never
    reads as variable rate, over a long clip, from any start."""
    for n in (351, 2000, 9000):
        assert drift_ok(cfr_pts(fps, timescale, n)), (fps, timescale, n)
        assert drift_ok([t + 7 for t in cfr_pts(fps, timescale, n)])


@pytest.mark.parametrize("fps, timescale", [(30000 / 1001, 600), (30, 15360), (60000 / 1001, 60000)])
def test_phone_style_capture_jitter_is_not_variable(fps, timescale):
    """Capture timestamps wobble by about a millisecond around a steady rate."""
    import random

    rnd = random.Random(1)
    assert drift_ok(cfr_pts(fps, timescale, 3000, jitter=lambda i: rnd.uniform(-1e-3, 1e-3)))
    assert drift_ok(cfr_pts(fps, timescale, 3000, jitter=lambda i: rnd.gauss(0, 1e-3)))


@pytest.mark.parametrize("fps, timescale", [(30000 / 1001, 600), (30000 / 1001, 30000), (30, 15360), (25, 12800)])
def test_a_dropped_or_doubled_frame_is_variable(fps, timescale):
    pts = cfr_pts(fps, timescale, 601)
    assert drift_ok(pts)
    assert not drift_ok(pts[:300] + pts[301:])  # frame 300 dropped: everything after it a frame early
    assert not drift_ok(pts[:300] + [pts[299]] + pts[300:-1])  # frame 299's timestamp twice
    assert not drift_ok(pts[:5] + pts[6:])  # near an end too


def test_the_tolerance_sits_between_jitter_and_a_frame_held_too_long():
    """A step of 0.4 frame part-way through measures 0.2 (allowed); one of
    0.6 measures 0.3 (refused). A threshold loosened to half a frame would let
    the second through; one tightened to 0.1 would refuse the first."""
    from data.linked import rate_drift

    def stepped(by):
        return [round((i + (by if i >= 300 else 0)) * 1001) for i in range(600)]  # 29.97 fps at 1/30000

    assert drift_ok(stepped(0.4)) and abs(rate_drift(stepped(0.4))[0] - 0.2) < 0.01
    assert not drift_ok(stepped(0.6)) and abs(rate_drift(stepped(0.6))[0] - 0.3) < 0.01


def test_too_few_frames_or_one_timestamp():
    from data.linked import rate_drift

    assert rate_drift([])[0] == 0 and rate_drift([5])[0] == 0 and rate_drift([0, 512])[0] == 0
    assert not drift_ok([7, 7, 7])


def test_an_export_check_catches_a_same_size_same_mtime_swap(tmp_path):
    """The cheap check (size, mtime) cannot see bytes swapped in place with the
    mtime put back; ?verify=1 re-hashes and can. Re-hashing is desktop only."""
    from data.linked import TOKEN_HEADER, make_blueprint, register

    clip = moving_square(tmp_path / "swap.mp4")
    video, record = register(str(clip), source_for(clip))  # the real content hash
    c = Flask("verify")
    c.register_blueprint(make_blueprint(token="t"))
    c = c.test_client()
    verify = f"/linked-source?path={video.path}&verify=1"
    desktop = {TOKEN_HEADER: "t"}
    assert c.get(verify).status_code == 403 and c.get(verify, headers={TOKEN_HEADER: "x"}).status_code == 403
    assert c.get(verify, headers=desktop).get_json()["changed"] is False

    st = os.stat(clip)
    data = bytearray(clip.read_bytes())
    data[len(data) // 2] ^= 0xFF
    clip.write_bytes(bytes(data))
    os.utime(clip, ns=(st.st_atime_ns, st.st_mtime_ns))
    assert os.stat(clip).st_size == record["file"]["size"]
    assert c.get(f"/linked-source?path={video.path}").get_json()["changed"] is False  # what the cheap check sees
    assert c.get(verify, headers=desktop).get_json()["changed"] is True


def test_a_file_that_cannot_be_read_counts_as_changed(tmp_path):
    from data.linked import TOKEN_HEADER, make_blueprint, register

    clip = moving_square(tmp_path / "locked.mp4")
    video, _ = register(str(clip), source_for(clip))
    app = Flask("locked")
    app.register_blueprint(make_blueprint(token="t"))
    os.chmod(clip, 0)
    try:
        if os.access(clip, os.R_OK):
            pytest.skip("running as a user that reads past permissions")
        got = app.test_client().get(f"/linked-source?path={video.path}&verify=1", headers={TOKEN_HEADER: "t"})
        assert got.status_code == 200 and got.get_json()["changed"] is True
    finally:
        os.chmod(clip, 0o644)


def test_what_cannot_be_linked_says_why(tmp_path):
    from data.linked import LinkRefused, register

    with pytest.raises(LinkRefused, match="absolute"):
        register("relative/clip.mp4", {})
    with pytest.raises(LinkRefused, match="no file"):
        register(str(tmp_path / "gone.mp4"), {})
    txt = tmp_path / "notes.txt"
    txt.write_text("x")
    with pytest.raises(LinkRefused, match="footage, not .txt"):
        register(str(txt), {})


def test_the_record_says_when_the_file_changed_and_preload_lists_it(tmp_path):
    from data.linked import preload, register, source_of

    clip = moving_square(tmp_path / "edit.mp4")
    video, _ = register(str(clip), source_for(clip), hash_file=lambda p: "h")
    assert source_of(video.path)["changed"] is False
    assert video.code in preload()
    os.utime(clip, (1, 1))
    assert source_of(video.path)["changed"] is True
    clip.unlink()
    rec = source_of(video.path)
    assert rec["missing"] is True
    assert video.code not in preload()  # a dangling link is not listed
    assert source_of("uploads/x.mp4") is None and source_of("linked/../x.mp4") is None


def test_the_routes_need_the_desktop_token_and_serve_ranges(tmp_path):
    from data.linked import TOKEN_HEADER, make_blueprint

    clip = moving_square(tmp_path / "route.mp4")
    body = {"path": str(clip), "source": source_for(clip)}

    off = Flask("off")
    off.register_blueprint(make_blueprint(token=""))
    assert off.test_client().post("/linked", json=body).status_code == 404  # no token set: the route is off

    app = Flask("on")
    app.register_blueprint(make_blueprint(token="s3cret"))
    c = app.test_client()
    assert c.post("/linked", json=body).status_code == 403
    assert c.post("/linked", json=body, headers={TOKEN_HEADER: "nope"}).status_code == 403
    bad = c.post("/linked", json={**body, "source": source_for(clip, frames=7)}, headers={TOKEN_HEADER: "s3cret"})
    assert bad.status_code == 422 and "frame count" in bad.get_json()["error"]
    r = c.post("/linked", json=body, headers={TOKEN_HEADER: "s3cret"})
    assert r.status_code == 200, r.data
    out = r.get_json()
    assert out["width"] == W and out["record"]["native"]["frames"] == N
    got = c.get(f"/{out['path']}", headers={"Range": "bytes=0-99"})
    assert got.status_code == 206 and len(got.data) == 100
    got.close()
    assert c.get(f"/linked-source?path={out['path']}").get_json()["source"]["aeItemId"] == 12
    assert c.get("/linked/.sources").status_code == 404
