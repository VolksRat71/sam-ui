"""Details are output annotations, never tracking prompts or seed-hash inputs."""
import copy
import numpy as np
from test_api import Harness
from tracks.engine import FakeEngine
from tracks import rle
from tracks.seeds import SeedStore, cleared, confirmed


def detail(key='a'):
    return dict(id=key * 64, rect=[0, 0, 2, 2], points=[[0.5, 0.5, 1]],
                mask=rle.encode(np.ones((2, 2), bool)),
                geometry=dict(version='working-copy-v1', width=16, height=16))


def test_details_preserved_but_projected_out_of_seeds(tmp_path):
    s = SeedStore(str(tmp_path)); s.add_points('v', 1, 0, [[.2, .2]], [1], True)
    base = s.record('v', 1); key = s.record_key(base)
    s.add_detail('v', 1, 0, detail())
    assert s.record_key(s.record('v', 1)) == key
    assert s.snapshot_key(s.record('v', 1)) != key
    assert s.seeds('v', 1)[0] == base['seeds.json']['0']
    s.add_points('v', 1, 0, [[.3, .3]], [1], True)
    assert s.details('v', 1)[0] == [detail()]
    s.set_text('v', 1, 0, 'coat', rle.encode(np.ones((16, 16), bool)))
    assert s.details('v', 1)[0] == [detail()]
    s.add_detail('v', 1, 3, detail('b'))
    assert 3 not in s.seeds('v', 1)
    assert not cleared(s.raw_seeds('v', 1)[3]) and not confirmed(s.raw_seeds('v', 1)[3])
    assert s.snapshot_key(base) == key


def test_detail_undo_redo_never_changes_track_and_groups_once(tmp_path):
    h = Harness(tmp_path, engine=FakeEngine(n_frames=8))
    h.click(1, frame=0); h.track()
    s = h.service; v = h.video
    before = s.seeds.hash(v, 1)
    track = s.tracks.track_dir(v, 1, 'fake') / 'masks.jsonl'
    masks = track.read_bytes(); history = len(s.versions.history(v, 1)['undo'])
    with s._seed_change(v, 1): s.seeds.add_detail(v, 1, 0, detail())
    a = s._record(v, 1)[0]
    with s._seed_change(v, 1): s.seeds.add_detail(v, 1, 0, detail('b'))
    b = s._record(v, 1)[0]
    assert a != b and len(a) == len(b) == 64
    assert len(s.versions.history(v, 1)['undo']) == history + 2
    s.undo(v, 1); assert len(s.seeds.details(v, 1)[0]) == 1
    s.redo(v, 1); assert len(s.seeds.details(v, 1)[0]) == 2
    assert s.seeds.hash(v, 1) == before and track.read_bytes() == masks
    assert s.object_info(v, 1)['state'] == 'tracked'
    assert s.jobs.running() == []
    n = len(s.versions.history(v, 1)['undo'])
    h.click(1, frame=0, points=[[.8, .8]], labels=[1])
    assert len(s.versions.history(v, 1)['undo']) == n + 1
    assert len(s.seeds.details(v, 1)[0]) == 2
    s.undo(v, 1)
    assert s.seeds.hash(v, 1) == before and track.read_bytes() == masks


def test_legacy_keys_and_record_bytes_stay_identical(tmp_path):
    s = SeedStore(str(tmp_path)); s.add_points('v', 1, 0, [[.2, .2]], [1], True)
    files = s.record('v', 1); frozen = copy.deepcopy(files)
    assert s.tracking_record(files) == files
    assert s.snapshot_key(files) == s.record_key(files)
    assert files == frozen


def test_output_union_and_off_path(tmp_path, monkeypatch):
    from tracks.detail import effective_mask
    base = rle.encode(np.eye(16, dtype=bool)); d = detail()
    assert effective_mask(base, [d]) is base
    monkeypatch.setenv('SAM_UI_REFINE_DETAIL', '1')
    assert effective_mask(base, []) is base
    expected = np.eye(16, dtype=bool); expected[:2, :2] = True
    assert np.array_equal(rle.decode(effective_mask(base, [d])), expected)
    h = Harness(tmp_path, engine=FakeEngine(n_frames=8))
    h.click(1); h.track()
    original = list(h.service.cached(h.video))
    # Use the fake engine's actual raster for an independent detail-only frame.
    size = original[0][1][1]['size']; d['geometry'].update(width=size[1], height=size[0])
    h.service.seeds.add_detail(h.video, 1, 3, d)
    shown = dict(h.service.output_masks(h.video, 1, 'fake'))
    assert np.all(rle.decode(shown[3])[:2, :2])
    assert 3 not in h.service.object_info(h.video, 1)['seeds']
    assert h.service.seeds.hash(h.video, 1) == h.service.tracks.meta(h.video, 1, 'fake')['seeds_hash']


def fitted_detail(h, key='a'):
    d = detail(key)
    size = next(h.service.tracks.masks(h.video, 1, 'fake'))[1]['size']
    d['geometry'].update(width=size[1], height=size[0])
    return d


