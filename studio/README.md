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

End-to-end smoke test (headless Chrome, a running backend and studio): upload,
three objects, Track, per-object effects, reload, video export (checked to play
in `<video>`), delete. It saves the export as `e2e/out/export.mp4`.

```sh
<backend venv>/bin/python e2e/make_clip.py e2e/out/clip.mp4 $RANDOM
CLIP=e2e/out/clip.mp4 STUDIO_URL=http://127.0.0.1:7362 API=http://127.0.0.1:7363 npm run smoke
swift e2e/avcheck.swift e2e/out/export.mp4   # decodes it with AVFoundation (QuickTime)
```

The no-server smoke test (headed Chrome, for WebGPU) runs against a studio
with no backend, such as the browser-only build below: it opens the clip
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

### Without a backend (the browser-only build)

Studio also runs with no backend at all, on the browser engine alone, when
built with `VITE_API_ENDPOINT=none` (that is the only way: any other build
waits for its backend, and shows an error with Retry if it never answers,
rather than quietly turning into the browser demo). It needs Chrome or Edge
on desktop (WebGPU). Safari and Firefox are untested. Then:

- Studio asks for a WebGPU adapter at start. Without a working one, a notice
  (not dismissible) says the browser can't run the demo and points at Chrome,
  Edge or the desktop app, and nothing can be clicked or tracked. With a
  backend, the browser engine's entry is disabled instead: "Needs WebGPU".

- Media lists the videos opened into this browser (copied into the Origin
  Private File System under their sha256; nothing is uploaded) and any
  bundled samples. Delete removes a video, and with it its objects and tracks.
- Seeds (clicks and approved masks), object names and browser tracks live in
  OPFS, keyed by the video's sha256 as the backend keys them, so a reload
  restores them. Effects stay in localStorage, as with a backend.
- The picker lists SAM 2.1 large and SAM 3 disabled, linking to the desktop
  app, and a banner (once, dismissible) says the browser version is a demo,
  tested in Chrome.
- Every export works: mask videos, Vector JSON and the roto working folder as zips.

`npm run build:pages` makes that build for GitHub Pages: base `/sam-ui/`,
no backend, output in `dist-pages/`, with two of Meta's gallery clips
(`05_default_juggle.mp4`, `01_dog.mp4` from `demo/data/gallery`) as samples.
It holds no model files: the models come from Hugging Face on first use and
are kept in Cache Storage. ONNX Runtime runs with one wasm thread, so the
site needs no cross-origin isolation. To look at it as Pages would serve it:

```sh
npm run build:pages
mkdir -p /tmp/pages && ln -sfn "$PWD/dist-pages" /tmp/pages/sam-ui
python3 -m http.server 7390 --bind 127.0.0.1 --directory /tmp/pages   # http://127.0.0.1:7390/sam-ui/
```

## Using it

- **Objects.** Click the video to add an object and a positive point. Right
  click adds a negative point, and the Add / Remove toggle swaps the two.
  Click a point to remove it. *Add object* starts the next object. On a
  tracked frame a click refines the tracked mask: a negative, sent with a
  positive on the part to keep, cuts away the region it is on. If every click
  on a frame would be negative, SAM 2 needs a positive to keep something:
  studio sends nothing, keeps the clicks as they were, and nudges you to add a
  positive to trim or, when SAM 3 is available, to switch to it. On SAM 3 a
  lone negative empties the frame, and studio asks "Gone for a while?".
- **Review flags.** While scrubbing, F flags the current frame of the selected
  object (the flag button in the transport does the same). Each flag is a
  yellow marker on the object's lane that seeks there when clicked; clicks on
  that frame clear it. After a correction the object's track is stale: studio
  keeps showing it, faded, until the re-track, so the other flagged frames can
  be corrected against it. On SAM 2 the re-track runs only a stretch around
  each correction and keeps the rest of the cached track; its job chip says
  *near corrections* while it does.
- **Absent ranges.** Drag across an object's lane to select frames, then
  *Mark absent* in the transport when the object is not in the shot there. The
  range shows as a hatched block on the lane; its frames are empty in the
  preview and in every export, and tracking skips them. Each side of the gap is
  tracked from its own clicks, and a side with none stays empty, with a "click
  the object after the gap" hint on the lane. A positive click inside an absent
  range says the object is back: the range ends on the frame before it (and
  goes, when the click is on its first frame), and the click segments as
  usual. Clicks there with no positive are refused, with a note saying so; to
  place them, click the block to select it and *Unmark* it (all of it, or a
  dragged part) first. *Gone for a while?* (from the SAM 2 nudge, or after
  SAM 3 empties a frame) marks the object absent from that frame to the frame
  before its next click, or to the clip's end; from the nudge it first clears
  the clicks the nudge kept on that frame. Escape drops a selection.
