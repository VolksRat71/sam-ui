<!-- sam-ui (Apache-2.0). New file; Meta's original README is docs/SAM2_UPSTREAM.md. -->
# sam-ui

Interactive video segmentation on [SAM 2](https://github.com/facebookresearch/sam2)
and SAM 3, where **every object keeps its own cached track**. Click an object, press
Track, and only the objects that are new or changed get tracked again. Everything
else stays as it was, including after a reload or a server restart.

![studio tracking a player and a ball on Meta's juggle sample](docs/images/studio.jpg)

sam-ui began as a fork of Meta's SAM 2 web demo. The backend keeps Meta's model code
and adds a track cache, a second engine (SAM 3), exports and a job system. The
frontend, **studio**, replaces the demo UI with an editor layout.

## Download the app

**macOS 14 or newer, Apple Silicon (M1 or later):** get `sam-ui-<version>-arm64.dmg` from the
[latest release](https://github.com/VolksRat71/sam-ui/releases/latest) and drag it
into Applications.
- On first launch it downloads SAM 2.1 large (about 900 MB, hash-checked). The app
  runs the full model locally on your GPU, with no other install.
- The build is **not signed yet**: the first time, right-click the app and choose
  **Open** (macOS 14), or open it once and click **Open Anyway** in System Settings →
  Privacy & Security (macOS 15 and later), or run
  `xattr -dr com.apple.quarantine /Applications/sam-ui.app`.
- **SAM 3 (optional):** accept Meta's SAM License on
  [facebook/sam3](https://huggingface.co/facebook/sam3), then choose
  **SAM 3 → Download SAM 3 with a Hugging Face token…**. See
  [`desktop/README.md`](desktop/README.md).

**Or try it in the browser:** [volksrat71.github.io/sam-ui](https://volksrat71.github.io/sam-ui/)
runs SAM 2.1 tiny on WebGPU with no install, no server and nothing uploaded (your
video stays in the browser). Chrome or Edge on desktop; Safari and Firefox are
untested. It is a demo: clips up to 2 minutes, and the app's SAM 2.1 large and SAM 3
give much better masks. Or run it from source, below.

## Hardware

Memory does not grow with clip length: frames are decoded as tracking and playback
reach them, and tracking state keeps only what the model reads again. So what sets
the hardware floor is the model, not the clip. Figures are marked **measured** or
**estimated**; the estimates add up the model's weights, its working memory and the
caches, and have not been run on that hardware yet.

| | Minimum | Recommended | Notes |
|---|---|---|---|
| **App, SAM 2.1 large** (default) | 8 GB, with the feature cache off (`SAM_UI_FEATURE_CACHE_GB=0`); **estimated** | 16 GB | About 1.3 s a frame on an M1 Pro (**measured**), so a 5-minute clip at 24 fps (7,200 frames) takes about 2.5 hours per pass. |
| **App, SAM 3** (optional) | 16 GB; **measured** working on an M1 Pro, 16 GB | 16 GB or more | Its weights alone are 3.4 GB. Slower than SAM 2.1 large (not yet timed). |
| **Browser demo, SAM 2.1 tiny** | 8 GB; **measured** 2.7 to 3.6 GB for a 2-minute track | 16 GB | Chrome or Edge with WebGPU. About 46 ms a frame at 512 px, 252 ms at 1024, one object (**measured**). |

The app needs an Apple Silicon Mac (M1 or later) on macOS 14 or newer. Measured on a
3-minute 720p clip (4,320 frames, SAM 2.1 tiny, two objects): the backend's memory
stays at 3.0 to 3.3 GB from start to end, where the code this began from needed 7.8 GB
for 10 seconds and 17 GB for 30. `tools/memory_bench.py` reproduces the comparison.

## Platform support

| | Status |
|---|---|
| **Desktop app**, macOS 14+ on Apple Silicon | Released ([v0.2.0](https://github.com/VolksRat71/sam-ui/releases/latest)) |
| Desktop app, Intel Mac | Not supported ([#7](https://github.com/VolksRat71/sam-ui/issues/7)) |
| Desktop app, Windows or Linux | Not yet ([#6](https://github.com/VolksRat71/sam-ui/issues/6)) |
| **Browser demo**, Chrome on macOS | Tested |
| Browser demo, Chrome or Edge on Windows | Untested ([#2](https://github.com/VolksRat71/sam-ui/issues/2)) |
| Browser demo, Safari 26 | Untested ([#3](https://github.com/VolksRat71/sam-ui/issues/3)) |
| Browser demo, Firefox | WebGPU only on some versions; untested ([#4](https://github.com/VolksRat71/sam-ui/issues/4)) |
| Browser demo, Android Chrome | Known issue: blank preview ([#1](https://github.com/VolksRat71/sam-ui/issues/1)) |

Details and progress: [Platform support, #16](https://github.com/VolksRat71/sam-ui/issues/16).

## What it does

- **Per-object track cache.** Your clicks are saved as seeds, with the mask you
  approved on each clicked frame. Each object keeps one track per engine, in one of
  four states: untracked, stale (its clicks changed since), tracked, or tracking (a
  job holds it). Track runs only what isn't current.
- **Corrections that stick.** Click on any frame to fix a mask; the next Track uses
  your corrected mask on that frame. A correction refines the tracked mask, even
  after an earlier correction has made the track stale: a negative click, sent with
  a positive on the part to keep, cuts away only the region it is on, and a lone
  positive click adds one. SAM 2 needs a positive on the frame.
- **Keep working while it tracks.** A track job holds the model one frame at a time,
  so clicks come back in about 0.1 s even while a job runs. Jobs can overlap, and
  each has its own cancel.
- **Two engines.** SAM 2 (default, and used for clicks) and SAM 3's video tracker
  (opt-in per Track, loaded on first use). Each engine's track is cached separately,
  and studio marks the frames where the two disagree.
- **Fast re-tracks.** Image-backbone features are cached per video and shared by
  every job, so a re-track skips the backbone (about 35% faster, same masks).
- **Long clips.** Uploads up to 5 minutes and 2 GB (`MAX_UPLOAD_VIDEO_DURATION`,
  `MAX_UPLOAD_MB`); a longer clip keeps its start, and studio says so before it
  uploads. Memory stays flat however long the clip (see Hardware).
- **Studio:**
  - up to 16 objects, each with a name you can edit in place (exports use it);
  - an engine picker that lists every model and says why one can't run here;
  - per-object effects from Meta's demo;
  - a timeline with a lane per object;
  - uploads, and deleting uploads;
  - zoom, with click markers that stay sharp at any zoom.
- **Exports** (each records the engine and model that made it):
  - **Mask videos:** one black and white MP4 per object, in a zip.
  - **Vector JSON:** per-frame outlines (pieces and holes) per object, for After
    Effects masks.
  - **Rotoscoping working folder:** `products.json`, `anchors.json`, `shots.json`
    and per-object mattes (`data/mattes_tracked/<id>/%05d.png`), optionally with
    the frames.
  - **Video:** an MP4 with each object's effect, encoded in the browser.
  - **After Effects:** coming.

## Quick start

Needs Python 3.11+, Node 20+ and ffmpeg. Tested on Apple Silicon (MPS); CUDA and
CPU work as they do in SAM 2.

```sh
git clone https://github.com/VolksRat71/sam-ui.git && cd sam-ui
python3 -m venv .venv && . .venv/bin/activate
SAM2_BUILD_CUDA=0 pip install -e '.[interactive-demo]'
(cd checkpoints && ./download_ckpts.sh)          # SAM 2.1 checkpoints (Apache-2.0)
git config core.hooksPath .githooks               # the footage guard, for contributors
```

**Backend.** Run it as a single process. Do not use gunicorn on macOS: a forked
worker cannot reach the Metal compiler and fails on its first GPU call.

```sh
mkdir -p ~/sam-ui-data && ln -s "$PWD/demo/data/gallery" ~/sam-ui-data/gallery
cd demo/backend/server
PYTORCH_ENABLE_MPS_FALLBACK=1 APP_ROOT="$(git rev-parse --show-toplevel)" \
MODEL_SIZE=large DATA_PATH=~/sam-ui-data API_URL=http://localhost:7263 \
DEFAULT_VIDEO_PATH=gallery/05_default_juggle.mp4 \
python -m flask --app app run --host 127.0.0.1 --port 7263 --with-threads
```

**Studio:**

```sh
cd studio && npm ci
VITE_API_ENDPOINT=http://127.0.0.1:7263 npm run dev -- --port 7262   # http://localhost:7262
```

**SAM 3 (optional).** `pip install "transformers==5.17.0"`, then put the SAM 3 weights
(from [facebook/sam3](https://huggingface.co/facebook/sam3), after accepting Meta's
SAM License) in a folder and set `SAM_UI_SAM3_WEIGHTS=/path/to/sam3`. The SAM 3
option in studio stays disabled, with the reason shown, until they're found.

| Setting | Default | What it does |
| --- | --- | --- |
| `SAM_UI_FEATURE_CACHE_GB` | 6 | backbone feature cache budget (0 turns it off) |
| `SAM_UI_SESSION_TTL_MIN` | 30 | idle sessions are freed after this long (0 keeps them) |
| `SAM_UI_EXPORT_ROOT` | `~/Movies` | rotoscoping exports may only write under this folder |
| `SAM_UI_SAM3_WEIGHTS` | `~/.cache/rotoscoping-video-subjects/weights/sam3-hf` | where the SAM 3 weights are |

## How it fits together

```
studio (React, Vite, WebCodecs)                 demo/backend/server (Flask)
  UI ── StudioMethods ── studio.worker ── HTTP ──►  GraphQL: sessions, clicks, objects, uploads
                         decode, masks,             tracks/: seeds, track store, engines,
                         effects, export                     jobs, feature cache, export
                                                    sam2/  (Meta's model code)
```

- **`demo/backend/server/tracks/`:**
  - `seeds.py` and `store.py`: seeds and per-engine tracks on disk, under
    `DATA_PATH/tracks/<video sha256>/<object>/`;
  - `service.py`: selects what to track, caches the results, computes disagreement;
  - `engine.py` / `sam3_engine.py`: the engines;
  - `jobs.py`: job claims and cancel;
  - `features.py`: the backbone cache;
  - `export.py` and `routes.py`: exports and the HTTP routes.
- **`studio/`.** The UI talks to the backend only through the `StudioMethods` table
  (`src/worker/protocol.ts`), which the upcoming in-browser engine will implement
  as well. Meta's demo code it reuses is vendored under `src/meta/`.

### API, in brief

| Kind | Endpoints |
| --- | --- |
| GraphQL, `POST /graphql` | `startSession` (returns the objects already known for the video), `addPoints` (points normalised 0–1), `clearPointsInFrame`, `removeObject`, `clearPointsInVideo`, `objectTracks`, `clearTrack`, `uploadVideo`, `deleteVideo`, `videos`, `defaultVideo` |
| Streams, `multipart/x-savi-stream` | `POST /track_objects {session_id, object_ids?, engine?}` streams one part per frame and ends with a `done` or `error` part. `POST /track_masks` streams cached tracks. |
| JSON | `GET /engines` (every engine, with why one can't run), `GET /limits` (upload length and size), `POST /cancel_track`, `POST /track_jobs`, `POST /track_disagreement`, `POST /rename_object`, `POST /object_names`, `POST /export` |

## Tests

```sh
pytest demo/backend/tests -q                         # backend, no model needed
SAM_UI_SLOW=1 PYTORCH_ENABLE_MPS_FALLBACK=1 pytest demo/backend/tests -q -k "slow or streamed"
                                                     # + real SAM 2 / SAM 3: streamed and pruned tracks
                                                     #   give the same masks as upstream on every frame
cd studio && npm test && npm run lint && npm run build
npm run smoke                                        # end to end in headless Chrome
SMOKE=both npm run smoke                             # + the browser-only build (headed Chrome, WebGPU)
python tools/memory_bench.py --seconds 10 60 180     # peak memory against clip length
python tools/track_cache_e2e.py --api http://127.0.0.1:7373   # live backend (use a scratch one)
```

`tools/track_cache_e2e.py` uploads its own synthetic clips and deletes them when it
finishes. It also has `--after-restart`, `--correction` and `--responsive` checks.

## Licences and credits

- sam-ui is **Apache-2.0**, like SAM 2. It is a modified version of
  [SAM 2](https://github.com/facebookresearch/sam2) by Meta Platforms, Inc.
  [`NOTICE-sam-ui.md`](NOTICE-sam-ui.md) lists what changed. Files we modified carry
  a notice, and Meta's copyright headers are kept.
- **SAM 3 is not included.** Its code and weights are under Meta's
  [SAM License](https://huggingface.co/facebook/sam3), not Apache. sam-ui imports
  Hugging Face `transformers` at run time and loads weights you download yourself.
- The Inter font is under the SIL Open Font License; the licence ships with it in
  `studio/public/fonts/`.
- Meta's original README, with the model details, checkpoints and training, is
  [`docs/SAM2_UPSTREAM.md`](docs/SAM2_UPSTREAM.md).
