// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Studio's memory budgets, in one place, sized for a 16 GB Mac (Apple
// silicon: CPU and GPU share it). Every per-frame cache is bounded here, so
// opening or tracking a long clip plateaus instead of climbing:
//   - decoded video frames: an LRU by bytes (worker/frameStore.ts), for the
//     player, effects, export and the browser engine alike;
//   - the browser engine's encoder outputs per frame (GPU tensors, plus
//     feats2 as tokens on the CPU): an LRU by bytes, per model size
//     (local/sam2/ortModels.ts);
//   - its memories and object pointers: a window of frames behind the one
//     being tracked, not per frame (local/sam2/tracker.ts prunes them);
//   - frames for the model: made per request and closed at once
//     (local/model.worker.ts), never cached;
//   - mask textures for the preview: MaskOverlayEffect keeps a few frames;
//   - tracks: RLE, a few hundred bytes a frame per object.
import type {Quality} from '~/local/sam2/config';
import type {UploadLimits} from '~/state/uploadLimits';

/** Encoder-output cache per model size: about 5 MB a frame at 512, 20 MB at 1024. */
export const FEATURE_CACHE_BYTES: Record<Quality, number> = {
  512: 0.75e9,
  1024: 1.5e9,
};

/** Decoded frames kept for the open video: about 740 frames of 720p, 330 of 1080p. */
export const DECODED_FRAME_BYTES = 1.0e9;

/**
 * Longest clip the browser build opens. Its memory no longer grows with the
 * clip (the frames above are an LRU): tracking a 2-minute 720p clip at 512
 * plateaued at 2.7-3.6 GB for all of Chrome, JS heap under 35 MB. 120 s is
 * the longest length measured end to end; a 5-minute run held the same
 * level (2.8-3.1 GB) for its first 196 frames before it was stopped, so
 * raising this to 300 needs that run finished: `npm run memory` (see
 * studio/README.md). Tracking takes about 0.3 s a frame at 720p, so 2
 * minutes takes about 15. VITE_BROWSER_MAX_SECONDS overrides it.
 */
export const BROWSER_MAX_SECONDS: number = Number(import.meta.env.VITE_BROWSER_MAX_SECONDS) || 120;

/** The browser build's limits: longer clips are refused, not trimmed. */
export const BROWSER_LIMITS: UploadLimits = {maxSeconds: BROWSER_MAX_SECONDS, maxMb: 500, over: 'refuse'};
