// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {defaultRows, exportProblems, selectedRows, toExportObjects, type ExportRow} from './exportForm';
import {fromServer} from './objects';

const obj = (objectId: number, state: string) =>
  fromServer({objectId, state, frames: null, nFrames: 0, seeds: [{frameIndex: 0, points: [[0.5, 0.5]], labels: [1]}]});

const options = {outDir: '~/Movies/test', includeStale: false, frames: false, force: false};

describe('export form', () => {
  it('prefills tracked and stale objects with their colour', () => {
    const rows = defaultRows([obj(0, 'tracked'), obj(1, 'untracked'), obj(2, 'stale')]);
    expect(rows).toEqual([
      {objectId: 0, include: true, id: 'object_1', prompt: 'object 1', color: '#3880f3'},
      {objectId: 2, include: true, id: 'object_3', prompt: 'object 3', color: '#00d2be'},
    ]);
  });

  it('sends stale objects only when include stale is on', () => {
    const rows: ExportRow[] = [
      {objectId: 0, include: true, id: 'a', prompt: '', color: '#000000'},
      {objectId: 2, include: true, id: 'b', prompt: '', color: '#000000'},
    ];
    const state = (id: number) => (id === 0 ? 'tracked' : 'stale');
    expect(selectedRows(rows, state, false).map(r => r.objectId)).toEqual([0]);
    expect(selectedRows(rows, state, true).map(r => r.objectId)).toEqual([0, 2]);
  });

  it('refuses bad ids, bad colours, duplicates and an empty folder', () => {
    const rows: ExportRow[] = [
      {objectId: 0, include: true, id: 'cup', prompt: '', color: '#123456'},
      {objectId: 1, include: true, id: 'cup', prompt: '', color: 'red'},
      {objectId: 2, include: true, id: '-bad id', prompt: '', color: '#123456'},
    ];
    const problems = exportProblems(rows, {...options, outDir: ' '});
    expect(problems).toHaveLength(4);
    expect(problems.join('\n')).toMatch(/folder/);
    expect(problems.join('\n')).toMatch(/share the product id "cup"/);
    expect(exportProblems([rows[0]], options)).toEqual([]);
  });

  it('builds the objects map, defaulting an empty prompt from the id', () => {
    expect(toExportObjects([{objectId: 4, include: true, id: 'red_cup', prompt: ' ', color: '#ff0000'}])).toEqual({
      '4': {id: 'red_cup', prompt: 'red cup', color: '#ff0000'},
    });
  });
});

describe('defaultRows from names', () => {
  it('uses each name as the product id and prompt, unique in order', () => {
    const o = (id: number, name: string | null) => ({...fromServer({objectId: id, state: 'tracked', nFrames: 1, seeds: []}), name});
    expect(defaultRows([o(0, 'Red cup'), o(1, 'red cup'), o(2, null)]).map(r => [r.id, r.prompt])).toEqual([
      ['red_cup', 'Red cup'],
      ['red_cup_2', 'red cup'],
      ['object_3', 'object 3'],
    ]);
  });
});
