// sam-ui (Apache-2.0). New file, not from SAM 2.
import {afterEach, expect, test, vi} from 'vitest';
import {FrameStore} from './frameStore';

/** Just enough of WebCodecs' VideoFrame: tracks whether a frame owns its pixels. */
class FakeFrame {
  closed = false;
  readonly owned: boolean;
  readonly codedWidth = 64;
  readonly codedHeight = 32;
  readonly displayWidth = 64;
  readonly displayHeight = 32;
  readonly format = 'NV12';
  readonly colorSpace = {};
  readonly visibleRect = null;
  readonly duration = null;
  readonly timestamp: number;
  constructor(source: ArrayBuffer | FakeFrame, init: {timestamp: number}) {
    this.owned = source instanceof ArrayBuffer; // a clone or wrap shares the decoder's buffer
    this.timestamp = init.timestamp;
  }
  allocationSize() {
    return this.codedWidth * this.codedHeight * 1.5;
  }
  async copyTo() {}
  clone() {
    return new FakeFrame(this, this);
  }
  close() {
    this.closed = true;
  }
}

afterEach(() => vi.unstubAllGlobals());

test('the cache keeps an owned copy and closes the decoder frame at once (#1)', async () => {
  vi.stubGlobal('VideoFrame', FakeFrame);
  const decoded: FakeFrame[] = [];
  let samplesClosed = 0;
  const sink = {
    async *samples() {
      for (const timestamp of [0, 1, 2]) {
        yield {
          timestamp,
          toVideoFrame: () => {
            const f = new FakeFrame(new FakeFrame(new ArrayBuffer(0), {timestamp}), {timestamp});
            decoded.push(f);
            return f;
          },
          close: () => samplesClosed++,
        };
      }
    },
  };
  const Store = FrameStore as unknown as new (...args: unknown[]) => FrameStore;
  const store = new Store({dispose: () => {}}, sink, [0, 1, 2], {width: 64, height: 32, numFrames: 3, fps: 1}, 1e9);

  const frame = (await store.frame(0)) as unknown as FakeFrame;

  expect(decoded).toHaveLength(3);
  expect(decoded.every(f => f.closed)).toBe(true);
  expect(samplesClosed).toBeGreaterThanOrEqual(3);
  const cached = [...(store as unknown as {_cache: Map<number, FakeFrame>})._cache.values()];
  expect(cached).toHaveLength(3);
  expect(cached.every(f => f.owned && !f.closed && !decoded.includes(f))).toBe(true);
  expect(store.cachedBytes).toBe(3 * 64 * 32 * 1.5);
  frame.close();
  expect(cached[0].closed).toBe(false);
});
