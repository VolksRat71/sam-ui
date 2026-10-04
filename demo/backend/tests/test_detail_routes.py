"""HTTP trust boundaries and removable annotations, without model execution."""
import numpy as np
import pytest
from test_api import Harness
from test_detail_records import detail
from tracks.detail_preview import DetailPreviews


@pytest.fixture
def h(tmp_path, monkeypatch):
    monkeypatch.setenv('SAM_UI_REFINE_DETAIL', '1')
    h = Harness(tmp_path); h.click(1); h.track()
    mask = h.service.tracks.mask_at(h.video, 1, 'fake', 0)
    h.service._detail_previews = DetailPreviews(h.service,
        read_frame=lambda *_: np.zeros((*mask['size'], 3), np.uint8),
        infer=lambda crop, _: np.ones(crop.shape[:2], bool))
    return h


def post(h, route, **args):
    return h.client.post('/' + route, json=dict(session_id='s', object_id=1, frame_index=0, **args))


@pytest.mark.parametrize('engine', ['../1/fake', '/tmp/outside', 'unknown', ['fake']])
def test_engine_whitelist_precedes_store_access(h, monkeypatch, engine):
    def forbidden(*_): raise AssertionError('untrusted engine reached storage')
    monkeypatch.setattr(h.service.tracks, 'mask_at', forbidden)
    for route in ('detail_frame', 'preview_detail_crop', 'remove_detail_crop'):
        response = post(h, route, engine=engine)
        assert response.status_code == 400 and response.json == {'error': 'invalid_engine'}


def test_store_rejects_escape_before_recovery(h, tmp_path):
    target = tmp_path / 'victim'; backup = tmp_path / '.victim.old-x'; backup.mkdir()
    for engine in (str(target), '../victim', '..', '/tmp/x'):
        with pytest.raises(ValueError): list(h.service.tracks.masks(h.video, 1, engine))
        with pytest.raises(ValueError): h.service.tracks.clear(h.video, 1, engine)
    with pytest.raises(ValueError): list(h.service.tracks.masks('../v', 1, 'fake'))
    assert backup.is_dir() and not target.exists()


@pytest.mark.parametrize('body', [[], [1], 5, 'x', None])
def test_non_object_body_is_400(h, body):
    response = h.client.post('/detail_frame', json=body)
    assert response.status_code == 400 and response.json == {'error': 'invalid_body'}


def test_flag_off_routes_never_create_store(h, monkeypatch):
    monkeypatch.setenv('SAM_UI_REFINE_DETAIL', '0')
    del h.service._detail_previews
    assert post(h, 'detail_state').json == {'enabled': False, 'objects': {}}
    for route in ('detail_frame', 'preview_detail_crop', 'apply_detail_crop', 'remove_detail_crop'):
        assert post(h, route).json == {'error': 'refine_detail_disabled'}
    assert not hasattr(h.service, '_detail_previews')


@pytest.mark.parametrize('rect,points', [
    ([-1, 0, 2, 2], [[.5, .5, 1]]), ([0, 0, 257, 2], [[.5, .5, 1]]),
    ([0, 0, 2, 2], [[.5, .5, 1]] * 65), ([0, 0, 2, 2], [[float('nan'), .5, 1]]),
    ([0, 0, 2, 2], [[.5, float('inf'), 1]]), ([0, 0, 2, 2], [[.5, .5, True]]),
    ([0, 0, 2, 2], [[.5, .5, 1.0]]), ([0, 0, 2, 2], [[.5, .5, 0]])])
def test_invalid_crop_never_runs_model_or_mutates(h, rect, points):
    before = h.service.seeds.record(h.video, 1)
    revision = post(h, 'detail_frame').json['revision']
    def forbidden(*_): raise AssertionError('invalid crop reached inference')
    h.service._detail_previews.infer = forbidden
    response = post(h, 'preview_detail_crop', correction_revision=revision, crop_rect=rect,
                    crop_points=points, request_id='bad')
    assert response.status_code == 400
    assert h.service.seeds.record(h.video, 1) == before


def test_route_apply_remove_stale_missing_and_one_undo(h):
    initial = post(h, 'detail_frame').json
    preview = post(h, 'preview_detail_crop', correction_revision=initial['revision'],
        crop_rect=[0, 0, 2, 2], crop_points=[[.5, .5, 1]], request_id='p').json
    n = len(h.service.versions.history(h.video, 1)['undo'])
    applied = post(h, 'apply_detail_crop', preview_id=preview['preview_id'], expected_correction_revision=preview['revision'])
    assert applied.status_code == 200
    assert len(h.service.versions.history(h.video, 1)['undo']) == n + 1
    state = post(h, 'detail_frame').json
    args = dict(detail_id=preview['preview_id'], expected_correction_revision=state['snapshot_revision'])
    assert post(h, 'remove_detail_crop', **{**args, 'expected_correction_revision': initial['snapshot_revision']}).json == {'error': 'stale_preview'}
    assert post(h, 'remove_detail_crop', **{**args, 'detail_id': '../x'}).json == {'error': 'invalid_detail_id'}
    assert post(h, 'remove_detail_crop', **{**args, 'detail_id': 'f' * 64}).json == {'error': 'detail_missing'}
    assert post(h, 'remove_detail_crop', **args).json['removed'] is True
    assert len(h.service.versions.history(h.video, 1)['undo']) == n + 2
    h.service.undo(h.video, 1)
    assert h.service.seeds.details(h.video, 1)[0][0]['id'] == preview['preview_id']


@pytest.mark.parametrize('reason', ['no_track', 'no_seeds', 'absent', 'empty'])
def test_remove_works_when_base_is_unavailable(h, reason):
    d = detail(); mask = h.service.tracks.mask_at(h.video, 1, 'fake', 0)
    d['geometry'].update(width=mask['size'][1], height=mask['size'][0])
    with h.service._seed_change(h.video, 1): h.service.seeds.add_detail(h.video, 1, 3, d)
    if reason == 'absent': h.service.set_range(h.video, 1, 3, 3, 'absent')
    elif reason == 'no_seeds': h.service.clear_frame(h.video, 1, 0)
    elif reason == 'no_track': h.service.clear_track(h.video, 1)
    else:
        meta = h.service.tracks.meta(h.video, 1, 'fake')
        h.service.tracks.save(h.video, 1, 'fake', meta['model'], meta['seeds_hash'],
                             {3: np.zeros(mask['size'], bool)}, 0)
    state = h.client.post('/detail_frame', json=dict(session_id='s', object_id=1, frame_index=3)).json
    assert state['base'] is None and state['details'] == [d]
    response = h.client.post('/remove_detail_crop', json=dict(session_id='s', object_id=1, frame_index=3,
        detail_id=d['id'], expected_correction_revision=state['snapshot_revision']))
    assert response.status_code == 200 and response.json['removed']
    assert h.service.seeds.details(h.video, 1) == {}


def test_decoder_errors_do_not_expose_server_paths(h):
    def failed(*_): raise OSError('cannot open /private/media/nate.mp4')
    h.service._detail_previews.read_frame = failed
    response = post(h, 'detail_frame')
    assert response.status_code == 400 and response.json == {'error': 'detail_media_unavailable'}


def test_real_decode_failure_has_media_error_code(h):
    from tracks.detail_preview import read_working_frame
    h.service._detail_previews.read_frame = read_working_frame
    response = post(h, 'detail_frame')  # Harness's clip is deliberately not a video
    assert response.status_code == 400
    assert response.json == {'error': 'detail_media_unavailable'}
