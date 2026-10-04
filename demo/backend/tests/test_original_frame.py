"""Original pixels by presentation index; no models or working-copy substitution."""
from fractions import Fraction
import json

import pytest

from asset_media_fixtures import make_clip
from data.assets.retention import retain_upload


def asset(tmp_path, **kwargs):
    source = make_clip(tmp_path / 'source.mp4', **kwargs)
    root = tmp_path / 'assets'
    record = retain_upload(source, root=root, working_copy_sha256='a' * 64,
                           start_time_sec=0, duration_time_sec=300)
    directory = root / record['source_sha256']
    manifest = json.loads((directory / 'asset.json').read_text())
    return root, record, manifest


@pytest.mark.parametrize('pts', [list(range(8)), [20, 21, 24, 29, 30, 37, 40, 48]])
def test_reads_native_frame_id_and_exact_pts(tmp_path, pts):
    from data.assets.original_frame import OriginalFrameReader
    root, record, manifest = asset(tmp_path, pts=pts, time_base=Fraction(1, 30000), bframes=True)
    reader = OriginalFrameReader(root, max_cache_bytes=128 * 64 * 3 * 2)
    for index in [7, 0, 5, 2]:
        frame = reader.read_original_frame(record['asset_id'], index, manifest['frame_table_hash'])
        assert frame.index == index
        assert frame.pts == manifest['inspection']['frames'][index]['pts']
        assert frame.pixels.shape == (64, 128, 3)
        assert frame.geometry['coded_width'] == 128
        assert frame.geometry['coded_height'] == 64
        assert frame.geometry['pixel_format'] == 'rgb24'
        assert sum(1 << bit for bit in range(8) if frame.pixels[32, bit * 16 + 8, 0] > 128) == index
        assert not frame.pixels.flags.writeable
        assert reader.cached_bytes <= 128 * 64 * 3 * 2


def test_identity_bounds_and_mutation_rejected(tmp_path):
    from data.assets.original_frame import OriginalFrameReader
    root, record, manifest = asset(tmp_path)
    reader = OriginalFrameReader(root)
    key, table = record['asset_id'], manifest['frame_table_hash']
    for bad in ['../source.mp4', 'a' * 63, 'A' * 64]:
        with pytest.raises(ValueError, match='invalid_asset_id'):
            reader.read_original_frame(bad, 0, table)
    for index in [-1, 8, True, 1.5]:
        with pytest.raises(ValueError, match='invalid_frame_index'):
            reader.read_original_frame(key, index, table)
    with pytest.raises(ValueError, match='frame_table_mismatch'):
        reader.read_original_frame(key, 0, 'b' * 64)
    reader.read_original_frame(key, 0, table)
    (root / record['original_path']).write_bytes(b'changed source')
    with pytest.raises(ValueError, match='original_hash_mismatch'):
        reader.read_original_frame(key, 0, table)


def test_missing_and_symlink_asset_never_fall_back(tmp_path):
    from data.assets.original_frame import OriginalFrameReader
    root, record, manifest = asset(tmp_path)
    reader = OriginalFrameReader(root)
    with pytest.raises(ValueError, match='original_unavailable'):
        reader.read_original_frame('f' * 64, 0, manifest['frame_table_hash'])
    path = root / record['original_path']; source = tmp_path / 'source.mp4'
    path.unlink(); path.symlink_to(source)
    with pytest.raises(ValueError, match='symlink_asset_path'):
        reader.read_original_frame(record['asset_id'], 0, manifest['frame_table_hash'])


def test_budget_smaller_than_one_frame_does_not_cache(tmp_path):
    from data.assets.original_frame import OriginalFrameReader
    root, record, manifest = asset(tmp_path)
    reader = OriginalFrameReader(root, max_cache_bytes=1)
    reader.read_original_frame(record['asset_id'], 3, manifest['frame_table_hash'])
    assert reader.cached_bytes == 0
