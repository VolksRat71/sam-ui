# sam-ui (Apache-2.0). New file, not from SAM 2.
"""What each engine costs on this machine, for the README's Hardware table
(issues #11 and #12): load time, peak memory and speed, one process per run
so each peak is its own.

Runs (--runs, any of):
  sam2        SAM 2.1 large tracking (tracks.engine.Sam2Engine), as the app runs it
  sam3        SAM 3 tracking (tracks.sam3_engine.Sam3Engine)
  sam3-text   SAM 3 text prompt (#22): first prompt (loads the detector), then warm
  app         the desktop app's worst case: SAM 2.1 large loaded and tracking, then
              SAM 3 loaded beside it, tracking and (on a gallery clip) a text prompt
  sam3-idle   what SAM 3 holds between uses (gallery clip): after a track job, after
              a text prompt, once the detector is unloaded, once the engine is

Clips (--clips, any of):
  synth:<seconds>   moving squares on noise, 1280x720, 24 fps (tools/memory_bench.py's)
  gallery:<name>    a gallery clip (demo/data/gallery/<name>.mp4) with fixed clicks below

Memory is measured three ways, all for the run's own process:
  - MPS driver memory, torch.mps.driver_allocated_memory(): what Metal holds
    for PyTorch, including the allocator's cached blocks; sampled every frame
    and every 0.2 s;
  - physical footprint, the kernel's own peak (proc_pid_rusage's
    ri_lifetime_max_phys_footprint), which is what macOS counts against RAM:
    it includes the GPU's buffers (unified memory) and compressed pages, unlike
    RSS;
  - vmmap --summary's "Physical footprint (peak)" at the end, as a check.
"Idle" is the footprint once the job is over and the engine is still loaded,
as the app sits between jobs.

Optimisations are switched by the same environment variables the app reads, so
the bench measures the app's code: --env SAM_UI_SAM3_DTYPE=bf16 and so on. It
measures the tree it sits in, so a copy in an older checkout gives a baseline
(SAM_UI_GALLERY says where the gallery clips are, when that tree has none).
--save-masks DIR keeps every frame's masks; --compare A B prints mask IoU
between two saved runs of the same clip and seeds.

    python tools/hardware_bench.py --runs sam2 sam3 --clips synth:10 gallery:05_default_juggle
    python tools/hardware_bench.py --runs sam3 --clips synth:10 --env SAM_UI_SAM3_DTYPE=bf16 --save-masks /tmp/b
    python tools/hardware_bench.py --compare /tmp/a /tmp/b
"""
import argparse
import ctypes
import gc
import json
import os
import platform
import re
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "tools"))
sys.path.insert(1, str(REPO))  # this tree's sam2, not the venv's editable install (a worktree, a baseline copy)
GALLERY = Path(os.environ.get("SAM_UI_GALLERY", REPO / "demo/data/gallery"))
if not GALLERY.is_dir():  # a worktree without the gallery: the main checkout's
    GALLERY = REPO.parents[2] / "demo/data/gallery"
WEIGHTS = Path.home() / ".cache/rotoscoping-video-subjects/weights"
SAM2_LARGE = ("sam2.1_hiera_large.pt", "configs/sam2.1/sam2.1_hiera_l.yaml")

# normalised (x, y) clicks on frame 0, one object each
SEEDS = {
    "synth": {1: (130 / 1280, 210 / 720), 2: ((1280 - 130) / 1280, 510 / 720)},
    "05_default_juggle": {
        1: (0.547, 0.32),
        2: (0.509, 0.444),
    },  # the player's shirt, the ball
    "01_dog": {1: (0.484, 0.611), 2: (0.242, 0.583)},  # the dog, the woman's jeans
    "02_cups": {1: (0.5, 0.5)},
}
GB = 2**30


# -- memory --------------------------------------------------------------------------------


