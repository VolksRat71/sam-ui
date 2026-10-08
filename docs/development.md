<!-- sam-ui (Apache-2.0). New file, not from SAM 2. -->
# Development

Running sam-ui from source, how its parts fit together, its API and its tests.
Studio and the desktop app have their own READMEs too:
[`studio/README.md`](../studio/README.md) and [`desktop/README.md`](../desktop/README.md).

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
otherwise. More in [`studio/README.md`](../studio/README.md); the desktop app's build is
in [`desktop/README.md`](../desktop/README.md).

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
| `SAM_UI_SAM3_DTYPE` | `fp16` on Apple Silicon, `fp32` elsewhere | SAM 3's precision: `fp32` for full precision, at about 1.6 times the time and 0.6 to 2.1 GB more memory; `bf16` moves masks more than `fp16` (see [Hardware](hardware.md)) |
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
  After Effects round trip; `src/update-check.js` the update notice; `src/mcp-server.js`
  and `src/mcp-tools.js` the [MCP server](#agents-mcp) for agents.

### API, in brief

| Kind | Endpoints |
| --- | --- |
| GraphQL, `POST /graphql` | `startSession` (returns the objects already known for the video), `addPoints` (points normalised 0 to 1), `clearPointsInFrame`, `removeObject`, `clearPointsInVideo`, `objectTracks` (with each object's `history`: undo, redo, kept versions, and its `ranges` by state), `clearTrack`, `setObjectRange` (absent, present, or candidate with `source` and `score`; null clears, `clear` limits which states), `setObjectCandidates` (candidates in bulk), `undoSeeds`, `redoSeeds`, `restoreVersion`, `moveClicks`, `uploadVideo`, `deleteVideo`, `videos`, `defaultVideo` |
| Streams, `multipart/x-savi-stream` | `POST /track_objects {session_id, object_ids?, engine?}` streams one part per frame and ends with a `done` or `error` part. `POST /track_masks` streams cached tracks. |
| JSON | `GET /engines` (every engine, with why one can't run), `GET /limits` (upload length and size), `POST /cancel_track`, `POST /track_jobs`, `POST /track_disagreement`, `POST /track_provenance`, `POST /review_queue`, `POST /set_reviewed`, `POST /text_prompt`, `POST /discover_text` (find a phrase across the clip, written as candidates), `POST /rename_object`, `POST /object_names`, `POST /object_layout`, `POST /set_object_layout`, `POST /export`, `POST /capture` (1 to 12 frames with the masks drawn on, as JPEG plus a legend, for agents), `GET /linked-source` |

### Agents (MCP)

`desktop/src/mcp-server.js` serves MCP (streamable HTTP, JSON replies) on
`127.0.0.1:8793/mcp` with the bearer token in `~/.sam-ui/token`
(`SAM_UI_TOKEN_DIR` moves it, for tests). The desktop app starts it when
**Agents → Allow agents (MCP)** is ticked. Against a dev backend it runs on its own,
on the same port, with the same token:

```sh
node desktop/src/mcp-server.js --backend http://127.0.0.1:7263
claude mcp add --transport http --scope user sam-ui http://127.0.0.1:8793/mcp --header "Authorization: Bearer $(cat ~/.sam-ui/token)"
```

Only one of the two can hold the port; the second says so and stops. The tools
(`desktop/src/mcp-tools.js`) are a thin layer over the API above, and name
videos, objects and jobs by id, never by path:

| Tool | Commands |
| --- | --- |
| `sam_query` | `videos`, `engines`, `objects` |
| `sam_session` | `open` (a video_id such as `gallery/01_dog.mp4`; answers with frame 0 drawn), `close` |
| `sam_edit` | `points`, `text` (both answer with the frame drawn), `range`, `undo`, `redo`, `remove` |
| `sam_track` | `start`, `wait` (up to 50 s, called again until done), `status`, `cancel` |
| `sam_review` | `queue`, `mark` |
| `sam_capture` | `frame`, `sheet` (`POST /capture`) |
| `sam_export` | a folder `name`, written to `~/Movies/sam-ui/<name>`; never `force` |

The server holds a track's stream open itself (a dropped reader cancels the job)
and keeps a finished job's result for 30 minutes. Its backend client never sends
the link token, so agents can't open files in place.

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
(cd desktop && npm test)                             # desktop: downloads, update check, AE bridge, export and MCP
python tools/memory_bench.py --seconds 10 60 180     # peak memory against clip length
python tools/hardware_bench.py --runs sam2 sam3 sam3-text --clips gallery:01_dog   # the Hardware figures
python tools/track_cache_e2e.py --api http://127.0.0.1:7373   # live backend (use a scratch one)
```

`tools/track_cache_e2e.py` uploads its own synthetic clips and deletes them when it
finishes. It also has `--after-restart`, `--correction`, `--responsive`,
`--absent`, `--bounded` and `--undo` checks.

### Studio's smoke and memory tests

Run these from `studio/`.

End-to-end smoke test (headless Chrome, a running backend and studio): upload,
three objects, Track, per-object effects, reload, video export (checked to play
in `<video>`), delete. It saves the export as `e2e/out/export.mp4`.

```sh
<backend venv>/bin/python e2e/make_clip.py e2e/out/clip.mp4 $RANDOM
CLIP=e2e/out/clip.mp4 STUDIO_URL=http://127.0.0.1:7362 API=http://127.0.0.1:7363 npm run smoke
swift e2e/avcheck.swift e2e/out/export.mp4   # decodes it with AVFoundation (QuickTime)
```

The no-server smoke test (headed Chrome, for WebGPU) runs against a studio
with no backend, such as the [browser-only build](../studio/README.md#without-a-backend-the-browser-only-build): it opens the clip
from disk, tracks three objects, reloads (restored from OPFS), renames one,
exports mask videos, Vector JSON and the roto zip, and deletes the video.
`SMOKE=both` runs the two.

```sh
CLIP=e2e/out/clip.mp4 SMOKE=local NO_SERVER_URL=http://127.0.0.1:7390/sam-ui/ npm run smoke
```

Memory over a long track, in the browser-only build (headed Chrome, macOS).
`npm run memory` makes a synthetic clip with ffmpeg (720p, 24 fps, a red
square over a grid) and opens it. It clicks the square on frame 0 and tracks
it to the end, then exports the mask video and scores its IoU against the
square on every 240th frame. It samples the physical footprint of every Chrome
process it started (macOS `footprint`, split into GPU, renderer and other),
the VideoToolbox decoders, the JS heap and the system's memory pressure, and
stops at critical pressure. The build has to accept the clip, so raise its limit:

```sh
VITE_BROWSER_MAX_SECONDS=900 npm run build:pages
CLIP_SECONDS=300 SERVE=dist-pages npm run memory   # serves it on :7999/sam-ui/
```

Rows go to `/private/tmp/sam-ui-memory/memory-clip300-720.csv`, one every 5 s,
and the summary to the `.json` beside it. The summary holds the frames, the time,
memory before the track, the plateau (median of the second half), the peak and
the IoU. `OPEN_ONLY=1` stops once the clip is open (no model, no WebGPU work),
and `MASK=<mask.mp4>` re-scores an exported mask video. The header of
`e2e/memory.mjs` lists the other settings.
