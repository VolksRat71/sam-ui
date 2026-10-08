<!-- sam-ui (Apache-2.0). New file, not from SAM 2. -->
# sam-ui studio

sam-ui's web UI, a compositing-suite workspace for the backend in
`demo/backend` (its design is in [`DESIGN.md`](../DESIGN.md)): the preview at
the top left, a dock beside it with Review, Layer info, Effects and Media
sections, and a timeline below with a lane per object, where objects are
selected, grouped and reordered. It keeps Meta's demo interactions, and it
reuses Meta's demo code: the video decoder and renderer
(`VideoWorkerContext`), the worker bridge, the effects, the RLE code, the
multipart parser and the Relay environment, vendored under `src/meta/`.

It replaces Meta's demo frontend (`demo/frontend`), which was removed.

How to use it, control by control, is in [Using studio](../docs/using-studio.md).
Running sam-ui from source, the tests and the API are in
[Development](../docs/development.md).

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

The end-to-end smoke tests and the memory test over a long track are in
[Development](../docs/development.md#studios-smoke-and-memory-tests).

### Without a backend (the browser-only build)

Studio also runs with no backend at all, on the browser engine alone, when
built with `VITE_API_ENDPOINT=none` (that is the only way: any other build
waits for its backend, and shows an error with Retry if it never answers,
rather than quietly turning into the browser demo). It needs Chrome or Edge
on desktop (WebGPU). Firefox does not work yet (#4: ONNX Runtime Web's Pad
shader fails there). Safari itself is untested; Playwright's WebKit build
tracks (#3). What studio does then
is in [Using studio](../docs/using-studio.md#the-browser-only-build).

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
- `src/local/`: the browser engine, SAM 2.1 tiny on WebGPU. How it works and
  where it differs from Python SAM 2 is in
  [Browser engine](../docs/using-studio.md#browser-engine).
- `src/responsive.css`, `src/lib/layout.ts`, `src/lib/gestures.ts`: the
  phone and tablet layouts, and the touch gestures on the preview.
- `src/meta/`: Meta's demo frontend code that studio uses, in its original
  layout and with Meta's headers (`@/` points here). `scripts/meta-imports.py`
  lists what studio reaches; `--unused` lists vendored files nothing uses.
- `schema.graphql`, `schemas/`: the backend's GraphQL schema.
- `public/fonts/`: the Inter font, under the SIL Open Font License.
- `__generated__/` folders are relay-compiler output.
