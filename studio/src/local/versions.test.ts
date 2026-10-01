// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Browser track versions and seed undo with no backend: the port of
// demo/backend/tests/test_versions.py to the browser engine's stores.
import {describe, expect, it} from 'vitest';
import type {RLEObject} from '@/jscocotools/mask';
import {MemoryKv} from './kv';
import {LOCAL_KEEP, type LocalTrack, type LocalTrackStore, MemoryTrackStore, seedsKey, variantKey} from './localTracks';
import {KvTrackStore, OfflineService, seedPoints} from './offlineStores';

const V = 'b'.repeat(64);
const VARIANT = variantKey(512, 0);
const mask = (counts: string): RLEObject => ({size: [2, 2], counts});

function track(objectId: number, key: string, counts: string): LocalTrack {
  return {objectId, seedsKey: key, variant: VARIANT, masks: new Map([[0, mask(counts)], [1, mask(counts)]]), nFrames: 2};
}

for (const [name, make] of [
  ['MemoryTrackStore', () => new MemoryTrackStore()],
  ['KvTrackStore', () => new KvTrackStore(new MemoryKv())],
] as Array<[string, () => LocalTrackStore]>) {
  describe(`${name} versions`, () => {
    it('keeps every track it is given as a version, newest first', async () => {
      const s = make();
      await s.put(V, track(1, 'a', '04'));
      await s.put(V, track(1, 'b', '13'));
      expect((await s.versions(V, 1)).map(v => v.seedsKey)).toEqual(['b', 'a']);
      expect((await s.get(V, 1))!.seedsKey).toBe('b');
    });

    it('brings a kept track back as the current one', async () => {
      const s = make();
      await s.put(V, track(1, 'a', '04'));
      await s.put(V, track(1, 'b', '13'));
      expect(await s.adopt(V, 1, 'a', VARIANT)).toBe(true);
      const got = (await s.get(V, 1))!;
      expect(got.seedsKey).toBe('a');
      expect(got.masks.get(0)).toEqual(mask('04'));
      expect(await s.adopt(V, 1, 'never', VARIANT)).toBe(false);
      expect(await s.adopt(V, 1, 'b', variantKey(1024, 0))).toBe(false); // another model setting
    });

    it(`keeps the last ${LOCAL_KEEP}, never the current one evicted`, async () => {
      const s = make();
      for (let i = 0; i <= LOCAL_KEEP + 1; i++) {
        await s.put(V, track(1, `k${i}`, '04'));
      }
      const kept = (await s.versions(V, 1)).map(v => v.seedsKey);
      expect(kept).toHaveLength(LOCAL_KEEP);
      expect(kept).not.toContain('k0');
      await s.adopt(V, 1, kept[LOCAL_KEEP - 1], VARIANT); // the oldest kept is current now
      await s.put(V, track(1, 'new', '04'));
      await s.adopt(V, 1, kept[LOCAL_KEEP - 1], VARIANT);
      expect((await s.get(V, 1))!.seedsKey).toBe(kept[LOCAL_KEEP - 1]);
    });

    it('clearing the current track can keep its versions; deleting drops them', async () => {
      const s = make();
      await s.put(V, track(1, 'a', '04'));
      await s.delete(V, 1, {keepVersions: true});
      expect(await s.get(V, 1)).toBeNull();
      expect(await s.list(V)).toEqual([]);
      expect(await s.adopt(V, 1, 'a', VARIANT)).toBe(true);
      await s.delete(V, 1);
      expect(await s.versions(V, 1)).toEqual([]);
    });
  });
}

describe('KvTrackStore', () => {
  it('reads a track stored before versions existed', async () => {
    const kv = new MemoryKv();
    await kv.write(
      `tracks/${V}/1/browser-sam2.json`,
      JSON.stringify({objectId: 1, seedsKey: 'old', variant: VARIANT, nFrames: 1, masks: [[0, mask('04')]]}),
    );
    const s = new KvTrackStore(kv);
    expect((await s.get(V, 1))!.seedsKey).toBe('old');
    expect(await s.versions(V, 1)).toEqual([]);
  });
});

