// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Which memories and object pointers a tracked frame attends to, ported from
// SAM2Base._prepare_memory_conditioned_features (sam2/modeling/sam2_base.py),
// and their assembly into the fixed-shape inputs of the exported
// memory_attention graph.
//
// SAM 2 (eval, SAM 2.1 configs):
//   - every conditioning (seed) frame's memory, temporal PE row num_maskmem-1;
//   - the non-conditioning memories 1..num_maskmem-1 frames back (in the
//     tracking direction), temporal PE row t_rel-1, when they exist;
//   - object pointers: the seed frames in the past (only_obj_ptrs_in_the_past_for_eval),
//     then non-conditioning frames 1..min(N,16)-1 back, each with its distance
//     normalised by min(N,16)-1 (pointer_tpos turns that into a 64-d PE);
//   - a 256-d pointer is split into 4 tokens of 64, which share its PE.
//
// The export's shapes are fixed: exactly 7 memory blocks and 16 pointers.
// Where SAM 2 has fewer, the most recent one is duplicated (as the export's
// README prescribes); where it has more, the ones closest in time are kept
// (an approximation: SAM 2 keeps every seed frame, so an object with two seed
// frames loses its oldest recent memory once 6 are available).

export type MemoryPlanInput = {
  frame: number;
  reverse: boolean;
  numFrames: number;
  /** Seed frames of the object (they always have a memory and a pointer). */
  cond: readonly number[];
  /** Non-conditioning frames whose memory is still held. */
  hasMemory: (frame: number) => boolean;
  /** Non-conditioning frames whose object pointer is still held. */
  hasPointer: (frame: number) => boolean;
  numMaskmem?: number;
  maxPointers?: number;
};

export type MemoryBlock = {frame: number; cond: boolean; tposRow: number};
export type PointerSlot = {frame: number; cond: boolean; diff: number};

export type MemoryPlan = {
  /** Exactly numMaskmem blocks, padding included. */
  blocks: MemoryBlock[];
  /** Exactly maxPointers pointers, padding included. */
  pointers: PointerSlot[];
  /** pointer_tpos's input: each pointer's diff / (min(N, maxPointers) - 1). */
  normalizedDiffs: Float32Array;
  /** How many blocks / pointers SAM 2 itself would have used, before padding or capping. */
  realBlocks: number;
  realPointers: number;
  /** Set when there was no pointer in the past and a future seed's stood in. */
  pointerFallback: boolean;
};

export function planMemory(input: MemoryPlanInput): MemoryPlan {
  const numMaskmem = input.numMaskmem ?? 7;
  const maxPointers = input.maxPointers ?? 16;
  const {frame, reverse, numFrames} = input;
  const dir = reverse ? -1 : 1;
  if (input.cond.length === 0) {
    throw new Error('an object needs a seed frame before it can be tracked');
  }
  const byDistance = [...input.cond].sort((a, b) => Math.abs(a - frame) - Math.abs(b - frame) || a - b);

  // -- memory blocks: seeds first (closest in time), then recent frames, nearest first
  const blocks: MemoryBlock[] = byDistance.slice(0, numMaskmem).map(t => ({frame: t, cond: true, tposRow: numMaskmem - 1}));
  const recent: MemoryBlock[] = [];
  for (let tRel = 1; tRel < numMaskmem; tRel++) {
    const t = frame - tRel * dir;
    if (input.hasMemory(t)) {
      recent.push({frame: t, cond: false, tposRow: tRel - 1});
    }
  }
  const realBlocks = input.cond.length + recent.length;
  blocks.push(...recent.slice(0, numMaskmem - blocks.length));
  const newest = recent[0] ?? blocks[0];
  while (blocks.length < numMaskmem) {
    blocks.push({...newest});
  }

  // -- object pointers
  const span = Math.min(numFrames, maxPointers);
  let pointers: PointerSlot[] = input.cond
    .filter(t => (reverse ? t >= frame : t <= frame))
    .map(t => ({frame: t, cond: true, diff: (frame - t) * dir}));
  for (let tDiff = 1; tDiff < span; tDiff++) {
    const t = frame - tDiff * dir;
    if (t < 0 || t >= numFrames) {
      break;
    }
    if (input.hasPointer(t)) {
      pointers.push({frame: t, cond: false, diff: tDiff});
    }
  }
  const realPointers = pointers.length;
  let pointerFallback = false;
  if (pointers.length === 0) {
    // SAM 2 would attend to no pointer here (an object tracked before its first seed)
    const t = byDistance[0];
    pointers = [{frame: t, cond: true, diff: Math.abs(frame - t)}];
    pointerFallback = true;
  }
  pointers.sort((a, b) => a.diff - b.diff || (a.cond === b.cond ? 0 : a.cond ? -1 : 1));
  pointers = pointers.slice(0, maxPointers);
  const nearest = pointers[0];
  while (pointers.length < maxPointers) {
    pointers.push({...nearest});
  }
  const norm = span > 1 ? span - 1 : 1;
  const normalizedDiffs = Float32Array.from(pointers, p => p.diff / norm);
  return {blocks, pointers, normalizedDiffs, realBlocks, realPointers, pointerFallback};
}

export type HeldMemory = {tokens: Float32Array; pos: Float32Array};

/**
 * The memory_attention inputs for a plan: `memory` and `memory_pos`, each
 * [numMaskmem * tokensPerBlock + maxPointers * (256 / memDim), 1, memDim].
 * A block's pos is its spatial PE plus its temporal PE row; a pointer's 4
 * tokens are its 4 slices of 64, and share its pointer_tpos PE.
 */
export function assembleMemory(
  plan: MemoryPlan,
  memoryOf: (block: MemoryBlock) => HeldMemory,
  pointerOf: (slot: PointerSlot) => Float32Array,
  pointerPos: Float32Array,
  tposTable: readonly (readonly number[])[],
  tokensPerBlock: number,
  memDim = 64,
): {memory: Float32Array; memoryPos: Float32Array} {
  const ptrDim = 256;
  const split = ptrDim / memDim;
  const blockLen = tokensPerBlock * memDim;
  const total = plan.blocks.length * blockLen + plan.pointers.length * split * memDim;
  const memory = new Float32Array(total);
  const memoryPos = new Float32Array(total);
  plan.blocks.forEach((b, i) => {
    const held = memoryOf(b);
    if (held.tokens.length !== blockLen || held.pos.length !== blockLen) {
      throw new Error(`memory for frame ${b.frame} has ${held.tokens.length} values, expected ${blockLen}`);
    }
    const off = i * blockLen;
    memory.set(held.tokens, off);
    const row = tposTable[b.tposRow];
    for (let t = 0; t < tokensPerBlock; t++) {
      const base = t * memDim;
      for (let k = 0; k < memDim; k++) {
        memoryPos[off + base + k] = held.pos[base + k] + row[k];
      }
    }
  });
  const ptrOff = plan.blocks.length * blockLen;
  plan.pointers.forEach((p, i) => {
    const ptr = pointerOf(p);
    for (let j = 0; j < split; j++) {
      const at = ptrOff + (i * split + j) * memDim;
      memory.set(ptr.subarray(j * memDim, (j + 1) * memDim), at);
      memoryPos.set(pointerPos.subarray(i * memDim, (i + 1) * memDim), at);
    }
  });
  return {memory, memoryPos};
}
