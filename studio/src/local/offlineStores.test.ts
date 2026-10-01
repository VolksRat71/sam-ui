// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The no-server stores, tested as the backend's are: these port the pure
// parts of demo/backend/tests/test_store.py, test_api.py, test_names.py and
// test_jobs.py to the browser engine's OfflineService.
import {describe, expect, it} from 'vitest';
import {MemoryKv} from './kv';
import {LocalEngine} from './LocalEngine';
import {type LocalTrack, seedsKey, variantKey} from './localTracks';
import {OfflineService, SeedStore, seedPoints} from './offlineStores';

const V = 'a'.repeat(64);
const VARIANT = variantKey(512, 0);
const rle = {size: [2, 2] as [number, number], counts: '04'};

async function tracked(svc: OfflineService, obj: number, variant = VARIANT): Promise<void> {
  const key = seedsKey(seedPoints(await svc.seeds.seeds(V, obj)));
  const t: LocalTrack = {objectId: obj, seedsKey: key, variant, masks: new Map([[0, rle], [1, rle]]), nFrames: 2};
  await svc.tracks.put(V, t);
}

const state = async (svc: OfflineService, obj: number, held: Set<number> = new Set()) =>
  (await svc.objectInfo(V, obj, VARIANT, held)).tracks?.find(t => t.engine === 'browser-sam2')?.state;

describe('SeedStore (test_store.py)', () => {
  it('appends or replaces points like SAM 2', async () => {
    const s = new SeedStore(new MemoryKv());
    await s.addPoints(V, 1, 0, [[0.1, 0.1]], [1], true);
    await s.addPoints(V, 1, 0, [[0.2, 0.2]], [0], false);
    expect((await s.seeds(V, 1)).get(0)).toEqual({points: [[0.1, 0.1], [0.2, 0.2]], labels: [1, 0]});
    await s.addPoints(V, 1, 0, [[0.3, 0.3]], [1], true, rle);
    expect((await s.seeds(V, 1)).get(0)).toEqual({points: [[0.3, 0.3]], labels: [1], mask: rle});
  });

  it('survives a new instance on the same files and lists objects', async () => {
    const kv = new MemoryKv();
    await new SeedStore(kv).addPoints(V, 2, 5, [[0.4, 0.6]], [1], true);
    await new SeedStore(kv).addPoints(V, 0, 1, [[0.1, 0.1]], [1], true);
    const s = new SeedStore(kv);
    expect(await s.objects(V)).toEqual([0, 2]);
    expect([...(await s.seeds(V, 2))]).toEqual([[5, {points: [[0.4, 0.6]], labels: [1]}]]);
    expect(await s.objects('unknown')).toEqual([]);
  });

  it('clears one frame only', async () => {
    const s = new SeedStore(new MemoryKv());
    await s.addPoints(V, 1, 0, [[0.1, 0.1]], [1], true);
    await s.addPoints(V, 1, 9, [[0.9, 0.9]], [1], true);
    expect([...(await s.clearFrame(V, 1, 0)).keys()]).toEqual([9]);
  });

  it('reads a damaged seeds file as no seeds', async () => {
    const kv = new MemoryKv();
    await kv.write(`seeds/${V}/1/seeds.json`, '{not json');
    expect((await new SeedStore(kv).seeds(V, 1)).size).toBe(0);
  });
});

describe('OfflineService (test_api.py)', () => {
  it('is untracked, tracked, stale on new clicks or a new model, tracking while held', async () => {
    const svc = new OfflineService(new MemoryKv());
    await svc.recordPoints(V, 1, 0, [[0.5, 0.5, 1]], rle);
    expect(await state(svc, 1)).toBe('untracked');
    await tracked(svc, 1);
    expect(await state(svc, 1)).toBe('tracked');
    expect(await state(svc, 1, new Set([1]))).toBe('tracking');
    expect((await svc.objectInfo(V, 1, variantKey(1024, 0), new Set())).tracks?.[0].state).toBe('stale');
    await svc.recordPoints(V, 1, 3, [[0.2, 0.2, 0]], null);
    expect(await state(svc, 1)).toBe('stale');
  });

  it('selects only untracked and stale objects, and exactly the ids given', async () => {
    const svc = new OfflineService(new MemoryKv());
    for (const o of [1, 2, 3]) {
      await svc.recordPoints(V, o, 0, [[0.5, 0.5, 1]], null);
    }
    await tracked(svc, 1);
    expect(await svc.select(V, null, VARIANT, new Set())).toEqual([2, 3]);
    expect(await svc.select(V, [1, 99], VARIANT, new Set())).toEqual([1]); // 99 is unknown
    expect(await svc.select(V, null, VARIANT, new Set([3]))).toEqual([2]); // a job holds 3
  });

  it('drops the track with the last seed frame, and forgets a removed object', async () => {
    const svc = new OfflineService(new MemoryKv());
    await svc.recordPoints(V, 1, 0, [[0.5, 0.5, 1]], null);
    await svc.recordPoints(V, 2, 0, [[0.5, 0.5, 1]], null);
    await tracked(svc, 1);
    await tracked(svc, 2);
    await svc.clearFrame(V, 1, 0);
    expect(await state(svc, 1)).toBe('untracked');
    expect(await svc.tracks.list(V)).toHaveLength(1);
    expect(await svc.select(V, null, VARIANT, new Set())).toEqual([]); // no seeds: nothing to track
    await svc.removeObject(V, 2);
    expect((await svc.objects(V, VARIANT)).map(o => o.objectId)).toEqual([1]);
    expect(await svc.tracks.list(V)).toEqual([]);
  });

  it('keeps tracks and objects across a new instance, and clears a video whole', async () => {
    const kv = new MemoryKv();
    const svc = new OfflineService(kv);
    await svc.recordPoints(V, 1, 2, [[0.5, 0.5, 1]], rle);
    await tracked(svc, 1);
    const again = new OfflineService(kv);
    const [o] = await again.objects(V, VARIANT);
    expect(o.seeds).toEqual([{frameIndex: 2, points: [[0.5, 0.5]], labels: [1], mask: rle}]);
    expect(o.tracks).toEqual([{engine: 'browser-sam2', state: 'tracked', frames: [0, 1], nFrames: 2}]);
    expect([...(await again.tracks.get(V, 1))!.masks.keys()]).toEqual([0, 1]);
    await again.clearVideo(V);
    expect(await again.objects(V, VARIANT)).toEqual([]);
    expect(kv.files.size).toBe(0);
  });
});

