# sam-ui (Apache-2.0). Upload proxy bounds, verified on encoded output.
import shutil
import subprocess
from dataclasses import replace

import pytest

from data.transcoder import get_video_metadata, normalize_video, transcode

pytestmark = pytest.mark.skipif(shutil.which('ffmpeg') is None, reason='needs ffmpeg')


def make_clip(path, size='1920x1080'):
    # FFV1 accepts odd dimensions, so the input does not pre-round our fixtures.
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                    f'testsrc=size={size}:rate=30', '-t', '0.2', '-c:v', 'ffv1',
                    str(path)], check=True)
    return str(path)


@pytest.mark.parametrize('size,limits,want', [
    ('1920x1080', (640, 400), (640, 360)),
    ('1080x1920', (360, 640), (360, 640)),
    ('1000x1000', (1280, 720), (720, 720)),
    ('1080x1920', (600, 1000), (562, 1000)),
    ('320x240', (1920, 1080), (320, 240)),
    ('321x241', (640, 480), (320, 240)),
    ('1920x1080', (641, 361), (640, 360)),
    ('3840x2160', (1920, 1080), (1920, 1080)),
])
def test_encoded_proxy_fits_both_bounds_without_upscaling(tmp_path, size, limits, want):
    src = make_clip(tmp_path / 'source.mkv', size)
    out = tmp_path / 'proxy.mp4'
    normalize_video(src, str(out), *limits, seek_t=0, max_time=0.2, in_metadata=None)
    meta = get_video_metadata(str(out))
    assert (meta.width, meta.height) == want
    assert meta.fps == 24
    assert meta.num_video_frames > 0


def test_upload_environment_controls_bounds_and_fps(tmp_path, monkeypatch):
    src = make_clip(tmp_path / 'source.mkv')
    monkeypatch.setenv('VIDEO_ENCODE_MAX_WIDTH', '960')
    monkeypatch.setenv('VIDEO_ENCODE_MAX_HEIGHT', '540')
    monkeypatch.setenv('VIDEO_ENCODE_FPS', '30')
    out = tmp_path / 'proxy.mp4'
    transcode(src, str(out), None, seek_t=0, duration_time_sec=0.2)
    meta = get_video_metadata(str(out))
    assert (meta.width, meta.height, meta.fps, meta.num_video_frames) == (960, 540, 30, 6)


def test_rotation_is_applied_before_fitting_display_dimensions(tmp_path):
    from test_media import clip
    src = clip(tmp_path / 'landscape.mp4', rotation=90, size='640x360')
    out = tmp_path / 'portrait.mp4'
    normalize_video(str(src), str(out), 180, 320, seek_t=0, max_time=0.2, in_metadata=None)
    meta = get_video_metadata(str(out))
    assert (meta.width, meta.height) == (180, 320)


@pytest.mark.parametrize('limits', [(0, 720), (1280, -1), (1, 720)])
def test_invalid_bounds_fail_before_encoding(tmp_path, limits):
    src = make_clip(tmp_path / 'source.mkv', '320x240')
    with pytest.raises(ValueError, match='at least 2'):
        normalize_video(src, str(tmp_path / 'out.mp4'), *limits, 0, 0.2, None)


def test_invalid_source_dimensions_fail_before_encoding(tmp_path):
    src = make_clip(tmp_path / 'source.mkv', '320x240')
    meta = replace(get_video_metadata(src), width=0)
    with pytest.raises(ValueError, match='at least 2'):
        normalize_video(src, str(tmp_path / 'out.mp4'), 1280, 720, 0, 0.2, meta)
