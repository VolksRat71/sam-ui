// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// SAM 2 video propagation over the five exported graphs, ported from
// SAM2VideoPredictor (sam2/sam2_video_predictor.py) and SAM2Base
// (sam2/modeling/sam2_base.py), in the order our Python engine drives it
// (demo/backend/server/tracks/engine.py):
//
//   1. every seed frame but a cleared one (isClearedSeed: no positive and no
//      approved mask, tracked through with its output blanked, as the
//      backend's Sam2Engine does), frame-major across objects, is an initial
//      conditioning frame: the decoder runs on the frame's features without
//      memory (feats2_no_mem) with the frame's clicks, and the memory encoder
//      encodes its mask binarised (binarize_mask_from_pts_for_mem_enc);
//   2. the forward pass runs from the earliest seed to the last frame, the
//      reverse pass from the frame before it back to 0, reusing the forward
//      pass's memories; seed frames output their seed mask;
//   3. every other frame: memory bank (memoryBank.ts), memory attention, the
//      decoder with one padding point (label -1), and the memory encoder on
//      its mask (not binarised). Object-score gating is in-graph.
//   4. output: the low-res logits, optionally hole-filled, bilinear to the
//      video size, > 0, as COCO RLE.
//
// Objects are tracked independently, each with its own memory, as SAM 2
// does (non_overlap_masks is off).
//
// Approved-mask seeds (sam-ui stores the mask the user approved on each seed
// frame): SAM 2 conditions on the mask itself (add_new_mask with
// use_mask_input_as_output_without_sam): the mask is the frame's output and
// its memory, and the object pointer comes from the decoder run with the mask
// as its dense prompt. The exported decoder has no mask input, so here the
// pointer comes from the decoder run on that frame's clicks instead. The
// output and the memory are exact.
import type {RLEObject} from '@/jscocotools/mask';
import type {NormPoint} from '~/state/objects';
import type {Sam2Constants} from './config';
import {fillHoles, logitsToRle, maskInput, maskToRle, rleArea, upsampleLogits} from './masks';
import {assembleMemory, type HeldMemory, planMemory} from './memoryBank';

export interface Releasable {
  release(): void;
}

export type DecoderOutput = {
  /** Low-res mask logits, row-major lowSize x lowSize. */
  lowRes: Float32Array;
  lowSize: number;
  /** The decoder's high-res mask, kept for the memory encoder. */
  highRes: Releasable;
  objectScore: number;
  pointer: Float32Array;
  iou: number;
};

/** The five graphs, with the frame features cached behind them. */
export interface Sam2Models {
  readonly constants: Sam2Constants;
  /** One frame's encoder outputs; release when done (cached, reference counted). */
  features(frame: number): Promise<Releasable>;
  /** `cond` null: the no-memory features (a seed frame). Points in model-input pixels. */
  decode(features: Releasable, cond: Releasable | null, points: Float32Array, labels: Int32Array): Promise<DecoderOutput>;
  /** `mask`: a decoder's high-res mask, or high-res logits (imageSize^2). */
  encodeMemory(features: Releasable, mask: Releasable | Float32Array, objectScore: number, binarize: boolean): Promise<HeldMemory>;
  attend(features: Releasable, memory: Float32Array, memoryPos: Float32Array): Promise<Releasable>;
  pointerPos(normalizedDiffs: Float32Array): Promise<Float32Array>;
}

export type TrackSeed = {frame: number; points: readonly NormPoint[]; mask?: RLEObject | null};
export type TrackObject = {id: number; seeds: readonly TrackSeed[]};

export type TrackedFrame = {frame: number; masks: Map<number, RLEObject>; ms: number};

export type TrackerOptions = {
  numFrames: number;
  width: number;
  height: number;
  /** SAM 2's fill_hole_area (8 upstream); 0 turns it off. */
  fillHoleArea?: number;
};

export type TrackStats = {
  /** Frames where SAM 2 would have used more memories than the export's 7 blocks. */
  cappedBlocks: number;
  cappedPointers: number;
  pointerFallbacks: number;
  /** Most non-conditioning memories (tokens + pos) one object held at once. */
  peakMemories: number;
};

type Held = {memory: HeldMemory | null; pointer: Float32Array};
type ObjectState = {
  id: number;
  cond: Map<number, Held & {rle: RLEObject}>;
  nonCond: Map<number, Held>;
};

/**
 * A seed SAM 2 must never condition on, as the backend's seeds.cleared()
 * decides: no positive click and no approved mask, or an empty one (a frame
 * emptied on SAM 3). A legacy seed trimmed by the removed hidden anchor (no
 * positive, a mask) still conditions.
 */
export function isClearedSeed(seed: TrackSeed): boolean {
  return !seed.points.some(p => p[2] === 1) && (seed.mask == null || rleArea(seed.mask) === 0);
}

/**
 * An object's seeds as the tracker uses them: the conditioning ones, and the
 * cleared frames, tracked through like any other frame with their output
 * blanked (the backend's strip_cleared).
 */
