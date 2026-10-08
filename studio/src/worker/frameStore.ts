// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The open video's frames, decoded on demand and kept in an LRU bounded by
// bytes, so studio's memory does not grow with the clip. Meta's decoder
// (src/meta/common/codecs/VideoDecoder.ts) decoded every frame up front and
// kept them all: a 2-minute 720p clip held 3.9 GB of frames, and the 5-minute
// uploads a current backend takes would hold far more.
//
// Frames are addressed by index in presentation order. A miss decodes a run
// of frames (mediabunny: from the keyframe before, in hardware) in the
// direction the reader is moving, so playback forward and a track job's
// reverse pass both hit the cache. Callers get their own clone of a frame
// and must close it; eviction closes only the cache's copy.
import {ALL_FORMATS, BlobSource, EncodedPacketSink, Input, type InputVideoTrack, UrlSource, VideoSampleSink} from 'mediabunny';
import {cloneFrame} from '@/common/codecs/WebCodecUtils';
import {DECODED_FRAME_BYTES} from '~/budgets';

/** Frames decoded per miss: enough to play ahead smoothly, few enough to decode fast. */
const RUN = 24;

export type FrameStoreInfo = {width: number; height: number; numFrames: number; fps: number};

export class FrameStore {
  private readonly _cache = new Map<number, VideoFrame>();
  private readonly _pending = new Map<number, Promise<void>>();
  private _bytes = 0;
  private _last = -1;
  private _closed = false;

  private constructor(
    private readonly _input: Input,
    private readonly _sink: VideoSampleSink,
    /** Presentation timestamps, seconds, in order. */
    private readonly _times: number[],
    readonly info: FrameStoreInfo,
    private readonly _budget: number,
  ) {}

  // ponytail: the 1 GB budget now holds owned copies in the renderer (CPU
  // buffers; RGBA rasters for 10-bit), not decoder buffers. It is sized for a
  // 16 GB Mac; low-RAM Android may need a smaller one passed here.
  /** Open a video (a URL, or a blob: URL), reading only what it needs to index the frames. */
  static async open(url: string, budget = DECODED_FRAME_BYTES): Promise<FrameStore> {
    // a path ("/sam-ui/samples/x.mp4") is relative to the page; a worker has no base for it
    const href = new URL(url, self.location.href).href;
    const source = href.startsWith('blob:')
      ? new BlobSource(await (await fetch(href)).blob())
      : new UrlSource(href, {requestInit: {credentials: 'same-origin', cache: 'no-store'}});
    const input = new Input({source, formats: ALL_FORMATS});
    const track: InputVideoTrack | null = await input.getPrimaryVideoTrack();
    if (track == null) {
      throw new Error('the file has no video track');
    }
    const times: number[] = [];
    for await (const p of new EncodedPacketSink(track).packets(undefined, undefined, {metadataOnly: true})) {
      times.push(p.timestamp);
    }
    times.sort((a, b) => a - b);
    if (times.length === 0) {
      throw new Error('the video has no frames');
    }
    const duration = (await track.computeDuration()) - times[0];
    const fps = duration > 0 ? times.length / duration : 30;
    const sink = new VideoSampleSink(track);
    const info = {width: track.displayWidth, height: track.displayHeight, numFrames: times.length, fps};
    return new FrameStore(input, sink, times, info, budget);
  }

  get cachedFrames(): number {
    return this._cache.size;
  }

  get cachedBytes(): number {
    return this._bytes;
  }

  /** Frame `index`'s presentation time, seconds from the first frame. */
  time(index: number): number {
    return this._times[index] - this._times[0];
  }

  /**
   * Frame `index` as a VideoFrame the caller owns (close it). `run` frames
   * are decoded on a miss (1 for sparse reads, like the filmstrip's).
   */
  async frame(index: number, run = RUN): Promise<VideoFrame> {
    if (this._closed) {
      throw new Error('the video is closed');
    }
    const i = Math.max(0, Math.min(this._times.length - 1, Math.round(index)));
    const reverse = this._last >= 0 && i < this._last && this._last - i <= RUN;
    this._last = i;
    let f = this._cache.get(i);
    if (f == null) {
      await (this._pending.get(i) ?? this._decodeRun(reverse ? Math.max(0, i - run + 1) : i, run));
      f = this._cache.get(i);
      if (f == null) {
        // evicted before we got to it (a tiny budget): decode it alone
        await this._decodeRun(i, 1);
        f = this._cache.get(i);
      }
      if (f == null) {
        throw new Error(`frame ${i} could not be decoded`);
      }
    } else {
      this._touch(i, f);
    }
    return f.clone();
  }

