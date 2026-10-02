# Upload proxy resolution benchmark

This tool compares inference working copies. It does not change the default
720p cap, preserve originals, alter frame-rate policy, or implement audio export.
The original/audio design remains open pending Nate's export-scope and timing
decisions.

## Reproduce

From an isolated checkout based on main, using the sam-ui Python environment
and an existing SAM 2.1 large checkpoint:

```sh
python tools/proxy_resolution_bench.py --out /tmp/sam-ui-proxy-bench --prepare-only
python tools/proxy_resolution_bench.py --out /tmp/sam-ui-proxy-bench
```

`--weights PATH` selects the existing checkpoint; no weights are downloaded.
`--repeats` defaults to 3. The second command probes the runtime in one short
child (no model loaded), then starts 27 sequential fresh model processes.
Each model process runs a first and a warm track. The parent acquires
`~/Movies/sam2-poc-data/.gpu-lock` with `mkdir` before starting each child and
releases its own directory only after the child exits; the runtime probe uses
the same lock. An existing lock causes
waiting; the tool never removes another owner's lock. No ports or servers are
used. A force-killed parent may leave its lock behind for manual recovery after
confirming that its child has stopped.

Output contains synthetic clips, checksums, per-run logs/JSON, and cumulative
`results.json`. Keep it outside the repository. The fixture manifest checks
scene/preparation code, transcoder code, fixture names/sizes, configuration, and
clip checksums. `measurement.json` also records hardware/device, a hashed host
name, OS/Python, package versions, FFmpeg version, and Torch thread counts.
Completed runs are reused only when that environment, input, checkpoint,
configuration, code hashes, and git HEAD match. An incompatible manifest is
rejected before starting any model. Use a fresh output directory after changing
those inputs or moving to another machine.

Model-source hashes include SAM Python and YAML files, so uncommitted model or
configuration edits also invalidate a resumed measurement. A failed runtime
probe surfaces the child's diagnostic output before any model job starts.

## Method

Three deterministic, native 3840×2160 scenes provide visible binary ground truth:
a textured subject with thin projections, the same subject moving horizontally,
and that motion behind an occluder. Each is 30 frames at 24 fps, with one positive
point on one object at frame zero. A lossless FFV1 source produces 1280×720,
1920×1080, and 3840×2160 H.264 CRF 23 working copies through `normalize_video`.
Resolution order rotates between repetitions.

All runs use SAM 2.1 large, FP32, the main-branch streaming decoder and engine,
1024×1024 model input, and a 1 GiB feature-cache budget. Each repetition is a
fresh process. The second pass reuses image features but gets a fresh decoded
frame cache, isolating the feature-cache advantage. Full model loading and
interactive-session initialization are measured separately from tracking.

Recorded quantities:

- Raw decode: PyAV decode plus conversion to source-size RGB, all 30 frames.
  This is a separate diagnostic; it is not the application's decoder.
- Application decode/preprocess: `Sam2Frames` traversal, including Decord resize
  to 1024×1024 and FP32 normalization. Both decode measurements precede inference
  and can benefit from the filesystem cache.
- Track time: summed synchronized calls to the real engine iterator, including
  seed processing, propagation, CPU output masks, and final iterator cleanup.
  Packing masks, hashing, sampling memory, and scoring are outside this timer.
- Cache bytes: logical FP32 frame-feature bytes and separately positional bytes,
  because `FeatureCache.nbytes` excludes positional data. Hits/misses and retained
  frame count accompany every pass.
- Memory: process peak RSS through the end of each pass, including model loading
  and decode diagnostics; sampled MPS allocated/driver high-water marks at frame
  boundaries, **not** an exhaustive GPU peak. First-pass masks are retained in
  bit-packed form (about 3.3/7.4/29.7 MiB by resolution) for scoring afterward.
- Quality: visible-mask intersection-over-union, nearest-neighbor resized onto
  the native 4K source grid, scored after timings and memory samples. Every frame
  must appear exactly once; empty missed masks score zero against nonempty truth.
  Warm outputs are checked against first-pass fingerprints.

These clips isolate resolution effects but cannot establish quality on people,
hair, motion blur, difficult textures, or real compressed footage. They contain
one short-lived object and do not test cache eviction or long-clip memory.
Results on main's Decord path also need repeating after any decoder changes.

Runtime notes for the measured Mac: PyAV and Decord print duplicate AVFoundation
class warnings when loaded together. SAM 2 also reports that its optional CUDA
`_C` extension is unavailable and skips hole-filling postprocessing. The MPS
model runs still complete; comparisons use that same configuration at every
resolution. Results should not be treated as CUDA/postprocessed quality scores.
## Results — 2026-10-02

Apple M4 Max, 48 GiB unified memory, macOS 26.6.2 arm64, Python 3.11.1,
PyTorch 2.14.0, MPS. Backend base `471e607`, sizing fix `612c1cb`.
All 27 fresh-process runs completed (3 scenes × 3 sizes × 3 repetitions),
with 30 frames in each first and warm pass. The table reports medians across
the nine runs per resolution; timings are seconds per 30-frame clip.

| Working copy | Raw RGB decode | App decode/preprocess | First track | Warm track | Peak RSS, MiB |
|---|---:|---:|---:|---:|---:|
| 720p | 0.030 | 0.176 | 11.92 | 5.28 | 2211 |
| 1080p | 0.050 | 0.206 | 12.00 | 5.31 | 2216 |
| 4k | 0.144 | 0.304 | 11.96 | 5.43 | 2320 |

Track-time ranges across the nine runs (first / warm):

- 720p: 11.72–12.51 s / 5.16–5.61 s.
- 1080p: 11.66–12.48 s / 5.18–5.84 s.
- 4k: 11.73–12.59 s / 5.37–5.79 s.

Every run retained **480 MiB** of frame features plus **84 MiB** of positional
data: **564 MiB total**, regardless of proxy resolution. Each first pass had
30 cache misses; each warm pass had 30 hits and zero misses. All warm output
masks matched their first-pass fingerprints exactly.

Mean IoU over the 30 source-grid masks, averaged over three repetitions:

| Scene | 720p | 1080p | 4K | 4K minus 720p, percentage points |
|---|---:|---:|---:|---:|
| detail | 0.96967 | 0.97073 | 0.97124 | 0.157 |
| motion | 0.96961 | 0.97069 | 0.97135 | 0.174 |
| occlusion | 0.76912 | 0.76950 | 0.77022 | 0.110 |

**Keep the 720p default for now.** These fixtures show only a small quality
gain at 4K, increased decode cost, and slightly greater process memory. Feature
cache memory does **not** grow with proxy resolution because SAM encodes the
same 1024×1024 input shape. The difficult occlusion remains difficult at every
size. This supports configurable bounds without justifying a larger default;
real-footage quality validation is still needed before changing that default.

Raw results, synthetic inputs, logs and checksums are retained in Nate's
Downloads folder as `sam-ui-proxy-benchmark-2026-10-02`. `results.json` SHA-256:
`dd77cf7cf1979b91f3cc806a46631a01009fea8a8f1bf801ab8fc3f40ec35855`.
Each row records checkpoint/input hashes and the exact measured source hashes.

The archived dataset was measured with harness commit `7201f00`; its exact
script is included as `measured-harness.py`. Final review subsequently added
stricter fixture and runtime resume validation, without changing scenes,
inference, scoring, or timing. Use the current harness with a new output
directory; it deliberately rejects manifests from the earlier version.
