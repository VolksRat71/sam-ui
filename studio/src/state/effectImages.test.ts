// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it, vi} from 'vitest';
import {MemoryKv} from '~/local/kv';
import {clipsMissingImages, imageKeys} from './effectClips';
import {MAX_IMAGE_BYTES, coverSize, loadEffectImage, sha256Hex, storeEffectImage} from './effectImages';

describe('effect pictures', () => {
  it('are kept at the size Cover needs on the video: never scaled up, a panorama capped at twice the video', () => {
    expect(coverSize(3840, 2160, 1280, 720)).toEqual([1280, 720]);
    expect(coverSize(6000, 4000, 1280, 720)).toEqual([1280, 853]); // 3:2 covers 16:9 at its width
    expect(coverSize(2000, 4000, 1280, 720)).toEqual([1280, 2560]); // portrait: its width fills, height to crop
    expect(coverSize(640, 480, 1280, 720)).toEqual([640, 480]);
    expect(coverSize(40000, 2000, 1280, 720)).toEqual([2560, 128]); // long side at most 2 x 1280
  });

  it('are keyed by the sha-256 of their bytes', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it("load as 'missing' when this browser has no copy or the key isn't one, 'unreadable' when the copy doesn't decode (the clip draws its colour)", async () => {
    const kv = new MemoryKv();
    expect(await loadEffectImage('ab'.repeat(32), kv)).toBe('missing');
    await kv.write('effect-images/x', new Uint8Array([1]));
    expect(await loadEffectImage('../effect-images/x', kv)).toBe('missing');
    await kv.write(`effect-images/${'cd'.repeat(32)}`, new Uint8Array([1, 2, 3]));
    vi.stubGlobal('createImageBitmap', () => Promise.reject(new Error('InvalidStateError')));
    try {
      expect(await loadEffectImage('cd'.repeat(32), kv)).toBe('unreadable');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuse a file that is not PNG, JPEG or WebP before reading it', async () => {
    const kv = new MemoryKv();
    await expect(storeEffectImage(new Blob(['<svg/>'], {type: 'image/svg+xml'}), 1280, 720, kv)).rejects.toThrow(/PNG, JPEG or WebP/);
    expect(kv.files.size).toBe(0);
    const huge = {type: 'image/jpeg', size: MAX_IMAGE_BYTES + 1} as Blob;
    await expect(storeEffectImage(huge, 1280, 720, kv)).rejects.toThrow(/over 50 MB/);
    expect(kv.files.size).toBe(0);
  });

  it("are found in a doc's clips, once each", () => {
    const [a, b] = ['ab'.repeat(32), 'cd'.repeat(32)];
    const clip = (id: string, params: Record<string, string>) => ({id, target: {kind: 'background' as const}, effect: 'ReplaceBackground', params, start: 0, end: 1, row: 0, phase: 0});
    expect(imageKeys({version: 2, clips: [clip('c1', {image: b}), clip('c2', {image: a}), clip('c3', {image: b}), clip('c4', {image: ''}), clip('c5', {style: 'Image'})]})).toEqual([a, b]);
  });

  it('count the clips that draw a missing picture (only with the Image fill), for the export warning', () => {
    const [a, b] = ['ab'.repeat(32), 'cd'.repeat(32)];
    const clip = (id: string, params: Record<string, string>) => ({id, target: {kind: 'background' as const}, effect: 'ReplaceBackground', params, start: 0, end: 1, row: 0, phase: 0});
    const doc = {version: 2 as const, clips: [clip('c1', {style: 'Image', image: a}), clip('c2', {style: 'Image', image: a}), clip('c3', {style: 'Colour', image: a}), clip('c4', {style: 'Image', image: b})]};
    expect(clipsMissingImages(doc, new Set([a]))).toBe(2);
    expect(clipsMissingImages(doc, new Set())).toBe(0);
  });
});
