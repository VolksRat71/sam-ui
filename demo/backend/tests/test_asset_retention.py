from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import pytest
from asset_media_fixtures import make_clip


def retain(source, root, **kwargs):
    from data.assets import retain_upload
    return retain_upload(source, root=root, working_copy_sha256=kwargs.get('key', 'a' * 64),
                         start_time_sec=kwargs.get('start', 0.0), duration_time_sec=300.0)


def test_byte_identical_and_idempotent(tmp_path):
    source = make_clip(tmp_path / 'input.mp4')
    original = source.read_bytes(); root = tmp_path / 'assets'
    result = retain(source, root)
    assert result['source_sha256'] == hashlib.sha256(original).hexdigest()
    stored = root / result['original_path']
    assert stored.read_bytes() == original
    assert stored.suffix == '.mp4'
    assert result['timing_mode'] == 'legacy_retimed'
    assert result['frame_accurate_export'] is False
    assert retain(source, root) == result
    manifest = json.loads((stored.parent / 'asset.json').read_text())
    assert manifest['inspection']['decoded_count'] == 8
    assert manifest['frame_table_hash']


def test_same_working_hash_keeps_distinct_sources(tmp_path):
    first = make_clip(tmp_path / 'a.mp4')
    second = make_clip(tmp_path / 'b.mp4', pts=[0, 1, 2])
    root = tmp_path / 'assets'
    a, b = retain(first, root), retain(second, root)
    assert a['asset_id'] != b['asset_id']
    assert len(list((root / 'working-copies' / ('a' * 64)).glob('*.json'))) == 2


def test_concurrent_identical_uploads(tmp_path):
    source = make_clip(tmp_path / 'in.mp4'); root = tmp_path / 'assets'
    with ThreadPoolExecutor(max_workers=4) as pool:
        records = list(pool.map(lambda _: retain(source, root), range(8)))
    assert all(r == records[0] for r in records)
    assert not list(root.glob('.stage-*'))


def test_unsupported_keeps_original_without_valid_hash(tmp_path):
    source = tmp_path / 'unknown'; source.write_bytes(b'undecodable original bytes')
    root = tmp_path / 'assets'; result = retain(source, root)
    original = root / result['original_path']
    assert original.suffix == '.bin' and original.read_bytes() == source.read_bytes()
    manifest = json.loads((original.parent / 'asset.json').read_text())
    assert manifest['frame_table_hash'] is None
    assert manifest['inspection']['timing_status'] == 'unsupported'


@pytest.mark.parametrize('kind', ['root', 'original', 'manifest', 'association'])
def test_refuses_symlinks(tmp_path, kind):
    source = make_clip(tmp_path / 'in.mp4'); root = tmp_path / 'assets'
    outside = tmp_path / 'outside'; outside.mkdir()
    if kind == 'root':
        root.symlink_to(outside, target_is_directory=True)
    else:
        record = retain(source, root)
        if kind == 'original':
            path = root / record['original_path']
        elif kind == 'manifest':
            path = (root / record['original_path']).parent / 'asset.json'
        else:
            path = next((root / 'working-copies' / ('a' * 64)).glob('*.json'))
        path.unlink(); path.symlink_to(source)
    with pytest.raises(ValueError, match='original_retention_failed'):
        retain(source, root)
    assert not list(outside.iterdir())


def test_existing_corruption_refused(tmp_path):
    source = make_clip(tmp_path / 'in.mp4'); root = tmp_path / 'assets'
    record = retain(source, root)
    (root / record['original_path']).write_bytes(b'corrupted')
    with pytest.raises(ValueError, match='original_retention_failed'):
        retain(source, root)


