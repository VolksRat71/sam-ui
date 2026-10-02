# sam-ui (Apache-2.0). Synthetic proxy benchmark; never opens a running server.
"""Compare 720p/1080p/4K proxies on SAM 2.1 large, FP32, one object, 30 frames.

    python tools/proxy_resolution_bench.py --out /tmp/proxy-bench --prepare-only
    python tools/proxy_resolution_bench.py --out /tmp/proxy-bench

Every model subprocess acquires ~/Movies/sam2-poc-data/.gpu-lock before
importing torch, then exits before the parent releases its own lock. Existing
locks are never removed. SIGKILL can leave our lock behind for manual recovery.
Outputs are synthetic clips, per-run logs and JSON. Existing results are skipped
only when their configuration and clip digest match; use a new output directory
for a new full measurement. See proxy_resolution_bench.md for interpretation.
"""
import argparse
from contextlib import contextmanager
import hashlib
import inspect
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time

REPO = Path(__file__).resolve().parents[1]
FIXTURES = ('detail', 'motion', 'occlusion')
SIZES = {'720p': (1280, 720), '1080p': (1920, 1080), '4k': (3840, 2160)}
FRAMES, FPS = 30, 24
CONFIG = {'version': 1, 'frames': FRAMES, 'fps': FPS, 'model': 'sam2.1_hiera_large',
          'dtype': 'float32', 'cache_limit_bytes': 2**30, 'crf': 23,
          'decoder': 'main Sam2Frames/decord', 'source_size': [3840, 2160]}
LOCK = Path.home() / 'Movies/sam2-poc-data/.gpu-lock'
WEIGHTS = Path.home() / '.cache/rotoscoping-video-subjects/weights/sam2.1_hiera_large.pt'


@contextmanager
def gpu_lock(path=LOCK, timeout=None):
    """Atomic shared lock. No stale-lock guessing, and only remove our inode."""
    start = time.monotonic()
    next_notice = start
    while True:
        try:
            path.mkdir()
            break
        except FileExistsError:
            now = time.monotonic()
            if timeout is not None and now - start >= timeout:
                raise TimeoutError(f'GPU lock occupied: {path}')
            if now >= next_notice:
                print(f'Waiting for GPU lock: {path}', flush=True)
                next_notice = now + 30
            time.sleep(2)
    owned = path.stat()
    try:
        yield
    finally:
        try:
            current = path.stat()
            if (current.st_dev, current.st_ino) == (owned.st_dev, owned.st_ino):
                path.rmdir()
        except FileNotFoundError:
            pass