class _RusageV4(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [
        (f"f{i}", ctypes.c_uint64) for i in range(40)
    ]


_PHYS_FOOTPRINT, _LIFETIME_MAX = (
    7,
    28,
)  # ri_phys_footprint, ri_lifetime_max_phys_footprint


def footprint() -> tuple:
    """(current, lifetime peak) physical footprint of this process, bytes, or
    (None, None) off macOS."""
    if sys.platform != "darwin":
        return None, None
    lib = ctypes.CDLL("/usr/lib/libproc.dylib")
    info = _RusageV4()
    if lib.proc_pid_rusage(os.getpid(), 4, ctypes.byref(info)) != 0:  # RUSAGE_INFO_V4
        return None, None
    return getattr(info, f"f{_PHYS_FOOTPRINT}"), getattr(info, f"f{_LIFETIME_MAX}")


def vmmap_peak() -> dict:
    """vmmap --summary's physical footprint and its peak, GB (a cross-check)."""
    if sys.platform != "darwin":
        return {}
    out = subprocess.run(
        ["vmmap", "--summary", str(os.getpid())], capture_output=True, text=True
    ).stdout
    got = {}
    for key, label in (
        ("vmmap_footprint_gb", "Physical footprint:"),
        ("vmmap_peak_gb", "Physical footprint (peak):"),
    ):
        m = re.search(re.escape(label) + r"\s+([\d.]+)([KMG])", out)
        if m:
            got[key] = round(
                float(m.group(1)) / {"K": 2**20, "M": 2**10, "G": 1}[m.group(2)], 2
            )
    return got


class Meter:
    """Peak MPS driver memory, sampled on demand and every 0.2 s."""

    def __init__(self):
        import torch

        self._mps = torch.backends.mps.is_available()
        self._torch = torch
        self.peak = 0
        self._stop = threading.Event()
        self._t = threading.Thread(target=self._loop, daemon=True)
        self._t.start()

    def mps(self) -> int:
        return self._torch.mps.driver_allocated_memory() if self._mps else 0

    def sample(self) -> int:
        v = self.mps()
        self.peak = max(self.peak, v)
        return v

    def _loop(self):
        while not self._stop.wait(0.2):
            self.sample()

    def stop(self):
        self._stop.set()
        self._t.join()


def _gb(v):
    return None if v is None else round(v / GB, 2)


# -- clips ---------------------------------------------------------------------------------


def clip_path(spec: str, out: Path) -> Path:
    kind, _, arg = spec.partition(":")
    if kind == "synth":
        from memory_bench import make_clip

        p = out / f"synth_{arg}s.mp4"
        if not p.exists():
            make_clip(p, float(arg))
        return p
    if kind == "gallery":
        return GALLERY / f"{arg}.mp4"
    raise SystemExit(f"unknown clip {spec!r}")


def clip_seeds(spec: str) -> dict:
    kind, _, arg = spec.partition(":")
    pts = SEEDS["synth" if kind == "synth" else arg]
    return {o: {0: {"points": [[x, y]], "labels": [1]}} for o, (x, y) in pts.items()}


# -- one run (child process) ---------------------------------------------------------------


def _device():
    import torch

    return (
        "mps"
        if torch.backends.mps.is_available()
        else ("cuda" if torch.cuda.is_available() else "cpu")
    )


def _sam2_engine(cache_gb: float):
    sys.path.insert(0, str(REPO / "demo/backend/server"))
    from sam2.build_sam import build_sam2_video_predictor

    from tracks.engine import Sam2Engine
    from tracks.features import FeatureCache, install as install_feature_cache
    from tracks.streaming import install_sam2_streaming

    ckpt = REPO / "checkpoints" / SAM2_LARGE[0]
    if not ckpt.exists():
        ckpt = WEIGHTS / SAM2_LARGE[0]
    dev = _device()
    pred = build_sam2_video_predictor(SAM2_LARGE[1], str(ckpt), device=dev)
    install_sam2_streaming()
    if cache_gb > 0:
        install_feature_cache(pred, FeatureCache(int(cache_gb * GB)))
    try:
        from tracks.precision import sam2_autocast
    except (
        ImportError
    ):  # a tree from before the switch (a baseline): fp32 on MPS, as it ran
        import contextlib

        def sam2_autocast(_):
            return contextlib.nullcontext()

    return Sam2Engine(
        pred,
        model="large",
        offload_video_to_cpu=dev == "mps",
        autocast=lambda: sam2_autocast(dev),
    )


def _sam2_session(e, path: Path, cache_gb: float):
    """A session-like SAM 2 state for the clip, as the app's interactive
    session holds, which jobs share (tracks.engine.job_state_like). Only such
    a state uses the feature cache, so without it --feature-cache-gb would
    measure nothing. None with the cache off: the job decodes on its own."""
    if cache_gb <= 0:
        return None
    from tracks.features import VIDEO_KEY

    state = e.predictor.init_state(
        str(path), offload_video_to_cpu=e.offload_video_to_cpu
    )
    state[VIDEO_KEY] = str(path)
    return state


def run_child(
    run: str, clip: str, out: Path, cache_gb: float, text: str, save: str
) -> dict:
    sys.path.insert(0, str(REPO / "demo/backend/server"))
    import numpy as np
    import torch

    path = clip_path(clip, out)
    meter = Meter()
    row = {"run": run, "clip": clip}
    masks = {}
    t0 = time.perf_counter()
    if run in ("sam2", "app"):
        e = _sam2_engine(cache_gb)
    else:
        from tracks.sam3_engine import Sam3Engine

        e = Sam3Engine()
        e._load()
    if torch.backends.mps.is_available():
        torch.mps.synchronize()
    row["load_s"] = round(time.perf_counter() - t0, 1)
    row["mps_after_load_gb"] = _gb(meter.sample())
    row["footprint_after_load_gb"] = _gb(footprint()[0])

    if run == "sam3-idle":

        def settled():
            time.sleep(2)
            return _gb(footprint()[0]), _gb(meter.mps())

        seeds = clip_seeds(clip)
        n = sum(
            1 for _ in e.track(str(path), seeds, windows={o: [(0, 47)] for o in seeds})
        )  # 48 frames
        row["frames"] = n
        row["after_job_gb"], row["after_job_mps_gb"] = settled()
        e.segment_text(str(path), 0, text)
        row["after_prompt_gb"], row["after_prompt_mps_gb"] = settled()
        e.detector_idle_s = 0.0
        row["dropped"] = e.release_idle(now=time.monotonic() + 1)
        row["detector_unloaded_gb"], row["detector_unloaded_mps_gb"] = settled()
        e.unload()
        row["engine_unloaded_gb"], row["engine_unloaded_mps_gb"] = settled()
    elif run == "sam3-text":
        t0 = time.perf_counter()
        first = e.segment_text(str(path), 0, text)
        row["first_prompt_s"] = round(time.perf_counter() - t0, 1)
        meter.sample()
        t0 = time.perf_counter()
        warm = e.segment_text(str(path), 0, text)
        row["warm_prompt_s"] = round(time.perf_counter() - t0, 2)
        meter.sample()
        row.update(score=round(warm.score, 3), instances=warm.instances, frames=1)
        if warm.mask is not None:
            masks[(0, 1)] = warm.mask
        assert (first.mask is None) == (warm.mask is None)
    elif run == "app":
        from tracks.sam3_engine import Sam3Engine

        seeds = clip_seeds(clip)
        n2 = sum(
            1
            for _ in e.track(
                str(path), seeds, video_handle=_sam2_session(e, path, cache_gb)
            )
        )
        row["footprint_sam2_done_gb"] = _gb(footprint()[1])
        s3 = Sam3Engine()
        n3, t0 = 0, time.perf_counter()
        for _ in s3.track(str(path), seeds):
            n3 += 1
            meter.sample()
        row.update(
            frames=n3,
            s_per_frame=round((time.perf_counter() - t0) / max(n3, 1), 3),
            sam2_frames=n2,
        )
        if clip.startswith("gallery:"):
            t0 = time.perf_counter()
            hit = s3.segment_text(str(path), 0, text)
            row.update(
                first_prompt_s=round(time.perf_counter() - t0, 1),
                score=round(hit.score, 3),
            )
            meter.sample()
    else:
        seeds = clip_seeds(clip)
        handle = _sam2_session(e, path, cache_gb) if run == "sam2" else None
        n, t0 = 0, time.perf_counter()
        for f, m in e.track(str(path), seeds, video_handle=handle):
            n += 1
            meter.sample()
            if save:
                for o, mk in m.items():
                    masks[(f, o)] = mk
        dt = time.perf_counter() - t0
        row.update(frames=n, s_per_frame=round(dt / max(n, 1), 3), track_s=round(dt, 1))
    if torch.backends.mps.is_available():
        torch.mps.synchronize()
    meter.stop()
    cache = getattr(getattr(e, "predictor", None), "_sam_ui_feature_cache", None)
    if cache is not None:
        row["feature_cache_held_gb"] = _gb(cache.nbytes)
    row["mps_peak_gb"] = _gb(max(meter.peak, meter.sample()))
    row["footprint_peak_gb"] = _gb(footprint()[1])
    row["mps_end_gb"] = _gb(meter.mps())
    gc.collect()
    if torch.backends.mps.is_available():
        torch.mps.empty_cache()
    time.sleep(2)  # the kernel takes a moment to count released pages out
    row["mps_idle_gb"] = _gb(meter.mps())
    row["footprint_idle_gb"] = _gb(footprint()[0])
    row.update(vmmap_peak())
    row["env"] = {
        k: v
        for k, v in os.environ.items()
        if k.startswith("SAM_UI_") and k != "SAM_UI_GALLERY"
    }
    if cache_gb > 0:
        row["env"]["feature_cache_gb"] = cache_gb
    if save:
        d = Path(save) / f"{run}_{clip.replace(':', '_')}"
        d.mkdir(parents=True, exist_ok=True)
        keys = sorted(masks)
        np.savez_compressed(
            d / "masks.npz",
            keys=np.array(keys, dtype=np.int64).reshape(-1, 2),
            masks=(
                np.packbits(np.stack([masks[k] for k in keys]), axis=-1)
                if keys
                else np.zeros(0)
            ),
            shape=np.array(next(iter(masks.values())).shape if keys else (0, 0)),
        )
        (d / "row.json").write_text(json.dumps(row, indent=1))
    return row


# -- comparing two saved runs --------------------------------------------------------------


def _load_masks(d: Path) -> dict:
    import numpy as np

    z = np.load(d / "masks.npz")
    h, w = (int(v) for v in z["shape"])
    if not len(z["keys"]):
        return {}
    m = np.unpackbits(z["masks"], axis=-1)[..., :w].astype(bool)
    return {tuple(int(v) for v in k): m[i] for i, k in enumerate(z["keys"])}


def compare(a: Path, b: Path) -> None:
    """Per-run IoU of b's masks against a's (frame, object by frame, object)."""
    print(
        "| run | frames | objects | IoU min | IoU mean | masks < 0.9 | masks < 0.98 | masks < 0.995 |"
    )
    print("|---|---|---|---|---|---|---|---|")
    for da in sorted(p for p in a.iterdir() if (p / "masks.npz").exists()):
        db = b / da.name
        if not (db / "masks.npz").exists():
            continue
        ma, mb = _load_masks(da), _load_masks(db)
        ious = []
        for k in sorted(set(ma) & set(mb)):
            x, y = ma[k], mb[k]
            u = (x | y).sum()
            ious.append(1.0 if u == 0 else float((x & y).sum() / u))
        if not ious:
            continue
        print(
            f"| {da.name} | {len({k[0] for k in ma})} | {len({k[1] for k in ma})} | {min(ious):.4f} | "
            f"{sum(ious) / len(ious):.4f} | {sum(i < 0.9 for i in ious)} | {sum(i < 0.98 for i in ious)} | {sum(i < 0.995 for i in ious)} |"
        )


# -- the table -----------------------------------------------------------------------------


def machine() -> str:
    try:
        cpu = subprocess.run(
            ["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True
        ).stdout.strip()
        ram = (
            int(
                subprocess.run(
                    ["sysctl", "-n", "hw.memsize"], capture_output=True, text=True
                ).stdout
            )
            / GB
        )
        return f"{cpu}, {ram:.0f} GB, macOS {platform.mac_ver()[0]}"
    except (OSError, ValueError):
        return platform.platform()


def table(rows) -> str:
    cols = [
        ("run", "run"),
        ("clip", "clip"),
        ("frames", "frames"),
        ("load_s", "load s"),
        ("s_per_frame", "s/frame"),
        ("first_prompt_s", "1st prompt s"),
        ("warm_prompt_s", "warm prompt s"),
        ("mps_peak_gb", "MPS peak GB"),
        ("footprint_after_load_gb", "footprint loaded GB"),
        ("footprint_peak_gb", "footprint peak GB"),
        ("footprint_idle_gb", "footprint idle GB"),
        ("vmmap_peak_gb", "vmmap peak GB"),
        ("env", "config"),
    ]
    lines = ["| " + " | ".join(c[1] for c in cols) + " |", "|" + "---|" * len(cols)]
    for r in rows:
        if "error" in r:
            lines.append(f"| {r['run']} | {r['clip']} | error: {r['error'][-120:]!r} |")
            continue
        vals = []
        for k, _ in cols:
            v = r.get(k, "")
            if k == "env":
                v = " ".join(f"{kk}={vv}" for kk, vv in sorted(v.items())) or "defaults"
            vals.append("" if v is None else str(v))
        lines.append("| " + " | ".join(vals) + " |")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument(
        "--runs",
        nargs="*",
        default=["sam2", "sam3", "sam3-text"],
        choices=["sam2", "sam3", "sam3-text", "app", "sam3-idle"],
    )
    ap.add_argument("--clips", nargs="*", default=["synth:10"])
    ap.add_argument(
        "--text",
        default="dog",
        help="the phrase for sam3-text (on frame 0 of each clip)",
    )
    ap.add_argument(
        "--feature-cache-gb",
        type=float,
        default=0.0,
        help="SAM 2's backbone-feature cache (the app defaults to a quarter of RAM, up to 6)",
    )
    ap.add_argument(
        "--env",
        nargs="*",
        default=[],
        help="KEY=VALUE set for every run (the app's switches)",
    )
    ap.add_argument(
        "--save-masks", default="", help="keep every run's masks under this folder"
    )
    ap.add_argument(
        "--compare",
        nargs=2,
        metavar=("A", "B"),
        help="IoU between two --save-masks folders",
    )
    ap.add_argument(
        "--out", default=str(Path(tempfile.gettempdir()) / "sam-ui-hardware-bench")
    )
    ap.add_argument("--_child", nargs=2, help=argparse.SUPPRESS)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    if a.compare:
        compare(Path(a.compare[0]), Path(a.compare[1]))
        return
    if a._child:
        print(
            json.dumps(
                run_child(
                    a._child[0],
                    a._child[1],
                    out,
                    a.feature_cache_gb,
                    a.text,
                    a.save_masks,
                )
            )
        )
        return
    env = {
        **os.environ,
        "PYTORCH_ENABLE_MPS_FALLBACK": "1",
        **dict(kv.split("=", 1) for kv in a.env),
    }
    rows = []
    print(f"machine: {machine()}", flush=True)
    for clip in a.clips:
        clip_path(clip, out)  # made once, before any run is timed
        for run in a.runs:
            if run in ("sam3-text", "sam3-idle") and not clip.startswith("gallery:"):
                continue  # a phrase needs something to name
            cmd = [
                sys.executable,
                __file__,
                "--_child",
                run,
                clip,
                "--out",
                str(out),
                "--text",
                a.text,
                "--feature-cache-gb",
                str(a.feature_cache_gb),
                "--save-masks",
                a.save_masks,
            ]
            r = subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=REPO)
            last = [l for l in r.stdout.splitlines() if l.startswith("{")]
            row = (
                json.loads(last[-1])
                if last
                else {"run": run, "clip": clip, "error": (r.stderr or "")[-400:]}
            )
            rows.append(row)
            print(json.dumps(row), flush=True)
    print("\n" + table(rows))


if __name__ == "__main__":
    main()