export function splitSeeds(seeds: readonly TrackSeed[]): {cond: TrackSeed[]; blank: Set<number>} {
  const cond: TrackSeed[] = [];
  const blank = new Set<number>();
  for (const seed of seeds) {
    if (isClearedSeed(seed)) {
      blank.add(seed.frame);
    } else {
      cond.push(seed);
    }
  }
  return {cond, blank};
}

/** Seed points (0-1) as the decoder's input, in pixels of the model input. */
export function promptOf(points: readonly NormPoint[], size: number): {points: Float32Array; labels: Int32Array} {
  if (points.length === 0) {
    // SAM 2's padding point for a frame without clicks
    return {points: new Float32Array([0, 0]), labels: new Int32Array([-1])};
  }
  return {
    points: Float32Array.from(points.flatMap(p => [p[0] * size, p[1] * size])),
    labels: Int32Array.from(points, p => (p[2] === 0 ? 0 : 1)),
  };
}

export class Sam2Tracker {
  readonly stats: TrackStats = {cappedBlocks: 0, cappedPointers: 0, pointerFallbacks: 0, peakMemories: 0};
  private readonly _pointerPos = new Map<number, Float32Array>();

  constructor(
    private readonly _models: Sam2Models,
    private readonly _opts: TrackerOptions,
  ) {}

  private get _c(): Sam2Constants {
    return this._models.constants;
  }

  private _rle(out: DecoderOutput): RLEObject {
    const {width, height, fillHoleArea = 0} = this._opts;
    const logits = fillHoles(out.lowRes, out.lowSize, out.lowSize, fillHoleArea);
    return logitsToRle(logits, out.lowSize, out.lowSize, width, height);
  }

  /** A click: the frame's mask from its clicks alone, as SAM 2 gives a seed frame. */
  async click(frame: number, points: readonly NormPoint[]): Promise<{rle: RLEObject; objectScore: number; iou: number}> {
    const features = await this._models.features(frame);
    try {
      const p = promptOf(points, this._c.imageSize);
      const out = await this._models.decode(features, null, p.points, p.labels);
      out.highRes.release();
      return {rle: this._rle(out), objectScore: out.objectScore, iou: out.iou};
    } finally {
      features.release();
    }
  }

  /** Pointer PEs per normalised diff; pointer_tpos is elementwise, so they cache. */
  private async _pointerPosFor(diffs: Float32Array): Promise<Float32Array> {
    const n = this._c.maxPointers;
    const dim = this._c.memDim;
    const missing = [...new Set(diffs)].filter(d => !this._pointerPos.has(d));
    for (let i = 0; i < missing.length; i += n) {
      const batch = missing.slice(i, i + n);
      const input = Float32Array.from({length: n}, (_, k) => batch[Math.min(k, batch.length - 1)]);
      const out = await this._models.pointerPos(input);
      batch.forEach((d, k) => this._pointerPos.set(d, out.slice(k * dim, (k + 1) * dim)));
    }
    const pos = new Float32Array(diffs.length * dim);
    diffs.forEach((d, i) => pos.set(this._pointerPos.get(d)!, i * dim));
    return pos;
  }

  private async _seed(state: ObjectState, seed: TrackSeed, features: Releasable): Promise<void> {
    const p = promptOf(seed.points, this._c.imageSize);
    const out = await this._models.decode(features, null, p.points, p.labels);
    try {
      if (seed.mask != null) {
        // the approved mask is the output and the memory; the pointer is the clicks'
        const input = maskInput(seed.mask, this._c.imageSize);
        const memory = await this._models.encodeMemory(features, input.logits, input.appearing ? 10 : -10, true);
        state.cond.set(seed.frame, {memory, pointer: out.pointer, rle: seed.mask});
      } else {
        // SAM 2 encodes a seed from its stored (hole-filled) low-res mask; with
        // no fill that is the decoder's own high-res mask
        const fill = this._opts.fillHoleArea ?? 0;
        const mask =
          fill > 0 ? upsampleLogits(fillHoles(out.lowRes, out.lowSize, out.lowSize, fill), out.lowSize, this._c.imageSize) : out.highRes;
        const memory = await this._models.encodeMemory(features, mask, out.objectScore, true);
        state.cond.set(seed.frame, {memory, pointer: out.pointer, rle: this._rle(out)});
      }
    } finally {
      out.highRes.release();
    }
  }

