import io
import json
import os
from pathlib import Path
import subprocess
import sys
import pytest
from asset_media_fixtures import make_clip


def test_config_default_and_opt_in(tmp_path):
    server = Path(__file__).resolve().parents[1] / 'server'
    for setting, expected in [(None, 'False'), ('0', 'False'), ('1', 'True'), ('true', None)]:
        env = dict(os.environ, DATA_PATH=str(tmp_path / 'config'), PYTHONPATH=str(server))
        env.pop('SAM_UI_RETAIN_ORIGINAL_UPLOADS', None)
        if setting is not None:
            env['SAM_UI_RETAIN_ORIGINAL_UPLOADS'] = setting
        result = subprocess.run([sys.executable, '-c',
            'from app_conf import RETAIN_ORIGINAL_UPLOADS; print(RETAIN_ORIGINAL_UPLOADS)'],
            env=env, capture_output=True, text=True, timeout=30)
        if expected is None:
            assert result.returncode != 0
        else:
            assert result.returncode == 0, result.stderr
            assert result.stdout.strip() == expected
        assert not (tmp_path / 'config' / 'assets').exists()


@pytest.fixture
def upload_env(tmp_path, monkeypatch):
    import data.schema as schema
    root = tmp_path / 'data'; root.mkdir()
    uploads = root / 'uploads'; uploads.mkdir()
    monkeypatch.setattr(schema, 'DATA_PATH', root)
    monkeypatch.setattr(schema, 'UPLOADS_PATH', uploads)
    monkeypatch.setattr(schema, 'RETAIN_ORIGINAL_UPLOADS', False, raising=False)
    return schema, root


def test_disabled_has_no_retention_side_effects(upload_env, tmp_path, monkeypatch):
    import data.assets
    schema, root = upload_env
    def forbidden(*args, **kwargs): raise AssertionError('disabled hook called')
    monkeypatch.setattr(data.assets, 'retain_upload', forbidden)
    source = make_clip(tmp_path / 'in.mp4')
    path, key, metadata = schema.process_video(io.BytesIO(source.read_bytes()), max_time=300)
    assert Path(path).is_file() and key.startswith('uploads/')
    assert metadata.num_video_frames > 0
    assert not (root / 'assets').exists()


def test_enabled_preserves_full_audio_original_and_same_output(upload_env, tmp_path, monkeypatch):
    schema, root = upload_env
    video = make_clip(tmp_path / 'silent.mp4', pts=list(range(24)))
    source = tmp_path / 'with-audio.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-i', str(video), '-f', 'lavfi',
                    '-i', 'sine=frequency=440:duration=1', '-map', '0:v', '-map', '1:a',
                    '-c:v', 'copy', '-c:a', 'aac', str(source)],
                   capture_output=True, check=True, timeout=30)
    original = source.read_bytes()
    off = schema.process_video(io.BytesIO(original), max_time=300,
                               start_time_sec=0.25, duration_time_sec=0.25)
    off_bytes = Path(off[0]).read_bytes()
    monkeypatch.setattr(schema, 'RETAIN_ORIGINAL_UPLOADS', True)
    on = schema.process_video(io.BytesIO(original), max_time=300,
                              start_time_sec=0.25, duration_time_sec=0.25)
    assert on == off
    assert Path(on[0]).read_bytes() == off_bytes
    originals = list((root / 'assets').glob('*/original.*'))
    assert len(originals) == 1 and originals[0].read_bytes() == original
    manifest = json.loads((originals[0].parent / 'asset.json').read_text())
    assert manifest['inspection']['decoded_count'] == 24
    assert any(s['type'] == 'audio' for s in manifest['inspection']['streams'])


def test_retention_failure_prevents_upload_success(upload_env, tmp_path, monkeypatch):
    import data.assets
    schema, root = upload_env
    source = make_clip(tmp_path / 'in.mp4')
    def fail(*args, **kwargs): raise ValueError('original_retention_failed')
    monkeypatch.setattr(data.assets, 'retain_upload', fail)
    monkeypatch.setattr(schema, 'RETAIN_ORIGINAL_UPLOADS', True)
    with pytest.raises(ValueError, match='original_retention_failed'):
        schema.process_video(io.BytesIO(source.read_bytes()), max_time=300)
    assert not list((root / 'uploads').iterdir())


def test_unsupported_timing_retains_and_accepts_legacy_upload(upload_env, tmp_path, monkeypatch):
    from data.assets import retention
    schema, root = upload_env
    source = make_clip(tmp_path / 'in.mp4')
    inspect = retention.inspect_source
    def unsupported(path):
        result = inspect(path)
        result['timing_status'] = 'unsupported'
        result['diagnostic_code'] = 'missing_or_invalid_pts'
        result['frames'][0]['pts'] = None
        return result
    monkeypatch.setattr(retention, 'inspect_source', unsupported)
    monkeypatch.setattr(schema, 'RETAIN_ORIGINAL_UPLOADS', True)
    path, _, _ = schema.process_video(io.BytesIO(source.read_bytes()), max_time=300)
    assert Path(path).is_file()
    manifest = json.loads(next((root / 'assets').glob('*/asset.json')).read_text())
    assert manifest['frame_table_hash'] is None
    assert manifest['inspection']['diagnostic_code'] == 'missing_or_invalid_pts'
