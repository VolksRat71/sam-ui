import numpy as np
import pytest
from test_api import Harness
from tracks.engine import FakeEngine
from tracks import rle


def test_preview_apply_idempotent_stale_and_expiry(tmp_path, monkeypatch):
    from tracks.detail_preview import DetailPreviews
    monkeypatch.setenv('SAM_UI_REFINE_DETAIL', '1')
    h = Harness(tmp_path, engine=FakeEngine(n_frames=8)); h.click(1); h.track()
    size = h.service.tracks.meta(h.video, 1, 'fake')
    mask = next(h.service.tracks.masks(h.video, 1, 'fake'))[1]
    pixels = np.zeros((*mask['size'], 3), np.uint8)
    clock = [1.0]
    store = DetailPreviews(h.service, read_frame=lambda path, index: pixels,
                           infer=lambda crop, points: np.ones(crop.shape[:2], bool), clock=lambda: clock[0])
    context = dict(video=h.video, path='fake.mp4', owner='session', obj_id=1, frame=0, engine='fake')
    state = store.frame(**context)
    result = store.preview(**context, revision=state['revision'], rect=[0, 0, 2, 2], points=[[.5, .5, 1]], request_id='test')
    before = len(h.service.versions.history(h.video, 1)['undo'])
    applied = store.apply(result['preview_id'], state['revision'], owner='session')
    assert store.apply(result['preview_id'], state['revision'], owner='session') == applied
    assert len(h.service.versions.history(h.video, 1)['undo']) == before + 1
    assert h.service.seeds.details(h.video, 1)[0][0]['geometry']['version'] == 'working-copy-v1'
    with pytest.raises(ValueError, match='preview_owner'):
        store.apply(result['preview_id'], state['revision'], owner='another')
    h.service.undo(h.video, 1)
    with pytest.raises(ValueError, match='stale_preview'):
        store.apply(result['preview_id'], state['revision'], owner='session')
    fresh = store.frame(**context)
    other = store.preview(**context, revision=fresh['revision'], rect=[0, 0, 2, 2], points=[[.5, .5, 1]], request_id='other')
    h.click(1, frame=0, points=[[.8, .8]], labels=[1])
    with pytest.raises(ValueError, match='stale_preview'):
        store.apply(other['preview_id'], fresh['revision'], owner='session')
    clock[0] = 1000
    with pytest.raises(ValueError, match='preview_expired'):
        store.apply(other['preview_id'], fresh['revision'], owner='session')


def test_off_does_not_read_or_infer(tmp_path):
    from tracks.detail_preview import DetailPreviews
    h = Harness(tmp_path, engine=FakeEngine(n_frames=8))
    def forbidden(*args): raise AssertionError('must not run')
    store = DetailPreviews(h.service, read_frame=forbidden, infer=forbidden)
    with pytest.raises(ValueError, match='refine_detail_disabled'):
        store.frame(video=h.video, path='x', owner='session', obj_id=1, frame=0, engine='fake')


@pytest.mark.slow
@pytest.mark.skipif(__import__('os').environ.get('SAM_UI_DETAIL_MODEL_TEST') != '1', reason='explicit model test under GPU lock')
def test_stock_sam21_image_pass_uses_shared_model_without_video_prompts(tmp_path):
    import os
    import torch
    from sam2.build_sam import build_sam2_video_predictor
    from tracks.engine import Sam2Engine
    from tracks.service import TrackService
    from tracks.detail_preview import DetailPreviews
    predictor = build_sam2_video_predictor('configs/sam2.1/sam2.1_hiera_l.yaml',
        os.environ['SAM_UI_DETAIL_CHECKPOINT'], device='mps' if torch.backends.mps.is_available() else 'cpu')
    service = TrackService(str(tmp_path), Sam2Engine(predictor, 'sam2.1-hiera-large'))
    crop = np.zeros((128, 128, 3), np.uint8); crop[24:104, 40:88] = [220, 80, 80]
    result = DetailPreviews(service)._infer(crop, [[.5, .5, 1]])
    assert result.shape == (128, 128) and result.dtype == bool
    assert service.seeds.objects('v') == [] and service.jobs.running() == []