- **Candidate and present ranges.** A lane draws four kinds of frame by shape,
  not colour, with a legend under the lanes: *unknown* is the plain thin line, a
  *candidate* (a model or tool thinks the object is there, nobody has said) a
  dotted outline, *present* a solid bracket along the lane's foot, and *absent*
  the hatched block. The solid line in the object's colour is still the tracked
  mask, drawn apart from all four. Drag a span and *Mark present* to confirm the
  object is there; *Unmark* makes a span unknown again. Click a candidate (or
  press ] and [ to step through the selected object's) to see its source and
  score, then *Present* (P), *Absent* (A) or *Reject* (R); the next candidate is
  picked for you. Present and candidate ranges never change a mask or make a
  track stale; confirming absent does, and Cmd-Z takes it back. Exports list
  every range with its state in README.txt and the roto folder's JSON;
  candidates never blank a mask.
- **Review.** The Review section lists the few stops worth a look on the
  engine on screen, best first, each with why (engines disagree, track stops,
  reappears, area jump, jumps, pieces change, re-tracked, candidate starts,
  flagged) and a score, and its badge counts the ones left. Click a stop, or
  press . and , to step through them; *Looks right* (Y) marks the one on screen
  reviewed and goes to the next. If it is wrong, correct it with clicks as
  usual and track again: only the stops the re-track remade open again. On the
  timeline a stop is a downward triangle above its lane, a check mark once
  reviewed. Without a backend the browser engine's queue is built in the tab
  and its marks kept in this browser. The roto folder's `data/review.json`
  carries the queue, reviewed or not.
- **Undo.** Cmd-Z undoes the selected object's last click, cleared frame or
  range edit, and Shift-Cmd-Z redoes it (Ctrl-Z and Ctrl-Y elsewhere; Undo and
  Redo on the object's row do the same). Neither fires while you type in a
  field. When a track of the clicks you go back to is kept, it shows at once,
  tracked, with no re-track; otherwise the object is stale, as after any click.
  Undo waits while a job tracks the object. *Versions* on the selected object
  lists its kept tracks with when they were tracked, the engine and the number
  of clicks; click one to go back to it (that is undoable too). With a backend
  the list is the backend's; browser-engine tracks come back with undo.
- **Wrong object?** When the selected object has clicks on the frame on
  screen, *Move these clicks to* hands them to another object, which segments
  them as if you had clicked it. Each object can undo its side. An object
  marked absent on that frame, or being tracked, is not offered.
- **Which object is selected.** Its mask has a wider outline ringed in white,
  and the other objects dim while it is selected.
- **Text prompts.** With SAM 3 on screen, the selected object's row has a
  *Find by text* field: type a phrase ("dog", "the red cup") and *Find*. The
  phrase's best match on the frame on screen becomes that frame's mask,
  replacing its clicks, and the row says the score, and how many things
  matched when several did. A click on that frame refines the mask and keeps
  the text, and deleting the frame's last click goes back to the text's mask.
  To trim it on SAM 2 or the browser engine, add a positive with the
  negatives: a negative alone is refused there, as on any frame. A phrase that
  matches nothing changes nothing. The frame is marked on the lane like a
  clicked one, titled with its text. With SAM 2 or the browser engine the
  field is disabled and says why (`GET /engines` reports `text` per engine).
- **Names.** Objects are *Object N* until renamed:
  double-click the name (or the pencil) to rename it in place. Names are
  stored with the seeds (`POST /rename_object`) and never make a track stale;
  numbers are never reused after a delete.
- **Order and groups.** Drag an object by its handle to reorder it, or onto a
  group's header to put it in that group; Alt-Up / Alt-Down on the handle,
  the arrow buttons and each object's *Group* menu do the same from the
  keyboard. *New group* makes a group holding the selected object (or an
  empty one). A group has a name, a colour, and collapses; its header can
  Track only its stale or untracked members, clear their tracks, give them
  all one effect, hide them in the preview (exports keep them) and Ungroup
  (the objects stay, ungrouped). The order is also the timeline lanes' and
  every export's: each group gets a folder in the zips (and
  `data/groups/<group>/` in the roto folder), with an optional union mask per
  group, and README.txt and the JSON name each object's group. The layout is
  stored per video (`tracks/<video>/layout.json`, or OPFS with no backend),
  outside the seeds hash: reordering never makes a track stale and is not an
  undo step. Videos from before keep creation order.
- **Track** runs the objects that are untracked or stale. Tracked objects never
  re-run, and their masks stay on screen. Jobs run beside you: you can keep
  clicking, adding objects and correcting while one runs, and pressing Track
  again starts a second job for the objects the first does not hold. Each job
  shows its progress in the top bar and has its own cancel button.
- **Engines**: the engine button next to Track chooses which engine Track
  runs and which engine's tracks the preview shows (switching repaints from
  that engine's cache). Its popover lists SAM 2, SAM 3 and the browser engine;
  one that cannot run here is disabled, with the reason (and a link, when it
  has one). SAM 3 loads on its first job (about 30 s,
  shown on the job). Clicks always go through SAM 2's session. Each object
  shows a badge per engine; *Clear track* clears the engine on screen. When
  both engines track an object with its current clicks, studio asks
  `/track_disagreement` and shows the mean IoU, and marks the frames that
  disagree in red on the object's swimlane.
- **Browser · SAM 2.1 tiny** runs SAM 2.1 tiny in the browser, on WebGPU
  (see *Browser engine* below). With it chosen, clicks and Track run in this
  browser; the backend still stores the clicks. Its popover entry holds the
  model size, 512 px (fp16, 83 MB) or 1024 px (fp32, 190 MB), and an optional
  hole fill; tracks made with another setting show as stale. The model
  downloads on first use (progress on the engine button) and is kept in the
  browser's Cache Storage. With a backend its tracks live in this tab (a
  reload forgets them); with no backend they are kept in the browser.