  /** The cached frame, if any, without decoding (a clone the caller closes). */
  peek(index: number): VideoFrame | null {
    return this._cache.get(index)?.clone() ?? null;
  }

  private _touch(i: number, f: VideoFrame): void {
    this._cache.delete(i);
    this._cache.set(i, f);
  }

  private _put(i: number, f: VideoFrame): void {
    const old = this._cache.get(i);
    if (old != null) {
      old.close();
      this._bytes -= frameBytes(old);
      this._cache.delete(i);
    }
    this._cache.set(i, f);
    this._bytes += frameBytes(f);
    for (const [k, v] of this._cache) {
      if (this._bytes <= this._budget || this._cache.size <= 1) {
        break;
      }
      if (k === i) {
        continue;
      }
      v.close();
      this._bytes -= frameBytes(v);
      this._cache.delete(k);
    }
  }

  /** Decode frames [start, start + n) that are not cached, in one pass. */
  private _decodeRun(start: number, n = RUN): Promise<void> {
    const end = Math.min(this._times.length, start + n);
    const wanted: number[] = [];
    for (let i = start; i < end; i++) {
      if (!this._cache.has(i) && !this._pending.has(i)) {
        wanted.push(i);
      }
    }
    if (wanted.length === 0) {
      return Promise.all([...Array(end - start).keys()].map(k => this._pending.get(start + k))).then(() => {});
    }
    const run = (async () => {
      const first = wanted[0];
      const last = wanted[wanted.length - 1];
      const t0 = this._times[first];
      const t1 = last + 1 < this._times.length ? this._times[last + 1] : Infinity;
      let i = first;
      for await (const sample of this._sink.samples(t0, t1)) {
        // match samples to frames by timestamp (a sample may repeat or skip one)
        while (i < last && this._times[i + 1] <= sample.timestamp + 1e-6) {
          i++;
        }
        if (!this._closed && !this._cache.has(i)) {
          // Cache an owned copy and close the decoder's frame at once: a clone
          // would still hold its output buffer, and Chrome's hardware decoders
          // on Android and Windows stop at a small pool of those (#1).
          const decoded = sample.toVideoFrame();
          sample.close();
          const owned = await ownedCopy(decoded).finally(() => decoded.close());
          if (this._closed) {
            owned.close();
          } else {
            this._put(i, owned);
          }
        }
        sample.close();
        if (i >= last) {
          break;
        }
      }
    })();
    const done = run.finally(() => wanted.forEach(i => this._pending.delete(i)));
    wanted.forEach(i => this._pending.set(i, done));
    return done;
  }

  close(): void {
    this._closed = true;
    for (const f of this._cache.values()) {
      f.close();
    }
    this._cache.clear();
    this._bytes = 0;
    this._input.dispose();
  }
}

/**
 * A copy of `f` that does not hold the decoder's buffer. A frame with no CPU
 * format (Chrome's 10-bit hardware frames: HEVC Main10, VP9 profile 2) cannot
 * be read with copyTo, so it is rasterized to RGBA at its display size, as
 * drawImage would show it.
 */
async function ownedCopy(f: VideoFrame): Promise<VideoFrame> {
  if (f.format != null) {
    return cloneFrame(f);
  }
  const bitmap = await createImageBitmap(f);
  try {
    return new VideoFrame(bitmap, {timestamp: f.timestamp, duration: f.duration ?? undefined});
  } finally {
    bitmap.close();
  }
}

/** A decoded frame's size in memory (NV12 / I420: 1.5 bytes a pixel, else 4). */
export function frameBytes(f: {codedWidth: number; codedHeight: number; format: VideoPixelFormat | null}): number {
  const px = f.codedWidth * f.codedHeight;
  return f.format === 'NV12' || f.format === 'I420' ? px * 1.5 : px * 4;
}
