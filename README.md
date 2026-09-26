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

**macOS (Apple Silicon):** get `sam-ui-<version>-arm64.dmg` from the
[latest release](https://github.com/VolksRat71/sam-ui/releases/latest) and drag it
into Applications.
- On first launch it downloads SAM 2.1 large (about 900 MB, hash-checked). The app
  runs the full model locally on your GPU, with no other install.
- The build is **not signed yet**: the first time, right-click the app and choose
  **Open**, or run `xattr -dr com.apple.quarantine /Applications/sam-ui.app`.
- **SAM 3 (optional):** accept Meta's SAM License on
  [facebook/sam3](https://huggingface.co/facebook/sam3), then choose
  **SAM 3 → Download SAM 3 with a Hugging Face token…**. See
  [`desktop/README.md`](desktop/README.md).

A lighter in-browser demo, SAM 2.1 tiny on WebGPU with no install, is planned for
GitHub Pages. Or run it from source, below.

## What it does

- **Per-object track cache.** Your clicks are saved as seeds, with the mask you
  approved on each clicked frame. Each object keeps one track per engine, in one of
  four states: untracked, stale (its clicks changed since), tracked, or tracking (a
  job holds it). Track runs only what isn't current.
- **Corrections that stick.** Click on any frame to fix a mask; the next Track uses
  your corrected mask on that frame. (As in SAM 2 itself, a frame needs at least one
  positive click. A lone negative click empties the mask.)
- **Keep working while it tracks.** A track job holds the model one frame at a time,
  so clicks come back in about 0.1 s even while a job runs. Jobs can overlap, and
  each has its own cancel.
- **Two engines.** SAM 2 (default, and used for clicks) and SAM 3's video tracker
  (opt-in per Track, loaded on first use). Each engine's track is cached separately,
  and studio marks the frames where the two disagree.
- **Fast re-tracks.** Image-backbone features are cached per video and shared by
  every job, so a re-track skips the backbone (about 35% faster, same masks).
- **Studio:**
  - up to 16 objects;
  - per-object effects from Meta's demo;
  - a timeline with a lane per object;
  - uploads, and deleting uploads;
  - zoom, with click markers that stay sharp at any zoom.
- **Exports:**
  - **Video:** an MP4 with each object's effect, encoded in the browser.
  - **Rotoscoping working folder:** `products.json`, `anchors.json`, `shots.json`
    and per-object mattes (`data/mattes_tracked/<id>/%05d.png`), optionally with
    the frames.

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
| JSON | `POST /cancel_track`, `POST /track_jobs`, `GET /engines`, `POST /track_disagreement`, `POST /export` |

## Tests

```sh
pytest demo/backend/tests -q                         # backend, no model needed
SAM_UI_SLOW=1 pytest demo/backend/tests -q -k slow   # + SAM 2 on synthetic video
cd studio && npm test && npm run lint && npm run build
npm run smoke                                        # end to end in headless Chrome
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
