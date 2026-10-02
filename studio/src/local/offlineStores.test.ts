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
    // like the backend: a seedless stored object goes, and an id never stored is a no-op
    await svc.removeObject(V, 1);
    await svc.removeObject(V, 99);
    expect(await svc.objects(V, VARIANT)).toEqual([]);
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
