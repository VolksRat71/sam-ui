// sam-ui (Apache-2.0). New file, not from SAM 2.
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {FrameStore} from './frameStore';

/** The decoder's buffer: a frame made from it (or cloned from one) holds the pool. */
const POOL = {};
const W = 64;
const H = 32;

/** How the next decoder frames behave. */
let format: string | null;
let copyTo: () => Promise<void>;

/** Just enough of WebCodecs' VideoFrame: tracks whether a frame owns its pixels. */
class FakeFrame {
  closed = false;
  readonly owned: boolean;
  readonly format: string | null;
  readonly codedWidth = W;
  readonly codedHeight = H;
  readonly displayWidth = W;
  readonly displayHeight = H;
  readonly colorSpace = {};
  readonly visibleRect = null;
  readonly duration = null;
  readonly timestamp: number;
  constructor(source: unknown, init: {timestamp: number; format?: string | null}) {
    this.owned = source !== POOL && !(source instanceof FakeFrame); // a buffer or a bitmap
    this.timestamp = init.timestamp;
    this.format = source === POOL ? format : source instanceof FakeFrame ? source.format : (init.format ?? 'RGBA');
  }
  allocationSize() {
    if (this.format == null) {
      throw new DOMException('no format', 'NotSupportedError');
    }
    return W * H * 1.5;
  }
  copyTo() {
    return this.format == null ? Promise.reject(new DOMException('no format', 'NotSupportedError')) : copyTo();
  }
  clone() {
    return new FakeFrame(this, this);
  }
  close() {
    this.closed = true;
  }
}

let decoded: FakeFrame[];
let samples: {closed: boolean}[];
let bitmaps: {closed: boolean}[];

function store(): FrameStore {
  const sink = {
    async *samples() {
      for (const timestamp of [0, 1, 2]) {
        const sample = {
          timestamp,
          closed: false,
          toVideoFrame: () => {
            const f = new FakeFrame(POOL, {timestamp});
            decoded.push(f);
            return f;
          },
          close: () => {
            sample.closed = true;
          },
        };
        samples.push(sample);
        yield sample;
      }
    },
  };
  const Store = FrameStore as unknown as new (...args: unknown[]) => FrameStore;
  return new Store({dispose: () => {}}, sink, [0, 1, 2], {width: W, height: H, numFrames: 3, fps: 1}, 1e9);
}

const cache = (s: FrameStore) => [...(s as unknown as {_cache: Map<number, FakeFrame>})._cache.values()];

beforeEach(() => {
  format = 'NV12';
  copyTo = async () => {};
  decoded = [];
  samples = [];
  bitmaps = [];
  vi.stubGlobal('VideoFrame', FakeFrame);
  vi.stubGlobal('createImageBitmap', async () => {
    const b = {width: W, height: H, closed: false, close: () => (b.closed = true)};
    bitmaps.push(b);
    return b;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('the cache keeps an owned copy and closes the decoder frame at once (#1)', async () => {
  const s = store();
  const frame = (await s.frame(0)) as unknown as FakeFrame;

  expect(decoded).toHaveLength(3);
  expect(decoded.every(f => f.closed)).toBe(true);
  expect(samples.every(x => x.closed)).toBe(true);
  const cached = cache(s);
  expect(cached).toHaveLength(3);
  expect(cached.every(f => f.owned && !f.closed && f.format === 'NV12')).toBe(true);
  expect(s.cachedBytes).toBe(3 * W * H * 1.5);
  frame.close();
  expect(cached[0].closed).toBe(false);
});

test('a frame with no CPU format (10-bit hardware) is rasterized to an owned RGBA frame', async () => {
  format = null;
  const s = store();
  const frame = (await s.frame(0)) as unknown as FakeFrame;

  expect(frame.closed).toBe(false);
  expect(decoded.every(f => f.closed)).toBe(true);
  expect(bitmaps.length === 3 && bitmaps.every(b => b.closed)).toBe(true);
  const cached = cache(s);
  expect(cached.every(f => f.owned && !f.closed && f.format === 'RGBA')).toBe(true);
  expect(s.cachedBytes).toBe(3 * W * H * 4);
});

test('when copyTo fails, the clone fallback warns once', async () => {
  copyTo = () => Promise.reject(new Error('copyTo failed'));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const s = store();
  await s.frame(0);

  expect(warn).toHaveBeenCalledTimes(1);
  expect(decoded.every(f => f.closed)).toBe(true);
  expect(cache(s)).toHaveLength(3);
});

test('closing the store while a copy is pending closes the copy instead of caching it', async () => {
  let release = () => {};
  const held = new Promise<void>(r => (release = r));
  let copying = () => {};
  const started = new Promise<void>(r => (copying = r));
  copyTo = () => {
    copying();
    return held;
  };
  const created: FakeFrame[] = [];
  vi.stubGlobal(
    'VideoFrame',
    class extends FakeFrame {
      constructor(source: unknown, init: {timestamp: number}) {
        super(source, init);
        created.push(this);
      }
    },
  );
  const s = store();
  const pending = s.frame(0);
  await started;
  s.close();
  release();

  await expect(pending).rejects.toThrow();
  expect(s.cachedFrames).toBe(0);
  expect(s.cachedBytes).toBe(0);
  expect(decoded.length > 0 && decoded.every(f => f.closed)).toBe(true);
  expect(created.length > 0 && created.every(f => f.closed)).toBe(true);
});
