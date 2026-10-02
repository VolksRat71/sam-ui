# sam-ui (Apache-2.0). Benchmark integrity without loading a model.
import importlib.util
from pathlib import Path

import numpy as np
import pytest

spec = importlib.util.spec_from_file_location(
    'proxy_bench', Path(__file__).resolve().parents[3] / 'tools/proxy_resolution_bench.py')
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


def test_lock_releases_only_our_directory_even_on_failure(tmp_path):
    lock = tmp_path / '.gpu-lock'
    with pytest.raises(RuntimeError):
        with bench.gpu_lock(lock, timeout=0):
            assert lock.is_dir()
            raise RuntimeError('model failed')
    assert not lock.exists()


def test_existing_gpu_lock_is_never_deleted(tmp_path):
    lock = tmp_path / '.gpu-lock'
    lock.mkdir()
    owner = lock / 'someone-else'
    owner.write_text('busy')
    with pytest.raises(TimeoutError):
        with bench.gpu_lock(lock, timeout=0):
            pytest.fail('entered an occupied lock')
    assert owner.read_text() == 'busy'


def test_lock_replacement_is_never_deleted(tmp_path):
    lock = tmp_path / '.gpu-lock'
    with bench.gpu_lock(lock, timeout=0):
        lock.rename(tmp_path / 'old-lock')
        lock.mkdir()
    assert lock.is_dir()


@pytest.mark.parametrize('fixture', bench.FIXTURES)
def test_fixture_truth_matches_rendered_visible_subject(fixture):
    rgb, truth = bench.scene(fixture, 15, width=384, height=216)
    # The subject is red; background and occluder have blue >= red.
    assert np.array_equal(truth, rgb[:, :, 0] > rgb[:, :, 2])
    assert truth.any()


def test_occlusion_removes_visible_ground_truth():
    _, visible = bench.scene('occlusion', 15, width=384, height=216)
    _, full = bench.scene('motion', 15, width=384, height=216)
    assert np.count_nonzero(visible) < np.count_nonzero(full)
    assert not (visible & ~full).any()


def test_iou_uses_common_grid_and_counts_empty_misses():
    truth = np.array([[True, False], [False, False]])
    assert bench.mask_iou(np.ones((1, 1), dtype=bool), truth) == .25
    assert bench.mask_iou(np.zeros((1, 1), dtype=bool), truth) == 0
    assert bench.mask_iou(np.zeros((1, 1), dtype=bool), np.zeros_like(truth)) == 1


def test_frame_validation_rejects_missing_or_duplicate_outputs():
    bench.validate_frames([2, 0, 1], 3)
    with pytest.raises(ValueError, match='exactly once'):
        bench.validate_frames([0, 1], 3)
    with pytest.raises(ValueError, match='exactly once'):
        bench.validate_frames([0, 1, 1], 3)


def test_prepared_fixtures_reject_a_changed_generator(tmp_path, monkeypatch):
    import json
    identity = bench.fixture_identity()
    (tmp_path / 'fixtures.json').write_text(json.dumps({**identity, 'digests': {}}))
    original = bench.scene

    def changed_scene(*args, **kwargs):
        rgb, truth = original(*args, **kwargs)
        return rgb, ~truth

    monkeypatch.setattr(bench, 'scene', changed_scene)
    with pytest.raises(ValueError, match='Fixture identity'):
        bench.prepare(tmp_path)


def test_prepared_fixtures_reject_changed_transcoder(tmp_path, monkeypatch):
    import json
    identity = bench.fixture_identity()
    (tmp_path / 'fixtures.json').write_text(json.dumps({**identity, 'digests': {}}))
    actual_digest = bench.digest
    monkeypatch.setattr(bench, 'digest', lambda path: 'changed' if path.name == 'transcoder.py' else actual_digest(path))
    with pytest.raises(ValueError, match='Fixture identity'):
        bench.prepare(tmp_path)


@pytest.mark.parametrize('change', [
    {'device': 'cuda'}, {'hardware': 'another GPU'},
    {'packages': {'torch': 'new release'}}, {'machine': 'another host'},
])
def test_measurement_resume_rejects_environment_changes(tmp_path, change):
    import json
    original = {'environment': {'device': 'mps', 'hardware': 'M4 Max',
                               'packages': {'torch': '2.14.0'}, 'machine': 'host A'}}
    bench.record_measurement_identity(tmp_path, original)
    bench.record_measurement_identity(tmp_path, original)  # unchanged is resumable
    new = {'environment': {**original['environment'], **change}}
    with pytest.raises(ValueError, match='Measurement identity'):
        bench.record_measurement_identity(tmp_path, new)
    assert json.loads((tmp_path / 'measurement.json').read_text()) == original