describe('OfflineService undo (test_versions.py)', () => {
  async function trackNow(svc: OfflineService, obj: number, counts: string): Promise<void> {
    const seeds = await svc.seeds.seeds(V, obj);
    const ranges = await svc.seeds.ranges(V, obj);
    await svc.tracks.put(V, {
      ...track(obj, seedsKey(seedPoints(seeds), ranges), counts),
      record: await svc.seeds.record(V, obj),
    });
  }
  const info = (svc: OfflineService, obj = 1) => svc.objectInfo(V, obj, VARIANT, new Set());
  const stateOf = async (svc: OfflineService, obj = 1) => (await info(svc, obj)).tracks?.[0]?.state;

  it('undoing an accidental click brings back the earlier track, with no job', async () => {
    const svc = new OfflineService(new MemoryKv());
    await svc.recordPoints(V, 1, 0, [[0.5, 0.5, 1]], mask('04'));
    await trackNow(svc, 1, '04');
    await svc.recordPoints(V, 1, 5, [[0.2, 0.2, 1]], mask('13')); // the accident
    await trackNow(svc, 1, '13');
    const o = await svc.undo(V, 1, VARIANT);
    expect(o.seeds.map(s => s.frameIndex)).toEqual([0]);
    expect(o.tracks?.[0].state).toBe('tracked');
    expect((await svc.tracks.get(V, 1))!.masks.get(0)).toEqual(mask('04'));
    expect(o.history?.canRedo).toBe(true);
    await svc.redo(V, 1, VARIANT);
    expect((await svc.tracks.get(V, 1))!.masks.get(0)).toEqual(mask('13'));
    expect(await stateOf(svc)).toBe('tracked');
  });

  it('covers ranges, survives a new instance, and a new change clears redo', async () => {
    const kv = new MemoryKv();
    const svc = new OfflineService(kv);
    await svc.recordPoints(V, 1, 0, [[0.5, 0.5, 1]], null);
    await trackNow(svc, 1, '04');
    await svc.setRange(V, 1, 3, 4, 'absent');
    expect(await stateOf(svc)).toBe('stale');
    const again = new OfflineService(kv);
    const o = await again.undo(V, 1, VARIANT);
    expect(o.ranges).toEqual([]);
    expect(await stateOf(again)).toBe('tracked');
    await again.recordPoints(V, 1, 2, [[0.1, 0.1, 1]], null);
    expect((await info(again)).history?.canRedo).toBe(false);
    await expect(again.redo(V, 1, VARIANT)).rejects.toThrow(/nothing to redo/i);
  });

  it('lists versions with engine, clicks and which one is current, and restores one', async () => {
    const svc = new OfflineService(new MemoryKv());
    await svc.recordPoints(V, 1, 0, [[0.5, 0.5, 1]], null);
    await trackNow(svc, 1, '04');
    await svc.recordPoints(V, 1, 5, [[0.2, 0.2, 1], [0.3, 0.3, 0]], null);
    await trackNow(svc, 1, '13');
    const vs = (await info(svc)).history!.versions;
    expect(vs.map(v => [v.engine, v.clicks, v.current])).toEqual([
      ['browser-sam2', 3, true],
      ['browser-sam2', 1, false],
    ]);
    const o = await svc.restoreVersion(V, 1, vs[1].key!, VARIANT);
    expect(o.seeds.map(s => s.frameIndex)).toEqual([0]);
    expect(o.tracks?.[0].state).toBe('tracked');
    expect((await svc.undo(V, 1, VARIANT)).seeds.map(s => s.frameIndex)).toEqual([0, 5]);
  });

  it('clearing the last click keeps the track to undo back to', async () => {
    const svc = new OfflineService(new MemoryKv());
    await svc.recordPoints(V, 1, 0, [[0.5, 0.5, 1]], null);
    await trackNow(svc, 1, '04');
    await svc.clearFrame(V, 1, 0);
    expect(await stateOf(svc)).toBe('untracked');
    await svc.undo(V, 1, VARIANT);
    expect(await stateOf(svc)).toBe('tracked');
  });

  it('is refused while a job holds the object', async () => {
    const held = new Set<number>();
    const svc = new OfflineService(new MemoryKv(), () => held);
    await svc.recordPoints(V, 1, 0, [[0.5, 0.5, 1]], null);
    held.add(1);
    await expect(svc.undo(V, 1, VARIANT)).rejects.toThrow(/being tracked/);
    held.clear();
    await svc.undo(V, 1, VARIANT);
    expect((await svc.seeds.seeds(V, 1)).size).toBe(0);
  });

  it('removing the object forgets its history and versions', async () => {
    const kv = new MemoryKv();
    const svc = new OfflineService(kv);
    await svc.recordPoints(V, 1, 0, [[0.5, 0.5, 1]], null);
    await trackNow(svc, 1, '04');
    await svc.removeObject(V, 1);
    expect(kv.files.size).toBe(0);
  });
});
