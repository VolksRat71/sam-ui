# sam-ui (Apache-2.0). New file, not from SAM 2.
"""Peak memory and speed of a track job against clip length.

Makes synthetic clips (moving squares on noise, no footage) at 1280x720, 24 fps,
and tracks two objects through each with our Sam2Engine, one process per run,
so each peak is its own. With frames streamed and state pruned
(tracks/streaming.py) the peak should stay about flat as the clip grows;
`--upstream` runs the same job the old way (every frame decoded up front, every
output kept) for comparison.

    python tools/memory_bench.py --seconds 10 60 180 [--upstream 10 30] [--model tiny|large]
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
WEIGHTS = Path.home() / ".cache/rotoscoping-video-subjects/weights"
MODELS = {
    "tiny": ("sam2.1_hiera_tiny.pt", "configs/sam2.1/sam2.1_hiera_t.yaml"),
    "large": ("sam2.1_hiera_large.pt", "configs/sam2.1/sam2.1_hiera_l.yaml"),
}


def make_clip(
    path: Path, seconds: float, w: int = 1280, h: int = 720, fps: int = 24
) -> None:
    import av
    import numpy as np

    rng = np.random.default_rng(1)
    bg = rng.integers(80, 150, (h, w, 3), dtype=np.uint8)
    out = av.open(str(path), "w")
    st = out.add_stream(
        "libx264", rate=fps, options={"crf": "18", "preset": "veryfast"}
    )
    st.width, st.height, st.pix_fmt = w, h, "yuv420p"
    for i in range(int(seconds * fps)):
        img = bg.copy()
        x = 40 + (i * 4) % (w - 240)
        img[120:300, x : x + 180] = (220, 40, 40)
        img[420:600, w - 220 - x // 2 : w - 40 - x // 2] = (40, 200, 60)
        for pkt in st.encode(av.VideoFrame.from_ndarray(img, format="rgb24")):
            out.mux(pkt)
    for pkt in st.encode():
        out.mux(pkt)
    out.close()


def run_one(clip: str, model: str, upstream: bool) -> dict:
    sys.path.insert(0, str(REPO / "demo/backend/server"))
    import torch

    import tracks.engine as engine_mod
    from sam2.build_sam import build_sam2_video_predictor
    from tracks.engine import Sam2Engine
    from tracks.streaming import install_sam2_streaming, peak_rss_mb

    ckpt, cfg = MODELS[model]
    dev = (
        "mps"
        if torch.backends.mps.is_available()
        else ("cuda" if torch.cuda.is_available() else "cpu")
    )
    pred = build_sam2_video_predictor(cfg, str(WEIGHTS / ckpt), device=dev)
    if upstream:
        engine_mod.sam2_prune = lambda *a, **k: 0
    else:
        install_sam2_streaming()
    e = Sam2Engine(pred, model=model, offload_video_to_cpu=dev == "mps")
    seeds = {
        1: {0: {"points": [[(40 + 90) / 1280, 210 / 720]], "labels": [1]}},
        2: {0: {"points": [[(1280 - 130) / 1280, 510 / 720]], "labels": [1]}},
    }
    base = peak_rss_mb()
    t0 = time.perf_counter()
    n = sum(1 for _ in e.track(clip, seeds))
    dt = time.perf_counter() - t0
    return {
        "frames": n,
        "s_per_frame": round(dt / max(n, 1), 3),
        "seconds": round(dt, 1),
        "peak_rss_mb": round(peak_rss_mb() or 0),
        "rss_before_mb": round(base or 0),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, nargs="*", default=[10, 60, 180])
    ap.add_argument("--upstream", type=float, nargs="*", default=[])
    ap.add_argument("--model", choices=sorted(MODELS), default="tiny")
    ap.add_argument(
        "--out", default=str(Path(tempfile.gettempdir()) / "sam-ui-memory-bench")
    )
    ap.add_argument("--_child", nargs=3, help=argparse.SUPPRESS)
    a = ap.parse_args()
    if a._child:
        clip, model, mode = a._child
        print(json.dumps(run_one(clip, model, mode == "upstream")))
        return
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    rows = []
    for mode, lengths in (("streamed", a.seconds), ("upstream", a.upstream)):
        for s in lengths:
            clip = out / f"clip_{int(s)}s.mp4"
            if not clip.exists():
                make_clip(clip, s)
            env = {**os.environ, "PYTORCH_ENABLE_MPS_FALLBACK": "1"}
            r = subprocess.run(
                [sys.executable, __file__, "--_child", str(clip), a.model, mode],
                capture_output=True,
                text=True,
                env=env,
                cwd=REPO,
            )
            last = [l for l in r.stdout.splitlines() if l.startswith("{")]
            row = {
                "mode": mode,
                "clip_s": s,
                **(
                    json.loads(last[-1]) if last else {"error": (r.stderr or "")[-300:]}
                ),
            }
            rows.append(row)
            print(json.dumps(row), flush=True)
    (out / f"results_{a.model}.json").write_text(json.dumps(rows, indent=1))


if __name__ == "__main__":
    main()
