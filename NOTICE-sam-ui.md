# sam-ui

sam-ui is a modified version of [SAM 2](https://github.com/facebookresearch/sam2)
by Meta Platforms, Inc., licensed under the Apache License 2.0 (see `LICENSE`).
The original copyright notices are kept in every file.

Files we changed carry a one-line "Modified by sam-ui" notice at the top, as
section 4(b) of the licence requires. New files under `demo/backend/server/tracks/`,
`demo/backend/tests/`, `tools/` and `studio/` are ours, except the `studio/` files
that carry Meta's header: those come from Meta's SAM 2 demo frontend (see below).

## Changes

- Docs: `README.md` is rewritten for sam-ui. Meta's original README moved to
  `docs/SAM2_UPSTREAM.md`, with its relative links adjusted, and `training/README.md`
  points its image-prediction link there. The README screenshot
  (`docs/images/studio.jpg`) shows Meta's own juggle sample.
- Footage guard: `.gitignore` rules and a pre-commit hook (`.githooks/`) that keep
  media and project data out of the repo. Enable with
  `git config core.hooksPath .githooks`.
- Per-object track cache (`demo/backend/server/tracks/`): every object's clicks are
  stored as seeds, and each object owns a cached track per engine under
  `DATA_PATH/tracks/`. `POST /track_objects` runs only the objects that are
  untracked or stale; `POST /track_masks` streams cached tracks back; GraphQL gains
  `objectTracks`, `clearTrack` and `StartSession.objects`. A new session replays the
  stored seeds, so objects survive a reload or restart. "Start over"
  (`clearPointsInVideo`) also forgets the cache.
- Feature cache (`tracks/features.py`): the image backbone's per-frame output is
  cached per video on the CPU and shared by the session and every track job, so a
  re-track skips the backbone (35% faster on the large model, masks identical).
  Budget `SAM_UI_FEATURE_CACHE_GB` (default 6, 0 turns it off); about 16 MB a frame.
- Track jobs hold the model lock one frame at a time, so clicks are served between
  frames (0.12 s during a job, where they used to wait for the whole job). Jobs can
  overlap; each claims its objects (state "tracking") so no two share one.
  `Job-Id` header, `POST /cancel_track {session_id, job_id}`, `POST /track_jobs
  {session_id}` for progress; `cancelPropagateInVideo` also cancels a session's jobs.
- Export (`tracks/export.py`, `POST /export`): tracked objects become a
  rotoscoping working folder (`products.json`, `anchors.json` in full-res pixels,
  `shots.json`, `data/mattes_tracked/<pid>/%05d.png` numbered from 1, optionally
  `data/clip.mp4` + `data/frames/`), which the rotoscoping-video-subjects pipeline
  loads and traces unchanged. Writes and deletes only under `SAM_UI_EXPORT_ROOT`
  (default ~/Movies/sam-ui), links followed, and never replaces confirmed
  decision files or existing mattes without `force`; its own notes and frames
  are always rewritten.
- studio (`studio/`) is the served UI: a Vite + React + TypeScript editor with
  resizable panes, preview, timeline, and Media / Objects / Effects sections, built
  on the per-object track API. **Meta's demo frontend (`demo/frontend`) was
  removed.** The parts of it studio uses are vendored, with Meta's headers, under
  `studio/src/meta/` in their original layout (from `demo/frontend/src` as of
  upstream commit 2b90b9f): the video decoder and renderer, worker bridge, effects
  and shaders, RLE code (jscocotools), multipart parser, Relay environment, logger
  and theme colours. `studio/scripts/meta-imports.py` lists what studio reaches.
  Changed there: `common/tracker/Trackers.ts` (no SAM2Model), and
  `common/components/video/VideoWorkerContext.ts` (frames from studio's
  `worker/frameStore.ts`, decoded on demand into a bounded cache, instead of
  every frame decoded up front). Adapted from Meta's
  files: `studio/src/worker/studio.worker.ts` (from `VideoWorker.ts`),
  `studio/src/worker/StudioSession.ts` (from `SAM2Model.ts`) and `studio/Dockerfile`
  (from `frontend.Dockerfile`). The GraphQL schema moved with it
  (`studio/schema.graphql`, `studio/schemas/`). The Inter font in
  `studio/public/fonts/` is under the SIL Open Font License (`Inter-OFL.txt`).
  The browser engine (`studio/src/local/`, "Browser · SAM 2.1 tiny") ports SAM 2's
  video propagation (`sam2/sam2_video_predictor.py`, `sam2/modeling/sam2_base.py`)
  to TypeScript. It depends on ONNX Runtime
  Web (`onnxruntime-web`, MIT, Microsoft), installed from npm and not vendored. It
  runs the Apache-2.0 SAM 2.1 tiny ONNX exports
  (`square-zero-labs/sam2.1-tiny-video-onnx`,
  `diffusionstudio/sam2.1-tiny-video-onnx-fp16`), which are fetched at run time and
  never committed.
  See `docs/using-studio.md` (*Browser engine*).
- Engines (`tracks/service.py`, `tracks/sam3_engine.py`): SAM 2 is the default and
  serves clicks; SAM 3's video tracker (Hugging Face transformers
  `Sam3TrackerVideoModel`, which runs on MPS) is opt-in per track job
  (`"engine": "sam3"`), built on first use. Each object keeps one cached track per
  engine (`ObjectTrack.tracks`); `GET /engines`; `POST /track_disagreement` flags
  frames where two engines' current tracks disagree. **SAM 3 is under Meta's SAM
  License, not Apache-2.0**: sam-ui only imports transformers at run time and loads
  weights from a local folder (`SAM_UI_SAM3_WEIGHTS`); no SAM 3 code or weights are
  in this repository.
- Video decoding uses PyAV instead of decord (`sam2/utils/misc.py`,
  `tracks/streaming.py`). `load_video_frames_from_video_file` decodes with PyAV
  through the filter graph decord ran, so resized frames are bit-identical to
  decord's; `tracks/streaming.py` decodes frames on request, 16 at a time, finding
  frame i by timestamp. decord is no longer a dependency.
- Changed upstream files: `setup.py`, `sam2/utils/misc.py`,
  `demo/backend/server/app.py`, `inference/predictor.py`, `data/schema.py`,
  `data/data_types.py`, `studio/schemas/inference-api-schema.graphql` (and the
  generated `studio/schema.graphql`), `docker-compose.yaml`, `README.md`,
  `demo/README.md`.
- Tests: `demo/backend/tests/` (`pytest demo/backend/tests`; `SAM_UI_SLOW=1` also runs
  the SAM 2 engine on a synthetic video) and `tools/track_cache_e2e.py` against a live
  backend.

## Running on Apple Silicon

Run the backend as a single process (`python -m flask --app app run --with-threads`),
not under gunicorn: a forked gunicorn worker cannot reach macOS's Metal compiler
service, and the first GPU call fails with "Unable to reach MTLCompilerService".
