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
