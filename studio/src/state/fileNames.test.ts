// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {
  cleanObjectName,
  defaultExportName,
  exportFileName,
  objectName,
  productId,
  safeFileName,
  uniqueFileNames,
} from './fileNames';

describe('object names', () => {
  it('fall back to Object N, and are trimmed and capped at 64', () => {
    expect(objectName({id: 0})).toBe('Object 1');
    expect(objectName({id: 4, name: 'Red cup'})).toBe('Red cup');
    expect(objectName({id: 4, name: '  '})).toBe('Object 5');
    expect(cleanObjectName('  cup  ')).toBe('cup');
    expect(cleanObjectName('   ')).toBeNull();
    expect(cleanObjectName('x'.repeat(100))).toHaveLength(64);
  });
});

describe('safeFileName', () => {
  it('replaces unsafe characters, collapses whitespace and keeps Unicode letters', () => {
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j', 'x')).toBe('a-b-c-d-e-f-g-h-i-j');
    expect(safeFileName('tab\there\nnew  line', 'x')).toBe('tab here new line');
    expect(safeFileName('Café ☕ 日本', 'x')).toBe('Café ☕ 日本');
    expect(safeFileName('../secret', 'x')).toBe('-secret');
    expect(safeFileName('bell\u0007', 'x')).toBe('bell-');
  });

  it('falls back when nothing is left, and shortens a long name', () => {
    expect(safeFileName('   ', 'Object 3')).toBe('Object 3');
    expect(safeFileName('...', 'Object 3')).toBe('Object 3');
    expect([...safeFileName('é'.repeat(300), 'x')]).toHaveLength(120);
  });
});

describe('uniqueFileNames', () => {
  it('numbers duplicates in order, ignoring case, and fills empty names', () => {
    expect(uniqueFileNames(['cup', 'Cup', 'cup', '', 'cup (2)'], i => `Object ${i + 1}`)).toEqual([
      'cup',
      'Cup (2)',
      'cup (3)',
      'Object 4',
      'cup (2) (2)',
    ]);
  });
});

describe('export file names', () => {
  it('start from the video stem, and keep their extension', () => {
    expect(defaultExportName('uploads/My clip.mp4', 'masks')).toBe('My clip-masks.zip');
    expect(defaultExportName('gallery/05_default_juggle.mp4', 'roto')).toBe('05_default_juggle-roto.zip');
    expect(defaultExportName('a.mov', 'vectors')).toBe('a-vectors.zip');
    expect(defaultExportName('a.mov', 'video')).toBe('a-export.mp4');
    expect(exportFileName('shot 4: take 2', 'a-masks.zip', '.zip')).toBe('shot 4- take 2.zip');
    expect(exportFileName('done.ZIP', 'a-masks.zip', '.zip')).toBe('done.zip');
    expect(exportFileName('  ', 'a-masks.zip', '.zip')).toBe('a-masks.zip');
  });

  it('make product ids for the roto layout', () => {
    expect(productId('Red cup', 0)).toBe('red_cup');
    expect(productId('Café', 0)).toBe('cafe');
    expect(productId('日本', 2)).toBe('object_3');
  });
});
