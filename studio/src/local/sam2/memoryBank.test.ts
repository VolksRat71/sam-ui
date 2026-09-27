// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {assembleMemory, planMemory} from './memoryBank';

const upTo = (frames: number[]) => (f: number) => frames.includes(f);

describe('planMemory', () => {
  it('uses the seed with row 6 and pads with it on the frame after the seed', () => {
    const plan = planMemory({frame: 1, reverse: false, numFrames: 24, cond: [0], hasMemory: () => false, hasPointer: () => false});
    expect(plan.blocks).toHaveLength(7);
    expect(plan.blocks.every(b => b.frame === 0 && b.cond && b.tposRow === 6)).toBe(true);
    expect(plan.realBlocks).toBe(1);
    expect(plan.pointers).toHaveLength(16);
    expect(plan.pointers.every(p => p.frame === 0 && p.diff === 1)).toBe(true);
    expect(plan.normalizedDiffs[0]).toBeCloseTo(1 / 15);
    expect(plan.pointerFallback).toBe(false);
  });

  it('takes the 6 previous frames with row t_rel - 1, and pads with the newest', () => {
    const past = [5, 6, 7, 8, 9];
    const plan = planMemory({frame: 10, reverse: false, numFrames: 24, cond: [0], hasMemory: upTo(past), hasPointer: upTo(past)});
    expect(plan.blocks.map(b => [b.frame, b.tposRow])).toEqual([
      [0, 6],
      [9, 0],
      [8, 1],
      [7, 2],
      [6, 3],
      [5, 4],
      [9, 0], // padding: the newest memory again
    ]);
    // pointers: the seed (diff 10) and frames 9..5 (diff 1..5), then padding with diff 1
    expect(plan.realPointers).toBe(6);
    expect(plan.pointers.slice(0, 6).map(p => p.diff)).toEqual([1, 2, 3, 4, 5, 10]);
    expect(plan.pointers.slice(6).every(p => p.frame === 9 && p.diff === 1)).toBe(true);
  });

  it('keeps every seed and drops the oldest recent memory when 7 blocks are not enough', () => {
    const held = [11, 12, 13, 14, 15, 16];
    const plan = planMemory({frame: 17, reverse: false, numFrames: 20, cond: [0, 10], hasMemory: upTo(held), hasPointer: () => true});
    expect(plan.realBlocks).toBe(8);
    expect(plan.blocks.map(b => b.frame)).toEqual([10, 0, 16, 15, 14, 13, 12]);
  });

  it('only takes pointers from the past, and walks backwards in reverse', () => {
    const held = [6, 7];
    const plan = planMemory({frame: 5, reverse: true, numFrames: 24, cond: [0, 8], hasMemory: upTo(held), hasPointer: upTo(held)});
    expect(plan.blocks.slice(0, 4).map(b => [b.frame, b.tposRow])).toEqual([
      [8, 6],
      [0, 6],
      [6, 0],
      [7, 1],
    ]);
    // seed 0 is in the future when tracking in reverse, so its pointer is left out
    expect(plan.pointers.filter(p => p.frame === 0)).toHaveLength(0);
    expect(plan.pointers.slice(0, 3).map(p => [p.frame, p.diff])).toEqual([
      [6, 1],
      [7, 2],
      [8, 3],
    ]);
  });

  it('caps pointers at 16, nearest first, and stops the window at the video start', () => {
    const plan = planMemory({frame: 30, reverse: false, numFrames: 40, cond: [0, 3, 5], hasMemory: () => true, hasPointer: f => ![0, 3, 5].includes(f)});
    expect(plan.realPointers).toBe(3 + 15);
    expect(plan.pointers.map(p => p.diff)).toEqual([...Array(15).keys()].map(i => i + 1).concat([25]));
    const edge = planMemory({frame: 3, reverse: false, numFrames: 40, cond: [0], hasMemory: () => true, hasPointer: f => f !== 0});
    expect(edge.realPointers).toBe(3); // frames 2, 1 and the seed
  });

  it('normalises by min(N, 16) - 1', () => {
    const plan = planMemory({frame: 4, reverse: false, numFrames: 5, cond: [0], hasMemory: () => false, hasPointer: () => false});
    expect(plan.pointers[0].diff).toBe(4);
    expect(plan.normalizedDiffs[0]).toBeCloseTo(1);
  });

  it('falls back to a future seed pointer when none is in the past', () => {
    const plan = planMemory({frame: 2, reverse: false, numFrames: 24, cond: [5], hasMemory: () => false, hasPointer: () => false});
    expect(plan.pointerFallback).toBe(true);
    expect(plan.realPointers).toBe(0);
    expect(plan.pointers[0]).toEqual({frame: 5, cond: true, diff: 3});
    expect(plan.blocks[0]).toEqual({frame: 5, cond: true, tposRow: 6}); // the future seed's memory is used, as in SAM 2
  });
});

describe('assembleMemory', () => {
  it('lays out blocks with temporal PE, then 4 tokens per pointer', () => {
    const tokens = 2; // tokens per block
    const dim = 64;
    const plan = planMemory({frame: 2, reverse: false, numFrames: 8, cond: [0], hasMemory: upTo([1]), hasPointer: upTo([1])});
    const tpos = Array.from({length: 7}, (_, r) => Array.from({length: dim}, () => r * 100));
    const mem = (frame: number) => ({
      tokens: new Float32Array(tokens * dim).fill(frame + 1),
      pos: new Float32Array(tokens * dim).fill(0.5),
    });
    const ptr = (frame: number) => Float32Array.from({length: 256}, (_, i) => frame * 1000 + i);
    const pointerPos = Float32Array.from({length: 16 * dim}, (_, i) => Math.floor(i / dim));
    const {memory, memoryPos} = assembleMemory(plan, b => mem(b.frame), p => ptr(p.frame), pointerPos, tpos, tokens, dim);
    expect(memory.length).toBe((7 * tokens + 64) * dim);
    // block 0 is the seed (frame 0, row 6); block 1 is frame 1 (row 0)
    expect(memory[0]).toBe(1);
    expect(memoryPos[0]).toBeCloseTo(600.5);
    expect(memory[tokens * dim]).toBe(2);
    expect(memoryPos[tokens * dim]).toBeCloseTo(0.5);
    // pointer 0 is frame 1 (diff 1): token j is ptr[64j .. 64j+63], all with pointerPos[0]
    const off = 7 * tokens * dim;
    expect(memory[off]).toBe(1000);
    expect(memory[off + dim]).toBe(1000 + 64);
    expect(memory[off + 3 * dim + 63]).toBe(1000 + 255);
    expect(memoryPos[off + 3 * dim]).toBe(0);
    expect(memoryPos[off + 4 * dim]).toBe(1); // pointer 1's PE
  });
});
