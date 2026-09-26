<!-- sam-ui (Apache-2.0). New file, not from SAM 2. Working notes; delete when phase 1 lands. -->
# Browser engine, phase 1: paused 2026-09-26

## Done (committed)
- `onnxruntime-web@1.30.0` (MIT) in studio's dependencies, noted in `NOTICE-sam-ui.md`.
- `studio/.gitignore` ignores `.models` (the local model override).

## Done (not in git, by design)
Both exports are downloaded into `studio/.models/<repo>/{constants.json,onnx/*.onnx}`:

| repo | size | files |
| --- | --- | --- |
| `square-zero-labs/sam2.1-tiny-video-onnx` (1024, fp32) | 181 MB | vision_encoder 134.3 MB, memory_attention 32.3, mask_decoder 17.8, memory_encoder 5.6, pointer_tpos 0.07 |
| `diffusionstudio/sam2.1-tiny-video-onnx-fp16` (512) | 79 MB | vision_encoder 58.4 MB, memory_attention 13.0, mask_decoder 8.9, memory_encoder 2.8, pointer_tpos 0.03 |

## Half done
Nothing. No engine code is written yet; everything below is design.

## What the graphs are (checked in Node with ORT wasm)
- The encoder outputs feats0/feats1/feats2/feats2_no_mem/vision_pos_embed, all float32. At
  512 the features are 32x32, feats0 is 128x128 and feats1 is 64x64.
- The decoder takes `input_points [1,1,N,2]` in pixels of the model input and `input_labels`
  as int32. It returns ONE mask (`iou [1,1]`) at N=1 and at N=2, so the multimask choice is
  made in-graph, for both exports. A `selectMask` helper is still worth having, for a
  decoder that returns K>1.
- The memory encoder returns memory_tokens and memory_pos, each [F*F,1,64]. memory_pos is a
  sine PE, so it should be identical on every frame: check that, then read it back once.
- Memory attention takes `current_vision_features [F*F,1,256]`. That is feats2 TRANSPOSED
  (flatten(2).permute(2,0,1)), not reshaped: read feats2 back once per frame, transpose it on
  the CPU, and cache the result. The same goes for vision_pos_embed, once per video.
  Memory is [7*F*F+64,1,64].
- pointer_tpos is dynamic [P] in square-zero and fixed [16] in diffusionstudio: always pass 16.
- constants.json keys differ. square-zero has image_size, feat_size, mem_dim, num_maskmem,
  max_object_pointers and no_obj_score. diffusionstudio has image_size and memory_frames.
  Both have image_mean, image_std and memory_temporal_positional_encoding (7x64).

## Semantics to port (read from sam2/sam2_video_predictor.py and sam2_base.py)
- **tpos rows.** A conditioning memory uses row 6. The memory k frames back (t_rel = k)
  uses row k-1, since `maskmem_tpos_enc[num_maskmem - t_pos - 1]` with t_rel = 7 - t_pos.
- **Every conditioning frame is used** (`max_cond_frames_in_attn = -1`), plus the
  non-conditioning memories at t_rel 1..6, if present.
  - The export has a FIXED 7 blocks. Keep the cond frames first (up to 7, closest in
    time), then the most recent non-cond ones, until the blocks are full. With 2 seeds
    (twotone) this drops the t_rel=6 memory on late frames: an approximation to document.
  - Pad by duplicating the most recent block. Block order does not matter (RoPE is spatial
    within a block).
- **Pointers.** Take the cond pointers in the past (t <= f forward, t >= f in reverse), with
  diff |f-t|. Then take the non-cond pointers at t_diff 1..min(N,16)-1, stopping at the video
  edge.
  - Normalise by min(N,16)-1.
  - Cap at 16 by smallest diff, and pad by duplicating the most recent.
  - With ZERO pointers (an object tracked before its first seed, in the forward pass),
    Python uses no pointer tokens. Fall back to the nearest future cond pointer, and document it.
  - A 256-d pointer becomes 4 tokens of 64. Token 4i+j is ptr_i[64j:64j+64], and its pos is
    pointer_pos[i].
- **Order** is Python's (`tracks/engine.py`):
  1. Seed frames are processed frame-major. Each is an init cond frame (no memory,
     feats2_no_mem).
  2. The seed memory uses binarize=1.
  3. The forward pass runs from start = min(seed frame) to N-1.
  4. The reverse pass runs from start-1 to 0, reusing the forward pass's non-cond outputs.
- **Tracked frames** use one padding point (0,0), label -1, with binarize=0.
  Output = low_res_mask [1,1,256,256], resized bilinearly (align_corners=False, no antialias)
  to the video size, then thresholded at 0. Object-score gating is in-graph (-1024 logits,
  the no-obj pointer).
