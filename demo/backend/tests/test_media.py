# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Upload and gallery fixes: rotation on PyAV 18, uploads listed, a clear
error for an empty gallery, and seed masks in GraphQL."""
import shutil
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")


def clip(path: Path, rotation=None, size="320x240"):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc=size={size}:rate=24", "-t", "0.5",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)], check=True)
    if rotation is not None:
        rotated = path.with_name("r_" + path.name)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-display_rotation", str(rotation), "-i", str(path),
                        "-c", "copy", str(rotated)], check=True)
        rotated.replace(path)
    return path


def test_metadata_reads_on_this_pyav_and_a_rotated_clip_swaps_its_size(tmp_path):
    from data.transcoder import get_video_metadata

    plain = get_video_metadata(str(clip(tmp_path / "plain.mp4")))
    assert (plain.width, plain.height) == (320, 240) and plain.num_video_frames == 12
    rot = get_video_metadata(str(clip(tmp_path / "rot.mp4", rotation=90)))
    assert (rot.width, rot.height) == (240, 320)  # a portrait phone clip stays portrait


def test_uploads_are_listed_with_the_gallery(tmp_path):
    from app_conf import UPLOADS_PATH
    from data.loader import preload_data

    up = clip(Path(UPLOADS_PATH) / "abc123.mp4")
    try:
        paths = [v.path for v in preload_data().values()]
        assert "uploads/abc123.mp4" in paths
    finally:
        up.unlink()


def test_default_video_on_an_empty_gallery_says_what_to_do():
    from data.schema import schema
    from data.store import get_videos, set_videos

    saved = get_videos()
    set_videos({})
    try:
        r = schema.execute_sync("{ defaultVideo { path } }")
    finally:
        set_videos(saved)
    assert r.errors and "no videos" in r.errors[0].message and "upload one" in r.errors[0].message


def test_seed_frames_carry_their_approved_mask():
    from test_schema import FakeAPI, INFO, run

    class WithMask(FakeAPI):
        def object_tracks(self, session_id):
            return [{**INFO, "seeds": {4: {"points": [[0.5, 0.5]], "labels": [1],
                                           "mask": {"size": [2, 2], "counts": "04"}}}}]

    seeds = run('{ objectTracks(sessionId: "s1") { seeds { frameIndex mask { size counts } } } }',
                WithMask())["objectTracks"][0]["seeds"]
    assert seeds == [{"frameIndex": 4, "mask": {"size": [2, 2], "counts": "04"}}]


class Api:
    """InferenceAPI's two video hooks, recorded."""

    def __init__(self, busy=()):
        self.busy, self.purged = {str(Path(p).resolve()) for p in busy}, []

    def video_in_use(self, path):
        return str(Path(path).resolve()) in self.busy

    def purge_video(self, path):
        self.purged.append(Path(path).name)


def delete(api, path, purge=True):
    from data.schema import schema

    q = 'mutation($p: String!, $g: Boolean!) { deleteVideo(input: {path: $p, purgeTracks: $g}) { path purged } }'
    return schema.execute_sync(q, variable_values={"p": path, "g": purge}, context_value={"inference_api": api})


def upload(name):
    from app_conf import UPLOADS_PATH
    from data.loader import get_video
    from data.store import get_videos, set_videos

    if not isinstance(get_videos(), dict):  # Meta's store starts as [] until app.py sets it
        set_videos({})
    p = clip(Path(UPLOADS_PATH) / name)
    v = get_video(p, Path(UPLOADS_PATH), generate_poster=False, width=320, height=240)
    get_videos()[v.code] = v
    return p, v


def test_delete_video_removes_an_upload_its_listing_and_its_tracks():
    from data.store import get_videos

    p, v = upload("del1.mp4")
    api = Api()
    r = delete(api, v.path)
    assert r.errors is None and r.data["deleteVideo"] == {"path": "uploads/del1.mp4", "purged": True}
    assert not p.exists() and v.code not in get_videos() and api.purged == ["del1.mp4"]


def test_delete_video_can_keep_the_tracks():
    p, v = upload("del2.mp4")
    api = Api()
    assert delete(api, v.path, purge=False).data["deleteVideo"]["purged"] is False
    assert api.purged == [] and not p.exists()


def test_delete_video_refuses_gallery_videos_escapes_missing_files_and_open_ones(tmp_path):
    from app_conf import GALLERY_PATH

    g = clip(Path(GALLERY_PATH) / "keep.mp4")
    try:
        for path, why in (("gallery/keep.mp4", "only uploaded videos"),
                          ("uploads/../gallery/keep.mp4", "only uploaded videos"),
                          ("uploads/nope.mp4", "no uploaded video")):
            r = delete(Api(), path)
            assert r.errors and why in r.errors[0].message, path
        assert g.exists()
        p, v = upload("busy.mp4")
        r = delete(Api(busy=[p]), v.path)
        assert r.errors and "open in a session" in r.errors[0].message and p.exists()
        p.unlink()
    finally:
        g.unlink()


def test_delete_video_can_close_sessions_that_went_idle():
    p, v = upload("idle.mp4")

    class IdleApi(Api):
        def close_idle_sessions_on(self, path):
            self.busy.discard(str(Path(path).resolve()))  # the leaked tab's session
            return 1

    api = IdleApi(busy=[p])
    r = delete(api, v.path)
    assert r.errors and "open in a session" in r.errors[0].message  # not asked: refused as before
    from data.schema import schema
    q = 'mutation($p: String!) { deleteVideo(input: {path: $p, closeIdleSessions: true}) { purged sessionsClosed } }'
    r = schema.execute_sync(q, variable_values={"p": v.path}, context_value={"inference_api": api})
    assert r.errors is None and r.data["deleteVideo"] == {"purged": True, "sessionsClosed": 1} and not p.exists()


def test_close_idle_sessions_on_keeps_recent_and_busy_ones(tmp_path, monkeypatch):
    from test_inference_api import StubPredictor
    from inference.data_types import StartSessionRequest
    from inference.predictor import InferenceAPI

    video = tmp_path / "v.mp4"
    video.write_bytes(b"x")
    a = InferenceAPI(predictor=StubPredictor(), tracks_root=str(tmp_path / "t"))
    clock = [100.0]
    monkeypatch.setattr("inference.predictor.time.time", lambda: clock[0])
    old, busy = (a.start_session(StartSessionRequest(type="start_session", path=str(video))).session_id for _ in range(2))
    job = a.tracks.jobs.claim(busy, "v", [1])
    clock[0] += 120
    recent = a.start_session(StartSessionRequest(type="start_session", path=str(video))).session_id
    assert a.close_idle_sessions_on(str(video)) == 1
    assert set(a.session_states) == {busy, recent}
    a.tracks.jobs.release(job)