def test_clear_frame_drops_own_details_keeps_other_frames_without_ghosts(tmp_path, monkeypatch):
    monkeypatch.setenv('SAM_UI_REFINE_DETAIL', '1')
    h = Harness(tmp_path); h.click(1); h.track()
    d = fitted_detail(h)
    with h.service._seed_change(h.video, 1):
        h.service.seeds.add_detail(h.video, 1, 0, d)
        h.service.seeds.add_detail(h.video, 1, 3, detail_at := {**d, 'id': 'b' * 64})
    n = len(h.service.versions.history(h.video, 1)['undo'])
    h.service.clear_frame(h.video, 1, 0)
    assert h.service.seeds.details(h.video, 1) == {3: [detail_at]}
    assert list(h.service.cached(h.video)) == []
    assert list(h.service.output_masks(h.video, 1, 'fake')) == []
    assert len(h.service.versions.history(h.video, 1)['undo']) == n + 1
    h.service.undo(h.video, 1)
    assert h.state(1) == 'tracked' and h.service.seeds.details(h.video, 1)[0] == [d]
    assert len(list(h.service.cached(h.video))) == 4


def test_empty_base_never_becomes_floating_detail(tmp_path, monkeypatch):
    from tracks.detail import effective_mask
    monkeypatch.setenv('SAM_UI_REFINE_DETAIL', '1')
    empty = rle.encode(np.zeros((16, 16), bool))
    assert effective_mask(None, [detail()]) is None
    assert effective_mask(empty, [detail()]) is empty


def test_detail_only_undo_uses_seed_change_without_adoption_or_clear(tmp_path, monkeypatch):
    import contextlib
    import re
    h = Harness(tmp_path); h.click(1); h.track()
    s, v = h.service, h.video
    with s._seed_change(v, 1): s.seeds.add_detail(v, 1, 3, fitted_detail(h))
    assert re.fullmatch('[0-9a-f]{64}', s._record(v, 1)[0])
    original = s._seed_change
    calls = []
    @contextlib.contextmanager
    def spy(*args, **kwargs):
        calls.append(kwargs)
        with original(*args, **kwargs): yield
    def forbidden(*_): raise AssertionError('detail-only undo touched tracking')
    monkeypatch.setattr(s, '_seed_change', spy)
    monkeypatch.setattr(s, '_adopt_versions', forbidden)
    monkeypatch.setattr(s.tracks, 'clear', forbidden)
    s.undo(v, 1); s.redo(v, 1)
    assert calls == [{'record_history': False}, {'record_history': False}]
    assert s.seeds.details(v, 1)[3]


def test_candidate_detail_is_neither_confirmed_nor_cleared(tmp_path, monkeypatch):
    monkeypatch.setenv('SAM_UI_REFINE_DETAIL', '1')
    h = Harness(tmp_path, engine=FakeEngine(n_frames=30)); h.click(1); h.track()
    s, v = h.service, h.video
    s.set_range(v, 1, 10, 20, 'candidate', source='text:coat@sam3')
    before = s.review_queue(v)
    with s._seed_change(v, 1): s.seeds.add_detail(v, 1, 10, fitted_detail(h))
    assert s.review_queue(v) == before
    reasons = [r for loc in before['objects']['1']['locations'] for r in loc['reasons'] if r['kind'] == 'candidate']
    assert [r['frame'] for r in reasons] == [10]
    assert 10 not in s.seeds.seeds(v, 1)
    assert s.object_info(v, 1)['ranges'][0]['state'] == 'candidate'


def test_distinct_snapshot_gc_other_engine_and_restore_undo(tmp_path, monkeypatch):
    import re
    h = Harness(tmp_path); h.click(1); h.track()
    s, v = h.service, h.video
    d = fitted_detail(h)
    with s._seed_change(v, 1): s.seeds.add_detail(v, 1, 0, d)
    snap, files = s._record(v, 1); tracking = s.seeds.record_key(files)
    assert snap != tracking and re.fullmatch('[0-9a-f]{64}', snap)
    meta = s.tracks.meta(v, 1, 'fake')
    s._keep_version(v, 1, 'fake', tracking, files, meta)
    assert s.versions_info(v, 1)['versions'][0]['key'] == snap
    s.versions.record(v, 1, 'second', tracking, s.tracks.track_dir(v, 1, 'fake'), {'snapshot_key': snap})
    s.versions.set_history(v, 1, {'undo': [], 'redo': []})
    from tracks import versions
    monkeypatch.setattr(versions, 'KEEP', 0)
    s.versions.evict(v, 1, 'fake'); s.versions.gc(v, 1)
    assert s.versions.snapshot(v, 1, snap) == files  # second engine keeps it alive
    with s._seed_change(v, 1): s.seeds.remove_detail(v, 1, 0, d['id'])
    s.versions.drop(v, 1, 'second'); s.versions.gc(v, 1)
    assert s.versions.snapshot(v, 1, snap) == files  # history keeps it alive
    s.restore_version(v, 1, snap)
    assert s.seeds.details(v, 1)[0] == [d]
    s.undo(v, 1)
    assert s.seeds.details(v, 1) == {}
    h.new_service()
    h.service.redo(v, 1)
    assert h.service.seeds.details(v, 1)[0] == [d]


