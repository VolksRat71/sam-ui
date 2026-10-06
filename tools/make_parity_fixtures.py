# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Reference masks for the browser engine's parity test (studio/e2e/parity.mjs).

Makes two synthetic clips (no footage) and tracks them with Meta's SAM 2.1
*tiny* checkpoint through our own Python engine (tracks.engine.Sam2Engine),
the model the browser engine runs as ONNX. Writes, into
studio/e2e/fixtures/parity/:
  squares.mp4  + squares.ref.json   three coloured squares moving across noise
  twotone.mp4  + twotone.ref.json   a red|orange bar: frame 0 clicks both halves,
                                    frame 10 corrects (cut orange, keep red)
Each ref.json: {clip, width, height, n_frames, model, seeds, frames}, where
seeds = {obj: {frame: {points (0-1), labels}}} and frames = {obj: {frame: RLE}}.

    python tools/make_parity_fixtures.py [--checkpoint ~/.cache/.../sam2.1_hiera_tiny.pt]
"""
import argparse
import json
import sys
from pathlib import Path

import av
import numpy as np

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "demo" / "backend" / "server"))
from tracks import rle  # noqa: E402
from tracks.engine import Sam2Engine  # noqa: E402

OUT = REPO / "studio" / "e2e" / "fixtures" / "parity"
W, H = 320, 240


def write_clip(path: Path, frames):
    out = av.open(str(path), "w")
    st = out.add_stream("libx264", rate=24, options={"crf": "12"})
    st.width, st.height, st.pix_fmt = W, H, "yuv420p"
    for img in frames:
        for pkt in st.encode(av.VideoFrame.from_ndarray(img, format="rgb24")):
            out.mux(pkt)
    for pkt in st.encode():
        out.mux(pkt)
    out.close()


def squares_clip(n=24, s=50):
    bg = np.random.default_rng(7).integers(
        90, 140, (H, W, 3), dtype=np.uint8
    )  # fixed: the fixture is committed
    spec = {
        0: (20, 10, 5, (220, 40, 40)),
        1: (95, 260, -5, (40, 60, 220)),
        2: (170, 10, 5, (40, 200, 60)),
    }
    frames = []
    for i in range(n):
        img = bg.copy()
        for y, x0, dx, color in spec.values():
            img[y : y + s, x0 + dx * i : x0 + dx * i + s] = color
        frames.append(img)
    seeds = {
        o: {0: {"points": [[(x0 + s / 2) / W, (y + s / 2) / H]], "labels": [1]}}
        for o, (y, x0, dx, _) in spec.items()
    }
    return frames, seeds


def twotone_clip(n=20):
    bg = np.random.default_rng(11).integers(90, 140, (H, W, 3), dtype=np.uint8)
    frames = []
    for i in range(n):
        img = bg.copy()
        x = 30 + 5 * i
        img[100:150, x : x + 50] = (220, 40, 40)
        img[100:150, x + 50 : x + 100] = (240, 170, 30)
        frames.append(img)
    x10 = 30 + 5 * 10
    seeds = {
        0: {
            0: {"points": [[55 / W, 125 / H], [105 / W, 125 / H]], "labels": [1, 1]},
            10: {
                "points": [[(x10 + 75) / W, 125 / H], [(x10 + 25) / W, 125 / H]],
                "labels": [0, 1],
            },
        }
    }
    return frames, seeds


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--checkpoint",
        default=str(
            Path.home()
            / ".cache/rotoscoping-video-subjects/weights/sam2.1_hiera_tiny.pt"
        ),
    )
    a = ap.parse_args()
    import torch
    from sam2.build_sam import build_sam2_video_predictor

    dev = (
        "mps"
        if torch.backends.mps.is_available()
        else ("cuda" if torch.cuda.is_available() else "cpu")
    )
    pred = build_sam2_video_predictor(
        "configs/sam2.1/sam2.1_hiera_t.yaml", a.checkpoint, device=dev
    )
    engine = Sam2Engine(
        pred, model="sam2.1_hiera_tiny", offload_video_to_cpu=dev == "mps"
    )
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (frames, seeds) in {
        "squares": squares_clip(),
        "twotone": twotone_clip(),
    }.items():
        clip = OUT / f"{name}.mp4"
        write_clip(clip, frames)
        masks = dict(engine.track(str(clip), seeds))
        ref = {
            "clip": clip.name,
            "width": W,
            "height": H,
            "n_frames": len(frames),
            "model": "sam2.1_hiera_tiny",
            "device": dev,
            "seeds": {
                str(o): {str(f): v for f, v in s.items()} for o, s in seeds.items()
            },
            "frames": {
                str(o): {str(f): rle.encode(masks[f][o]) for f in sorted(masks)}
                for o in seeds
            },
        }
        (OUT / f"{name}.ref.json").write_text(json.dumps(ref))
        areas = {
            o: [int(masks[f][o].sum()) for f in (0, len(frames) // 2, len(frames) - 1)]
            for o in seeds
        }
        print(f"{name}: {len(masks)} frames, mask areas (first/mid/last) {areas}")


if __name__ == "__main__":
    main()
