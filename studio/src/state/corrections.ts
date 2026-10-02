// sam-ui (Apache-2.0). New file, not from SAM 2.
// Fails safe like the backend: only engines that take "not here" skip the nudge.
//
// What a frame's clicks mean depends on the engine. SAM 2 (and the browser's
// SAM 2.1 tiny) was trained on a positive first, so negatives alone ask it to
// keep nothing: the click is refused and studio nudges for a positive. SAM 3
// takes negatives alone as "not on this frame", and studio asks whether the
// object is gone for a while.
const TAKES_NOT_HERE = new Set(['sam3']);

/** The backend's refusal of a frame with no positive (add_points on SAM 2). */
const NEEDS_POSITIVE = /(^|\s)needs_positive:/;

type Click = readonly [number, number, number];

export type Nudge = {objectId: number; frame: number; engine: string};

/** True when SAM 2 (or the browser's SAM 2.1 tiny) would be asked to keep nothing. */
export function needsPositive(points: ReadonlyArray<Click>, engine: string): boolean {
  return points.length > 0 && !points.some(p => p[2] === 1) && !TAKES_NOT_HERE.has(engine);
}

/**
 * What a frame's clicks going from `current` to `next` does, and the clicks
 * the frame keeps: send `next`, or nudge and keep `current` unchanged (nothing
 * is sent). `gone`: the sent list is negatives only on an engine that takes
 * them, so the frame empties and the "Gone for a while?" hint shows.
 */
export function planClicks<P extends Click>(
  current: ReadonlyArray<P>,
  next: ReadonlyArray<P>,
  engine: string,
): {kind: 'nudge'; points: ReadonlyArray<P>} | {kind: 'send'; points: ReadonlyArray<P>; gone: boolean} {
  if (needsPositive(next, engine)) {
    return {kind: 'nudge', points: current};
  }
  return {kind: 'send', points: next, gone: next.length > 0 && !next.some(p => p[2] === 1)};
}

/** True for the backend's `needs_positive:` refusal, bare or wrapped by Relay. */
export function isNeedsPositive(error: unknown): boolean {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return NEEDS_POSITIVE.test(text);
}