@pytest.mark.parametrize('operation', ['fsync', 'rename'])
def test_publication_failure_no_ready_asset(tmp_path, monkeypatch, operation):
    from data.assets import retention
    source = make_clip(tmp_path / 'in.mp4'); root = tmp_path / 'assets'
    def fail(*args): raise OSError('injected disk failure')
    monkeypatch.setattr(retention.os, operation, fail)
    with pytest.raises(ValueError, match='original_retention_failed'):
        retain(source, root)
    assert not list(root.glob('*/asset.json'))
    assert not list(root.glob('.stage-*'))


def test_association_failure_keeps_committed_original(tmp_path, monkeypatch):
    from data.assets import retention
    source = make_clip(tmp_path / 'in.mp4'); root = tmp_path / 'assets'
    def fail(*args): raise OSError('injected association failure')
    monkeypatch.setattr(retention, '_publish_association', fail)
    with pytest.raises(ValueError, match='original_retention_failed'):
        retain(source, root)
    originals = list(root.glob('*/original.*'))
    assert len(originals) == 1 and originals[0].read_bytes() == source.read_bytes()


@pytest.mark.parametrize('key,start', [('../escape', 0), ('a'*64, float('nan')), ('a'*64, -1)])
def test_invalid_association_input(tmp_path, key, start):
    source = make_clip(tmp_path / 'in.mp4')
    with pytest.raises(ValueError):
        retain(source, tmp_path / 'assets', key=key, start=start)
    assert not (tmp_path / 'assets').exists()


def test_parent_symlink_cannot_redirect_storage(tmp_path):
    source = make_clip(tmp_path / 'in.mp4')
    outside = tmp_path / 'outside'; outside.mkdir()
    redirect = tmp_path / 'redirect'; redirect.symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match='original_retention_failed'):
        retain(source, redirect / 'assets')
    assert not list(outside.iterdir())


def test_metadata_write_failure_no_ready_asset(tmp_path, monkeypatch):
    from data.assets import retention
    source = make_clip(tmp_path / 'in.mp4'); root = tmp_path / 'assets'
    def fail(*args): raise OSError('disk full')
    monkeypatch.setattr(retention, '_write', fail)
    with pytest.raises(ValueError, match='original_retention_failed'):
        retain(source, root)
    assert not list(root.glob('*/asset.json'))
    assert not list(root.glob('.stage-*'))


@pytest.mark.parametrize('during', ['open', 'decode'])
def test_pyav_io_failure_cannot_publish_asset(tmp_path, monkeypatch, during):
    from data.assets import timing
    import av
    source = make_clip(tmp_path / 'in.mp4'); root = tmp_path / 'assets'
    real_open = timing.av.open
    class BrokenDecode:
        def __init__(self, path): self.container = real_open(path)
        def __enter__(self): return self
        def __exit__(self, *args): self.container.close()
        @property
        def streams(self): return self.container.streams
        def decode(self, stream):
            yield next(self.container.decode(stream))
            av.error.err_check(-5)
    def broken_open(path):
        if during == 'open': av.error.err_check(-5)
        return BrokenDecode(path)
    monkeypatch.setattr(timing.av, 'open', broken_open)
    with pytest.raises(ValueError, match='original_retention_failed'):
        retain(source, root)
    assert not list(root.glob('*/asset.json'))
    assert not list(root.glob('.stage-*'))


def test_new_directory_entries_synced_before_success(tmp_path, monkeypatch):
    from data.assets import retention
    source = make_clip(tmp_path / 'in.mp4'); root = tmp_path / 'new' / 'assets'
    events = []
    real_sync = retention._fsync_directory
    def sync(path):
        real_sync(path)
        events.append(path)
    monkeypatch.setattr(retention, '_fsync_directory', sync)
    retain(source, root)
    # Losing any parent entry after a crash would make retained records disappear.
    assert tmp_path in events
    assert root.parent in events
    assert root / 'working-copies' in events
    assert events.index(tmp_path) < events.index(root.parent)
    assert events.index(root.parent) < events.index(root)
    assert events.index(root) < events.index(root / 'working-copies')
    assert events.index(root / 'working-copies') < events.index(root / 'working-copies' / ('a' * 64))
