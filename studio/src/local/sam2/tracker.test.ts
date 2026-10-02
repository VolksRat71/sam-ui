// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import type {Sam2Constants} from './config';
import {maskToRle, rleToMask} from './masks';
import {isClearedSeed, promptOf, type Releasable, type Sam2Models, Sam2Tracker, splitSeeds, type TrackObject} from './tracker';

const S = 32; // model input size
const F = 2; // feature side: 4 tokens per memory block
const LOW = 8; // low-res logits side

const CONSTANTS: Sam2Constants = {
  imageSize: S,
  featSize: F,
  numMaskmem: 7,
  maxPointers: 16,
  memDim: 64,
  mean: [0, 0, 0],
  std: [1, 1, 1],
  tpos: Array.from({length: 7}, () => new Array(64).fill(0)),
};

type Call =
  | {kind: 'decode'; frame: number; cond: boolean; labels: number[]}
  | {kind: 'memory'; frame: number; binarize: boolean; fromLogits: boolean; score: number}
  | {kind: 'attend'; frame: number; memoryLength: number};

/**
 * A fake model: the decoder's mask is the left half on even frames and the
 * right half on odd ones, tagged so tests can tell which call made it.
 */
class FakeModels implements Sam2Models {
  readonly constants = CONSTANTS;
  calls: Call[] = [];
  open = 0;
  pointerCalls = 0;

  async features(frame: number): Promise<Releasable & {frame: number}> {
    this.open++;
    return {frame, release: () => void this.open--};
  }

  async decode(features: Releasable, cond: Releasable | null, _points: Float32Array, labels: Int32Array) {
    const frame = (features as unknown as {frame: number}).frame;
    this.calls.push({kind: 'decode', frame, cond: cond != null, labels: [...labels]});
    const lowRes = Float32Array.from({length: LOW * LOW}, (_, i) => ((i % LOW < LOW / 2) === (frame % 2 === 0) ? 5 : -5));
    this.open++;
    return {
      lowRes,
      lowSize: LOW,
      highRes: {release: () => void this.open--},
      objectScore: 3,
      pointer: new Float32Array(256).fill(frame),
      iou: 0.9,
    };
  }

  async encodeMemory(features: Releasable, mask: Releasable | Float32Array, objectScore: number, binarize: boolean) {
    const frame = (features as unknown as {frame: number}).frame;
    this.calls.push({kind: 'memory', frame, binarize, fromLogits: mask instanceof Float32Array, score: objectScore});
    return {tokens: new Float32Array(F * F * 64).fill(frame), pos: new Float32Array(F * F * 64)};
  }

  async attend(features: Releasable, memory: Float32Array) {
    const frame = (features as unknown as {frame: number}).frame;
    this.calls.push({kind: 'attend', frame, memoryLength: memory.length});
    this.open++;
    return {release: () => void this.open--};
  }

  async pointerPos(diffs: Float32Array) {
    this.pointerCalls++;
    return new Float32Array(diffs.length * 64);
  }
}

async function run(tracker: Sam2Tracker, objects: Parameters<Sam2Tracker['track']>[0]) {
  const frames: Array<{frame: number; masks: Map<number, unknown>}> = [];
  for await (const f of tracker.track(objects)) {
    frames.push(f);
  }
  return frames;
}

describe('promptOf', () => {
  it('scales clicks to model pixels, and pads a frame without clicks', () => {
    const p = promptOf([[0.5, 0.25, 1], [0.1, 0.2, 0]], 1024);
    expect([...p.points]).toEqual([512, 256, 102.4 * 1, 204.8].map(v => Math.fround(v)));
    expect([...p.labels]).toEqual([1, 0]);
    expect([...promptOf([], 1024).labels]).toEqual([-1]);
  });
});

describe('cleared seeds', () => {
  const band = new Uint8Array(16 * 12);
  band.fill(1, 16 * 4, 16 * 8);
  const kept = maskToRle(band, 16, 12);
  const empty = maskToRle(new Uint8Array(16 * 12), 16, 12);

  it('a seed with no positive and no approved mask, or an empty one, is cleared', () => {
    expect(isClearedSeed({frame: 1, points: [[0.5, 0.5, 0]]})).toBe(true);
    expect(isClearedSeed({frame: 1, points: [[0.5, 0.5, 0]], mask: null})).toBe(true);
    expect(isClearedSeed({frame: 1, points: [[0.5, 0.5, 0]], mask: empty})).toBe(true);
  });

  it('a positive, or a legacy anchor-trimmed seed (no positive, a mask), is not', () => {
    expect(isClearedSeed({frame: 1, points: [[0.5, 0.5, 1], [0.2, 0.2, 0]]})).toBe(false);
    expect(isClearedSeed({frame: 1, points: [[0.5, 0.5, 0]], mask: kept})).toBe(false);
  });

  it('splits an object\'s seeds into conditioning frames and frames to blank', () => {
    const {cond, blank} = splitSeeds([
      {frame: 0, points: [[0.5, 0.5, 1]]},
      {frame: 4, points: [[0.5, 0.5, 0]], mask: null},
      {frame: 6, points: [[0.5, 0.5, 0]], mask: kept},
    ]);
    expect(cond.map(s => s.frame)).toEqual([0, 6]);
    expect([...blank]).toEqual([4]);
  });
});

