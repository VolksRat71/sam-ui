"""Tiny deterministic frame-ID clips; no model or live media access."""
from fractions import Fraction
import json
import subprocess

import av
import numpy as np


def make_clip(path, *, pts=None, time_base=Fraction(1, 24), bframes=False):
    pts = list(range(8)) if pts is None else pts
    with av.open(str(path), 'w') as out:
        stream = out.add_stream('libx264', rate=24)
        stream.width, stream.height = 128, 64
        stream.pix_fmt = 'yuv420p'
        stream.time_base = time_base
        stream.codec_context.time_base = time_base
        stream.options = {'crf': '0' if not bframes else '10',
                          'bf': '2' if bframes else '0', 'g': '30'}
        for i, stamp in enumerate(pts):
            pixels = np.zeros((64, 128, 3), dtype=np.uint8)
            for bit in range(8):
                pixels[:, bit * 16:(bit + 1) * 16] = 235 if i & (1 << bit) else 16
            frame = av.VideoFrame.from_ndarray(pixels, format='rgb24')
            frame.pts, frame.time_base = stamp, time_base
            for packet in stream.encode(frame):
                out.mux(packet)
        for packet in stream.encode():
            out.mux(packet)
    return path


def probe(path):
    proc = subprocess.run(['ffprobe', '-v', 'error', '-show_frames', '-show_streams',
                           '-of', 'json', str(path)], capture_output=True,
                          text=True, check=True, timeout=30)
    return json.loads(proc.stdout)


def frame_ids(path):
    with av.open(str(path)) as container:
        return [sum((1 << bit) for bit in range(8)
                    if frame.to_ndarray(format='rgb24')[32, bit * 16 + 8, 0] > 128)
                for frame in container.decode(video=0)]
