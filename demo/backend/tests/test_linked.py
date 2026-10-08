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


@pytest.fixture(autouse=True)
def fresh_links():
    """Each test starts with no links, records or previews (DATA_PATH is shared by the session)."""
    from data.linked import LINKED_PATH

    shutil.rmtree(LINKED_PATH, ignore_errors=True)


def moving_square(path: Path, fps=FPS, frames=N, size=(W, H), codec="libx264", pix_fmt="yuv420p"):
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
         "-i", "-", "-c:v", codec, "-pix_fmt", pix_fmt, str(path)],
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
    reads as variable rate, over a long clip."""
    for n in (351, 2000, 9000):
        assert drift_ok(cfr_pts(fps, timescale, n)), (fps, timescale, n)


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


def test_removing_a_linked_video_deletes_only_sam_uis_files_never_the_footage(tmp_path):
    """deleteVideo on a linked video goes the way an upload's delete goes (refused
    while open, then seeds and tracks purged), but removes the link, its record
    and its poster, and leaves the footage the link points at byte for byte."""
    import hashlib

    from app_conf import DATA_PATH, POSTERS_PATH
    from data.linked import _record_file, register
    from data.store import get_videos
    from inference.data_types import StartSessionRequest
    from inference.predictor import InferenceAPI
    from test_inference_api import StubPredictor
    from test_media import delete

    clip = moving_square(tmp_path / "hero.mov")
    before = hashlib.sha256(clip.read_bytes()).hexdigest()
    video, record = register(str(clip), source_for(clip))
    link = Path(DATA_PATH) / video.path
    poster = Path(POSTERS_PATH) / record["poster"]
    assert record["poster"] and poster.is_file() and _record_file(link.name).is_file()

    api = InferenceAPI(predictor=StubPredictor(), tracks_root=str(tmp_path / "tracks"))
    tracks = tmp_path / "tracks" / record["videoHash"]
    tracks.mkdir(parents=True)
    (tracks / "seed.json").write_text("{}")
    sid = api.start_session(StartSessionRequest(type="start_session", path=str(link))).session_id
    r = delete(api, video.path)
    assert r.errors and "open in a session" in r.errors[0].message and link.is_symlink()
    api.session_states.pop(sid)

    r = delete(api, video.path)
    assert r.errors is None and r.data["deleteVideo"] == {"path": video.path, "purged": True}
    assert not link.is_symlink() and not _record_file(link.name).exists() and not poster.exists()
    assert not tracks.exists() and video.code not in get_videos()
    assert hashlib.sha256(clip.read_bytes()).hexdigest() == before


def test_removing_refuses_forged_and_path_like_ids_and_keeps_the_footage(tmp_path):
    from app_conf import DATA_PATH
    from data.linked import LINKED_PATH, register
    from data.store import get_videos
    from test_media import Api, delete

    clip = moving_square(tmp_path / "keep.mp4")
    video, _ = register(str(clip), source_for(clip), hash_file=lambda p: "h")
    link = Path(DATA_PATH) / video.path
    planted = LINKED_PATH / "planted.mp4"  # a real file, not a link sam-ui made
    shutil.copy(clip, planted)
    try:
        api = Api()
        for path in (str(clip), str(link), f"linked/../{video.path}", f"linked//{link.name}",
                     f"linked/.sources/{link.stem}.json", "linked/.sources", "linked/..", "linked/",
                     f"{video.path}\x00", "linked/planted.mp4", "linked/nope.mp4", f"gallery/../{video.path}",
                     "linked/" + link.name.upper()):  # a case variant reaches the real link on APFS
            r = delete(api, path)
            assert r.errors, path
        assert api.purged == [] and link.is_symlink() and planted.is_file() and clip.is_file()
        assert video.code in get_videos()
        assert os.path.realpath(link) == os.path.realpath(clip)
    finally:
        planted.unlink()


def prores(clip: Path) -> Path:
    """`clip` re-encoded to ProRes 422, as After Effects footage often is."""
    out = clip.with_name(clip.stem + "-prores.mov")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(clip), "-c:v", "prores_ks", "-profile:v", "2",
                    "-pix_fmt", "yuv422p10le", str(out)], check=True)
    return out


def test_prores_gets_a_frame_exact_h264_preview_that_studio_is_served(tmp_path):
    """Studio's browser decoder cannot play ProRes, so linking makes an H.264
    preview with the same frame count, times and size, kept under sam-ui's
    data, and GET /linked/<file> serves it. The link still points at the
    original, which the backend tracks and exports from."""
    import av
    import numpy as np
    from app_conf import DATA_PATH
    from data.linked import LINKED_PATH, PREVIEWS_DIR, TOKEN_HEADER, make_blueprint

    clip = prores(moving_square(tmp_path / "ae.mp4"))
    app = Flask("prores")
    app.register_blueprint(make_blueprint(token="t"))
    c = app.test_client()
    r = c.post("/linked", json={"path": str(clip), "source": source_for(clip)}, headers={TOKEN_HEADER: "t"})
    assert r.status_code == 200, r.data
    record = r.get_json()["record"]
    assert record["native"]["codec"] == "prores" and record["preview"]
    previews = LINKED_PATH / PREVIEWS_DIR
    preview = previews / record["preview"]
    assert previews.parent == Path(DATA_PATH) / "linked" and not list(previews.glob(".*.tmp"))
    assert os.path.realpath(Path(DATA_PATH) / record["path"]) == os.path.realpath(clip)

    def frames(path):
        with av.open(str(path)) as cont:
            vs = cont.streams.video[0]
            return vs.codec_context.name, [(f.time, f.to_ndarray(format="rgb24")) for f in cont.decode(vs)]

    src_codec, src = frames(clip)
    out_codec, out = frames(preview)
    assert (src_codec, out_codec) == ("prores", "h264")
    assert len(out) == len(src) == N
    for i, ((t0, _), (t1, img)) in enumerate(zip(src, out)):
        assert abs(t0 - t1) < 1e-9 and img.shape[:2] == (H, W)
        cols = np.where(img[120, :, 0] > 128)[0]
        assert abs(cols.min() - 10 * i) <= 1 and abs(cols.max() - (10 * i + 39)) <= 1, i

    got = c.get(f"/{record['path']}")
    assert got.status_code == 200 and got.mimetype == "video/mp4" and got.data == preview.read_bytes()
    got.close()


def test_footage_studio_can_play_gets_no_preview(tmp_path):
    from data.linked import TOKEN_HEADER, make_blueprint

    clip = moving_square(tmp_path / "h264.mov")
    app = Flask("h264")
    app.register_blueprint(make_blueprint(token="t"))
    c = app.test_client()
    r = c.post("/linked", json={"path": str(clip), "source": source_for(clip)}, headers={TOKEN_HEADER: "t"})
    record = r.get_json()["record"]
    assert record["native"]["codec"] == "h264" and record["preview"] is None
    got = c.get(f"/{record['path']}")
    assert got.data == clip.read_bytes()  # the original itself
    got.close()


def test_av1_is_recorded_by_its_codec_not_its_decoder_and_plays_as_is(tmp_path):
    from data.linked import register

    clip = tmp_path / "av1.mp4"
    try:
        moving_square(clip, codec="libsvtav1")
    except subprocess.CalledProcessError:
        pytest.skip("this ffmpeg has no libsvtav1")
    _, record = register(str(clip), source_for(clip))
    assert record["native"]["codec"] == "av1" and record["preview"] is None


def test_mpeg2_footage_links_with_a_preview(tmp_path):
    """FFmpeg's MPEG-2 decoder puts an empty pan-scan rectangle on every frame
    (XDCAM and IMX .mov); that crops nothing, so it must not refuse the link."""
    import av
    from data.linked import LINKED_PATH, PREVIEWS_DIR, register

    clip = moving_square(tmp_path / "xdcam.mov", codec="mpeg2video")
    _, record = register(str(clip), source_for(clip))
    assert record["native"]["codec"] == "mpeg2video" and record["preview"]
    with av.open(str(LINKED_PATH / PREVIEWS_DIR / record["preview"])) as cont:
        assert sum(1 for _ in cont.decode(video=0)) == N


def test_animation_colours_survive_the_preview(tmp_path):
    """An RGB source (QuickTime Animation) is converted with the BT.709 matrix
    and the H.264 is tagged BT.709, which is how the browser reads it. Untagged
    BT.601, as before, turned 254 green into 214."""
    import av
    import numpy as np
    from av.video.reformatter import ColorRange, Colorspace, VideoReformatter
    from data.linked import LINKED_PATH, PREVIEWS_DIR, register

    bars = [(0, 254, 0), (255, 0, 255), (200, 30, 60), (128, 128, 128), (16, 16, 16), (255, 255, 255)]
    img = np.zeros((H, W, 3), np.uint8)
    for i, c in enumerate(bars):
        img[:, i * 64:(i + 1) * 64] = c
    clip = tmp_path / "bars.mov"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
                    "-i", "-", "-c:v", "qtrle", "-pix_fmt", "rgb24", str(clip)], input=img.tobytes() * N, check=True)
    _, record = register(str(clip), source_for(clip))
    assert record["native"]["codec"] == "qtrle" and record["preview"]
    with av.open(str(LINKED_PATH / PREVIEWS_DIR / record["preview"])) as cont:
        cc = cont.streams.video[0].codec_context
        assert (cc.colorspace, cc.color_primaries, cc.color_trc, cc.color_range) == (1, 1, 1, 1)  # BT.709, limited
        frame = next(cont.decode(video=0))
    rgb = VideoReformatter().reformat(frame, format="rgb24", src_colorspace=Colorspace.ITU709,
                                      dst_colorspace=Colorspace.ITU709, src_color_range=ColorRange.MPEG,
                                      dst_color_range=ColorRange.JPEG).to_ndarray()
    for i, c in enumerate(bars):
        got = rgb[H // 2, i * 64 + 32].astype(int)
        assert np.abs(got - c).max() <= 3, (c, got)


def test_a_preview_that_cannot_be_exact_refuses_the_link_and_writes_nothing(tmp_path):
    from data.linked import LINKED_PATH, TOKEN_HEADER, make_blueprint

    clip = moving_square(tmp_path / "odd.mov", size=(W, H + 1), codec="prores_ks", pix_fmt="yuv422p10le")
    app = Flask("odd")
    app.register_blueprint(make_blueprint(token="t"))
    r = app.test_client().post("/linked", json={"path": str(clip), "source": source_for(clip, height=H + 1)},
                               headers={TOKEN_HEADER: "t"})
    assert r.status_code == 422 and "odd_frame_size" in r.get_json()["error"]
    assert not LINKED_PATH.exists() or not any(LINKED_PATH.rglob("*"))


def test_a_second_link_reuses_the_preview_and_an_empty_one_is_made_again(tmp_path, monkeypatch):
    import data.assets.proxy_codec as codec
    from data.linked import LINKED_PATH, PREVIEWS_DIR, register

    clip = prores(moving_square(tmp_path / "again.mp4"))
    _, first = register(str(clip), source_for(clip))
    preview = LINKED_PATH / PREVIEWS_DIR / first["preview"]
    made = preview.read_bytes()

    def refuse(*a, **k):
        raise AssertionError("encoded again")

    monkeypatch.setattr(codec, "encode_proxy", refuse)
    _, second = register(str(clip), source_for(clip))
    assert second["preview"] == first["preview"] and preview.read_bytes() == made

    monkeypatch.undo()
    preview.write_bytes(b"")
    _, third = register(str(clip), source_for(clip))
    assert third["preview"] == first["preview"] and preview.stat().st_size > 0


def test_two_links_of_the_same_footage_at_once_encode_it_once(tmp_path, monkeypatch):
    import threading
    import time

    import data.assets.proxy_codec as codec
    from data.linked import register

    clip = prores(moving_square(tmp_path / "twice.mp4"))
    real, calls = codec.encode_proxy, []

    def slow(*a, **k):
        calls.append(1)
        time.sleep(0.3)  # the second link arrives while this one encodes
        return real(*a, **k)

    monkeypatch.setattr(codec, "encode_proxy", slow)
    results = []
    threads = [threading.Thread(target=lambda: results.append(register(str(clip), source_for(clip))[1]))
               for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(calls) == 1 and len(results) == 2 and results[0]["preview"] == results[1]["preview"]


def test_a_missing_preview_says_to_open_the_footage_again(tmp_path):
    from data.linked import LINKED_PATH, PREVIEWS_DIR, TOKEN_HEADER, make_blueprint

    clip = prores(moving_square(tmp_path / "gone.mp4"))
    app = Flask("gone")
    app.register_blueprint(make_blueprint(token="t"))
    c = app.test_client()
    record = c.post("/linked", json={"path": str(clip), "source": source_for(clip)},
                    headers={TOKEN_HEADER: "t"}).get_json()["record"]
    (LINKED_PATH / PREVIEWS_DIR / record["preview"]).unlink()
    r = c.get(f"/{record['path']}")
    assert r.status_code == 410 and "open it from After Effects again" in r.get_json()["error"]


def test_linking_sweeps_old_previews_no_record_names(tmp_path):
    from data.linked import LINKED_PATH, PREVIEW_SWEEP_AGE, PREVIEWS_DIR, register

    previews = LINKED_PATH / PREVIEWS_DIR
    previews.mkdir(parents=True)
    old, fresh = previews / "old.mp4", previews / "fresh.mp4"
    old.write_bytes(b"x")
    fresh.write_bytes(b"x")
    past = os.path.getmtime(old) - PREVIEW_SWEEP_AGE - 1
    os.utime(old, (past, past))
    outside = LINKED_PATH / "keep.txt"
    outside.write_text("x")
    clip = prores(moving_square(tmp_path / "sweep.mp4"))
    _, record = register(str(clip), source_for(clip))
    assert not old.exists() and fresh.exists() and outside.exists()  # a link in flight may still name `fresh`
    assert (previews / record["preview"]).exists()
