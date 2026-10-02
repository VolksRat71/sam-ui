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
