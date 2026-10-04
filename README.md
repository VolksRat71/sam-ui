<!-- sam-ui (Apache-2.0). New file; Meta's original README is docs/SAM2_UPSTREAM.md. -->
# sam-ui

Rotoscoping and masking for video, on [SAM 2](https://github.com/facebookresearch/sam2)
and SAM 3. It is for compositors, motion designers and anyone who needs mattes of
objects in real footage. Click an object or describe it, track it through the clip,
correct and review the result, then export mattes, outlines or a roto folder. Footage
opened from After Effects goes back as a new comp with the masks on it.

It comes as a **macOS app** that runs the full models on your Mac, and a **browser
demo** that runs a small model with no install. Every object keeps its own cached
track, so Track only re-runs the objects that are new or changed, and everything else
stays as it was, including after a reload or a restart.

<!-- DEMO VIDEOS: paste each GitHub-uploaded MP4 link on its own line under its comment. -->
<!-- demo video: upload path (drag a clip in, track, export for After Effects) -->

<!-- demo video: After Effects path (Media > Open from After Effects, track, Export to After Effects) -->

![studio tracking a player and a ball on Meta's juggle sample](docs/images/studio.jpg)

sam-ui began as a fork of Meta's SAM 2 web demo. The backend keeps Meta's model code
and adds a track cache, a second engine (SAM 3), exports and a job system. The
frontend, **studio**, replaces the demo UI with a compositing-style workspace.

## Download

**macOS 14 or newer, Apple Silicon (M1 or later):** get `sam-ui-<version>-arm64.dmg` from the
[latest release](https://github.com/VolksRat71/sam-ui/releases/latest) and drag it
into Applications.
- On first launch it downloads SAM 2.1 large (about 900 MB, hash-checked). The app
  runs the full model locally on your GPU, with no other install.
- The build is **not signed yet**: the first time, right-click the app and choose
  **Open** (macOS 14), or open it once and click **Open Anyway** in System Settings >
  Privacy & Security (macOS 15 and later), or run
  `xattr -dr com.apple.quarantine /Applications/sam-ui.app`.
- **SAM 3 (optional):** accept Meta's SAM License on
  [facebook/sam3](https://huggingface.co/facebook/sam3), then choose
  **SAM 3 > Download SAM 3 with a Hugging Face token…**. See
  [`desktop/README.md`](desktop/README.md).
- **After Effects (optional):** the round trip needs
  [AE MCP Vision v2.2.0](https://github.com/VolksRat71/after-effects-mcp-vision/releases/tag/v2.2.0)
  installed in After Effects, with its panel open.
- The app checks GitHub for a newer release at most once a day and shows a banner
  with a link; **Help > Check for Updates…** checks now. It never downloads or
  installs anything itself.

**Or try it in the browser:** [volksrat71.github.io/sam-ui](https://volksrat71.github.io/sam-ui/)
runs SAM 2.1 tiny on WebGPU with no install, no server and nothing uploaded (your
video stays in the browser). Chrome or Edge on desktop; Safari and Firefox are
untested. It is a demo: clips up to 5 minutes, and the app's SAM 2.1 large and SAM 3
give much better masks. Or [run it from source](#run-from-source).

## Features

### Track

- **Click and Track.** Click an object for a positive point, right click for a
  negative, and press Track. Track runs only the objects that are untracked or whose
  clicks changed. Tracked objects never re-run, and their masks stay on screen.
- **Three engines.** SAM 2.1 large (the default, and the one clicks go through),
  SAM 3's video tracker (optional, loaded on first use) and SAM 2.1 tiny in the
  browser. Each engine's track is cached separately, and studio marks the frames
  where SAM 2 and SAM 3 disagree.
- **Find by text (SAM 3).** Type a phrase ("dog", "the red cup") and SAM 3's
  detector segments it **on the frame on screen**. The best match becomes that
  frame's mask, as if clicked, and the object tracks from it with any engine. It is
  a seed for one frame, not a search of the whole clip. When several things match it
  says how many and takes the best. SAM 2 and the browser engine take clicks only.
- **Keep working while it tracks.** Clicks come back in about 0.1 s while a job runs.
  Jobs can overlap, and each has its own cancel.
- **Long clips.** Uploads take up to 5 minutes and 2 GB; a longer clip keeps its
  start, and studio says so before it uploads. In the app, an upload becomes a working copy at
  24 fps, fitted within 1280x720 and never upscaled. Video is decoded with PyAV as
  tracking and playback reach each frame, so memory stays flat however long the clip
  (see [Hardware](#hardware)). Image features are cached per video, so a re-track skips
  the backbone (about 35% faster, same masks).

### Correct

- **Corrections refine the mask.** Click on any frame to fix it, and the next Track
  uses your corrected mask there. A negative click, sent with a positive on the part
  to keep, cuts away only the region it is on; a lone positive adds one. On SAM 2 a
  negative with no positive on the frame is not sent: studio asks you to add a
  positive, or to switch to SAM 3, where a lone negative empties the frame.
- **Bounded re-tracking (SAM 2).** A correction re-tracks a stretch around the
  corrected frame and keeps the cached track beyond it. The pass stops once ten frames
  in a row agree with the cache (IoU above 0.98). On the gallery dog clip (289
  frames), a fix on frame 148 re-tracked 31 frames in 7.5 s, against 130 s for a full
  re-track. SAM 3 and the browser engine re-track the whole window for now.
- **Absent ranges.** Drag across an object's lane and **Mark absent** where it leaves
  the shot. Those frames stay empty in the preview and every export, the tracker
  skips them, and each side of the gap tracks only from its own clicks. A positive
  click inside the range means the object is back, so the range ends on the frame
  before it; clicks there with no positive are refused. **Gone for a while?**, offered
  after a lone negative, marks the object absent until its next click.
- **Undo and kept versions.** Cmd-Z and Shift-Cmd-Z undo and redo clicks, cleared
  frames and range edits. The last 10 tracks per object and engine are kept, so going
  back to the clicks that made one restores it from disk with no re-track. **Versions**
  lists them by time, engine and click count. **Move these clicks to** hands a frame's
  clicks to the right object.

### Review

- **Review queue.** Each track gets a short, ranked list of stops worth a look,
  computed from the cached masks with no model run: where the engines disagree, where
  the track starts, stops or the object comes back, where the mask jumps or splits,
  the seams of a bounded re-track, candidate starts, and frames you flagged with F.
  Step through them with . and , and press Y (**Looks right**) to mark one reviewed. A
  re-track reopens only the stops it changed.
- **Candidate, present and absent.** Each frame of an object is unknown, a candidate
  (a tool thinks the object is there, with its source and score), confirmed present,
  or confirmed absent. Review a candidate as Present, Absent or Reject (P, A, R). Only
  absent changes tracking. Candidates are written through the API
  (`setObjectCandidates`); sam-ui does not yet find objects across a clip on its own.

### Organise

- **Objects.** Up to 16 per video by default, each with a name you edit in place.
  Exports use the names.
- **Groups.** Drag objects to reorder them or into named, coloured groups. A group
  can track, clear, take one effect, hide from the preview and ungroup. The order is
  the timeline's and every export's. Reordering never makes a track stale.
- **The workspace.** The preview, a dock with Review, Layer info, Effects and Media,
  and a timeline with a lane per object. Press ? for the keyboard shortcuts.
- **Phones and tablets.** Studio stacks its panes on small screens, with tap to add a
  point, long press for the other kind, and pinch to zoom. It has been checked in
  Chrome's device emulation only, and Android Chrome shows a blank preview for now
  ([#1](https://github.com/VolksRat71/sam-ui/issues/1)).

### Export and After Effects

- **Exports.** Each records the engine and model that made it, and lists every range
  with its state.
  - **Mask videos:** one black and white MP4 per object, in a zip.
  - **Vector JSON:** per-frame outlines (pieces and holes) per object, for After
    Effects masks.
  - **Roto working folder:** `products.json`, `anchors.json`, `shots.json`, the review
    queue and per-object PNG mattes, optionally with the frames.
  - **Video:** an MP4 with each object's effect, encoded in the browser.
  - Groups become folders, with an optional union mask per group.
- **After Effects round trip** (desktop app, with
  [AE MCP Vision](https://github.com/VolksRat71/after-effects-mcp-vision) v2.2.0):
  - **Media > Open from After Effects** lists the footage in the open AE project and
    opens it where it is, with no upload and no re-encode, so frame N in sam-ui is
    frame N in AE. It takes unmodified .mp4 and .mov footage with square pixels, no
    proxy and no Interpret Footage overrides. Image sequences are not supported yet.
  - **Export > Export to After Effects** makes a new comp at the footage's own size,
    frame rate and duration: the footage as a guide layer, and one layer per object,
    named after it, with its outlines as mask-path keys. The footage is checked again
    before anything is written. Save the project in AE to keep it.
  - Export to After Effects is offered only for footage opened from After Effects.
    For an uploaded clip, use the Vector JSON or the roto folder.

### Experimental

- **Refine Detail** (off by default). Set `SAM_UI_REFINE_DETAIL=1` before starting the
  backend (for the app, `launchctl setenv SAM_UI_REFINE_DETAIL 1`, then restart it),
  then choose **Experimental > Refine Detail**. Box or click a small detail, add
  include and exclude points, then Refine and Apply. It works on the current frame
  only and crops the working copy, not the original; full-resolution refinement comes
  later. Details add to a non-empty tracked mask, show in the preview, matte exports
  and the AE export, and never feed tracking. Each Apply or Remove is one undo. The
  browser engine does not have it.

## Hardware

Memory does not grow with clip length: frames are decoded as tracking and playback
reach them, and tracking state keeps only what the model reads again. So what sets
the hardware floor is the model, not the clip. Figures are marked **measured** or
**estimated**. The minimums are estimates: they add the measured peak footprint
below to what macOS and the app's window need. They have not been tried on a Mac
with that much memory.

| | Minimum | Recommended | Notes |
|---|---|---|---|
| **App, SAM 2.1 large** (default) | 8 GB, with the feature cache off (`SAM_UI_FEATURE_CACHE_GB=0`); **estimated** from a **measured** 4.1 GB peak footprint | 16 GB | 0.68 to 0.72 s a frame on an M4 Max, 1.3 s on an M1 Pro (**measured**): a 5-minute clip at 24 fps (7,200 frames) takes about 1.4 hours per pass on the M4 Max, 2.5 on the M1 Pro. |
| **App, SAM 3** (optional) | 12 GB with `SAM_UI_SAM3_DTYPE=fp16`, **estimated** from a **measured** 5.7 GB peak for the app's worst case; 16 GB at full precision (6.7 GB peak), **measured** working on an M1 Pro, 16 GB | 16 GB or more | 1.35 s a frame at full precision, 0.8 at fp16 (M4 Max, **measured**). fp16 moves masks a little (below). |
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
| SAM 3, 10 s and gallery clips | 3.5 s | 1.35 s/frame | 4.2 GB | 5.4 to 5.5 GB |
| SAM 3, 60 s clip (1,440 frames) | 3.4 s | 1.37 s/frame | 4.2 GB | 5.1 GB: flat, no higher than at 10 s |
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
- SAM 2.1 large on a 3-minute clip, and on 5 minutes on the M1 Pro. Footprint was flat
  from 10 s to 60 s, as it was for SAM 2.1 tiny on 3 minutes.
- Intel Macs, which the app does not support ([#7](https://github.com/VolksRat71/sam-ui/issues/7)).
- Windows, Linux and CUDA GPUs ([#6](https://github.com/VolksRat71/sam-ui/issues/6)):
  there is no build for them yet and no such machine here.

```sh
python tools/hardware_bench.py --runs sam2 sam3 sam3-text --clips synth:10 gallery:01_dog
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

## Run from source

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

**Studio.** It talks to the backend on port 7263 unless `VITE_API_ENDPOINT` says
otherwise. More in [`studio/README.md`](studio/README.md); the desktop app's build is
in [`desktop/README.md`](desktop/README.md).

```sh
cd studio && npm ci
npm run dev                                       # http://localhost:7362
```

**SAM 3 (optional).** `pip install "transformers==5.17.0"`, then put the SAM 3 weights
(from [facebook/sam3](https://huggingface.co/facebook/sam3), after accepting Meta's
SAM License) in a folder and set `SAM_UI_SAM3_WEIGHTS=/path/to/sam3`. The SAM 3
option in studio stays disabled, with the reason shown, until they're found.

| Setting | Default | What it does |
| --- | --- | --- |
| `MAX_UPLOAD_VIDEO_DURATION`, `MAX_UPLOAD_MB` | 300, 2048 | longest upload in seconds, and largest in MB |
| `VIDEO_ENCODE_FPS`, `VIDEO_ENCODE_MAX_WIDTH`, `VIDEO_ENCODE_MAX_HEIGHT` | 24, 1280, 720 | the working copy an upload becomes (never upscaled) |
| `SAM_UI_RETAIN_ORIGINAL_UPLOADS` | `0` (off) | `1` also keeps an upload's original file and frame times, for tools; playback, tracking and export still use the working copy |
| `SAM_UI_REFINE_DETAIL` | `0` (off) | `1` enables Experimental > Refine Detail |
| `SAM_UI_FEATURE_CACHE_GB` | 6 | backbone feature cache budget (0 turns it off) |
| `SAM_UI_SESSION_TTL_MIN` | 30 | idle sessions are freed after this long (0 keeps them) |
| `SAM_UI_EXPORT_ROOT` | `~/Movies/sam-ui` (the desktop app sets your home folder) | rotoscoping exports may only write under this folder |
| `SAM_UI_SAM3_WEIGHTS` | `~/.cache/rotoscoping-video-subjects/weights/sam3-hf` | where the SAM 3 weights are |
| `SAM_UI_SAM3_DTYPE` | `fp32` | SAM 3's precision: `fp16` or `bf16` cut its memory and time, and move masks a little (see Hardware) |
| `SAM_UI_SAM2_DTYPE` | `fp32` | SAM 2's autocast on MPS: `fp16` or `bf16` halve its time, save no memory and move masks a little |
| `SAM_UI_SAM3_IDLE_S` | 600 | seconds before an unused SAM 3 is unloaded (`never` keeps it) |
| `SAM_UI_SAM3_DETECTOR_IDLE_S` | 300 | seconds before SAM 3's unused text detector is unloaded (`never` keeps it) |

## How it fits together

```
studio (React, Vite, WebCodecs)                 demo/backend/server (Flask)
  UI ── StudioMethods ── studio.worker ── HTTP ──►  GraphQL: sessions, clicks, objects, uploads
                         decode, masks,             tracks/: seeds, track store, engines,
                         effects, export                     jobs, feature cache, export
                                                    sam2/  (Meta's model code)
desktop (Electron): runs the backend, serves studio, talks to After Effects
```

- **`demo/backend/server/tracks/`:**
  - `seeds.py`, `store.py` and `versions.py`: seeds, per-engine tracks and kept
    versions on disk, under `DATA_PATH/tracks/<video sha256>/<object>/`;
  - `service.py`: selects what to track, caches the results, computes disagreement;
  - `engine.py` / `sam3_engine.py` / `text.py`: the engines and SAM 3 text prompts;
  - `bounded.py`: re-tracking only around a correction;
  - `ranges.py`: absent, present and candidate ranges;
  - `audit.py` and `review.py`: the review queue and its marks;
  - `streaming.py`: frames decoded on request with PyAV, so memory stays flat;
  - `jobs.py`: job claims and cancel;
  - `features.py`: the backbone cache;
  - `export.py` and `routes.py`: exports and the HTTP routes.
- **`demo/backend/server/data/linked.py`:** footage opened in place from After Effects.
- **`studio/`.** The UI talks to the backend only through the `StudioMethods` table
  (`src/worker/protocol.ts`), which the browser engine (`src/local/`) implements too.
  Meta's demo code it reuses is vendored under `src/meta/`.
- **`desktop/`.** The Electron app. `src/ae-bridge.js` and `src/ae-roto.js` are the
  After Effects round trip; `src/update-check.js` the update notice.

### API, in brief

| Kind | Endpoints |
| --- | --- |
| GraphQL, `POST /graphql` | `startSession` (returns the objects already known for the video), `addPoints` (points normalised 0 to 1), `clearPointsInFrame`, `removeObject`, `clearPointsInVideo`, `objectTracks` (with each object's `history`: undo, redo, kept versions, and its `ranges` by state), `clearTrack`, `setObjectRange` (absent, present, or candidate with `source` and `score`; null clears, `clear` limits which states), `setObjectCandidates` (candidates in bulk), `undoSeeds`, `redoSeeds`, `restoreVersion`, `moveClicks`, `uploadVideo`, `deleteVideo`, `videos`, `defaultVideo` |
| Streams, `multipart/x-savi-stream` | `POST /track_objects {session_id, object_ids?, engine?}` streams one part per frame and ends with a `done` or `error` part. `POST /track_masks` streams cached tracks. |
| JSON | `GET /engines` (every engine, with why one can't run), `GET /limits` (upload length and size), `POST /cancel_track`, `POST /track_jobs`, `POST /track_disagreement`, `POST /track_provenance`, `POST /review_queue`, `POST /set_reviewed`, `POST /text_prompt`, `POST /rename_object`, `POST /object_names`, `POST /object_layout`, `POST /set_object_layout`, `POST /export`, `GET /linked-source` |

## Tests

```sh
pytest demo/backend/tests -q                         # backend, no model needed
SAM_UI_SLOW=1 PYTORCH_ENABLE_MPS_FALLBACK=1 pytest demo/backend/tests -q -k "slow or streamed"
                                                     # + real SAM 2 / SAM 3: streamed and pruned tracks
                                                     #   give the same masks as upstream on every frame
cd studio && npm test && npm run lint && npm run build
npm run smoke                                        # end to end in headless Chrome
SMOKE=both npm run smoke                             # + the browser-only build (headed Chrome, WebGPU)
CLIP_SECONDS=300 SERVE=dist-pages npm run memory     # browser build: memory and IoU over a long track
(cd desktop && npm test)                             # desktop: downloads, update check, AE bridge and export
python tools/memory_bench.py --seconds 10 60 180     # peak memory against clip length
python tools/hardware_bench.py --runs sam2 sam3 sam3-text --clips gallery:01_dog   # the Hardware figures
python tools/track_cache_e2e.py --api http://127.0.0.1:7373   # live backend (use a scratch one)
```

`tools/track_cache_e2e.py` uploads its own synthetic clips and deletes them when it
finishes. It also has `--after-restart`, `--correction`, `--responsive`,
`--absent`, `--bounded` and `--undo` checks.

## Licences and credits

- sam-ui is **Apache-2.0**, like SAM 2. It is a modified version of
  [SAM 2](https://github.com/facebookresearch/sam2) by Meta Platforms, Inc.
  [`NOTICE-sam-ui.md`](NOTICE-sam-ui.md) lists what changed. Files we modified carry
  a notice, and Meta's copyright headers are kept.
- **SAM 3 is not included.** Its code and weights are under Meta's
  [SAM License](https://huggingface.co/facebook/sam3), not Apache. sam-ui imports
  Hugging Face `transformers` at run time and loads weights you download yourself.
- The After Effects round trip goes through
  [AE MCP Vision](https://github.com/VolksRat71/after-effects-mcp-vision), a separate
  project you install yourself. sam-ui does not include it.
- The Inter font is under the SIL Open Font License; the licence ships with it in
  `studio/public/fonts/`.
- Meta's original README, with the model details, checkpoints and training, is
  [`docs/SAM2_UPSTREAM.md`](docs/SAM2_UPSTREAM.md).
