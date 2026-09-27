// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The browser engine's memory budgets, in one place, sized for a 16 GB Mac
// (Apple silicon: CPU and GPU share it). Every per-frame cache it keeps is
// bounded here, so tracking a long clip plateaus instead of climbing:
//   - encoder outputs per frame (GPU tensors, plus feats2 as tokens on the
//     CPU): an LRU by bytes, per model size (ortModels.ts);
//   - memories and object pointers: a window of frames behind the one being
//     tracked, not per frame (tracker.ts prunes them);
//   - frames for the model: made per request and closed at once
//     (model.worker.ts), never cached;
//   - tracks: RLE, a few hundred bytes a frame per object.
// What is not bounded here is the decoded video itself: studio's player
// (Meta's decoder, src/meta) keeps every frame of the open clip, with or
// without a backend. That grows with the clip, so the browser build takes
// clips up to BROWSER_MAX_SECONDS.
import type {Quality} from './sam2/config';
import type {UploadLimits} from '~/state/uploadLimits';

/** Encoder-output cache per model size: about 5 MB a frame at 512, 20 MB at 1024. */
export const FEATURE_CACHE_BYTES: Record<Quality, number> = {
  512: 0.75e9,
  1024: 1.5e9,
};

/** Longest clip the browser build opens (its player holds every decoded frame). */
export const BROWSER_MAX_SECONDS = 90;

/** The browser build's limits: longer clips are refused, not trimmed. */
export const BROWSER_LIMITS: UploadLimits = {maxSeconds: BROWSER_MAX_SECONDS, maxMb: 500, over: 'refuse'};