def scene(fixture, frame, width=3840, height=2160):
    """Native-source-coordinate subject, thin details, motion and visible occlusion."""
    import numpy as np
    y, x = np.ogrid[:height, :width]
    x, y = (x + .5) * 3840 / width, (y + .5) * 2160 / height
    cx = 900 + (0 if fixture == 'detail' else 24 * frame)
    body = ((x - cx) / 360)**2 + ((y - 1080) / 310)**2 <= 1
    # Thin connected projections test source detail surviving downsampling.
    fingers = (x >= cx) & (x < cx + 510) & (abs(y - 1080) < 220) & ((y.astype(int) % 80) < 8)
    truth = body | fingers
    rgb = np.empty((height, width, 3), dtype=np.uint8)
    tile = ((x // 96 + y // 96) % 2 * 8).astype(np.uint8)
    rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2] = 40 + tile, 62 + tile, 85 + tile
    stripe = np.broadcast_to(((x // 28) % 2 * 16).astype(np.uint8), truth.shape)
    rgb[truth] = np.column_stack((210 + stripe[truth], 75 + stripe[truth], 35 + stripe[truth]))
    if fixture == 'occlusion':
        occluder = np.broadcast_to((x >= 1400) & (x < 1540), truth.shape)
        rgb[occluder] = (95, 105, 120)
        truth &= ~occluder
    return rgb, truth


def mask_iou(mask, truth):
    import numpy as np
    from PIL import Image
    if mask.shape != truth.shape:
        mask = np.asarray(Image.fromarray(mask).resize(
            (truth.shape[1], truth.shape[0]), Image.Resampling.NEAREST), dtype=bool)
    union = np.count_nonzero(mask | truth)
    return float(np.count_nonzero(mask & truth) / union) if union else 1.0


def validate_frames(frames, expected):
    if sorted(frames) != list(range(expected)):
        raise ValueError(f'Expected each of {expected} frames exactly once, got {frames}')


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def fixture_identity():
    return {'config': CONFIG, 'fixtures': list(FIXTURES),
            'sizes': {k: list(v) for k, v in SIZES.items()},
            'scene_sha256': hashlib.sha256(inspect.getsource(scene).encode()).hexdigest(),
            'preparation_sha256': hashlib.sha256(inspect.getsource(prepare).encode()).hexdigest(),
            'transcoder_sha256': digest(REPO / 'demo/backend/server/data/transcoder.py')}


def record_measurement_identity(out, identity):
    path = out / 'measurement.json'
    if path.exists():
        if json.loads(path.read_text()) != identity:
            raise ValueError('Measurement identity changed; choose a new --out directory')
    else:
        path.write_text(json.dumps(identity, indent=2) + '\n')


def select_device(torch):
    return 'mps' if torch.backends.mps.is_available() else ('cuda' if torch.cuda.is_available() else 'cpu')


def environment_fingerprint():
    """Probe in a separate child under the lock; never load a model here."""
    from importlib.metadata import PackageNotFoundError, version
    import torch

    device = select_device(torch)
    packages = {}
    for name in ('torch', 'torchvision', 'numpy', 'Pillow', 'av', 'decord'):
        try:
            packages[name] = version(name)
        except PackageNotFoundError:
            packages[name] = None
    hardware = {'processor': platform.processor(), 'architecture': platform.machine()}
    if sys.platform == 'darwin':
        hardware['mac'] = subprocess.check_output(
            ['/usr/sbin/sysctl', '-n', 'machdep.cpu.brand_string', 'hw.memsize'], text=True).splitlines()
    if device == 'cuda':
        gpu = torch.cuda.get_device_properties(0)
        hardware['gpu'] = {'name': gpu.name, 'memory': gpu.total_memory,
                           'capability': [gpu.major, gpu.minor]}
    return {'device': device, 'hardware': hardware, 'packages': packages,
            'machine': hashlib.sha256(platform.node().encode()).hexdigest(),
            'platform': platform.platform(), 'python': platform.python_version(),
            'torch_threads': [torch.get_num_threads(), torch.get_num_interop_threads()],
            'ffmpeg': subprocess.check_output(['ffmpeg', '-version'], text=True).splitlines()[0]}


def prepare(out):
    import av
    sys.path.insert(0, str(REPO / 'demo/backend/server'))
    os.environ.setdefault('DATA_PATH', str(out / 'app-data'))
    from data.transcoder import get_video_metadata, normalize_video
    manifest = out / 'fixtures.json'
    identity = fixture_identity()
    if manifest.exists():
        saved = json.loads(manifest.read_text())
        if any(saved.get(k) != v for k, v in identity.items()):
            raise ValueError('Fixture identity changed; choose a new --out directory')
        for name, sha in saved['digests'].items():
            if digest(out / name) != sha:
                raise ValueError(f'Fixture changed: {name}; choose a new --out directory')
        return saved
    if any(out.glob('*.mp4')) or any(out.glob('*.mkv')):
        raise ValueError('Partial fixture set exists; use a fresh --out directory')
    digests = {}
    for fixture in FIXTURES:
        source = out / f'{fixture}-source.mkv'
        with av.open(str(source), 'w') as container:
            stream = container.add_stream('ffv1', rate=FPS)
            stream.width, stream.height, stream.pix_fmt = 3840, 2160, 'bgr0'
            for frame in range(FRAMES):
                rgb, _ = scene(fixture, frame)
                for packet in stream.encode(av.VideoFrame.from_ndarray(rgb, format='rgb24')):
                    container.mux(packet)
            for packet in stream.encode():
                container.mux(packet)
        digests[source.name] = digest(source)
        for label, (w, h) in SIZES.items():
            proxy = out / f'{fixture}-{label}.mp4'
            normalize_video(str(source), str(proxy), w, h, 0, FRAMES / FPS, None,
                            fps=FPS, crf=CONFIG['crf'])
            meta = get_video_metadata(str(proxy))
            if (meta.width, meta.height, meta.fps, meta.num_video_frames) != (w, h, FPS, FRAMES):
                raise ValueError(f'Invalid proxy: {proxy}: {meta}')
            digests[proxy.name] = digest(proxy)
        print(f'Prepared {fixture}: native 4K plus three proxies', flush=True)
    saved = {**identity, 'digests': digests}
    manifest.write_text(json.dumps(saved, indent=2) + '\n')
    return saved


def run_one(clip, fixture, weights):
    """Only called by a subprocess while the parent owns the shared GPU lock."""
    import av
    import numpy as np
    import torch
    sys.path.insert(0, str(REPO))
    sys.path.insert(0, str(REPO / 'demo/backend/server'))
    from sam2.build_sam import build_sam2_video_predictor
    from tracks.engine import Sam2Engine
    from tracks.features import FeatureCache, VIDEO_KEY, install
    from tracks.streaming import Sam2Frames, install_sam2_streaming, peak_rss_mb

    torch.manual_seed(1)
    np.random.seed(1)
    device = select_device(torch)

    def sync():
        if device == 'mps':
            torch.mps.synchronize()
        elif device == 'cuda':
            torch.cuda.synchronize()

    def memory():
        if device == 'mps':
            return {'allocated': torch.mps.current_allocated_memory(), 'driver': torch.mps.driver_allocated_memory()}
        if device == 'cuda':
            return {'allocated': torch.cuda.memory_allocated(), 'driver': torch.cuda.memory_reserved()}
        return {'allocated': 0, 'driver': 0}

    t = time.perf_counter()
    decoded = 0
    with av.open(str(clip)) as container:
        for frame in container.decode(video=0):
            rgb = frame.to_ndarray(format='rgb24')
            decoded += 1
    del rgb, frame
    raw_decode_s = time.perf_counter() - t
    if decoded != FRAMES:
        raise ValueError(f'Decoded {decoded} frames, expected {FRAMES}')
    t = time.perf_counter()
    frames = Sam2Frames(str(clip), 1024)
    for i in range(len(frames)):
        frames[i]
    decode_preprocess_s = time.perf_counter() - t
    del frames

    install_sam2_streaming()
    t = time.perf_counter()
    predictor = build_sam2_video_predictor('configs/sam2.1/sam2.1_hiera_l.yaml', str(weights), device=device)
    sync()
    load_s = time.perf_counter() - t
    cache = FeatureCache(CONFIG['cache_limit_bytes'])
    install(predictor, cache)
    engine = Sam2Engine(predictor, model='large', offload_video_to_cpu=True)
    seeds = {1: {0: {'points': [[900 / 3840, 1080 / 2160]], 'labels': [1]}}}
    rows, packed = [], {}
    with torch.inference_mode():
        t = time.perf_counter()
        handle = predictor.init_state(str(clip), offload_video_to_cpu=True)
        handle[VIDEO_KEY] = str(clip)
        sync()
        init_s = time.perf_counter() - t
        for pass_name in ('first', 'warm'):
            # Same fresh decoded-frame cache both times; only features stay warm.
            handle['images'] = Sam2Frames(str(clip), 1024)
            hits, misses = cache.hits, cache.misses
            iterator = iter(engine.track(str(clip), seeds, video_handle=handle))
            seen, elapsed, samples, fingerprints = [], 0.0, [memory()], {}
            while True:
                sync()
                t = time.perf_counter()
                try:
                    index, masks = next(iterator)
                except StopIteration:
                    sync()
                    elapsed += time.perf_counter() - t
                    break
                sync()
                elapsed += time.perf_counter() - t
                mask = masks[1]
                bits = np.packbits(mask)
                if pass_name == 'first':
                    packed[index] = (mask.shape, bits)
                fingerprints[index] = hashlib.sha256(bits).hexdigest()
                seen.append(index)
                samples.append(memory())
            validate_frames(seen, FRAMES)
            rows.append({'pass': pass_name, 'track_s': elapsed, 'frames': len(seen),
                         'cache_bytes': cache.nbytes, 'cache_frames': len(cache),
                         'positional_bytes': sum(t.nelement() * t.element_size() for ts in cache._pos.values() for t in ts),
                         'cache_hits': cache.hits - hits, 'cache_misses': cache.misses - misses,
                         'sampled_gpu_allocated_peak_bytes': max(s['allocated'] for s in samples),
                         'sampled_gpu_driver_peak_bytes': max(s['driver'] for s in samples),
                         'process_peak_rss_mib': peak_rss_mb(),
                         'mask_fingerprints': fingerprints})
    # Score after all timed work and memory samples, at native source dimensions.
    ious = []
    for i in range(FRAMES):
        shape, bits = packed[i]
        mask = np.unpackbits(bits, count=shape[0] * shape[1]).reshape(shape).astype(bool)
        _, truth = scene(fixture, i)
        ious.append(mask_iou(mask, truth))
    return {'device': device, 'torch': torch.__version__, 'python': platform.python_version(),
            'platform': platform.platform(), 'raw_pyav_rgb_decode_s': raw_decode_s,
            'sam2_decode_preprocess_s': decode_preprocess_s, 'model_load_s': load_s,
            'session_init_s': init_s, 'passes': rows, 'iou_per_frame': ious,
            'mean_iou': float(np.mean(ious)), 'min_iou': min(ious),
            'warm_masks_identical': rows[0]['mask_fingerprints'] == rows[1]['mask_fingerprints']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--weights', type=Path, default=WEIGHTS)
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--prepare-only', action='store_true')
    parser.add_argument('--_environment', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--_child', nargs=3, metavar=('CLIP', 'FIXTURE', 'RESULT'), help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args._child or args._environment:
        # Private child protocol: refuse a direct model call without a held lock.
        if os.environ.get('SAM_UI_BENCH_LOCK_OWNER') != str(os.getppid()) or not LOCK.is_dir():
            raise RuntimeError('Run the parent command, which owns the GPU lock')
        if args._environment:
            print(json.dumps(environment_fingerprint()))
            return
        clip, fixture, result = args._child
        row = run_one(Path(clip), fixture, args.weights)
        Path(result).write_text(json.dumps(row, indent=2) + '\n')
        return
    if args.repeats < 1:
        parser.error('--repeats must be positive')
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    manifest = prepare(out)
    if args.prepare_only:
        return
    if not args.weights.is_file():
        parser.error(f'Checkpoint missing: {args.weights}')
    checkpoint_sha = digest(args.weights)
    provenance = {
        'git_head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip(),
        'source_sha256': {name: digest(REPO / name) for name in (
            'tools/proxy_resolution_bench.py', 'demo/backend/server/data/transcoder.py',
            'demo/backend/server/tracks/engine.py', 'demo/backend/server/tracks/streaming.py',
            'demo/backend/server/tracks/features.py')},
    }
    env = {**os.environ, 'PYTORCH_ENABLE_MPS_FALLBACK': '1',
           'DATA_PATH': str(out / 'app-data'), 'SAM_UI_BENCH_LOCK_OWNER': str(os.getpid())}
    with gpu_lock():
        probe = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--out', str(out),
                                '--_environment'], env=env, cwd=REPO,
                               capture_output=True, text=True, check=True)
    measurement = {'config': CONFIG, 'checkpoint_sha256': checkpoint_sha,
                   'provenance': provenance, 'environment': json.loads(probe.stdout)}
    record_measurement_identity(out, measurement)
    rows = []
    # Rotate order between repetitions to reduce systematic thermal/order bias.
    labels = list(SIZES)
    for repeat in range(args.repeats):
        for fixture in FIXTURES:
            for label in labels[repeat % 3:] + labels[:repeat % 3]:
                clip = out / f'{fixture}-{label}.mp4'
                result = out / f'{fixture}-{label}-{repeat + 1}.json'
                identity = {**measurement, 'fixture': fixture, 'resolution': label,
                            'repeat': repeat + 1, 'clip_sha256': manifest['digests'][clip.name]}
                if result.exists():
                    row = json.loads(result.read_text())
                    if any(row.get(k) != v for k, v in identity.items()):
                        raise ValueError(f'Result identity mismatch: {result}')
                else:
                    temporary = result.with_suffix('.partial')
                    print(f'Running {fixture} {label}, repeat {repeat + 1}/{args.repeats}', flush=True)
                    with gpu_lock(), result.with_suffix('.log').open('w') as log:
                        subprocess.run([sys.executable, str(Path(__file__).resolve()), '--out', str(out),
                                        '--weights', str(args.weights.resolve()), '--_child', str(clip),
                                        fixture, str(temporary)], env=env, cwd=REPO,
                                       stdout=log, stderr=subprocess.STDOUT, check=True)
                    row = {**identity, **json.loads(temporary.read_text())}
                    result.write_text(json.dumps(row, indent=2) + '\n')
                    temporary.unlink()
                rows.append(row)
                (out / 'results.json').write_text(json.dumps(rows, indent=2) + '\n')
                print(f"Finished {fixture} {label}: first {row['passes'][0]['track_s']:.2f}s, "
                      f"warm {row['passes'][1]['track_s']:.2f}s, IoU {row['mean_iou']:.4f}", flush=True)


if __name__ == '__main__':
    main()
