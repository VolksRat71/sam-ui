// sam-ui (Apache-2.0). New file, not from SAM 2.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {inflateSync} from 'node:zlib';
import {describe, expect, it} from 'vitest';
import {grayPng} from './png';
import {crc32, zip} from './zip';

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('zip', () => {
  it('writes an archive unzip reads back byte for byte', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sam-ui-zip-'));
    const bin = Uint8Array.from({length: 1000}, (_, i) => (i * 7) & 255);
    const file = path.join(dir, 'a.zip');
    fs.writeFileSync(file, zip([
      {name: 'README.txt', data: 'hello\n'},
      {name: 'masks/object_1.bin', data: bin},
    ]));
    execFileSync('unzip', ['-q', file, '-d', dir]);
    expect(fs.readFileSync(path.join(dir, 'README.txt'), 'utf8')).toBe('hello\n');
    expect(new Uint8Array(fs.readFileSync(path.join(dir, 'masks/object_1.bin')))).toEqual(bin);
    fs.rmSync(dir, {recursive: true});
  });

  it('refuses duplicate names', () => {
    expect(() => zip([{name: 'a', data: ''}, {name: 'a', data: ''}])).toThrow(/duplicate/);
  });
});

describe('grayPng', () => {
  it('writes an 8-bit grayscale PNG with the pixels', async () => {
    const px = Uint8Array.from({length: 6}, (_, i) => (i % 2 ? 255 : 0));
    const png = await grayPng(px, 3, 2);
    const v = new DataView(png.buffer, png.byteOffset);
    expect([...png.subarray(1, 4)].map(c => String.fromCharCode(c)).join('')).toBe('PNG');
    expect(v.getUint32(16)).toBe(3);
    expect(v.getUint32(20)).toBe(2);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(0);
    const idatLen = v.getUint32(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    expect([...raw]).toEqual([0, 0, 255, 0, 0, 255, 0, 255]);
  });
});
