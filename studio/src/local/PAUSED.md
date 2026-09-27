<!-- sam-ui (Apache-2.0). New file, not from SAM 2. Working notes; delete when phase 2 lands. -->
# Browser engine: phases 1 and 2 done (2026-09-27)

Phase 2 (no-server mode on OPFS, MediaApi, `npm run build:pages`, the
no-server smoke run) is built; the Pages workflow is not (it waits for review).
The user-facing description and the list of approximations are in
`studio/README.md` (*Browser engine*).

## What is built
- `sam2/`: config, memoryBank, masks, tracker (pure, vitest with fake models),
  ortModels (ORT WebGPU, GPU-resident features, an LRU feature cache, one run queue).
- `models.ts` (studio/.models in dev, else Hugging Face into Cache Storage),
  `model.worker.ts` + `modelProtocol.ts` + `modelClient.ts`, `frames.ts`.
- `LocalEngine.ts` (host side, nested in studio's video worker), `localTracks.ts`
  (LocalTrackStore interface, MemoryTrackStore, state rules, objectTracks merge).
- studio wiring: StudioSession routes clicks, Track, cancel, repaint, Clear track,
  Remove and Start over for `browser-sam2`; EnginePicker.tsx is the one engine
  control; `pickerEngines`/`pickerLayout` cover a Pages build (SAM 3 disabled,
  linked to releases/latest), not yet switched on by any build flag.
- `parityPage.ts` + `e2e/parity.html` + `e2e/parity.mjs`.

## Gate 1 numbers (M-series Mac, Chrome 154, WebGPU)
- ms/frame (1 object / 3 objects): 512: 46 / 98; 1024: 252 / 573.
- Clicks: repeat on a cached frame 10-11 ms; new frame 32-37 ms (512), 105-109 ms
  (1024); first click after load 120-211 ms, about 1.5 s on the very first
  WebGPU run (shader compilation).
- Downloads: 83.2 MB (512), 190.1 MB (1024), plus ORT's wasm 26.8 MB (6.7 MB gzip)
  from our origin. A reload reads them from Cache Storage (0 Hugging Face requests).
- Chrome GPU process footprint (macOS `footprint`, sampled every 0.5 s): about
  +0.5 GB at 512 and +3.5 GB at 1024 over a ~0.55 GB baseline.
- Parity IoU (min / mean), fill off = fill on at 1024:
  squares 0.982/0.993, 0.963/0.986, 0.980/0.990; twotone 0.980/0.997, red only.
  512 (not gated): squares 0.964-0.971 min; twotone 0.948 min, red only.

## Open
- The GitHub Pages workflow (after review).
- With a backend, browser tracks still live in memory (a reload forgets them).
- Memory at 1024 is dominated by memory attention (7 x 4096 keys); the feature
  cache budget is 1.5 GB at 1024, 0.75 GB at 512.
