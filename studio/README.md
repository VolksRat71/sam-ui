<!-- sam-ui (Apache-2.0). New file, not from SAM 2. -->
# sam-ui studio

An editor-style frontend for the sam-ui backend: resizable panes, the video on
the left, collapsible Media, Objects and Effects sections on the right, and a
timeline along the bottom. It uses Meta's demo palette and interactions, and
it reuses Meta's demo code where it can: the video decoder and renderer
(`VideoWorkerContext`), the worker bridge, the effects, the RLE code, the
multipart parser and the Relay environment. It imports them from
`demo/frontend/src` through the `@/` alias, so nothing is copied.

**studio is a sandbox.** Meta's demo (`demo/frontend`) is still the UI that
gets served, and studio changes nothing in `demo/`. The two run side by side.

## Run it side by side

| What | Port | Command |
| --- | --- | --- |
| Backend (unchanged) | 7263 | as today |
| Meta's demo UI (unchanged) | 7262 | as today |
| **studio** | 7362 | `cd studio && npm install && npm run dev` |

studio talks to `http://localhost:7263` by default. To point it at another
backend, or change the object cap (16 by default), set these when you start it:

```sh
VITE_API_ENDPOINT=http://127.0.0.1:7363 VITE_OBJECT_LIMIT=24 npm run dev
```

Other scripts: `npm test` (vitest, the pure logic), `npm run lint`,
`npm run build` (tsc and vite; the output goes to `studio/dist`),
`npm run relay` (regenerates `__generated__/` after a GraphQL change; the
schema is `demo/frontend/schema.graphql`).

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

## Parity with Meta's demo UI

| Meta demo feature | studio |
| --- | --- |
| Gallery of videos, pick one | done (Media) |
| Upload a video (mp4/mov, 70 MB) | done (click or drop); uploads are listed with the gallery |
| Remove a video | missing: the backend has no mutation for it (nor does Meta's demo) |
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

## Swap checklist

To make studio the served UI in place of `demo/frontend` (a description, not
done):

1. Serve `studio/dist` where `demo/frontend`'s build is served now: the
   frontend Dockerfile and the `frontend` service in `docker-compose.yaml`
   copy the build, or run `npm run dev` / `vite preview` on port 7262.
2. Build with `VITE_API_ENDPOINT` set to the backend's public URL (the demo has
   it hard-coded in `DemoConfig.tsx`).
3. studio imports `demo/frontend/src` at build time. Either keep that folder
   (as a source library, no longer served), or move the modules studio uses
   into studio with their headers kept.
4. Check the backend's `API_URL`. studio builds video URLs from its own
   endpoint and does not read `Video.url`, but other clients might.
5. Decide what happens to uploads after a reload: add them to the `videos`
   query (a backend change), or keep studio's per-browser list.
6. Update `NOTICE-sam-ui.md` and the top-level README to say which UI is served.

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
- `__generated__/` folders are relay-compiler output.
