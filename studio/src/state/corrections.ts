// sam-ui (Apache-2.0). New file, not from SAM 2.
// Fails safe like the backend: only engines that take "not here" skip the nudge.
//
// What a frame's clicks mean depends on the engine. SAM 2 (and the browser's
// SAM 2.1 tiny) was trained on a positive first, so negatives alone ask it to
// keep nothing: the click is refused and studio nudges for a positive. SAM 3
// takes negatives alone as "not on this frame", and studio asks whether the
// object is gone for a while.
import {absentUntilNextSeed} from './ranges';

const TAKES_NOT_HERE = new Set(['sam3']);

/** The backend's refusal of a frame with no positive (add_points on SAM 2). */
const NEEDS_POSITIVE = /(^|\s)needs_positive:/;

type Click = readonly [number, number, number];

export type Nudge = {objectId: number; frame: number; engine: string};
/** SAM 3 took a frame's negatives alone and emptied it: "Gone for a while?" for that object and frame. */
export type Hint = {kind: 'gone'; objectId: number; frame: number};

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

/**
 * What deleting a click from a frame does. The last click going from a text
 * frame goes back to the text's mask (sending no clicks would clear the frame,
 * text and all), and it asks for the first engine that reads text (`engine:
 * null`), not the one on screen: on SAM 2 or the browser engine the backend
 * refuses a text prompt named for them. Anything else is a correction of the
 * frame's clicks.
 */
export function planRemoval(
  rest: ReadonlyArray<Click>,
  text: string | null | undefined,
): {kind: 'restoreText'; text: string; engine: null} | {kind: 'correct'} {
  return rest.length === 0 && text != null ? {kind: 'restoreText', text, engine: null} : {kind: 'correct'};
}

/**
 * True when clicks on a frame inside an absent range are refused: none is a
 * positive, so nothing says the object is back. A positive goes through and
 * ends the absence at that frame (the backend trims the range); an emptied
 * frame goes through too. Asked before planClicks: on an absent frame the SAM 2
 * nudge's "add a positive" would end the absence, not trim.
 */
export function refusedAsAbsent(next: ReadonlyArray<Click>, absent: boolean): boolean {
  return absent && next.length > 0 && !next.some(p => p[2] === 1);
}

export type GoneStep = {kind: 'clearFrame'; frame: number} | {kind: 'absent'; start: number; end: number};

/**
 * What "Gone for a while?" does at `frame`, in order. From the SAM 2 nudge,
 * the frame may still hold the clicks the nudge kept, a positive among them
 * (the last positive deleted from [pos, neg]): they are cleared first, since
 * the user says the object is not there, and a positive left inside the
 * range would end it at its own start. From the SAM 3 hint the frame holds
 * negatives only, which stay. Then: absent until the next seed.
 */
export function goneSteps(from: 'nudge' | 'hint', seedFrames: ReadonlyArray<number>, frame: number, nFrames: number): GoneStep[] {
  const [start, end] = absentUntilNextSeed(seedFrames, frame, nFrames);
  const absent: GoneStep = {kind: 'absent', start, end};
  return from === 'nudge' && seedFrames.includes(frame) ? [{kind: 'clearFrame', frame}, absent] : [absent];
}

/** True for the backend's `needs_positive:` refusal, bare or wrapped by Relay. */
export function isNeedsPositive(error: unknown): boolean {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return NEEDS_POSITIVE.test(text);
}