describe('names (test_names.py)', () => {
  it('persist, are trimmed and capped, clear when empty, and never make a track stale', async () => {
    const kv = new MemoryKv();
    const svc = new OfflineService(kv);
    await svc.recordPoints(V, 1, 0, [[0.5, 0.5, 1]], null);
    await tracked(svc, 1);
    expect(await svc.seeds.setName(V, 1, '  red cup  ')).toBe('red cup');
    expect(await new SeedStore(kv).names(V)).toEqual({1: 'red cup'});
    expect(await state(svc, 1)).toBe('tracked');
    expect(await svc.seeds.setName(V, 1, 'x'.repeat(80))).toHaveLength(64);
    expect(await svc.seeds.setName(V, 1, '   ')).toBeNull();
    expect(await svc.seeds.names(V)).toEqual({});
    await svc.seeds.setName(V, 1, 'cup');
    await svc.removeObject(V, 1);
    expect(await svc.seeds.names(V)).toEqual({});
  });
});

describe('the object layout (test_layout.py)', () => {
  const cast = {id: 'g1', name: 'Cast', color: '#ff4fa3', members: [2, 1], collapsed: true, hidden: false};

  it('keeps creation order with no layout, and persists one in OPFS next to the objects', async () => {
    const kv = new MemoryKv();
    const svc = new OfflineService(kv);
    for (const o of [3, 1, 2]) {
      await svc.recordPoints(V, o, 0, [[0.5, 0.5, 1]], null);
    }
    expect(await svc.layout(V)).toEqual({order: [1, 2, 3], groups: []});
    await tracked(svc, 1);
    await svc.setLayout(V, {order: [3, 2, 1], groups: [cast]});
    expect(kv.files.has(`seeds/${V}/layout.json`)).toBe(true);
    expect(await new OfflineService(kv).layout(V)).toEqual({order: [3, 2, 1], groups: [{...cast, members: [2, 1]}]});
    // metadata only: the track stays tracked, and nothing goes on the undo history
    expect(await state(svc, 1)).toBe('tracked');
    expect((await svc.history(V, 1)).undo).toHaveLength(1); // the click only
    expect(await svc.seeds.objects(V)).toEqual([1, 2, 3]);
  });

  it('a removed object leaves the order and its group; a cleared video forgets the layout', async () => {
    const kv = new MemoryKv();
    const svc = new OfflineService(kv);
    for (const o of [1, 2, 3]) {
      await svc.recordPoints(V, o, 0, [[0.5, 0.5, 1]], null);
    }
    await svc.setLayout(V, {order: [3, 2, 1], groups: [cast]});
    await svc.removeObject(V, 2);
    expect(await svc.layout(V)).toEqual({order: [3, 1], groups: [{...cast, members: [1]}]});
    await svc.clearVideo(V);
    await svc.recordPoints(V, 5, 0, [[0.5, 0.5, 1]], null);
    expect(await svc.layout(V)).toEqual({order: [5], groups: []});
  });

  it('reads a damaged layout as none', async () => {
    const kv = new MemoryKv();
    const svc = new OfflineService(kv);
    await svc.recordPoints(V, 1, 0, [[0.5, 0.5, 1]], null);
    await kv.write(`seeds/${V}/layout.json`, 'not json');
    expect(await svc.layout(V)).toEqual({order: [1], groups: []});
  });
});

