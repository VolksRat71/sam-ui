// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The five exported SAM 2.1 graphs on ONNX Runtime Web: WebGPU in the
// browser (wasm is for Node checks and browsers without WebGPU).
//
// On WebGPU the big tensors stay on the GPU between graphs (IO binding
// through preferredOutputLocation): the encoder's feature maps, the
// decoder's high-res mask (the memory encoder's input), and memory
// attention's conditioned features (the decoder's input). What JS needs, it
// reads back: the low-res logits, the pointer and score, the memories, and
// feats2 once per frame, transposed to tokens for memory attention.
//
// Encoder outputs are cached per frame, least recently used first out past
// a byte budget (the browser version of the backend's features.py), so a
// click on a seen frame, a second object or a re-track skip the encoder.
// Entries in use are reference counted and never evicted.
//
// Every run goes through one queue: ORT sessions must not run concurrently,
// and a click then waits for at most one graph of a running track.
import type * as OrtNs from 'onnxruntime-web';
import {MODEL_FILES, type ModelFile, parseConstants, type Sam2Constants} from './config';
import {preprocess, toTokens} from './masks';
import type {HeldMemory} from './memoryBank';
import type {DecoderOutput, Releasable, Sam2Models} from './tracker';

type Ort = typeof OrtNs;
type Tensor = OrtNs.Tensor;

export type Pixels = {data: Uint8ClampedArray | Uint8Array; size: number};
/** One frame's RGBA pixels at the model's input size (size x size). */
export type FrameSource = (frame: number, size: number) => Promise<Pixels>;
export type FileLoader = (file: ModelFile | 'constants.json') => Promise<Uint8Array>;

export type OrtModelOptions = {
  ep: 'webgpu' | 'wasm';
  load: FileLoader;
  frames: FrameSource;
  /** Feature cache budget; about 20 MB a frame at 1024 and 5 MB at 512. */
  cacheBytes?: number;
};

export type RunTimes = Record<'encoder' | 'decoder' | 'memoryEncoder' | 'memoryAttention' | 'pointerTpos', {n: number; ms: number}>;

type Entry = {
  frame: number;
  feats0: Tensor;
  feats1: Tensor;
  feats2: Tensor;
  feats2NoMem: Tensor;
  /** feats2 as [F*F, 1, 256], for memory attention. */
  tokens: Float32Array;
  bytes: number;
  refs: number;
};

class Handle implements Releasable {
  private _done = false;
  constructor(
    readonly value: Entry | Tensor,
    private readonly _release: () => void,
  ) {}
  release(): void {
    if (!this._done) {
      this._done = true;
      this._release();
    }
  }
}

function bytesOf(t: Tensor): number {
  return t.dims.reduce((a, b) => a * b, 1) * 4;
}

export class OrtSam2Models implements Sam2Models {
  readonly times: RunTimes = {
    encoder: {n: 0, ms: 0},
    decoder: {n: 0, ms: 0},
    memoryEncoder: {n: 0, ms: 0},
    memoryAttention: {n: 0, ms: 0},
    pointerTpos: {n: 0, ms: 0},
  };
  private _cache = new Map<number, Entry>();
  private _pending = new Map<number, Promise<Entry>>();
  private _cacheBytes = 0;
  private _posTokens: Float32Array | null = null;
  private _queue: Promise<unknown> = Promise.resolve();
  private _canvas: OffscreenCanvas | null = null;

  private constructor(
    private readonly _ort: Ort,
    readonly constants: Sam2Constants,
    private readonly _s: Record<'enc' | 'dec' | 'mem' | 'attn' | 'ptr', OrtNs.InferenceSession>,
    private readonly _opts: OrtModelOptions,
  ) {}

