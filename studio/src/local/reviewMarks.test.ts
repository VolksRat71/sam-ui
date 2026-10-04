// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import type {ReviewMark} from '~/state/audit';
import {MemoryKv} from './kv';
import {OfflineService} from './offlineStores';
import {KvReviewStore} from './reviewMarks';

const V = 'v'.repeat(64);
const mark = (frame: number, engine = 'browser-sam2', mask = 'm'): ReviewMark => ({frame, span: [frame, frame + 2], engine, at: 't', mask, reasons: []});

describe('reviewed marks with no backend', () => {
  it('are kept per object, one per frame and engine', async () => {
    const kv = new MemoryKv();
    const store = new KvReviewStore(kv);
    await store.mark(V, 1, mark(5));
    await store.mark(V, 1, mark(5, 'browser-sam2', 'n')); // marked again: replaced
    await store.mark(V, 1, mark(5, 'other'));
    await store.mark(V, 2, mark(9));
    expect((await store.marks(V, 1)).map(m => [m.frame, m.engine, m.mask])).toEqual([
      [5, 'browser-sam2', 'n'],
      [5, 'other', 'm'],
    ]);
    expect(kv.files.has(`seeds/${V}/1/review.json`)).toBe(true);
    expect(await new KvReviewStore(kv).marks(V, 2)).toHaveLength(1); // read back, as after a reload
  });

  it('unmark drops the marks reviewing a stretch, on one engine', async () => {
    const store = new KvReviewStore(new MemoryKv());
    await store.mark(V, 1, mark(5)); // reviews 5-7
    await store.mark(V, 1, mark(20));
    await store.mark(V, 1, mark(6, 'other'));
    await store.unmark(V, 1, 'browser-sam2', 7, 7);
    expect((await store.marks(V, 1)).map(m => m.frame)).toEqual([20, 6]);
  });

  it('read a damaged file as none', async () => {
    const kv = new MemoryKv();
    await kv.write(`seeds/${V}/1/review.json`, 'not json');
    expect(await new KvReviewStore(kv).marks(V, 1)).toEqual([]);
    await kv.write(`seeds/${V}/1/review.json`, JSON.stringify({marks: [{frame: 'x'}, 7, mark(3)]}));
    expect((await new KvReviewStore(kv).marks(V, 1)).map(m => m.frame)).toEqual([3]);
  });

  it('go with their object, and never list one', async () => {
    const kv = new MemoryKv();
    const offline = new OfflineService(kv);
    await offline.seeds.addPoints(V, 1, 0, [[0.5, 0.5]], [1], true);
    const store = new KvReviewStore(kv);
    await store.mark(V, 1, mark(5));
    await store.mark(V, 4, mark(5)); // an object with nothing but a review file
    expect(await offline.seeds.objects(V)).toEqual([1]);
    await offline.removeObject(V, 1);
    expect(await store.marks(V, 1)).toEqual([]);
  });
});