describe('Sam2Tracker', () => {
  it('never conditions on a cleared seed, tracks through it, and blanks its frame', async () => {
    const models = new FakeModels();
    const tracker = new Sam2Tracker(models, {numFrames: 4, width: 16, height: 12});
    const frames = await run(tracker, [
      {id: 0, seeds: [{frame: 0, points: [[0.5, 0.5, 1]]}, {frame: 2, points: [[0.5, 0.5, 0]], mask: null}]},
    ]);
    expect(frames.map(f => f.frame)).toEqual([0, 1, 2, 3]);
    // only frame 0 is decoded as a seed; frame 2 is tracked like any other frame
    expect(models.calls.filter(c => c.kind === 'decode' && !c.cond).map(c => c.frame)).toEqual([0]);
    expect(models.calls.some(c => c.kind === 'attend' && c.frame === 2)).toBe(true);
    // its output is empty, the frames around it are not
    const area = (f: number) => rleToMask(frames.find(x => x.frame === f)!.masks.get(0) as never).mask.reduce((a, b) => a + b, 0);
    expect(area(2)).toBe(0);
    expect(area(1)).toBeGreaterThan(0);
    expect(area(3)).toBeGreaterThan(0);
    expect(models.open).toBe(0);
  });

  it('skips an object whose only seeds are cleared, without failing the others', async () => {
    const models = new FakeModels();
    const tracker = new Sam2Tracker(models, {numFrames: 3, width: 8, height: 8});
    const frames = await run(tracker, [
      {id: 0, seeds: [{frame: 1, points: [[0.5, 0.5, 0]]}]},
      {id: 1, seeds: [{frame: 0, points: [[0.5, 0.5, 1]]}]},
    ]);
    expect(frames.map(f => f.frame)).toEqual([0, 1, 2]);
    expect(frames.every(f => [...f.masks.keys()].join() === '1')).toBe(true);
    expect(await run(new Sam2Tracker(new FakeModels(), {numFrames: 3, width: 8, height: 8}), [
      {id: 0, seeds: [{frame: 1, points: [[0.5, 0.5, 0]]}]},
    ])).toEqual([]);
  });

  it('seeds, tracks forward from the earliest seed, then backwards, each frame once', async () => {
    const models = new FakeModels();
    const tracker = new Sam2Tracker(models, {numFrames: 6, width: 16, height: 12});
    const frames = await run(tracker, [{id: 3, seeds: [{frame: 2, points: [[0.5, 0.5, 1]]}]}]);
    expect(frames.map(f => f.frame)).toEqual([2, 3, 4, 5, 1, 0]);
    // the seed decodes without memory, with its click; its memory is binarised
    expect(models.calls[0]).toEqual({kind: 'decode', frame: 2, cond: false, labels: [1]});
    expect(models.calls[1]).toMatchObject({kind: 'memory', frame: 2, binarize: true, fromLogits: false});
    // a tracked frame: attention over 7 blocks + 64 pointer tokens, a padding point, a soft memory
    const tracked = models.calls.filter(c => c.frame === 3);
    expect(tracked).toEqual([
      {kind: 'attend', frame: 3, memoryLength: (7 * F * F + 64) * 64},
      {kind: 'decode', frame: 3, cond: true, labels: [-1]},
      {kind: 'memory', frame: 3, binarize: false, fromLogits: false, score: 3},
    ]);
    // every handle released
    expect(models.open).toBe(0);
    // frame 3 (odd) is the right half of the 16x12 video
    const {mask} = rleToMask(frames[1].masks.get(3) as never);
    expect(mask[0]).toBe(0);
    expect(mask[15]).toBe(1);
  });

  it('runs a window only: no model call outside it, seeds outside it ignored', async () => {
    const models = new FakeModels();
    const tracker = new Sam2Tracker(models, {numFrames: 12, width: 16, height: 12});
    const frames: number[] = [];
    const objects: TrackObject[] = [{id: 3, seeds: [{frame: 2, points: [[0.5, 0.5, 1]]}, {frame: 9, points: [[0.5, 0.5, 1]]}]}];
    for await (const f of tracker.track(objects, undefined, {lo: 7, hi: null})) {
      frames.push(f.frame);
    }
    expect(frames).toEqual([9, 10, 11, 8, 7]);
    expect(models.calls.every(c => c.frame >= 7)).toBe(true); // frame 2's seed was never read
    const before: number[] = [];
    for await (const f of new Sam2Tracker(models, {numFrames: 12, width: 16, height: 12}).track(objects, undefined, {lo: 0, hi: 4})) {
      before.push(f.frame);
    }
    expect(before).toEqual([2, 3, 4, 1, 0]);
    expect(models.open).toBe(0);
  });

  it('uses an approved mask as the seed output and memory, and the clicks for the pointer', async () => {
    const models = new FakeModels();
    const tracker = new Sam2Tracker(models, {numFrames: 3, width: 16, height: 12});
    const approved = new Uint8Array(16 * 12);
    approved.fill(1, 16 * 4, 16 * 8); // a horizontal band, unlike anything the fake decoder makes
    const rle = maskToRle(approved, 16, 12);
    const frames = await run(tracker, [{id: 0, seeds: [{frame: 0, points: [[0.2, 0.5, 1], [0.8, 0.5, 0]], mask: rle}]}]);
    expect(frames[0].masks.get(0)).toEqual(rle);
    expect(models.calls[0]).toEqual({kind: 'decode', frame: 0, cond: false, labels: [1, 0]});
    expect(models.calls[1]).toEqual({kind: 'memory', frame: 0, binarize: true, fromLogits: true, score: 10});
    expect(models.open).toBe(0);
  });

  it('tracks objects independently, from the earliest seed of any', async () => {
    const models = new FakeModels();
    const tracker = new Sam2Tracker(models, {numFrames: 4, width: 8, height: 8});
    const frames = await run(tracker, [
      {id: 0, seeds: [{frame: 1, points: [[0.5, 0.5, 1]]}]},
      {id: 1, seeds: [{frame: 2, points: [[0.5, 0.5, 1]]}]},
      {id: 2, seeds: [{frame: 0, points: []}]}, // no clicks: not tracked
    ]);
    expect(frames.map(f => f.frame)).toEqual([1, 2, 3, 0]);
    expect(frames.every(f => [...f.masks.keys()].join() === '0,1')).toBe(true);
    // object 1 is tracked on frame 1, before its seed (from its future seed's memory)
    expect(tracker.stats.pointerFallbacks).toBe(1);
    // each seed frame decoded once without memory
    expect(models.calls.filter(c => c.kind === 'decode' && !c.cond).map(c => c.frame)).toEqual([1, 2]);
  });

  it('keeps only the memories the next frames need', async () => {
    const models = new FakeModels();
    const tracker = new Sam2Tracker(models, {numFrames: 40, width: 8, height: 8});
    await run(tracker, [{id: 0, seeds: [{frame: 10, points: [[0.5, 0.5, 1]]}]}]);
    // the recent window (6) plus the frames after the start, kept for the reverse pass
    expect(tracker.stats.peakMemories).toBeLessThanOrEqual(12);
    // the pointer PEs cache: only a new seed distance needs a pointer_tpos run
    expect(models.pointerCalls).toBeLessThan(39);
    expect(models.open).toBe(0);
  });

  it('stops when aborted, releasing everything', async () => {
    const models = new FakeModels();
    const tracker = new Sam2Tracker(models, {numFrames: 10, width: 8, height: 8});
    const ac = new AbortController();
    const seen: number[] = [];
    await expect(async () => {
      for await (const f of tracker.track([{id: 0, seeds: [{frame: 0, points: [[0.5, 0.5, 1]]}]}], ac.signal)) {
        seen.push(f.frame);
        if (f.frame === 2) {
          ac.abort();
        }
      }
    }).rejects.toThrow();
    expect(seen).toEqual([0, 1, 2]);
    expect(models.open).toBe(0);
  });

  it('encodes a click seed from its hole-filled mask when hole fill is on, and tracked frames from the decoder', async () => {
    const models = new FakeModels();
    const tracker = new Sam2Tracker(models, {numFrames: 2, width: 16, height: 12, fillHoleArea: 8});
    await run(tracker, [{id: 0, seeds: [{frame: 0, points: [[0.5, 0.5, 1]]}]}]);
    const memories = models.calls.filter(c => c.kind === 'memory');
    expect(memories).toEqual([
      {kind: 'memory', frame: 0, binarize: true, fromLogits: true, score: 3},
      {kind: 'memory', frame: 1, binarize: false, fromLogits: false, score: 3},
    ]);
    expect(models.open).toBe(0);
  });

  it('answers a click from the clicks alone', async () => {
    const models = new FakeModels();
    const tracker = new Sam2Tracker(models, {numFrames: 4, width: 16, height: 12});
    const res = await tracker.click(1, [[0.7, 0.5, 1]]);
    expect(res.objectScore).toBe(3);
    expect(rleToMask(res.rle).mask[15]).toBe(1);
    expect(models.calls).toEqual([{kind: 'decode', frame: 1, cond: false, labels: [1]}]);
    expect(models.open).toBe(0);
  });
});
