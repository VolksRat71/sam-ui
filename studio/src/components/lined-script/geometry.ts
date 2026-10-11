// sam-ui (Apache-2.0). New file, not from SAM 2.
import type {FrameRange} from '../../state/ranges';
import type {EffectClip} from '../../state/effectClips';

/** Zero-based frame boundaries; coverage ends inclusively, Look clips exclusively. */
export function rangeGeometry(range: Pick<FrameRange | EffectClip, 'start' | 'end'>, numFrames: number, end: 'inclusive' | 'exclusive') {
  if (!Number.isInteger(numFrames) || numFrames < 1) return {left: 0, width: 0};
  const start = Math.max(0, Math.min(numFrames, range.start));
  const stop = Math.max(start, Math.min(numFrames, range.end + (end === 'inclusive' ? 1 : 0)));
  return {left: start / numFrames * 100, width: (stop - start) / numFrames * 100};
}

/** Non-drop-frame display at a rounded nominal frame rate, matching AE frame numbering. */
export function formatTimecode(frameIndex: number, fps: number) {
  if (!Number.isFinite(fps) || fps < 1 || !Number.isFinite(frameIndex)) return '00:00:00:00';
  const rate = Math.round(fps);
  const index = Math.max(0, Math.floor(frameIndex));
  const seconds = Math.floor(index / rate);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60, index % rate]
    .map(value => String(value).padStart(2, '0')).join(':');
}
