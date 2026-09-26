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

## Running on Apple Silicon

Run the backend as a single process (`python -m flask --app app run --with-threads`),
not under gunicorn: a forked gunicorn worker cannot reach macOS's Metal compiler
service, and the first GPU call fails with "Unable to reach MTLCompilerService".
