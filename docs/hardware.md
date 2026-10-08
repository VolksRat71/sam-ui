<!-- sam-ui (Apache-2.0). New file, not from SAM 2. -->
# Hardware

Memory does not grow with clip length: frames are decoded as tracking and playback
reach them, and tracking state keeps only what the model reads again. So what sets
the hardware floor is the model, not the clip. Figures are marked **measured** or
**estimated**. The minimums are estimates: they add the measured peak footprint
below to what macOS and the app's window need. They have not been tried on a Mac
with that much memory.

| | Minimum | Recommended | Notes |
|---|---|---|---|
| **App, SAM 2.1 large** (default) | 8 GB, with the feature cache off (`SAM_UI_FEATURE_CACHE_GB=0`); **estimated** from a **measured** 4.1 GB peak footprint | 16 GB | 0.68 to 0.72 s a frame on an M4 Max, 1.3 s on an M1 Pro (**measured**): a 5-minute clip at 24 fps (7,200 frames) takes about 1.4 hours per pass on the M4 Max, 2.5 on the M1 Pro. |
| **App, SAM 3** (optional) | 12 GB, **estimated** from a **measured** 6.1 GB peak for the app's worst case at fp16, SAM 3's default on Apple Silicon; 16 GB at full precision (`SAM_UI_SAM3_DTYPE=fp32`, 6.9 GB peak), **measured** working on an M1 Pro, 16 GB | 16 GB or more | 1.32 to 1.48 s a frame at full precision, 0.80 to 0.84 at fp16 (M4 Max, **measured**). fp16 moves masks a little (below). |
| **Browser demo, SAM 2.1 tiny** | 8 GB; **measured** 2.7 to 3.6 GB for a 2-minute track | 16 GB | Chrome or Edge with WebGPU. About 46 ms a frame at 512 px, 252 ms at 1024, one object (**measured**). |

The app needs an Apple Silicon Mac (M1 or later) on macOS 14 or newer. Measured on a
3-minute 720p clip (4,320 frames, SAM 2.1 tiny, two objects): the backend's memory
stays at 3.0 to 3.3 GB from start to end, where the code this began from needed 7.8 GB
for 10 seconds and 17 GB for 30. `tools/memory_bench.py` reproduces the comparison.

<details>
<summary>Benchmarks, half precision and what is not measured</summary>

**Measured** with `tools/hardware_bench.py` on an Apple M4 Max with 48 GB, macOS
26.6.2. Two objects clicked on frame 0. The clips are 1280x720: a 10 s or 60 s
synthetic one at 24 fps, and the gallery's dog and juggling clips (289 and 247
frames). The footprint is the backend process's peak physical footprint, the figure
macOS counts against memory, which includes the GPU's buffers (RSS does not). Each
row is its own process.

| Run | Load | Speed | MPS peak | Footprint peak |
|---|---|---|---|---|
| SAM 2.1 large, 10 s, 60 s and gallery clips | 0.9 s | 0.68 to 0.72 s/frame | 2.8 GB | 4.1 GB, the same at 10 s and 60 s |
| SAM 2.1 large, feature cache 3 GB (the default on a 12 GB Mac) | 0.9 s | 0.72 s/frame | 3.8 GB | 5.1 GB |
| SAM 3 at fp32 (`SAM_UI_SAM3_DTYPE=fp32`), 10 s and gallery clips | 3.2 to 4.3 s | 1.32 to 1.48 s/frame | 4.2 GB | 5.3 to 5.5 GB |
| SAM 3 at fp32, 60 s clip (1,440 frames) | 3.4 s | 1.37 s/frame | 4.2 GB | 5.1 GB: flat, no higher than at 10 s |
| SAM 3 at fp16 (the default on MPS), gallery and 10 s clips | 2.4 to 3.0 s | 0.80 to 0.84 s/frame | 2.0 to 3.0 GB | 3.4 to 4.7 GB, varying run to run with how far the allocator grows |
| SAM 3 at bf16, gallery and 10 s clips | 2.7 to 2.8 s | 0.79 to 0.80 s/frame | 3.0 GB | 4.2 to 4.3 GB |
| SAM 3 text prompt, "dog", fp32 (fp16 in brackets) | 2.7 s (1.5) first, which loads the detector; 0.72 s (0.64) after | | 4.2 GB (3.0) | 4.9 GB (4.5) |
| App worst case: SAM 2.1 large (3 GB cache) tracks, then SAM 3 tracks and a text prompt, one process, fp32 (fp16 in brackets) | | 1.36 s/frame (0.80) for SAM 3 | 5.8 GB (3.8) | 6.9 GB (6.1) |

What SAM 3 keeps while idle, at full precision (fp16 in brackets; earlier runs): 2.5 GB (1.5) after
a job, 4.8 GB (2.8) with the text detector loaded, and under 1 GB once both are
unloaded. The detector is unloaded after 5 idle minutes and the whole engine after 10
(`SAM_UI_SAM3_DETECTOR_IDLE_S`, `SAM_UI_SAM3_IDLE_S`, in seconds, or `never`). The
next use loads them again in a few seconds. Neither setting changes a mask.

**SAM 3 runs at fp16 on Apple Silicon by default; SAM 2 stays at fp32.** IoU of
every frame's mask against fp32, per object, on the same clips and clicks
(`--save-masks`, then `--compare`). fp32 on MPS is deterministic: a second fp32 run
matched the first to the pixel (IoU 1.0000 on every mask), so the differences below
are precision, not noise.

