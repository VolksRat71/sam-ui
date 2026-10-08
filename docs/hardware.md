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
| **App, SAM 2.1 large** (default) | 8 GB, with the feature cache off (`SAM_UI_FEATURE_CACHE_GB=0`); **estimated**: the backend's **measured** 3.9 to 4.0 GB peak footprint (M4 Max, 2026-10-07, flat from 10 s to 3 minutes) leaves about 4 GB for macOS and the app window | 16 GB | 0.60 to 0.69 s a frame on an M4 Max (**measured** 2026-10-07), 1.3 s on an M1 Pro (**measured** earlier): a 5-minute clip at 24 fps (7,200 frames) takes about 1.2 to 1.4 hours per pass on the M4 Max, 2.5 on the M1 Pro. |
| **App, SAM 3** (optional) | 12 GB with `SAM_UI_SAM3_DTYPE=fp16`, **estimated** from a **measured** 5.7 GB peak for the app's worst case; 16 GB at full precision (6.7 GB peak), **measured** working on an M1 Pro, 16 GB | 16 GB or more | 1.34 to 1.35 s a frame at full precision (M4 Max, **measured** 2026-10-07), 0.8 at fp16 (M4 Max, **measured** earlier). fp16 moves masks a little (below). |
| **Browser demo, SAM 2.1 tiny** | 8 GB; **measured** 2.7 to 3.6 GB for a 2-minute track | 16 GB | Chrome or Edge with WebGPU. About 46 ms a frame at 512 px, 252 ms at 1024, one object (**measured**). |

The app needs an Apple Silicon Mac (M1 or later) on macOS 14 or newer. Measured on a
3-minute 720p clip (4,320 frames, SAM 2.1 tiny, two objects): the backend's memory
stays at 3.0 to 3.3 GB from start to end, where the code this began from needed 7.8 GB
for 10 seconds and 17 GB for 30. `tools/memory_bench.py` reproduces the comparison.
On 2026-10-07 the peak physical footprint was flat too: 3.1 to 3.2 GB for SAM 2.1 tiny
and 3.9 to 4.0 GB for large, from 10 seconds to 3 minutes (below).

<details>
<summary>Benchmarks, half precision and what is not measured</summary>

**Measured** with `tools/hardware_bench.py` on an Apple M4 Max (Mac16,5) with 48 GB,
macOS 26.6.2. Rows marked 2026-10-07 were measured again that day on v0.3.0; the
others are from the v0.3.0 release work and were not re-run. Two objects clicked on
frame 0. The clips are 1280x720: a 10 s, 60 s or 3-minute synthetic one at 24 fps,
and the gallery's dog and juggling clips (289 and 247 frames). The footprint is the
backend process's peak physical footprint, the figure macOS counts against memory,
which includes the GPU's buffers (RSS does not). Each row is its own process.

| Run | Load | Speed | MPS peak | Footprint peak |
|---|---|---|---|---|
| SAM 2.1 large, 10 s, 60 s and dog clips (2026-10-07) | 0.9 to 1.0 s | 0.60 to 0.63 s/frame | 2.8 GB | 3.9 GB, the same at 10 s and 60 s |
| SAM 2.1 large, 3-minute clip, 4,320 frames (2026-10-07) | 0.9 s | 0.69 s/frame | 2.8 GB | 4.0 GB |
| SAM 2.1 tiny (`MODEL_SIZE=tiny`, from source), 10 s, 60 s and dog clips (2026-10-07) | 0.4 s | 0.43 to 0.48 s/frame | 2.3 GB | 3.1 GB |
| SAM 2.1 tiny, 3-minute clip (2026-10-07) | 0.4 s | 0.54 s/frame | 2.3 GB | 3.2 GB |
| SAM 2.1 large, feature cache 3 GB (the default on a 12 GB Mac) | 0.9 s | 0.72 s/frame | 3.8 GB | 5.1 GB |
| SAM 2.1 large, feature cache 4 GB (the default on a 16 GB Mac), dog clip (2026-10-07) | 0.9 s | 0.69 s/frame | 3.8 GB | 5.0 GB |
| SAM 3, 10 s, 60 s (1,440 frames) and dog clips (2026-10-07) | 3.4 to 3.7 s | 1.34 to 1.35 s/frame | 4.2 GB | 5.0 GB: flat, no higher at 60 s than at 10 s |
| SAM 3 at fp16 or bf16, gallery and 10 s clips | 2.7 to 3.9 s | 0.79 to 0.80 s/frame | 2.0 GB | 3.5 GB |
| SAM 3 text prompt, "dog" | 2.5 s first (loads the detector), 0.7 s after | | 4.2 GB | 5.0 GB (4.5 at fp16) |
| App worst case: SAM 2.1 large (3 GB cache) tracks, then SAM 3 tracks and a text prompt, one process | | 1.37 s/frame (SAM 3) | 5.8 GB (3.8 at fp16) | 6.7 GB (5.7 at fp16) |