- **Track state** is a badge on each object: untracked, stale, tracked, or
  tracking (a job holds it, possibly in another tab). *Clear track* forgets the
  cached track and keeps the clicks. *Remove* deletes the object.
- **Reload** brings everything back: the objects with their clicks, their state,
  and their cached tracks, repainted.
- **Start over** removes every object and cached track for the video. It asks
  first, in an in-app dialog.
- **Effects** are Meta's. Each object keeps its own selected-object effect
  and variant (Original, Pixelate, Emoji, ...) until you change it: selecting
  an object only chooses which object the buttons edit, and they show its
  effect. New objects start on the coloured Overlay. The background effect is
  one per video. Clicking the active effect again cycles its variants. Both
  groups start collapsed. Effects are saved per video in this browser.
- **Export** (top bar) is one menu; every dialog has a File name field,
  prefilled from the video's name, and the files inside are named after the
  objects (unique, in object order). The mask items take every object with a
  track on the engine on screen, and every zip has a README.txt naming the
  engine, model, video, frame count and fps.
  - *Mask videos (.zip)*: one grayscale H.264 MP4 per object (white object,
    black background) at the video's size and fps. H.264 is lossy: threshold
    at 128 to get the mask back.
  - *PNG sequence / roto working folder*: the layout of
    `demo/backend/server/tracks/export.py` (products, anchors, shots, 8-bit
    PNG mattes). For a server engine the backend writes it (`POST /export`,
    under its export root, with extract-frames and overwrite options); for
    browser tracks, or with no backend, studio builds it and saves a zip.
  - *Vector JSON (.zip)*: one JSON per object in the rotoscoping skill's
    `contours.py` format (`add`/`sub` outline slots per frame, plus `engine`,
    `model` and `object`), traced as OpenCV does (`src/state/contours.ts`).
  - *Export to After Effects*: not yet.
  - *Video with effects (.mp4)*: the whole video rendered in the browser,
    every object with its own effect and the background effect. Objects never
    given an effect render as Original by default, or as shown (the Overlay).
    No point markers, selection highlights or watermark; it plays in
    QuickTime and browsers (constant frame rate, even size, moov atom first).
- **Zoom**: pinch, Ctrl/Cmd + wheel, or the buttons. The wheel pans, and so do
  a middle drag and Alt + drag. Only the video and its masks are pixels; the
  point markers are an SVG overlay in video coordinates, so they stay crisp
  and keep their size on screen at any zoom. At 200% and above the video
  shows real pixels.