- **Hole fill** (fill_hole_area=8: background components of 8 px or less, 8-connected,
  in the low-res logits, set to 0.1) is UPSTREAM behaviour. But `sam2._C` is not built in
  the repo's .venv, so the parity reference ran WITHOUT it. Make it an option, and note
  this in the parity report.
- **Approved-mask seed** (`add_new_mask` with `use_mask_input_as_output_without_sam`):
  - output = the approved mask;
  - memory = memory_encoder(feats2, mask resized to S with antialias, then >=0.5, then
    *20-10, score +10 (or -10 if empty), binarize=1);
  - pointer = the decoder on that frame's clicks (feats2_no_mem). Our decoder has no mask
    input: that is the approximation.
- Python frames are decord-resized to SxS (no aspect preservation) and normalised with
  ImageNet mean and std. In the browser, use `createImageBitmap(videoFrame, {resizeWidth: S,
  resizeHeight: S, resizeQuality: 'high'})` in the studio worker, then transfer it.

## Planned layout
- `src/local/sam2/config.ts`: the two variants (URLs, sizes) and a parser for both
  constants.json shapes.
- `src/local/sam2/memoryBank.ts` (pure): `planMemory` (blocks, tpos rows, pointers,
  normalised diffs, padding) and `assembleMemory` (the Float32Arrays).
- `src/local/sam2/masks.ts` (pure):
  - bilinear resize, torch-exact, with and without antialias;
  - logits to RLE, column-major, through `meta/jscocotools/mask.ts`;
  - approved RLE to mask input, `fillHoles`, `selectMask`, IoU, and preprocessing.
- `src/local/sam2/tracker.ts`: `Sam2Tracker` over a `Sam2Models` interface (features,
  decode, memory, attend, pointerPos). It does `click()` and `track()`, an async generator
  with an AbortSignal, and holds per-object cond and non-cond maps, pruned to the 6/15-frame
  windows (plus start+1..start+15, for the reverse pass). Vitest can drive it with fake models.
- `src/local/sam2/ortModels.ts`:
  - ORT WebGPU, with `preferredOutputLocation` gpu-buffer for the encoder feats, the
    decoder's high_res_mask and attention's conditioned_feats;
  - an LRU feature cache by bytes (about 20 MB a frame at 1024, 5 MB at 512), with
    tensors disposed on eviction;
  - one mutex around every run, so clicks interleave between a job's frames;
  - `ort.env.wasm.numThreads = 1`.
- `src/local/models.ts`: fetch from `/.models/<repo>/...` in dev when it exists, else
  `https://huggingface.co/<repo>/resolve/main/...`, cached in Cache Storage, with progress
  events. Vite may need `optimizeDeps.exclude: ['onnxruntime-web']`.
- `src/local/model.worker.ts` and `src/local/modelClient.ts`: the RPC calls (load, click,
  track with a frame stream, cancel, stats). The worker asks its host for frames
  (`needFrame`, then an ImageBitmap back). It is spawned from the studio worker as a
  nested worker. Check that Vite builds it.
- `src/local/LocalEngine.ts`: used by StudioSession when the engine on screen is
  `browser-sam2`, labelled "Browser · SAM 2.1 tiny".
  - Clicks run locally and ALSO call the server's addPoints, only to persist seeds this
    phase. The local mask is shown and kept as the local approved mask.
  - The approved mask for a local Track is the latest click's mask on that frame, from
    either engine.
  - `LocalTrackStore` interface, with an in-memory implementation now and OPFS in phase 2.
  - `objectTracks` merges a local track entry per object: tracked if the seeds key and the
    variant match, stale otherwise, tracking while a local job holds it.
  - Roto export refuses the browser engine for now, with a clear message.
- UI:
  - `engineLabel` knows `browser-sam2`;
  - a 512/1024 toggle beside the picker, remembered;
  - a model-download status in the top bar;
  - `EngineInfo` gains an optional `href`, so a disabled engine can link somewhere (the
    Pages SAM 3 entry, later).
- `studio/e2e/parity.html` + `parity.mjs`:
  - decode the fixture clip with mediabunny, run the tracker with the ref.json seeds, and
    report per-frame IoU, min and mean per object, and ms/frame;
  - run it in headed Chrome through playwright-core on a Vite dev server on :7372, with
    `--enable-unsafe-webgpu` if needed.

## Exact next step
Write `src/local/sam2/memoryBank.ts` and `masks.ts`, with their vitest files. Then
`tracker.ts`, with a fake-model test that covers the approved-mask seed path. Then
`ortModels.ts` plus the parity page, and get the 1024 IoU against
`e2e/fixtures/parity/*.ref.json` before wiring studio.

## Numbers so far
Download sizes only (above). No timing, memory or parity numbers yet.