describe('job claims (test_jobs.py)', () => {
  it('never lets two jobs share an object, and frees them when released', () => {
    const engine = new LocalEngine({frame: async () => null, video: () => null, onModel: () => {}});
    const a = engine.claim([1, 2]);
    expect([...engine.heldIds()].sort()).toEqual([1, 2]);
    expect(() => engine.claim([2, 3])).toThrow(/already being tracked/);
    const b = engine.claim([3]);
    engine.release(a);
    expect([...engine.heldIds()]).toEqual([3]);
    engine.release(b);
    expect(engine.heldIds().size).toBe(0);
    expect(engine.isLocalJob(a) && !engine.isLocalJob('job-1')).toBe(true);
  });
});

describe('absent ranges (test_ranges.py)', () => {
  it('are stored apart from the seeds, make the track stale, and unmarking all of it restores it', async () => {
    const kv = new MemoryKv();
    const svc = new OfflineService(kv);
    await svc.recordPoints(V, 1, 0, [[0.5, 0.5, 1]], rle);
    await tracked(svc, 1);
    expect(await state(svc, 1)).toBe('tracked');
    expect(await svc.setRange(V, 1, 4, 8, 'absent')).toEqual([{start: 4, end: 8, state: 'absent'}]);
    expect(await state(svc, 1)).toBe('stale');
    expect((await new OfflineService(kv).objectInfo(V, 1, VARIANT, new Set())).ranges).toEqual([{start: 4, end: 8, state: 'absent'}]);
    expect(await svc.setRange(V, 1, 6, 6, null)).toEqual([{start: 4, end: 5, state: 'absent'}, {start: 7, end: 8, state: 'absent'}]);
    await svc.setRange(V, 1, 0, 20, null);
    expect(await state(svc, 1)).toBe('tracked');
  });

  it('keep an object with a range and no clicks yet listed', async () => {
    const svc = new OfflineService(new MemoryKv());
    await svc.setRange(V, 3, 0, 2, 'absent');
    expect(await svc.seeds.objects(V)).toEqual([3]);
    expect(await svc.select(V, null, VARIANT, new Set())).toEqual([]); // nothing to track
  });
});

describe('candidate and present ranges (test_candidates.py)', () => {
  const DOG = 'text:dog@sam3';
  const c = (start: number, end: number, score?: number) => ({start, end, state: 'candidate', source: DOG, ...(score == null ? {} : {score})});

  it('are annotations in OPFS: never in the seeds key or the undo history', async () => {
    const kv = new MemoryKv();
    const svc = new OfflineService(kv);
    await svc.recordPoints(V, 1, 0, [[0.5, 0.5, 1]], rle);
    await tracked(svc, 1);
    const undo = (await svc.history(V, 1)).undo.length;
    await svc.writeCandidates(V, 1, [{start: 2, end: 6, source: DOG, score: 0.5}]);
    expect(await svc.setRange(V, 1, 5, 9, 'present')).toEqual([c(2, 4, 0.5), {start: 5, end: 9, state: 'present'}]);
    expect(await state(svc, 1)).toBe('tracked');
    expect((await svc.history(V, 1)).undo.length).toBe(undo);
    expect(await kv.read(`seeds/${V}/1/ranges.json`)).toBeNull();
    // a new service on the same store reads them back, as a view
    expect((await new OfflineService(kv).objectInfo(V, 1, VARIANT, new Set())).ranges).toEqual([c(2, 4, 0.5), {start: 5, end: 9, state: 'present'}]);
  });

  it('confirming a candidate absent is a seed change; undo shows the candidate again', async () => {
    const svc = new OfflineService(new MemoryKv());
    await svc.recordPoints(V, 1, 0, [[0.5, 0.5, 1]], rle);
    await tracked(svc, 1);
    await svc.writeCandidates(V, 1, [{start: 3, end: 4, source: DOG}]);
    expect(await svc.setRange(V, 1, 3, 4, 'absent', VARIANT)).toEqual([{start: 3, end: 4, state: 'absent'}]);
    expect(await state(svc, 1)).toBe('stale');
    await svc.undo(V, 1, VARIANT);
    const o = await svc.objectInfo(V, 1, VARIANT, new Set());
    expect(o.ranges).toEqual([c(3, 4)]);
    expect(await state(svc, 1)).toBe('tracked');
  });

  it('rejects one candidate, and a bad batch writes nothing', async () => {
    const svc = new OfflineService(new MemoryKv());
    await svc.writeCandidates(V, 2, [{start: 0, end: 1, source: DOG}, {start: 5, end: 6, source: DOG}]);
    expect(await svc.seeds.objects(V)).toEqual([2]);
    expect(await svc.setRange(V, 2, 0, 1, null, null, {clear: ['candidate']})).toEqual([c(5, 6)]);
    await expect(svc.writeCandidates(V, 2, [{start: 8, end: 9, source: ''}], true)).rejects.toThrow(/source/);
    expect((await svc.objectInfo(V, 2, VARIANT, new Set())).ranges).toEqual([c(5, 6)]);
  });
});
