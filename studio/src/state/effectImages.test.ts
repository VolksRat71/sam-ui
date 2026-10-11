// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {MemoryKv} from '~/local/kv';
import {imageKeys} from './effectClips';
import {fitWithin, loadEffectImage, sha256Hex, storeEffectImage} from './effectImages';

describe('effect pictures', () => {
  it('scale down to fit the video, never up', () => {
    expect(fitWithin(3840, 2160, 1280, 720)).toEqual([1280, 720]);
    expect(fitWithin(1000, 2000, 1280, 720)).toEqual([360, 720]);
    expect(fitWithin(640, 480, 1280, 720)).toEqual([640, 480]);
    expect(fitWithin(10000, 1, 1280, 720)).toEqual([1280, 1]);
  });

  it('are keyed by the sha-256 of their bytes', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it("load as null when this browser has no copy, or the key isn't one (the clip then draws its colour)", async () => {
    const kv = new MemoryKv();
    expect(await loadEffectImage('ab'.repeat(32), kv)).toBeNull();
    await kv.write('effect-images/x', new Uint8Array([1]));
    expect(await loadEffectImage('../effect-images/x', kv)).toBeNull();
  });

  it('refuse a file that is not PNG, JPEG or WebP before reading it', async () => {
    const kv = new MemoryKv();
    await expect(storeEffectImage(new Blob(['<svg/>'], {type: 'image/svg+xml'}), 1280, 720, kv)).rejects.toThrow(/PNG, JPEG or WebP/);
    expect(kv.files.size).toBe(0);
  });

  it("are found in a doc's clips, once each", () => {
    const [a, b] = ['ab'.repeat(32), 'cd'.repeat(32)];
    const clip = (id: string, params: Record<string, string>) => ({id, target: {kind: 'background' as const}, effect: 'ReplaceBackground', params, start: 0, end: 1, row: 0, phase: 0});
    expect(imageKeys({version: 2, clips: [clip('c1', {image: b}), clip('c2', {image: a}), clip('c3', {image: b}), clip('c4', {image: ''}), clip('c5', {style: 'Image'})]})).toEqual([a, b]);
  });
});