def test_legacy_history_and_files_survive_restart_without_new_keys(tmp_path):
    h = Harness(tmp_path); h.click(1); h.track()
    s, v = h.service, h.video
    before = s._record(v, 1)
    h.click(1, points=[[.8, .8]])
    history = s.versions.history(v, 1)
    files = {str(p.relative_to(h.root)): p.read_bytes() for p in h.root.rglob('*') if p.is_file()}
    h.new_service()
    assert h.service.versions.history(v, 1) == history
    assert files == {str(p.relative_to(h.root)): p.read_bytes() for p in h.root.rglob('*') if p.is_file()}
    assert history['undo'][-1]['key'] == before[0] == s.seeds.record_key(before[1])
    h.service.undo(v, 1)
    assert h.service._record(v, 1) == before and h.state(1) == 'tracked'


def test_display_export_use_track_base_and_absent_is_blank(tmp_path, monkeypatch):
    from PIL import Image
    monkeypatch.setenv('SAM_UI_REFINE_DETAIL', '1')
    monkeypatch.setenv('SAM_UI_EXPORT_ROOT', str(tmp_path))
    h = Harness(tmp_path); h.click(1); h.track()
    s, v = h.service, h.video
    d = fitted_detail(h)
    # Seed and track deliberately disagree: output must preserve the displayed track.
    s.seeds.add_points(v, 1, 0, [[.5, .5]], [1], True,
                       rle.encode(np.ones((d['geometry']['height'], d['geometry']['width']), bool)))
    s.seeds.add_detail(v, 1, 0, d)
    s.seeds.add_detail(v, 1, 3, d)
    s.set_range(v, 1, 3, 3, 'absent')
    shown = {f: masks[1] for f, masks in s.cached(v)}
    base = s.tracks.mask_at(v, 1, 'fake', 0)
    assert shown[0] == s.effective_mask(v, 1, 0, base)
    assert rle.area(shown[0]) < d['geometry']['width'] * d['geometry']['height']
    assert rle.area(shown[3]) == 0
    out = tmp_path / 'export'
    response = h.client.post('/export', json=dict(session_id='s', out_dir=str(out), include_stale=True))
    assert response.status_code == 200
    for frame in (0, 3):
        png = np.array(Image.open(out / f'data/mattes_tracked/object_1/{frame + 1:05}.png')) > 0
        assert np.array_equal(png, rle.decode(shown[frame]).astype(bool))


def test_flag_off_with_stored_details_and_on_without_details_are_byte_identical(tmp_path, monkeypatch):
    monkeypatch.setenv('SAM_UI_EXPORT_ROOT', str(tmp_path))
    import time
    monkeypatch.setattr(time, 'strftime', lambda *_: '2026-10-04T12:00:00+0000')
    h = Harness(tmp_path); h.click(1); h.track()
    def capture(folder):
        stream = h.client.post('/track_masks', json={'session_id': 's'}).data
        cached = list(h.service.cached(h.video))
        response = h.client.post('/export', json=dict(session_id='s', out_dir=str(folder)))
        assert response.status_code == 200
        # Freeze only the wall clock; compare every exported file byte for byte.
        outputs = {str(p.relative_to(folder)): p.read_bytes() for p in folder.rglob('*') if p.is_file()}
        return stream, cached, outputs
    baseline = capture(tmp_path / 'baseline')
    monkeypatch.setenv('SAM_UI_REFINE_DETAIL', '1')
    assert capture(tmp_path / 'on_no_details') == baseline
    h.service.seeds.add_detail(h.video, 1, 0, fitted_detail(h))
    monkeypatch.setenv('SAM_UI_REFINE_DETAIL', '0')
    assert capture(tmp_path / 'off_with_details') == baseline


def test_detail_stream_reads_seed_and_range_files_once(tmp_path, monkeypatch):
    from collections import Counter
    monkeypatch.setenv('SAM_UI_REFINE_DETAIL', '1')
    h = Harness(tmp_path, engine=FakeEngine(n_frames=3000)); h.click(1); h.track()
    h.service.seeds.add_detail(h.video, 1, 0, fitted_detail(h))
    reads = Counter()
    for method in ('raw_seeds', 'ranges'):
        original = getattr(h.service.seeds, method)
        def spy(*args, _original=original, _method=method):
            reads[_method] += 1
            return _original(*args)
        monkeypatch.setattr(h.service.seeds, method, spy)
    for stream in (lambda: h.service.cached(h.video), lambda: h.service.output_masks(h.video, 1, 'fake')):
        reads.clear()
        assert len(list(stream())) == 3000
        assert reads == {'raw_seeds': 1, 'ranges': 1}