def test_cli_checks_runtime_identity_before_starting_any_model(tmp_path, monkeypatch):
    from contextlib import nullcontext
    import json
    import subprocess
    import sys

    weights = tmp_path / 'test-weights'
    weights.write_bytes(b'synthetic test placeholder')
    monkeypatch.setattr(sys, 'argv', ['bench', '--out', str(tmp_path), '--weights', str(weights)])
    monkeypatch.setattr(bench, 'prepare', lambda out: {'digests': {'detail-720p.mp4': 'clip digest'}})
    monkeypatch.setattr(bench, 'gpu_lock', nullcontext)
    monkeypatch.setattr(bench.subprocess, 'check_output', lambda *a, **k: 'same head\n')
    runtime = {'packages': {'torch': 'original'}}
    model_calls = []

    def child(command, **kwargs):
        if '--_environment' in command:
            return subprocess.CompletedProcess(command, 0, json.dumps(runtime))
        model_calls.append(command)
        raise RuntimeError('model stub')

    monkeypatch.setattr(bench.subprocess, 'run', child)
    with pytest.raises(RuntimeError, match='model stub'):
        bench.main()
    assert len(model_calls) == 1
    model_calls.clear()
    runtime['packages']['torch'] = 'upgraded'
    with pytest.raises(ValueError, match='Measurement identity'):
        bench.main()
    assert not model_calls


@pytest.fixture
def isolated_cli(tmp_path, monkeypatch):
    """A real CLI/manifest flow with fake children, so no model or lock is used."""
    from contextlib import nullcontext
    import json
    import subprocess
    import sys

    repo = tmp_path / 'repo'
    for name in ('tools/proxy_resolution_bench.py', 'demo/backend/server/data/transcoder.py',
                 'demo/backend/server/tracks/engine.py', 'demo/backend/server/tracks/streaming.py',
                 'demo/backend/server/tracks/features.py', 'sam2/sam2_video_predictor.py',
                 'sam2/configs/sam2.1/sam2.1_hiera_l.yaml'):
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('original source')
    weights = tmp_path / 'weights'
    weights.write_bytes(b'placeholder')
    monkeypatch.setattr(bench, 'REPO', repo)
    monkeypatch.setattr(sys, 'argv', ['bench', '--out', str(tmp_path), '--weights', str(weights)])
    monkeypatch.setattr(bench, 'prepare', lambda out: {'digests': {'detail-720p.mp4': 'clip digest'}})
    monkeypatch.setattr(bench, 'gpu_lock', nullcontext)
    monkeypatch.setattr(bench.subprocess, 'check_output', lambda *a, **k: 'same head\n')
    calls = []

    def child(command, **kwargs):
        if '--_environment' in command:
            return subprocess.CompletedProcess(command, 0, json.dumps({'device': 'test'}))
        calls.append(command)
        raise RuntimeError('model stub')

    monkeypatch.setattr(bench.subprocess, 'run', child)
    return repo, calls


@pytest.mark.parametrize('source', ['sam2/configs/sam2.1/sam2.1_hiera_l.yaml',
                                   'sam2/sam2_video_predictor.py'])
def test_cli_rejects_uncommitted_model_changes_before_resuming(isolated_cli, source):
    repo, model_calls = isolated_cli
    with pytest.raises(RuntimeError, match='model stub'):
        bench.main()
    model_calls.clear()
    (repo / source).write_text('changed model; same git HEAD')
    with pytest.raises(ValueError, match='Measurement identity'):
        bench.main()
    assert not model_calls


def test_cli_surfaces_runtime_probe_stderr(isolated_cli, monkeypatch):
    import subprocess
    _, model_calls = isolated_cli

    def fail_probe(command, **kwargs):
        raise subprocess.CalledProcessError(1, command, stderr='cannot load runtime: sentinel cause')

    monkeypatch.setattr(bench.subprocess, 'run', fail_probe)
    with pytest.raises(RuntimeError, match='cannot load runtime: sentinel cause'):
        bench.main()
    assert not model_calls