  private async _step(state: ObjectState, frame: number, reverse: boolean, features: Releasable): Promise<RLEObject> {
    const c = this._c;
    const cond = [...state.cond.keys()];
    const plan = planMemory({
      frame,
      reverse,
      numFrames: this._opts.numFrames,
      cond,
      hasMemory: t => state.nonCond.get(t)?.memory != null,
      hasPointer: t => state.nonCond.has(t),
      numMaskmem: c.numMaskmem,
      maxPointers: c.maxPointers,
    });
    this.stats.cappedBlocks += plan.realBlocks > c.numMaskmem ? 1 : 0;
    this.stats.cappedPointers += plan.realPointers > c.maxPointers ? 1 : 0;
    this.stats.pointerFallbacks += plan.pointerFallback ? 1 : 0;
    const held = (t: number, isCond: boolean): Held => {
      const h = isCond ? state.cond.get(t) : state.nonCond.get(t);
      if (h == null) {
        throw new Error(`object ${state.id}: no memory for frame ${t}`);
      }
      return h;
    };
    const pointerPos = await this._pointerPosFor(plan.normalizedDiffs);
    const {memory, memoryPos} = assembleMemory(
      plan,
      b => held(b.frame, b.cond).memory!,
      p => held(p.frame, p.cond).pointer,
      pointerPos,
      c.tpos,
      c.featSize * c.featSize,
      c.memDim,
    );
    const conditioned = await this._models.attend(features, memory, memoryPos);
    let out: DecoderOutput;
    try {
      const pad = promptOf([], c.imageSize);
      out = await this._models.decode(features, conditioned, pad.points, pad.labels);
    } finally {
      conditioned.release();
    }
    try {
      const mem = await this._models.encodeMemory(features, out.highRes, out.objectScore, false);
      state.nonCond.set(frame, {memory: mem, pointer: out.pointer});
    } finally {
      out.highRes.release();
    }
    return this._rle(out);
  }

  /**
   * Drop what the next frames cannot use: memories more than numMaskmem-2
   * frames behind, pointers more than maxPointers-2 behind, except the
   * frames from `start` on, which the reverse pass will read.
   */
  private _prune(state: ObjectState, frame: number, reverse: boolean, start: number): void {
    const dir = reverse ? -1 : 1;
    const memWindow = this._c.numMaskmem - 1;
    const ptrWindow = this._c.maxPointers - 1;
    for (const [t, h] of state.nonCond) {
      const behind = (frame - t) * dir;
      // the reverse pass starts at start - 1 and reads start, start + 1, ...
      const afterStart = t - start;
      const keepMem = (behind >= 0 && behind < memWindow) || (!reverse && afterStart >= 0 && afterStart < memWindow);
      const keepPtr = (behind >= 0 && behind < ptrWindow) || (!reverse && afterStart >= 0 && afterStart < ptrWindow);
      if (!keepPtr) {
        state.nonCond.delete(t);
      } else if (!keepMem) {
        h.memory = null;
      }
    }
    let held = 0;
    state.nonCond.forEach(h => (held += h.memory != null ? 1 : 0));
    this.stats.peakMemories = Math.max(this.stats.peakMemories, held);
  }

  /**
   * Track `objects` over the whole video, yielding every frame once (forward
   * from the earliest seed, then backwards from the frame before it). Stops
   * between frames once `signal` aborts.
   */
  async *track(objects: readonly TrackObject[], signal?: AbortSignal): AsyncGenerator<TrackedFrame> {
    const {numFrames} = this._opts;
    const states: ObjectState[] = [];
    const seeds: Array<{state: ObjectState; seed: TrackSeed}> = [];
    const blanks = new Map<number, Set<number>>();
    for (const o of objects) {
      const withClicks = o.seeds.filter(s => s.points.length > 0 && s.frame >= 0 && s.frame < numFrames);
      // cleared seeds never condition: an object with nothing else is not tracked
      const {cond, blank} = splitSeeds(withClicks);
      if (cond.length === 0) {
        continue;
      }
      const state: ObjectState = {id: o.id, cond: new Map(), nonCond: new Map()};
      states.push(state);
      blanks.set(o.id, blank);
      cond.forEach(seed => seeds.push({state, seed}));
    }
    if (states.length === 0) {
      return;
    }
    // frame-major, so each seed frame's features serve every object
    seeds.sort((a, b) => a.seed.frame - b.seed.frame || a.state.id - b.state.id);
    for (const {state, seed} of seeds) {
      signal?.throwIfAborted();
      const features = await this._models.features(seed.frame);
      try {
        await this._seed(state, seed, features);
      } finally {
        features.release();
      }
    }
    let empty: RLEObject | null = null;
    const blanked = () => (empty ??= maskToRle(new Uint8Array(this._opts.width * this._opts.height), this._opts.width, this._opts.height));
    const start = Math.min(...seeds.map(s => s.seed.frame));
    const passes: Array<{reverse: boolean; frames: number[]}> = [
      {reverse: false, frames: range(start, numFrames - 1)},
      {reverse: true, frames: start > 0 ? range(start - 1, 0) : []},
    ];
    for (const pass of passes) {
      for (const frame of pass.frames) {
        signal?.throwIfAborted();
        const t0 = performance.now();
        const masks = new Map<number, RLEObject>();
        const features = await this._models.features(frame);
        try {
          for (const state of states) {
            const seed = state.cond.get(frame);
            const rle = seed != null ? seed.rle : await this._step(state, frame, pass.reverse, features);
            masks.set(state.id, blanks.get(state.id)?.has(frame) ? blanked() : rle);
            this._prune(state, frame, pass.reverse, start);
          }
        } finally {
          features.release();
        }
        yield {frame, masks, ms: performance.now() - t0};
      }
    }
  }
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  const step = from <= to ? 1 : -1;
  for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
    out.push(i);
  }
  return out;
}
