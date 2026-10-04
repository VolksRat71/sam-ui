// sam-ui (Apache-2.0). New file, not from SAM 2.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {inflateSync} from 'node:zlib';
import {describe, expect, it} from 'vitest';
import type {RLEObject} from '@/jscocotools/mask';
import {maskToRle} from '~/local/sam2/masks';
import {groupExport} from '~/state/maskExport';
import {buildExport, sourceWithoutAbsent, type MaskSource} from './maskExports';

describe('sourceWithoutAbsent', () => {
  const car = {objectId: 2, label: 'Red car', name: 'car', state: 'tracked', prompt: 'red car', color: '#ff0000', ranges: [{start: 3, end: 5, state: 'absent' as const}]};
  const rle = (id: number, frame: number) => ({size: [1, 1], counts: `${id}@${frame}`}) as unknown as RLEObject;

  it('calls the original source, not itself, once the source is rebound', () => {
    let src: MaskSource = {maskAt: rle, seedsOf: () => new Map()};
    // buildExport rebinds its parameter the same way
    src = sourceWithoutAbsent(src, [car, {...car, objectId: 7, ranges: []}]);
    expect(src.maskAt(2, 2)).toEqual(rle(2, 2));
    expect(src.maskAt(2, 4)).toBeNull();
    expect(src.maskAt(7, 4)).toEqual(rle(7, 4));
  });
});

describe('buildExport with groups (issue #21)', () => {
  const W = 20;
  const H = 20;
  const p = {engine: 'sam2', engineLabel: 'SAM 2', model: 'm', video: 'v.mp4', frames: 2, fps: 24, width: W, height: H, exported: 'now'};
  // object 1 fills the left half, object 3 the bottom half, object 2 the top-right corner
  const shape = (id: number) => {
    const m = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        m[y * W + x] = id === 1 ? Number(x < 10) : id === 3 ? Number(y >= 10) : Number(x >= 15 && y < 5);
      }
    }
    return maskToRle(m, W, H);
  };
  const src: MaskSource = {maskAt: id => shape(id), seedsOf: () => new Map()};
  const obj = (objectId: number, name: string) => ({objectId, label: name, name, state: 'tracked', prompt: name, color: '#ffffff'});
  const layout = {order: [2, 3, 1], groups: [{id: 'g1', name: 'Cast', color: '#ff4fa3', members: [1, 3], collapsed: false, hidden: false}]};

  function unzipped(bytes: Uint8Array): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sam-ui-groups-'));
    fs.writeFileSync(path.join(dir, 'x.zip'), bytes);
    execFileSync('unzip', ['-q', path.join(dir, 'x.zip'), '-d', path.join(dir, 'out')]);
    return path.join(dir, 'out');
  }
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, {recursive: true, withFileTypes: true})
      .filter(d => d.isFile())
      .map(d => path.relative(dir, path.join(d.parentPath, d.name)))
      .sort();

  it('writes vector JSON in group folders, in layout order, with a union only when asked', async () => {
    const {objects, groups} = groupExport('vectors', [obj(1, 'Ann'), obj(2, 'Cup'), obj(3, 'Bob')], layout);
    const plain = unzipped(await buildExport('vectors', p, objects, src, () => {}, {groups}));
    expect(files(plain)).toEqual(['Cast/Ann.json', 'Cast/Bob.json', 'Cup.json', 'README.txt']);
    expect(JSON.parse(fs.readFileSync(path.join(plain, 'Cast/Ann.json'), 'utf8')).group).toEqual({id: 'g1', name: 'Cast'});
    expect(JSON.parse(fs.readFileSync(path.join(plain, 'Cup.json'), 'utf8')).group).toBeUndefined();
    const readmeText = fs.readFileSync(path.join(plain, 'README.txt'), 'utf8');
    expect(readmeText.indexOf('Cup:')).toBeLessThan(readmeText.indexOf('Bob:'));
    expect(readmeText.indexOf('Bob:')).toBeLessThan(readmeText.indexOf('Ann:'));

    const withUnion = unzipped(await buildExport('vectors', p, objects, src, () => {}, {groups, union: true}));
    expect(files(withUnion)).toContain('Cast/Cast union.json');
    const u = JSON.parse(fs.readFileSync(path.join(withUnion, 'Cast/Cast union.json'), 'utf8'));
    // left half and bottom half: one L-shaped piece covering 300 of 400 px
    expect(u.group).toEqual({id: 'g1', name: 'Cast'});
    expect(u.object).toBeUndefined();
    expect(u.add.length).toBe(1);
    expect(u.add[0][0].length).toBeGreaterThanOrEqual(6);
  });

  it('writes the roto folder with a folder per group and a union matte', async () => {
    const {objects, groups} = groupExport('folder', [obj(1, 'ann'), obj(2, 'cup'), obj(3, 'bob')], layout);
    const dir = unzipped(await buildExport('folder', p, objects, src, () => {}, {groups, union: true}));
    const all = files(dir);
    expect(all).toContain('data/mattes_tracked/ann/00001.png');
    expect(all).toContain('data/groups/cast/group.json');
    expect(all.filter(f => f.startsWith('data/groups/cast/union/'))).toEqual(['data/groups/cast/union/00001.png', 'data/groups/cast/union/00002.png']);
    const products = JSON.parse(fs.readFileSync(path.join(dir, 'products.json'), 'utf8')).products;
    expect(products.map((x: {id: string}) => x.id)).toEqual(['cup', 'bob', 'ann']);
    // the union matte: 255 where either member is
    const png = fs.readFileSync(path.join(dir, 'data/groups/cast/union/00001.png'));
    const gray = pngPixels(png, W, H);
    expect(gray[0 * W + 0]).toBe(255); // left half
    expect(gray[15 * W + 19]).toBe(255); // bottom half
    expect(gray[2 * W + 17]).toBe(0); // object 2's corner is not in the group
  });
});

/** An 8-bit grayscale PNG's pixels (one IDAT, filter 0 rows, as grayPng writes). */
function pngPixels(png: Buffer, w: number, h: number): Uint8Array {
  let at = 8;
  const idat: Buffer[] = [];
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    if (type === 'IDAT') {
      idat.push(png.subarray(at + 8, at + 8 + len));
    }
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    out.set(raw.subarray(y * (w + 1) + 1, (y + 1) * (w + 1)), y * w);
  }
  return out;
}
