"""Spatial-only encoding and an independent decoded timing/geometry gate."""
from fractions import Fraction
import math
from pathlib import Path
import struct

import av

from .proxy_contract import SourceAsset, fraction
from .retention import _hash
from .timing import inspect_source, rational


def time_base_for(source: SourceAsset) -> Fraction:
    denominator = 1
    origin = fraction(source.inspection['frames'][0]['pts'])
    for row in source.inspection['frames']:
        values = [fraction(row['pts'])-origin]
        if row['duration'] is not None:
            values.append(fraction(row['duration']))
        for value in values:
            denominator = math.lcm(denominator,value.denominator)
            if denominator > 2**31-1:
                raise ValueError('unrepresentable_time_base')
    base = Fraction(1,denominator)
    for row in source.inspection['frames']:
        if (fraction(row['pts'])-origin)/base > 2**63-1:
            raise ValueError('unrepresentable_timestamp')
    return base


def _check_display_data(frame) -> None:
    for side in frame.side_data:
        kind = side.type.name
        if kind == 'PANSCAN':
            raise ValueError('unsupported_display_crop')
        if kind == 'DISPLAYMATRIX':
            matrix = struct.unpack('=9i',bytes(side))
            a,b,u,c,d,v,x,y,w = matrix
            # Only pure quarter-turn display transforms, never reflection,
            # translation, scale, skew or perspective hidden behind rotation.
            if (u or v or x or y or w != 1<<30
                    or (a,b,c,d) not in ((65536,0,0,65536),(0,-65536,65536,0),
                                         (-65536,0,0,-65536),(0,65536,-65536,0))):
                raise ValueError('unsupported_display_transform')


def encode_proxy(source: SourceAsset, recipe: dict, output: Path) -> None:
    rows = source.inspection['frames']
    origin = fraction(rows[0]['pts'])
    base = time_base_for(source)
    ticks = [int((fraction(row['pts'])-origin)/base) for row in rows]
    duration_ticks = {tick: int(fraction(row['duration'])/base) if row['duration'] else None
                      for tick,row in zip(ticks,rows)}
    w,h = recipe['geometry']['proxy_raster']
    sar = fraction(recipe['geometry']['proxy_sar'])
    if max(sar.numerator,sar.denominator) > 65535:
        raise ValueError('unrepresentable_sample_aspect_ratio')
    # Rate is an encoder header hint only. Explicit per-frame PTS is the clock.
    span = fraction(rows[-1]['pts'])-origin
    rate = Fraction(len(rows)-1,1)/span if span else Fraction(1)
    with av.open(str(source.path)) as src, av.open(str(output),'w',format='mp4',
            options={'video_track_timescale':str(base.denominator)}) as dst:
        selected = src.streams[source.inspection['stream_index']]
        stream = dst.add_stream('libx264',rate=rate)
        stream.width,stream.height = w,h
        stream.pix_fmt = 'yuv420p'
        stream.time_base = stream.codec_context.time_base = base
        stream.codec_context.sample_aspect_ratio = sar
        stream.options = {'crf':'23','preset':'medium','threads':'1','bf':'0'}
        seen = set()
        def mux(packet):
            stamp = Fraction(packet.pts)*packet.time_base
            tick = stamp/base
            if tick.denominator != 1 or int(tick) not in duration_ticks or int(tick) in seen:
                raise ValueError('encoder_frame_correspondence_failed')
            tick = int(tick); seen.add(tick)
            duration = duration_ticks[tick]
            if duration is not None:
                packet_duration = duration*base/packet.time_base
                if packet_duration.denominator != 1:
                    raise ValueError('unrepresentable_packet_duration')
                packet.duration = int(packet_duration)
            dst.mux(packet)
        count = 0
        for i,frame in enumerate(src.decode(selected)):
            if i >= len(rows) or frame.pts is None or frame.time_base is None:
                raise ValueError('source_frame_mismatch')
            if Fraction(frame.pts)*frame.time_base != fraction(rows[i]['pts']):
                raise ValueError('source_pts_mismatch')
            if [frame.width,frame.height] != recipe['geometry']['source_raster']:
                raise ValueError('source_geometry_mismatch')
            _check_display_data(frame)
            resized = frame.reformat(width=w,height=h,format='yuv420p',interpolation='BICUBIC')
            resized.pts,resized.time_base = ticks[i],base
            for packet in stream.encode(resized):mux(packet)
            count += 1
        if count != len(rows):
            raise ValueError('source_frame_mismatch')
        for packet in stream.encode():mux(packet)
        if len(seen) != len(rows):
            raise ValueError('encoder_frame_correspondence_failed')


def validate_proxy(source: SourceAsset, recipe: dict, output: Path) -> dict:
    if _hash(source.path) != source.source_sha256:
        raise ValueError('original_hash_mismatch')
    expected = source.inspection
    # Independent source scan protects against using a stale or altered sidecar.
    if inspect_source(source.path,stream_index=expected['stream_index']) != expected:
        raise ValueError('source_inspection_mismatch')
    actual = inspect_source(output)
    if actual['timing_status'] != 'valid':
        raise ValueError('proxy_decode_failed')
    if actual['decoded_count'] != expected['decoded_count']:
        raise ValueError('proxy_frame_count_mismatch')
    geometry = recipe['geometry']
    if ([actual['coded_width'],actual['coded_height']] != geometry['proxy_raster']
            or actual['rotation_degrees'] != 0
            or fraction(actual['sample_aspect_ratio'] or {'num':1,'den':1}) != fraction(geometry['proxy_sar'])):
        raise ValueError('proxy_geometry_mismatch')
    origin = fraction(expected['frames'][0]['pts'])
    for source_row,proxy_row in zip(expected['frames'],actual['frames']):
        if fraction(proxy_row['pts'])+origin != fraction(source_row['pts']):
            raise ValueError('proxy_pts_mismatch')
        if source_row['duration'] is not None and (proxy_row['duration'] is None
                or fraction(proxy_row['duration']) != fraction(source_row['duration'])):
            raise ValueError('proxy_duration_mismatch')
    last = expected['frames'][-1]
    end = rational(fraction(last['pts'])+fraction(last['duration'])) if last['duration'] else None
    if _hash(source.path) != source.source_sha256:
        raise ValueError('original_hash_mismatch')
    return dict(frame_count=actual['decoded_count'], source_origin_offset=rational(origin),
                source_end=end, pts_equal=True, known_durations_equal=True, geometry_equal=True,
                source_hash_unchanged=True)