What SAM 3 keeps while idle, at full precision (fp16 in brackets): 2.5 GB (1.5) after
a job, 4.8 GB (2.8) with the text detector loaded, and under 1 GB once both are
unloaded. The detector is unloaded after 5 idle minutes and the whole engine after 10
(`SAM_UI_SAM3_DETECTOR_IDLE_S`, `SAM_UI_SAM3_IDLE_S`, in seconds, or `never`). The
next use loads them again in a few seconds. Neither setting changes a mask.

**Half precision is opt-in, because masks move.** IoU of each frame's mask against
full precision, on the same clips and clicks (`--save-masks`, then `--compare`):

| Setting | Mean IoU | Lowest IoU | Memory | Speed |
|---|---|---|---|---|
| `SAM_UI_SAM3_DTYPE=fp16` | 0.996 to 0.997 | 0.80, a ball under 1% of the frame | 3.5 GB peak, from 5.5 | 0.8 s/frame, from 1.35 |
| `SAM_UI_SAM3_DTYPE=bf16` | 0.99 | 0.78, the same ball | the same as fp16 | the same as fp16 |
| `SAM_UI_SAM2_DTYPE=fp16` (autocast) | 0.998 | 0.92, the dog at under 1% of the frame | no saving: 4.2 to 4.4 GB peak | 0.36 s/frame, from 0.69 |
| `SAM_UI_SAM2_DTYPE=bf16` (autocast) | 0.99 | 0.00, the same dog lost on one frame | no saving | 0.36 s/frame |

A text prompt's mask at fp16 keeps an IoU of 0.9996 against full precision, with the
same score. The desktop app passes its environment to the backend, so
`launchctl setenv SAM_UI_SAM3_DTYPE fp16` before starting it turns fp16 on there.

**Not measured:**
- Macs with 8, 12 or 16 GB, so the minimums above stay estimates. There is no such Mac
  here; the M1 Pro, 16 GB figures come from earlier runs.
- SAM 2.1 large on 5 minutes on the M1 Pro, and SAM 3 on 3 minutes. Footprint was flat
  from 10 s to 3 minutes for both SAM 2.1 sizes, and from 10 s to 60 s for SAM 3.
- Why the 3-minute runs were slower a frame than the 60 s ones (0.69 against 0.60 for
  large, 0.54 against 0.43 for tiny). Each run had the GPU to itself; the cause is open.
- Intel Macs, which the app does not support ([#7](https://github.com/VolksRat71/sam-ui/issues/7)).
- Windows, Linux and CUDA GPUs ([#6](https://github.com/VolksRat71/sam-ui/issues/6)):
  there is no build for them yet and no such machine here.

```sh
python tools/hardware_bench.py --runs sam2 sam2-tiny sam3 --clips synth:10 synth:60 gallery:01_dog
python tools/hardware_bench.py --runs sam2 sam2-tiny --clips synth:180
python tools/hardware_bench.py --runs sam3 sam3-text --clips gallery:01_dog
python tools/hardware_bench.py --runs app --clips gallery:01_dog --feature-cache-gb 3 [--env SAM_UI_SAM3_DTYPE=fp16]
python tools/hardware_bench.py --runs sam3-idle --clips gallery:01_dog
python tools/hardware_bench.py --runs sam3 --clips gallery:05_default_juggle --save-masks /tmp/a
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
