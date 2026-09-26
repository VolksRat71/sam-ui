# sam-ui

sam-ui is a modified version of [SAM 2](https://github.com/facebookresearch/sam2)
by Meta Platforms, Inc., licensed under the Apache License 2.0 (see `LICENSE`).
The original copyright notices are kept in every file.

Files we changed carry a one-line "Modified by sam-ui" notice at the top, as
section 4(b) of the licence requires. New files under `demo/backend/server/tracks/`,
`demo/backend/tests/`, `tools/` and `studio/` are ours, except the `studio/` files
that carry Meta's header (adapted from `demo/frontend`).

## Changes

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
  loads and traces unchanged. Writes only under `SAM_UI_EXPORT_ROOT` (default
  ~/Movies) and never replaces confirmed decision files without `force`.
- studio (`studio/`, a sandbox beside `demo/frontend`, which is unchanged and still
  served): a Vite + React + TypeScript editor UI with resizable panes, preview,
  timeline, and Media / Objects / Effects sections, built on the per-object track
  API. It imports Meta's demo modules from `demo/frontend/src` (decoder, renderer,
  worker bridge, effects, RLE, multipart parser, Relay environment). Two files are
  adapted from Meta's (`src/worker/studio.worker.ts` from `VideoWorker.ts`,
  `src/worker/StudioSession.ts` from `SAM2Model.ts`). See `studio/README.md`.
- Changed upstream files: `demo/backend/server/app.py`, `inference/predictor.py`,
  `data/schema.py`, `data/data_types.py`, `demo/frontend/schemas/inference-api-schema.graphql`
  (and the generated `demo/frontend/schema.graphql`).
- Tests: `demo/backend/tests/` (`pytest demo/backend/tests`; `SAM_UI_SLOW=1` also runs
  the SAM 2 engine on a synthetic video) and `tools/track_cache_e2e.py` against a live
  backend.

## Running on Apple Silicon

Run the backend as a single process (`python -m flask --app app run --with-threads`),
not under gunicorn: a forked gunicorn worker cannot reach macOS's Metal compiler
service, and the first GPU call fails with "Unable to reach MTLCompilerService".
