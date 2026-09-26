# sam-ui (Apache-2.0). New file, not from SAM 2.
"""A small synthetic clip for the smoke test: three moving shapes on noise, no
footage. Different seeds give different pixels, so each run uploads a new video.

    <backend venv>/bin/python studio/e2e/make_clip.py out.mp4 [seed]

Shapes on frame 1 (normalised x, y): striped red disc (0.1875, 0.375), speckled
blue square (0.766, 0.729), green disc (0.781, 0.25).
"""
import sys

import av
import numpy as np

out_path = sys.argv[1]
seed = int(sys.argv[2]) if len(sys.argv) > 2 else 0
N, H, W = 24, 240, 320
rng = np.random.default_rng(seed)
bg = rng.integers(60, 120, (H, W, 3), dtype=np.uint8)
yy, xx = np.mgrid[0:H, 0:W]
out = av.open(out_path, 'w')
st = out.add_stream('libx264', rate=24, options={'crf': '16'})
st.width, st.height, st.pix_fmt = W, H, 'yuv420p'
for i in range(N):
    img = bg.copy()
    # textured, so an effect (Pixelate, say) is visible in a frame grab
    red = (xx - (60 + 6 * i)) ** 2 + (yy - 90) ** 2 < 30 ** 2
    img[red] = (230, 50, 40)
    img[red & ((yy // 3) % 2 == 0)] = (250, 200, 60)  # red disc, yellow stripes
    x0 = 220 - 4 * i
    square = (xx >= x0) & (xx < x0 + 50) & (yy >= 150) & (yy < 200)
    # blue square, speckled: texture a Pixelate shows, but still one object to SAM
    speckle = rng.integers(-70, 70, (H, W, 1))
    img[square] = np.clip(np.array([40, 70, 230]) + speckle[square], 0, 255).astype(np.uint8)
    img[(xx - 250) ** 2 + (yy - (60 + 3 * i)) ** 2 < 22 ** 2] = (40, 200, 80)  # green disc
    for pkt in st.encode(av.VideoFrame.from_ndarray(img, format='rgb24')):
        out.mux(pkt)
for pkt in st.encode():
    out.mux(pkt)
out.close()
print('wrote', out_path)
