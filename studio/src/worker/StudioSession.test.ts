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

  it('skips a cleared seed on the start (negatives only, no mask or an empty one): the item moves on, the candidate stays', async () => {
    expect(await candidateQueue([[0.3, 0.3, 0]])).toEqual([11]);
    expect(await candidateQueue([[0.3, 0.3, 0]], 'empty')).toEqual([11]);
  });

  it('keeps the item on a seed that is neither confirmed nor cleared (a negative over a kept mask)', async () => {
    expect(await candidateQueue([[0.3, 0.3, 0]], 'mask')).toEqual([10]);
  });

  it('confirms on a text seed (no clicks, a mask)', async () => {
    expect(await candidateQueue([], 'mask')).toEqual([11]);
  });
});

describe('Refine Detail base separation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requests raw masks before capability discovery and removes details without a reload', async () => {
    const {DataArray, encode, decode} = await import('@/jscocotools/mask');
    const base = encode(new DataArray(new Uint8Array([1, 0, 0, 0]), [2, 2, 1]))[0];
    const detail = {id: 'a'.repeat(64), rect: [1, 1, 2, 2], points: [[.5, .5, 1]],
      geometry: {version: 'working-copy-v1', width: 2, height: 2},
      mask: encode(new DataArray(new Uint8Array([1]), [1, 1, 1]))[0]};
    let records = [detail];
    const requests: Array<{url: string; body: Record<string, unknown>}> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); requests.push({url, body});
      if (url.endsWith('/track_masks')) {
        expect(body.base_only).toBe(true);
        const json = JSON.stringify({frame_index: 0, results: [{object_id: 1, mask: base}]});
        return new Response(`--frame\r\nContent-Type: application/json\r\nContent-Length: ${json.length}\r\n\r\n${json}`, {headers: {'Content-Type': 'multipart/x-savi-stream; boundary=frame'}});
      }
      if (url.endsWith('/remove_detail_crop')) records = [];
      return new Response(JSON.stringify(url.endsWith('/detail_state') ? {enabled: true, objects: {1: {0: records}}} : {removed: true}));
    });
    const s = new StudioSession({} as never, {} as never, () => {});
    s.init('http://backend.test');
    const internals = s as unknown as {_sessionId: string; _render: () => void; _thumbnails: () => Promise<void>;
      _tracklets: Map<number, {masks: Array<{data: typeof base}>}>; _baseMasks: Map<number, Map<number, {data: typeof base}>>;
      _seedPoints: Map<number, unknown>; _seedMasks: Map<number, unknown>};
    internals._sessionId = 's'; internals._render = () => {}; internals._thumbnails = async () => {};
    await s.repaint();
    const tracklet = internals._tracklets.get(1)!;
    expect(tracklet.masks[0].data).toEqual(base);
    await s.detailRequest('detail_state');
    expect(Array.from(decode([tracklet.masks[0].data]).data)).toEqual([1, 0, 0, 1]);
    expect(internals._baseMasks.get(1)!.get(0)!.data).toEqual(base);
    await s.detailRequest('remove_detail_crop', {detail_id: detail.id});
    expect(tracklet.masks[0].data).toEqual(base);
    expect(internals._seedPoints.size).toBe(0); expect(internals._seedMasks.size).toBe(0);
    expect(requests.filter(r => r.url.endsWith('/track_masks'))).toHaveLength(2);
  });

  it('drops tracked bases when a track is cleared, without turning details into seeds', async () => {
    const {DataArray, encode} = await import('@/jscocotools/mask');
    const base = encode(new DataArray(new Uint8Array([1, 0, 0, 0]), [2, 2, 1]))[0];
    const t = {id: 1, masks: [{data: base}], points: []};
    const s = new StudioSession({} as never, {} as never, () => {});
    const inside = s as unknown as {_baseMasks: Map<number, Map<number, {data: typeof base}>>;
      _seedMasks: Map<number, Map<number, {data: typeof base}>>; _keepSeedMasksOnly: (t: unknown) => void};
    inside._baseMasks.set(1, new Map([[0, {data: base}]]));
    inside._keepSeedMasksOnly(t);
    expect(t.masks).toEqual([]); expect(inside._baseMasks.has(1)).toBe(false);
    expect(inside._seedMasks.size).toBe(0);
  });
});

it('keeps a newer click mask when another object refreshes or applies a detail', async () => {
  const {DataArray, encode} = await import('@/jscocotools/mask');
  const old = {data: encode(new DataArray(new Uint8Array([1, 0, 0, 0]), [2, 2, 1]))[0]};
  const clicked = {data: encode(new DataArray(new Uint8Array([0, 1, 0, 0]), [2, 2, 1]))[0]};
  const t = {id: 1, masks: [] as Array<typeof old>, points: []};
  const s = new StudioSession({} as never, {} as never, () => {});
  s.init('http://backend.test');
  const inside = s as unknown as {_sessionId: string; _render: () => void; _tracklets: Map<number, typeof t>;
    _setMask: (tracklet: typeof t, frame: number, mask: typeof old, fromTrack?: boolean) => void};
  inside._sessionId = 's'; inside._render = () => {}; inside._tracklets.set(1, t);
  const repaint = vi.spyOn(s, 'repaint').mockResolvedValue();
  vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(url.endsWith('/detail_state')
    ? {enabled: true, objects: {}} : {object_id: 2})));
  try {
    inside._setMask(t, 0, old, true);
    inside._setMask(t, 0, clicked);
    await s.detailRequest('detail_state');
    expect(t.masks[0]).toBe(clicked);
    await s.detailRequest('apply_detail_crop', {preview_id: 'other-object'});
    expect(t.masks[0]).toBe(clicked);
    expect(repaint).toHaveBeenCalledWith([2]);
  } finally {vi.unstubAllGlobals();}
});
