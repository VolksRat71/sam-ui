"""Canonical, source-bound proxy recipes and coded-raster geometry."""
from dataclasses import dataclass
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import re

from .retention import _hash, _read
from .timing import canonical_json, inspect_source, rational, validate_rows


@dataclass(frozen=True)
class ProxyRecipe:
    max_width: int = 1280
    max_height: int = 720

    def __post_init__(self):
        if any(type(v) is not int or v < 2 for v in (self.max_width, self.max_height)):
            raise ValueError('invalid_proxy_bounds')


@dataclass(frozen=True)
class SourceAsset:
    path: Path
    asset_id: str
    source_sha256: str
    frame_table_hash: str
    inspection: dict


def fraction(value: dict) -> Fraction:
    if (not isinstance(value, dict) or type(value.get('num')) is not int
            or type(value.get('den')) is not int or value['den'] <= 0):
        raise ValueError('invalid_rational')
    return Fraction(value['num'], value['den'])


def safe_path(path: Path) -> None:
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('symlink_asset_path')


def load_source(asset_dir: Path, *, max_frames: int) -> SourceAsset:
    if type(max_frames) is not int or max_frames < 1:
        raise ValueError('invalid_frame_budget')
    safe_path(asset_dir)
    try:
        manifest = json.loads(_read(asset_dir / 'asset.json'))
        inspection = manifest['inspection']
        if manifest['schema_version'] != 1:
            raise ValueError('unsupported_asset_schema')
        if inspection['timing_status'] != 'valid' or not manifest['frame_table_hash']:
            raise ValueError('unsupported_source_timing')
        count = inspection['decoded_count']
        if type(count) is not int or count < 1 or count != len(inspection['frames']):
            raise ValueError('invalid_frame_count')
        if count > max_frames:
            raise ValueError('frame_budget_exceeded')
        index = inspection['stream_index']
        if type(index) is not int or index < 0:
            raise ValueError('invalid_stream_index')
        table = dict(schema_version=1, asset_id=manifest['asset_id'], stream_index=index,
                     frames=inspection['frames'])
        table_bytes = _read(asset_dir / f'frames.{index}.json')
        if (table_bytes != canonical_json(table)
                or hashlib.sha256(table_bytes).hexdigest() != manifest['frame_table_hash']):
            raise ValueError('frame_table_mismatch')
        validate_rows(inspection['frames'])
        name = manifest['original_name']
        if not isinstance(name, str) or not re.fullmatch(r'original\.[a-z0-9]+', name):
            raise ValueError('invalid_original_name')
        source_hash = manifest['source_sha256']
        if not isinstance(source_hash, str) or not re.fullmatch('[0-9a-f]{64}', source_hash):
            raise ValueError('invalid_source_hash')
        identity = hashlib.sha256(canonical_json(dict(source_sha256=source_hash, stream_index=index))).hexdigest()
        if identity != manifest['asset_id']:
            raise ValueError('asset_identity_mismatch')
        path = asset_dir / name
        safe_path(path)
        if _hash(path) != source_hash:
            raise ValueError('original_hash_mismatch')
        actual = inspect_source(path, stream_index=index)
        if actual != inspection:
            raise ValueError('source_inspection_mismatch')
        return SourceAsset(path, identity, source_hash, manifest['frame_table_hash'], inspection)
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise ValueError('invalid_asset_manifest') from exc


def geometry_for(width: int, height: int, rotation: float, sar: Fraction,
                 recipe: ProxyRecipe) -> dict:
    if (type(width) is not int or type(height) is not int or min(width,height) < 2
            or rotation not in (-270,-180,-90,0,90,180,270) or sar <= 0):
        raise ValueError('unsupported_source_geometry')
    scale = min(Fraction(1), Fraction(recipe.max_width,width), Fraction(recipe.max_height,height))
    w, h = int(width*scale)//2*2, int(height*scale)//2*2
    if min(w,h) < 2:
        raise ValueError('unsupported_proxy_geometry')
    sx, sy = Fraction(w,width), Fraction(h,height)
    # Display transform stays separate: inference sees coded pixels, not a baked rotation.
    return dict(version=1, source_raster=[width,height], proxy_raster=[w,h],
                source_rotation=int(rotation), source_sar=rational(sar),
                proxy_sar=rational(sar * sy / sx),
                scale_x=rational(sx), scale_y=rational(sy),
                offset_x=rational((sx-1)/2), offset_y=rational((sy-1)/2),
                inverse_scale_x=rational(1/sx), inverse_scale_y=rational(1/sy),
                inverse_offset_x=rational((1/sx-1)/2), inverse_offset_y=rational((1/sy-1)/2))


def effective_recipe(source: SourceAsset, recipe: ProxyRecipe) -> dict:
    info = source.inspection
    geometry = geometry_for(info['coded_width'], info['coded_height'], info['rotation_degrees'],
                            fraction(info['sample_aspect_ratio']) if info['sample_aspect_ratio'] else Fraction(1), recipe)
    return dict(version=1, geometry=geometry, resize='bicubic',
                timing='exact_pts_relative_to_source_origin_v1',
                encoder=dict(container='mp4', codec='libx264', crf=23, preset='medium',
                             threads=1, pixel_format='yuv420p', b_frames=0))


def proxy_id(source: SourceAsset, recipe: dict) -> str:
    return hashlib.sha256(canonical_json(dict(asset_id=source.asset_id,
                          frame_table_hash=source.frame_table_hash, recipe=recipe))).hexdigest()
