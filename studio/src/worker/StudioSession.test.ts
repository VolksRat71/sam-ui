// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The worker's moveClicks against a stub backend: it sends the engine on
// screen, as setPoints does, and none (null, SAM 2's rule) when it has none.
import {afterEach, describe, expect, it, vi} from 'vitest';
import StudioSession from './StudioSession';

type Sent = {query: string; variables: {input: Record<string, unknown>}};

function session(sent: Sent[]): StudioSession {
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)) as Sent);
    return new Response(JSON.stringify({data: {moveClicks: []}}), {headers: {'Content-Type': 'application/json'}});
  });
  const s = new StudioSession({} as never, {} as never, () => {});
  s.init('http://backend.test');
  const open = s as unknown as {_sessionId: string; _showChanged: () => Promise<void>};
  open._sessionId = 's1';
  open._showChanged = async () => {}; // the preview's side, not under test here
  return s;
}

describe('StudioSession moveClicks', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the engine on screen, so SAM 3 can take a frame of negatives alone', async () => {
    const sent: Sent[] = [];
    await session(sent).moveClicks(4, 1, 2, 'sam3');
    expect(sent).toHaveLength(1);
    expect(sent[0].query).toContain('moveClicks');
    expect(sent[0].variables.input).toEqual({sessionId: 's1', frameIndex: 4, fromObjectId: 1, toObjectId: 2, engine: 'sam3'});
  });

  it('sends null with no engine, which the backend holds to SAM 2', async () => {
    const sent: Sent[] = [];
    await session(sent).moveClicks(4, 1, 2);
    expect(sent[0].variables.input.engine).toBeNull();
  });
});

describe('StudioSession review queue in the browser', () => {
  /** A 30-frame browser track of a moving square, blank on frame 12, with these clicks on 0 and 12. */
  async function queueWith(seed12: Array<[number, number, 0 | 1]>) {
    const {DataArray, encode} = await import('@/jscocotools/mask');
    const {seedsKey} = await import('~/local/localTracks');
    const {BROWSER_ENGINE} = await import('~/state/engines');
    const h = 48;
    const w = 64;
    const enc = (x: number | null) => {
      const data = new Uint8Array(h * w);
      if (x != null) {
        for (let xx = x; xx < x + 8; xx++) for (let y = 10; y < 18; y++) data[xx * h + y] = 1;
      }
      return encode(new DataArray(data, [h, w, 1]))[0];
    };
    const masks = new Map(Array.from({length: 30}, (_, f) => [f, enc(f === 12 ? null : 2 + f)] as const));
    const seeds = new Map<number, Array<[number, number, 0 | 1]>>([
      [0, [[0.5, 0.5, 1]]],
      [12, seed12],
    ]);
    const s = new StudioSession({_decodedVideo: {numFrames: 30}} as never, {} as never, () => {});
    const open = s as unknown as Record<string, unknown>;
    open._storeKey = 'clip';
    open._tracklets = new Map([[1, {id: 1}]]);
    open._seedPoints = new Map([[1, seeds]]);
    open._seedMasks = new Map([[1, new Map()]]); // no approved mask on frame 12
    open._ranges = new Map();
    open._local = {heldIds: () => new Set(), variant: 'tiny', store: {get: async () => ({masks, seedsKey: seedsKey(seeds, []), variant: 'tiny', nFrames: 30})}};
    return s.reviewQueue(BROWSER_ENGINE, {}, {});
  }

  it('passes over a cleared seed (negatives only, no mask): no stop or reappearance around it', async () => {
    const q = await queueWith([[0.3, 0.3, 0]]);
    expect(q.objects[1].state).toBe('tracked');
    expect(q.queue).toEqual([]);
  });

  it('still finds the gap around a seed with a positive', async () => {
    const q = await queueWith([[0.3, 0.3, 1]]);
    expect(q.queue.map(e => [e.frame, e.start, e.end])).toEqual([[13, 11, 13]]);
    expect(q.queue[0].reasons.map(r => r.kind).sort()).toEqual(['reappear', 'stop']);
  });
});

describe('StudioSession review queue: a positive inside a candidate confirms that frame present', () => {
  /** A 30-frame browser track of a steady square, a candidate over 10-20, and these clicks (and approved mask) on 10. */
  async function candidateQueue(seed10: Array<[number, number, 0 | 1]>, approved10: 'none' | 'empty' | 'mask' = 'none') {
    const {DataArray, encode} = await import('@/jscocotools/mask');
    const {seedsKey} = await import('~/local/localTracks');
    const {BROWSER_ENGINE} = await import('~/state/engines');
    const h = 48;
    const w = 64;
    const enc = (x: number | null) => {
      const data = new Uint8Array(h * w);
      if (x != null) {
        for (let xx = x; xx < x + 8; xx++) for (let y = 10; y < 18; y++) data[xx * h + y] = 1;
      }
      return encode(new DataArray(data, [h, w, 1]))[0];
    };
    const masks = new Map(Array.from({length: 30}, (_, f) => [f, enc(2 + f)] as const));
    const seeds = new Map<number, Array<[number, number, 0 | 1]>>([
      [0, [[0.5, 0.5, 1]]],
      [10, seed10],
    ]);
    const approved = approved10 === 'none' ? new Map() : new Map([[10, {data: enc(approved10 === 'mask' ? 12 : null)}]]);
    const s = new StudioSession({_decodedVideo: {numFrames: 30}} as never, {} as never, () => {});
    const open = s as unknown as Record<string, unknown>;
    open._storeKey = 'clip';
    open._tracklets = new Map([[1, {id: 1}]]);
    open._seedPoints = new Map([[1, seeds]]);
    open._seedMasks = new Map([[1, approved]]);
    open._ranges = new Map();
    open._local = {heldIds: () => new Set(), variant: 'tiny', store: {get: async () => ({masks, seedsKey: seedsKey(seeds, []), variant: 'tiny', nFrames: 30})}};
    const candidates = {1: [{start: 10, end: 20, state: 'candidate', source: 'text:dog@sam3', score: 0.6}]};
    const q = await s.reviewQueue(BROWSER_ENGINE, {}, candidates as never);
    return q.queue.flatMap(e => e.reasons.filter(r => r.kind === 'candidate').map(r => r.frame));
  }

  it('takes the clicked frame out, and the frame next to it stays a candidate', async () => {
    expect(await candidateQueue([[0.3, 0.3, 1]])).toEqual([11]);
    expect(await candidateQueue([[0.3, 0.3, 1], [0.6, 0.6, 0]], 'mask')).toEqual([11]);
  });

  it('does not confirm on a cleared seed (negatives only, no mask or an empty one)', async () => {
    expect(await candidateQueue([[0.3, 0.3, 0]])).toEqual([10]);
    expect(await candidateQueue([[0.3, 0.3, 0]], 'empty')).toEqual([10]);
  });

  it('confirms on a text seed (no clicks, a mask)', async () => {
    expect(await candidateQueue([], 'mask')).toEqual([11]);
  });
});
