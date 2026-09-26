# sam-ui

sam-ui is a modified version of [SAM 2](https://github.com/facebookresearch/sam2)
by Meta Platforms, Inc., licensed under the Apache License 2.0 (see `LICENSE`).
The original copyright notices are kept in every file.

Files we changed carry a one-line "Modified by sam-ui" notice at the top, as
section 4(b) of the licence requires. New files under `demo/backend/server/tracks/`,
`demo/backend/tests/` and `tools/` are ours.

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