- **Keys**: Space plays and pauses, the arrow keys step one frame, F flags
  the frame for a correction, Cmd-Z / Shift-Cmd-Z undo and redo the selected
  object's clicks, . and , step through the review queue, Y says its stop looks
  right, and Escape drops a lane selection.

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
| Highlight and background effects, with variants | done, and changed: each object has its own effect (Meta applies one to every object); the background stays one per video. Both effect groups start collapsed |
| Download the video with effects | done, and changed: Export video in the top bar, studio's own encoder (mediabunny), no watermark, untouched objects as Original by default |
| Share section and "try another video" step | missing |
| First-click onboarding, snackbar tips, tooltips | partial: an empty-state line and the negative-click nudge |
| Settings modal (API endpoints) | missing: set `VITE_API_ENDPOINT` instead |
| Mobile layout | missing (desktop only) |
| Loading and error screens | partial: session start, backend unreachable, and toasts for failed calls |
| Close the session on unload | missing: the backend expires idle sessions (30 min). A visible tab touches its session every 5 minutes to keep it |
| Stats overlay (debug) | missing |

Studio only: SAM 3 engine, the in-browser SAM 2.1 tiny engine, per-engine badges and disagreement flags, objects restored on reload (with their seed masks), track-state badges, Clear track, absent ranges, candidate and present ranges, undo with kept track versions, text prompts (SAM 3),
concurrent jobs, jobs from other tabs shown, zoom and pan, export for
rotoscoping, and keyboard shortcuts.

## Browser engine

`src/local/` runs SAM 2.1 tiny video tracking client side, with ONNX Runtime
Web on WebGPU (`ort.env.wasm.numThreads = 1`, so no cross-origin isolation is
needed). The models are the Apache-2.0 exports
[square-zero-labs/sam2.1-tiny-video-onnx](https://huggingface.co/square-zero-labs/sam2.1-tiny-video-onnx)
(1024 px, fp32) and
[diffusionstudio/sam2.1-tiny-video-onnx-fp16](https://huggingface.co/diffusionstudio/sam2.1-tiny-video-onnx-fp16)
(512 px), fetched from Hugging Face at run time and never committed. In dev,
a copy in the gitignored `studio/.models/<repo>/` is used instead
(`VITE_MODEL_BASE` points elsewhere).

- `sam2/`: the propagation logic ported from `sam2/sam2_video_predictor.py` and
  `sam2/modeling/sam2_base.py` (memory bank, object pointers, forward then
  reverse pass, seeds), the pixel work (torch-exact resizes, RLE, hole fill),
  and the five graphs on ORT (`ortModels.ts`, with a per-frame feature cache).
- `model.worker.ts`: a worker nested in the video worker, fed the frames
  studio already decodes. `LocalEngine.ts` is its host side, and
  `localTracks.ts` the track state rules (tracks in memory with a backend).
- With no backend: `kv.ts` (OPFS), `offlineStores.ts` (the seed and track
  stores and a TrackService for the browser engine, ported from
  `demo/backend/server/tracks`, with their tests) and `localMedia.ts` (the
  videos). `src/media/` is the MediaApi the Media list uses either way.
- Undo and versions run here too. Both track stores keep the last 10 tracks of
  each object and bring one back when its clicks return; with no backend they
  live in OPFS (`tracks/<video>/<obj>/versions/`, a full copy each, since OPFS
  has no hard links), next to an undo history in `seeds/<video>/<obj>/history.json`.
  With a backend the browser tracks and their versions stay in this tab.

Where it differs from Python SAM 2:

- The export's memory attention takes exactly 7 memory blocks and 16
  pointers. Where SAM 2 has fewer, the newest is repeated. Where it has more
  (an object with several seed frames, late in the clip), every seed frame is
  kept and the oldest recent frames are dropped.
- Before an object's first seed (in the forward pass), SAM 2 attends to no
  object pointer. The export needs one, so the nearest seed's is used.
- An approved-mask seed (the mask the user saw on a seed frame) is the
  frame's output and its memory, as in SAM 2. But its object pointer comes
  from the decoder run on the frame's clicks, since the exported decoder has
  no mask input (SAM 2 runs it with the mask as its dense prompt).
- Frames are resized to the model size by the browser, not by FFmpeg's
  bicubic scaler as the backend resizes them.

Parity with Python SAM 2.1 tiny runs in headed Chrome (WebGPU needs a GPU):

```sh
node e2e/parity.mjs        # its own Vite on :7372; QUALITIES=1024 CLIPS=twotone to narrow
```

It tracks the fixtures in `e2e/fixtures/parity/` (made by
`tools/make_parity_fixtures.py`, without hole fill) and requires, at 1024
px, IoU >= 0.95 on every frame, and that the two-tone clip keeps only the red
half after its frame-10 correction. Results go to `e2e/out/parity.json`.

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