| Setting | Clip | Mean IoU | Lowest IoU | Masks under 0.9 | Footprint peak | Speed |
|---|---|---|---|---|---|---|
| SAM 3 fp16 (default on MPS) | dog, 289 frames | 0.9954 | 0.964 | 0 of 578 | 3.7 to 4.7 GB, from 5.5 | 0.84 s/frame, from 1.32 |
| | juggling, 247 frames | 0.9976 | 0.960, the ball (0.7% of the frame) | 0 of 494 | 4.5 to 4.7 GB, from 5.4 | 0.80 s/frame, from 1.34 |
| | synthetic, 240 frames | 0.9991 | 0.985 | 0 of 480 | 3.4 to 4.2 GB, from 5.3 | 0.84 s/frame, from 1.48 |
| SAM 3 bf16 | dog | 0.9916 | 0.921 | 0 | 4.3 GB | 0.79 s/frame |
| | juggling | 0.9908 | 0.954, the ball | 0 | 4.2 GB | 0.80 s/frame |
| | synthetic | 0.9970 | 0.984 | 0 | 4.2 GB | 0.80 s/frame |
| SAM 2.1 large, `SAM_UI_SAM2_DTYPE=fp16` (autocast) | dog | 0.9985 | 0.919 | 0 | 3.9 GB, no saving | 0.36 s/frame, from 0.62 |
| | juggling | 0.9994 | 0.988 | 0 | 3.9 GB | 0.36 s/frame |
| | synthetic | 0.9990 | 0.989 | 0 | 3.9 GB | 0.36 s/frame |
| SAM 2.1 large, `SAM_UI_SAM2_DTYPE=bf16` (autocast) | dog | 0.9909 | 0.000, the dog lost on one frame | 1 | 3.9 GB | 0.36 s/frame |
| | juggling | 0.9935 | 0.974 | 0 | 3.9 GB | 0.36 s/frame |
| | synthetic | 0.9979 | 0.985 | 0 | 3.9 GB | 0.36 s/frame |

fp16 is deterministic too: a second fp16 run matched the first to the pixel, and only
its peak footprint moved (the ranges above). An earlier run of 0.3.0's code saw the
ball fall to 0.80 at fp16; this run, on the same clip and clicks, did not reproduce it.
A text prompt's mask ("dog" on frame 0 of the dog clip) at fp16 keeps an IoU of 0.9994
against full precision, with the same score (0.966). With fp16 as the default, the
whole slow suite (`SAM_UI_SLOW=1 pytest -m slow`) passes. The slow test
`test_real_sam3_half_precision_track_stays_close_to_fp32` (`SAM_UI_SLOW=1`) fails if
fp16 or bf16 drops below a mean IoU of 0.98 or any mask below 0.9 on 48 frames of the
dog clip.

For full precision, set `SAM_UI_SAM3_DTYPE=fp32`. The desktop app passes its
environment to the backend, so `launchctl setenv SAM_UI_SAM3_DTYPE fp32` before
starting it does that there. CUDA keeps fp32 for SAM 3 until it is measured.

**Not measured:**
- Macs with 8, 12 or 16 GB, so the minimums above stay estimates. There is no such Mac
  here; the M1 Pro, 16 GB figures come from earlier runs.
- The idle figures above at fp16 were not measured again with fp16 as the default.
- SAM 2.1 large on a 3-minute clip, and on 5 minutes on the M1 Pro. Footprint was flat
  from 10 s to 60 s, as it was for SAM 2.1 tiny on 3 minutes.
- Intel Macs, which the app does not support ([#7](https://github.com/VolksRat71/sam-ui/issues/7)).
- Windows, Linux and CUDA GPUs ([#6](https://github.com/VolksRat71/sam-ui/issues/6)):
  there is no build for them yet and no such machine here.

```sh
python tools/hardware_bench.py --runs sam2 sam3 sam3-text --clips synth:10 gallery:01_dog
python tools/hardware_bench.py --runs app --clips gallery:01_dog --feature-cache-gb 3 [--env SAM_UI_SAM3_DTYPE=fp32]
python tools/hardware_bench.py --runs sam3-idle --clips gallery:01_dog
python tools/hardware_bench.py --runs sam3 --clips gallery:05_default_juggle --env SAM_UI_SAM3_DTYPE=fp32 --save-masks /tmp/a
python tools/hardware_bench.py --runs sam3 --clips gallery:05_default_juggle --env SAM_UI_SAM3_DTYPE=fp16 --save-masks /tmp/b
python tools/hardware_bench.py --compare /tmp/a /tmp/b
```

</details>

## Platform support

| | Status |
|---|---|
| **Desktop app**, macOS 14+ on Apple Silicon | Released ([v0.3.0](https://github.com/VolksRat71/sam-ui/releases/latest)) |
| Desktop app, Intel Mac | Not supported ([#7](https://github.com/VolksRat71/sam-ui/issues/7)) |
| Desktop app, Windows or Linux | Not yet ([#6](https://github.com/VolksRat71/sam-ui/issues/6)) |
| **After Effects round trip** | Desktop app on macOS, with AE MCP Vision v2.2.0 |
| **Browser demo**, Chrome on macOS | Tested |
| Browser demo, Chrome or Edge on Windows | Untested ([#2](https://github.com/VolksRat71/sam-ui/issues/2)) |
| Browser demo, Safari 26 | Untested ([#3](https://github.com/VolksRat71/sam-ui/issues/3)) |
| Browser demo, Firefox | WebGPU only on some versions; untested ([#4](https://github.com/VolksRat71/sam-ui/issues/4)) |
| Browser demo, Android Chrome | Known issue: blank preview ([#1](https://github.com/VolksRat71/sam-ui/issues/1)) |

Details and progress: [Platform support, #16](https://github.com/VolksRat71/sam-ui/issues/16).
