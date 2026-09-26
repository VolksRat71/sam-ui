<!-- sam-ui (Apache-2.0). New file, not from SAM 2. -->
# sam-ui studio

sam-ui's web UI, an editor-style frontend for the backend in `demo/backend`:
resizable panes, the video on the left, collapsible Media, Objects and Effects
sections on the right, and a timeline along the bottom. It uses Meta's demo
palette and interactions, and it reuses Meta's demo code: the video decoder and
renderer (`VideoWorkerContext`), the worker bridge, the effects, the RLE code,
the multipart parser and the Relay environment, vendored under `src/meta/`.

It replaces Meta's demo frontend (`demo/frontend`), which was removed.

## Run it

```sh
cd studio
npm ci
npm run dev            # http://localhost:7362, against the backend on :7263
```

To point it at another backend, or change the object cap (16 by default), set
these when you start or build it:

```sh
VITE_API_ENDPOINT=http://127.0.0.1:7363 VITE_OBJECT_LIMIT=24 npm run dev
```

`docker compose up` from the repository root builds it (`studio/Dockerfile`)
and serves it on port 7262, next to the backend on 7263.

Other scripts: `npm test` (vitest, the pure logic), `npm run lint`,
`npm run build` (tsc and vite; the output goes to `studio/dist`), and
`npm run relay` (after a GraphQL change: merges `schemas/*.graphql` into
`schema.graphql`, then regenerates the `__generated__/` artifacts).

## Using it

- **Objects.** Click the video to add an object and a positive point. Right
  click adds a negative point, and the Add / Remove toggle swaps the two.
  Click a point to remove it. *Add object* starts the next object. If every
  click on a frame is negative, SAM 2 returns an empty mask, and studio shows a
  hint asking for a positive click.
- **Track** runs the objects that are untracked or stale. Tracked objects never
  re-run, and their masks stay on screen. Jobs run beside you: you can keep
  clicking, adding objects and correcting while one runs, and pressing Track
  again starts a second job for the objects the first does not hold. Each job
  shows its progress in the top bar and has its own cancel button.
- **Engines**: the SAM 2 / SAM 3 picker next to Track chooses which engine
  Track runs and which engine's tracks the preview shows (switching repaints
  from that engine's cache). An engine the backend cannot run is disabled,
  with the reason as its tooltip. SAM 3 loads on its first job (about 30 s,
  shown on the job). Clicks always go through SAM 2's session. Each object
  shows a badge per engine; *Clear track* clears the engine on screen. When
  both engines track an object with its current clicks, studio asks
  `/track_disagreement` and shows the mean IoU, and marks the frames that
  disagree in red on the object's swimlane.
- **Track state** is a badge on each object: untracked, stale, tracked, or
  tracking (a job holds it, possibly in another tab). *Clear track* forgets the
  cached track and keeps the clicks. *Remove* deletes the object.
- **Reload** brings everything back: the objects with their clicks, their state,
  and their cached tracks, repainted.
- **Start over** removes every object and cached track for the video. It asks
  first, in an in-app dialog.
- **Effects** are Meta's: a selected-object effect and a background, and
  clicking the active one again cycles its variants. The selected-object
  effect applies only to the focused object, and only once it is tracked;
  every other object keeps the overlay. Both groups start collapsed. *Export video with
  effects* renders an MP4 through Meta's encoder.
- **Export for rotoscoping** (bottom of Objects) writes the tracked objects as
  a rotoscoping working folder (`POST /export`), with a product id, prompt and
  colour per object, and then shows the manifest.
- **Zoom**: pinch, Ctrl/Cmd + wheel, or the buttons. The wheel pans, and so do
  a middle drag and Alt + drag. Only the video and its masks are pixels; the
  point markers are an SVG overlay in video coordinates, so they stay crisp
  and keep their size on screen at any zoom. At 200% and above the video
  shows real pixels.
- **Keys**: Space plays and pauses, and the arrow keys step one frame.

## Features

Compared with Meta's demo UI, which studio replaced:

| Feature | studio |
| --- | --- |
| Gallery of videos, pick one | done (Media) |
| Upload a video (mp4/mov, 70 MB) | done (click or drop); uploads are listed with the gallery |
| Remove a video | studio only (Meta's demo has none): a delete button on uploads, never on gallery videos, confirmed in an in-app dialog, with an option to keep the tracks. An open video's session closes first, and studio moves to the next video or the empty state |
| Default video (`defaultVideo`) | partial: the last video you used, else the first in the gallery |
| Click adds a positive point, right click a negative one | done |
| Add / Remove point toggle | done |
| Click a point to remove it | done |
| Several objects, each in its own colour | done (16 by default, Meta allows 3) |
| Per-object thumbnails | done |
| Filmstrip, playhead, play/pause, frame step | done |
| Per-object swimlanes (mask coverage and clicked frames) | done |
| Track (propagate) with progress | done, per object and incremental. Meta plays the video when tracking ends; studio stays on the frame you are on |
| Cancel tracking | done (per job, or all) |
| Start over | done, behind a confirmation |
| Remove object | done |
| Highlight and background effects, with variants | done, and changed: a selected-object effect applies only to the focused object once it is tracked (Meta applies it to every object); the others keep the overlay. Both effect groups start collapsed |
| Download the video with effects | done (Meta's encoder, and Meta's watermark) |
| Share section and "try another video" step | missing |
| First-click onboarding, snackbar tips, tooltips | partial: an empty-state line and the negative-click hint |
| Settings modal (API endpoints) | missing: set `VITE_API_ENDPOINT` instead |
| Mobile layout | missing (desktop only) |
| Loading and error screens | partial: session start, backend unreachable, and toasts for failed calls |
| Close the session on unload | missing: the backend expires idle sessions (30 min). A visible tab touches its session every 5 minutes to keep it |
| Stats overlay (debug) | missing |

Studio only: SAM 3 engine, per-engine badges and disagreement flags, objects restored on reload (with their seed masks), track-state badges, Clear track,
concurrent jobs, jobs from other tabs shown, zoom and pan, export for
rotoscoping, and keyboard shortcuts.

## Layout of the code

- `src/state/`: pure logic, with tests. The Objects reducer (`objects.ts`),
  timeline segments, zoom and pan, and the export form.
- `src/api/trackStream.ts`: reads `/track_objects` and `/track_masks`
  streams with Meta's multipart parser, closing and error parts included.
- `src/worker/`: the video worker. Meta's `VideoWorkerContext` decodes and
  draws. `StudioSession` (adapted from Meta's `SAM2Model`) makes the backend
  calls and keeps each object's masks. `MaskOverlayEffect` draws any number
  of masks.
- `src/bridge/StudioBridge.ts`: Meta's `VideoWorkerBridge` plus studio's
  typed RPC.
- `src/workspace/useStudioSession.ts`: one video's session: the calls, the
  reducer, and syncing from `objectTracks`.
- `src/components/`: the panes.
- `src/meta/`: Meta's demo frontend code that studio uses, in its original
  layout and with Meta's headers (`@/` points here). `scripts/meta-imports.py`
  lists what studio reaches; `--unused` lists vendored files nothing uses.
- `schema.graphql`, `schemas/`: the backend's GraphQL schema.
- `public/fonts/`: the Inter font, under the SIL Open Font License.
- `__generated__/` folders are relay-compiler output.
