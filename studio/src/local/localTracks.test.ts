// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {fromServer, type NormPoint, type ServerObject} from '~/state/objects';
import {
  BROWSER_ENGINE,
  type LocalTrack,
  localTrackEntry,
  MemoryTrackStore,
  seedsKey,
  variantKey,
  withLocalTracks,
} from './localTracks';

const rle = {size: [2, 2] as [number, number], counts: '04'};

function track(objectId: number, frames: number[], key: string, variant = variantKey(512, 0)): LocalTrack {
  return {objectId, seedsKey: key, variant, masks: new Map(frames.map(f => [f, rle])), nFrames: frames.length};
}

describe('seedsKey', () => {
  it('is independent of insertion order and ignores frames without clicks', () => {
    const a = new Map<number, NormPoint[]>([
      [4, [[0.5, 0.5, 1]]],
      [1, [[0.1, 0.2, 0]]],
    ]);
    const b = new Map<number, NormPoint[]>([
      [1, [[0.1, 0.2, 0]]],
      [7, []],
      [4, [[0.5, 0.5, 1]]],
    ]);
    expect(seedsKey(a)).toBe(seedsKey(b));
    expect(seedsKey(a)).not.toBe(seedsKey(new Map([[4, [[0.5, 0.5, 1] as NormPoint]]])));
  });
});

describe('localTrackEntry', () => {
  const current = {seedsKey: 'k', variant: variantKey(512, 0), running: false};

  it('is untracked, tracked, stale or tracking, as the backend decides', () => {
    expect(localTrackEntry(null, current)).toEqual({engine: BROWSER_ENGINE, state: 'untracked', frames: null, nFrames: 0});
    expect(localTrackEntry(track(0, [2, 0, 5], 'k'), current)).toEqual({
      engine: BROWSER_ENGINE,
      state: 'tracked',
      frames: [0, 5],
      nFrames: 3,
    });
    expect(localTrackEntry(track(0, [0], 'old'), current).state).toBe('stale');
    // other model settings make it stale too
    expect(localTrackEntry(track(0, [0], 'k', variantKey(1024, 0)), current).state).toBe('stale');
    expect(localTrackEntry(track(0, [0], 'k'), {...current, running: true}).state).toBe('tracking');
    expect(localTrackEntry(null, {...current, running: true}).state).toBe('tracking');
  });
});

describe('withLocalTracks', () => {
  const server: ServerObject = {
    objectId: 3,
    state: 'tracked',
    frames: [0, 9],
    nFrames: 10,
    seeds: [{frameIndex: 0, points: [[0.5, 0.5]], labels: [1]}],
  };

  it('adds the browser track beside the server engines, and the reducer reads it', () => {
    const merged = withLocalTracks([server], new Map([[3, localTrackEntry(track(3, [0, 1], 'k'), {seedsKey: 'k', variant: variantKey(512, 0), running: false})]]));
    expect(merged[0].tracks?.map(t => [t.engine, t.state])).toEqual([
      ['sam2', 'tracked'],
      [BROWSER_ENGINE, 'tracked'],
    ]);
    const o = fromServer(merged[0], BROWSER_ENGINE);
    expect(o.state).toBe('tracked');
    expect(o.frames).toEqual([0, 1]);
    expect(o.engines.sam2.state).toBe('tracked');
  });

  it('replaces an older browser entry and leaves objects without one alone', () => {
    const once = withLocalTracks([server], new Map([[3, {engine: BROWSER_ENGINE, state: 'stale', frames: null, nFrames: 0}]]));
    const twice = withLocalTracks(once, new Map([[3, {engine: BROWSER_ENGINE, state: 'tracking', frames: null, nFrames: 0}]]));
    expect(twice[0].tracks?.filter(t => t.engine === BROWSER_ENGINE).map(t => t.state)).toEqual(['tracking']);
    expect(withLocalTracks([server], new Map())[0]).toBe(server);
  });
});

describe('MemoryTrackStore', () => {
  it('keeps tracks per video and object', async () => {
    const store = new MemoryTrackStore();
    await store.put('a.mp4', track(1, [0], 'k'));
    await store.put('a.mp4', track(0, [0], 'k'));
    await store.put('b.mp4', track(0, [0], 'k'));
    expect((await store.list('a.mp4')).map(t => t.objectId)).toEqual([0, 1]);
    await store.delete('a.mp4', 0);
    expect(await store.get('a.mp4', 0)).toBeNull();
    await store.clear('a.mp4');
    expect(await store.list('a.mp4')).toEqual([]);
    expect(await store.get('b.mp4', 0)).not.toBeNull();
  });
});
