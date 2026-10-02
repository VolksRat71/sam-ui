"""Exact source presentation timing, independent of inference and legacy FPS."""
from fractions import Fraction
import json
from pathlib import Path
from typing import TypedDict

import av


class Rational(TypedDict):
    num: int
    den: int


class FrameRow(TypedDict):
    index: int
    pts: Rational | None
    duration: Rational | None
    duration_source: str | None


class Inspection(TypedDict):
    stream_index: int | None
    coded_width: int | None
    coded_height: int | None
    rotation_degrees: float
    sample_aspect_ratio: Rational | None
    streams: list[dict]
    frames: list[FrameRow]
    timing_status: str
    diagnostic_code: str | None
    decoded_count: int


def rational(value: Fraction) -> Rational:
    value = Fraction(value)
    return {'num': value.numerator, 'den': value.denominator}


def canonical_json(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      allow_nan=False).encode('utf-8')


def validate_rows(rows: list[FrameRow]) -> None:
    previous = None
    for index, row in enumerate(rows):
        if row['index'] != index:
            raise ValueError('invalid_frame_index')
        stamp = row['pts']
        if stamp is None or stamp['den'] <= 0:
            raise ValueError('missing_or_invalid_pts')
        current = Fraction(stamp['num'], stamp['den'])
        if previous is not None and current <= previous:
            raise ValueError('non_increasing_pts')
        previous = current


def inspect_source(path: Path, *, stream_index: int | None = None) -> Inspection:
    result: Inspection = dict(stream_index=None, coded_width=None, coded_height=None,
        rotation_degrees=0.0, sample_aspect_ratio=None, streams=[], frames=[],
        timing_status='unsupported', diagnostic_code=None, decoded_count=0)
    try:
        with av.open(str(path)) as container:
            videos = [s for s in container.streams if s.type == 'video']
            selected = next((s for s in videos if stream_index is None or s.index == stream_index), None)
            if selected is None:
                raise ValueError('video_stream_not_found')
            result['stream_index'] = selected.index
            for stream in container.streams:
                result['streams'].append(dict(index=stream.index, type=stream.type,
                    codec=stream.codec_context.name if stream.codec_context else None,
                    time_base=rational(stream.time_base) if stream.time_base else None,
                    start_pts=stream.start_time, duration_pts=stream.duration))
            sar = selected.sample_aspect_ratio
            result['sample_aspect_ratio'] = rational(sar) if sar else None
            geometry = None
            for index, frame in enumerate(container.decode(selected)):
                result['decoded_count'] += 1
                current_geometry = (frame.width, frame.height, float(getattr(frame, 'rotation', 0) or 0))
                if geometry is None:
                    geometry = current_geometry
                    result['coded_width'], result['coded_height'], result['rotation_degrees'] = geometry
                elif geometry != current_geometry:
                    result['diagnostic_code'] = 'changing_geometry'
                base = frame.time_base
                pts = rational(Fraction(frame.pts) * base) if frame.pts is not None and base else None
                duration = getattr(frame, 'duration', None)
                known_duration = rational(Fraction(duration) * base) if duration and duration > 0 and base else None
                result['frames'].append(dict(index=index, pts=pts, duration=known_duration,
                    duration_source='decoded_frame' if known_duration else None))
            try:
                validate_rows(result['frames'])
            except ValueError as exc:
                result['diagnostic_code'] = str(exc)
            if not result['frames']:
                result['diagnostic_code'] = 'no_decoded_frames'
            if result['diagnostic_code'] is None:
                result['timing_status'] = 'valid'
    except av.FFmpegError:
        result['diagnostic_code'] = 'decode_failed'
    return result