  static async create(ort: Ort, opts: OrtModelOptions): Promise<OrtSam2Models> {
    const constants = parseConstants(JSON.parse(new TextDecoder().decode(await opts.load('constants.json'))));
    const gpu = opts.ep === 'webgpu';
    const where = (names: string[]) =>
      gpu ? (Object.fromEntries(names.map(n => [n, 'gpu-buffer'])) as Record<string, OrtNs.Tensor.DataLocation>) : undefined;
    const make = async (file: ModelFile, outputs: string[]) =>
      ort.InferenceSession.create(await opts.load(file), {
        executionProviders: [opts.ep],
        graphOptimizationLevel: 'all',
        preferredOutputLocation: where(outputs),
      });
    const [enc, dec, mem, attn, ptr] = await Promise.all([
      make(MODEL_FILES[0], ['feats0', 'feats1', 'feats2', 'feats2_no_mem', 'vision_pos_embed']),
      make(MODEL_FILES[1], ['high_res_mask']),
      make(MODEL_FILES[2], []),
      make(MODEL_FILES[3], ['conditioned_feats']),
      make(MODEL_FILES[4], []),
    ]);
    return new OrtSam2Models(ort, constants, {enc, dec, mem, attn, ptr}, opts);
  }

  get cachedFrames(): number {
    return this._cache.size;
  }

  get cachedBytes(): number {
    return this._cacheBytes;
  }

