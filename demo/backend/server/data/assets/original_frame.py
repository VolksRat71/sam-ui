"""Bounded original-frame access, independent of inference/session bindings.

No working-copy fallback. Callers must still establish a frame-accurate binding
before using these pixels for corrections; retention alone does not do that.
"""
from collections import OrderedDict
from dataclasses import dataclass
import json
from pathlib import Path
import re
from threading import RLock

import av
import numpy as np

from .proxy_contract import fraction, load_source, safe_path
from .retention import _anchored, _read
from .timing import rational


@dataclass(frozen=True)
class OriginalFrame:
    index: int
    pts: dict
    geometry: dict
    pixels: np.ndarray


class OriginalFrameReader:
    def __init__(self, root: Path, *, max_cache_bytes: int = 64 * 1024 * 1024,
                 max_frames: int = 100_000):
        if type(max_cache_bytes) is not int or max_cache_bytes < 0:
            raise ValueError('invalid_cache_budget')
        if type(max_frames) is not int or max_frames < 1:
            raise ValueError('invalid_frame_budget')
        self.root = _anchored(root)
        self.max_cache_bytes = max_cache_bytes
        self.max_frames = max_frames
        self._cache = OrderedDict()
        self._lock = RLock()

    @property
    def cached_bytes(self):
        return sum(frame.pixels.nbytes for frame in self._cache.values())

    def _source(self, asset_id):
        if not isinstance(asset_id, str) or not re.fullmatch('[0-9a-f]{64}', asset_id):
            raise ValueError('invalid_asset_id')
        safe_path(self.root)
        # Retention directories are source hashes, not asset IDs. Never treat a
        # client identifier as a path or infer an association to a retimed copy.
        matches = []
        if self.root.is_dir():
            for directory in self.root.iterdir():
                if not re.fullmatch('[0-9a-f]{64}', directory.name):
                    continue
                safe_path(directory)
                manifest = directory / 'asset.json'
                safe_path(manifest)
                if json.loads(_read(manifest)).get('asset_id') == asset_id:
                    matches.append(directory)
        if len(matches) != 1:
            raise ValueError('original_unavailable')
        # Revalidation also protects cache hits against changed source/manifest
        # bytes. It is deliberately conservative until immutable bindings land.
        return load_source(matches[0], max_frames=self.max_frames)

    def read_original_frame(self, asset_id: str, frame_index: int,
                            frame_table_hash: str) -> OriginalFrame:
        if type(frame_index) is not int or frame_index < 0:
            raise ValueError('invalid_frame_index')
        with self._lock:
            source = self._source(asset_id)
            if frame_table_hash != source.frame_table_hash:
                raise ValueError('frame_table_mismatch')
            inspection = source.inspection
            if frame_index >= inspection['decoded_count']:
                raise ValueError('invalid_frame_index')
            # Unsupported display transforms are rejected, never approximated.
            sar = inspection['sample_aspect_ratio']
            if inspection['rotation_degrees'] != 0 or (sar and fraction(sar) != 1):
                raise ValueError('unsupported_source_geometry')
            key = (asset_id, frame_table_hash, frame_index, 'coded-rgb24-v1')
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._copy(self._cache[key])
            with av.open(str(source.path)) as container:
                stream = next(s for s in container.streams if s.index == inspection['stream_index'])
                for index, decoded in enumerate(container.decode(stream)):
                    if index != frame_index:
                        continue
                    expected = inspection['frames'][index]['pts']
                    if decoded.pts is None or decoded.time_base is None or rational(decoded.pts * decoded.time_base) != expected:
                        raise ValueError('frame_timestamp_mismatch')
                    if (decoded.width, decoded.height) != (inspection['coded_width'], inspection['coded_height']):
                        raise ValueError('frame_geometry_mismatch')
                    pixels = decoded.to_ndarray(format='rgb24')
                    pixels.setflags(write=False)
                    frame = OriginalFrame(index, dict(expected), dict(version='coded-rgb24-v1',
                        coded_width=decoded.width, coded_height=decoded.height,
                        pixel_format='rgb24', rotation_degrees=0, sample_aspect_ratio={'num': 1, 'den': 1}), pixels)
                    if pixels.nbytes <= self.max_cache_bytes:
                        while self._cache and self.cached_bytes + pixels.nbytes > self.max_cache_bytes:
                            self._cache.popitem(last=False)
                        self._cache[key] = frame
                    return self._copy(frame)
            raise ValueError('original_frame_missing')

    @staticmethod
    def _copy(frame):
        # A caller must not mutate a later reader's cached pixels or metadata.
        pixels = frame.pixels.copy()
        pixels.setflags(write=False)
        return OriginalFrame(frame.index, dict(frame.pts), json.loads(json.dumps(frame.geometry)), pixels)


def read_original_frame(asset_id: str, frame_index: int, frame_table_hash: str,
                        *, root: Path) -> OriginalFrame:
    """One-shot access; services may own a bounded OriginalFrameReader to reuse it."""
    return OriginalFrameReader(root).read_original_frame(asset_id, frame_index, frame_table_hash)