  /** Run `fn` after every run queued before it. */
  private _serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this._queue.then(fn, fn);
    this._queue = next.catch(() => {});
    return next;
  }

  private async _run(
    name: keyof RunTimes,
    session: OrtNs.InferenceSession,
    feeds: Record<string, Tensor>,
  ): Promise<OrtNs.InferenceSession.OnnxValueMapType> {
    return this._serial(async () => {
      const t0 = performance.now();
      const out = await session.run(feeds);
      this.times[name].n++;
      this.times[name].ms += performance.now() - t0;
      return out;
    });
  }

  private _pixels(p: Pixels): Float32Array {
    const size = this.constants.imageSize;
    if (p.size !== size) {
      throw new Error(`frame is ${p.size} px, the model wants ${size}`);
    }
    return preprocess(p.data, size, this.constants.mean, this.constants.std);
  }

  private async _encode(frame: number): Promise<Entry> {
    const c = this.constants;
    const pixels = this._pixels(await this._opts.frames(frame, c.imageSize));
    const input = new this._ort.Tensor('float32', pixels, [1, 3, c.imageSize, c.imageSize]);
    const out = await this._run('encoder', this._s.enc, {pixel_values: input});
    const hw = c.featSize * c.featSize;
    const tokens = toTokens((await out.feats2.getData()) as Float32Array, 256, hw);
    if (this._posTokens == null) {
      // a sine PE of the feature shape: the same on every frame
      this._posTokens = toTokens((await out.vision_pos_embed.getData()) as Float32Array, 256, hw);
    }
    out.vision_pos_embed.dispose();
    const entry: Entry = {
      frame,
      feats0: out.feats0,
      feats1: out.feats1,
      feats2: out.feats2,
      feats2NoMem: out.feats2_no_mem,
      tokens,
      bytes: bytesOf(out.feats0) + bytesOf(out.feats1) + 2 * bytesOf(out.feats2) + tokens.byteLength,
      refs: 0,
    };
    return entry;
  }

  private _evict(): void {
    const budget = this._opts.cacheBytes ?? 1.5e9;
    for (const [frame, e] of this._cache) {
      if (this._cacheBytes <= budget) {
        return;
      }
      if (e.refs > 0) {
        continue;
      }
      this._drop(frame, e);
    }
  }

  private _drop(frame: number, e: Entry): void {
    this._cache.delete(frame);
    this._cacheBytes -= e.bytes;
    for (const t of [e.feats0, e.feats1, e.feats2, e.feats2NoMem]) {
      t.dispose();
    }
  }

  async features(frame: number): Promise<Releasable> {
    let entry = this._cache.get(frame);
    if (entry == null) {
      let pending = this._pending.get(frame);
      if (pending == null) {
        pending = this._encode(frame).finally(() => this._pending.delete(frame));
        this._pending.set(frame, pending);
        const e = await pending;
        this._cache.set(frame, e);
        this._cacheBytes += e.bytes;
      }
      entry = await pending;
    } else {
      // most recently used last
      this._cache.delete(frame);
      this._cache.set(frame, entry);
    }
    entry.refs++;
    const e = entry;
    this._evict();
    return new Handle(e, () => {
      e.refs--;
      this._evict();
    });
  }

  /** Forget every cached frame (another video, or the model is going). */
  clearCache(): void {
    for (const [frame, e] of this._cache) {
      if (e.refs === 0) {
        this._drop(frame, e);
      }
    }
  }

  private _entry(h: Releasable): Entry {
    return (h as Handle).value as Entry;
  }

  private _tensor(h: Releasable): Tensor {
    return (h as Handle).value as Tensor;
  }

  async decode(features: Releasable, cond: Releasable | null, points: Float32Array, labels: Int32Array): Promise<DecoderOutput> {
    const e = this._entry(features);
    const n = labels.length;
    const out = await this._run('decoder', this._s.dec, {
      feats0: e.feats0,
      feats1: e.feats1,
      feats2_cond: cond == null ? e.feats2NoMem : this._tensor(cond),
      input_points: new this._ort.Tensor('float32', points, [1, 1, n, 2]),
      input_labels: new this._ort.Tensor('int32', labels, [1, 1, n]),
    });
    const low = out.low_res_mask;
    const high = out.high_res_mask;
    return {
      lowRes: low.data as Float32Array,
      lowSize: low.dims[3],
      highRes: new Handle(high, () => high.dispose()),
      objectScore: (out.object_score_logits.data as Float32Array)[0],
      pointer: (out.object_pointer.data as Float32Array).slice(0, 256),
      iou: (out.iou.data as Float32Array)[0],
    };
  }

  async encodeMemory(features: Releasable, mask: Releasable | Float32Array, objectScore: number, binarize: boolean): Promise<HeldMemory> {
    const e = this._entry(features);
    const s = this.constants.imageSize;
    const out = await this._run('memoryEncoder', this._s.mem, {
      feats2: e.feats2,
      high_res_mask: mask instanceof Float32Array ? new this._ort.Tensor('float32', mask, [1, 1, s, s]) : this._tensor(mask),
      object_score_logits: new this._ort.Tensor('float32', new Float32Array([objectScore]), [1, 1]),
      binarize: new this._ort.Tensor('float32', new Float32Array([binarize ? 1 : 0]), []),
    });
    return {tokens: out.memory_tokens.data as Float32Array, pos: out.memory_pos.data as Float32Array};
  }

  async attend(features: Releasable, memory: Float32Array, memoryPos: Float32Array): Promise<Releasable> {
    const e = this._entry(features);
    const hw = this.constants.featSize * this.constants.featSize;
    const n = memory.length / this.constants.memDim;
    const out = await this._run('memoryAttention', this._s.attn, {
      current_vision_features: new this._ort.Tensor('float32', e.tokens, [hw, 1, 256]),
      current_vision_position_embeddings: new this._ort.Tensor('float32', this._posTokens!, [hw, 1, 256]),
      memory: new this._ort.Tensor('float32', memory, [n, 1, this.constants.memDim]),
      memory_pos: new this._ort.Tensor('float32', memoryPos, [n, 1, this.constants.memDim]),
    });
    const t = out.conditioned_feats;
    return new Handle(t, () => t.dispose());
  }

  async pointerPos(normalizedDiffs: Float32Array): Promise<Float32Array> {
    const out = await this._run('pointerTpos', this._s.ptr, {
      normalized_diffs: new this._ort.Tensor('float32', normalizedDiffs, [normalizedDiffs.length]),
    });
    return out.pointer_pos.data as Float32Array;
  }

  /** Canvas for turning an ImageBitmap into model-size pixels (workers only). */
  pixelsOf(bitmap: ImageBitmap): Pixels {
    const size = this.constants.imageSize;
    this._canvas ??= new OffscreenCanvas(size, size);
    const ctx = this._canvas.getContext('2d', {willReadFrequently: true});
    if (ctx == null) {
      throw new Error('no 2d canvas');
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, size, size);
    return {data: ctx.getImageData(0, 0, size, size).data, size};
  }

  async release(): Promise<void> {
    await this._queue.catch(() => {});
    for (const [frame, e] of this._cache) {
      this._drop(frame, e);
    }
    await Promise.all(Object.values(this._s).map(s => s.release()));
  }
}
