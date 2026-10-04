// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {exportPath, groupExport, matteName, readme, rotoDecisions, unionMatteName, unionPath, withoutAbsent, type Provenance} from './maskExport';

const prov: Provenance = {
  engine: 'browser-sam2',
  engineLabel: 'Browser · SAM 2.1 tiny',
  model: 'sam2.1_hiera_tiny (512 px, fp16)',
  video: 'uploads/clip.mp4',
  frames: 24,
  fps: 24,
  width: 320,
  height: 240,
  exported: '2026-09-27T12:00:00.000Z',
};

describe('readme', () => {
  it('names the engine, model, video, frames and fps', () => {
    const text = readme('videos', prov, [{objectId: 0, label: 'Red cup', name: 'Red cup', state: 'tracked', prompt: '', color: '#ffffff'}]);
    for (const s of ['Browser · SAM 2.1 tiny (browser-sam2)', 'sam2.1_hiera_tiny (512 px, fp16)', 'uploads/clip.mp4', 'Frames:     24', 'FPS:        24', '2026-09-27', 'Red cup: object id 0, named "Red cup", tracked']) {
      expect(text).toContain(s);
    }
  });
});

describe('rotoDecisions', () => {
  it('lays out the working folder as tracks/export.py does', () => {
    const files = rotoDecisions(
      prov,
      [{objectId: 2, label: 'Red car', name: 'car', state: 'tracked', prompt: 'red car', color: '#ff0000'}],
      () => new Map([[4, [[0.5, 0.25, 1], [0.1, 0.1, 0]]]]),
      () => 24,
    );
    expect(Object.keys(files).sort()).toEqual(['anchors.json', 'data/review.json', 'notes/sam-ui-export.json', 'products.json', 'shots.json']);
    expect(JSON.parse(files['products.json'])).toEqual({
      products: [{id: 'car', shots: [1], prompt: 'red car', color: '#ff0000', status: 'confirmed', meta: {sam_ui_object: 2, name: 'Red car'}}],
    });
    expect(JSON.parse(files['anchors.json'])).toEqual({car: {points: {'5': [[160, 60, 1], [32, 24, 0]]}}});
    expect(JSON.parse(files['shots.json'])).toEqual({cuts: [1], unsure: []});
    const notes = JSON.parse(files['notes/sam-ui-export.json']);
    expect(notes).toMatchObject({engine: 'browser-sam2', model: prov.model, n_frames: 24});
    expect(notes.products.car).toMatchObject({object_id: 2, engine: 'browser-sam2', state: 'tracked'});
    expect(matteName('car', 0)).toBe('data/mattes_tracked/car/00001.png');
  });
});

describe('absent ranges in exports', () => {
  const car = {objectId: 2, label: 'Red car', name: 'car', state: 'tracked', prompt: 'red car', color: '#ff0000', ranges: [{start: 3, end: 5, state: 'absent' as const}]};

  it('empties the masks of absent frames, and only of that object', () => {
    const maskAt = withoutAbsent((id: number, frame: number) => `${id}@${frame}`, [car, {objectId: 7}]);
    expect([2, 3, 5, 6].map(f => maskAt(2, f))).toEqual(['2@2', null, null, '2@6']);
    expect(maskAt(7, 4)).toBe('7@4');
  });

  it('leaves the clicks inside a range out of anchors.json', () => {
    const files = rotoDecisions(prov, [car], () => new Map([[1, [[0.5, 0.5, 1]] as const], [4, [[0.25, 0.25, 1]] as const]]), () => 24);
    expect(Object.keys(JSON.parse(files['anchors.json']).car.points)).toEqual(['2']);
  });
});

describe('candidate and present ranges in exports', () => {
  const dog = {
    objectId: 3,
    label: 'Dog',
    name: 'dog',
    state: 'tracked',
    prompt: 'dog',
    color: '#00ff00',
    ranges: [{start: 4, end: 5, state: 'absent' as const}],
    marks: [
      {start: 0, end: 3, state: 'present' as const},
      {start: 6, end: 9, state: 'candidate' as const, source: 'text:dog@sam3', score: 0.25},
    ],
  };

  it('never blanks a mask for a candidate or a present range', () => {
    const maskAt = withoutAbsent((id: number, frame: number) => `${id}@${frame}`, [dog]);
    expect([0, 4, 5, 6, 9].map(f => maskAt(3, f))).toEqual(['3@0', null, null, '3@6', '3@9']);
  });

  it('records every range with its state in the roto JSON, and keeps clicks in candidate frames', () => {
    const files = rotoDecisions(prov, [dog], () => new Map([[1, [[0.5, 0.5, 1]] as const], [7, [[0.5, 0.5, 1]] as const]]), () => 24);
    expect(JSON.parse(files['notes/sam-ui-export.json']).products.dog.ranges).toEqual([
      {start: 0, end: 3, state: 'present'},
      {start: 4, end: 5, state: 'absent'},
      {start: 6, end: 9, state: 'candidate', source: 'text:dog@sam3', score: 0.25},
    ]);
    expect(Object.keys(JSON.parse(files['anchors.json']).dog.points)).toEqual(['2', '8']);
  });

  it('lists them in the README, frames 1-based as the files are', () => {
    const text = readme('folder', prov, [dog]);
    expect(text).toContain('    frames 1-4: present');
    expect(text).toContain('    frames 5-6: absent (empty mattes)');
    expect(text).toContain('    frames 7-10: candidate, text:dog@sam3 · score 0.25 (unconfirmed; masks unchanged)');
  });
});

describe('groups in exports (issue #21)', () => {
  const obj = (objectId: number, name: string) => ({objectId, label: name, name, state: 'tracked', prompt: name, color: '#ffffff'});
  const cast = {id: 'g1', name: 'The Cast', color: '#ff4fa3', members: [3, 1], collapsed: false, hidden: false};
  const props = {id: 'g2', name: 'The Cast', color: '#3fd0ff', members: [2], collapsed: false, hidden: false};
  const layout = {order: [2, 3, 1, 4], groups: [cast, props, {...cast, id: 'g3', name: 'Empty', members: [4]}]};

  it('orders the objects by the layout and gives each its group', () => {
    const {objects, groups} = groupExport('videos', [obj(1, 'Ann'), obj(2, 'Cup'), obj(3, 'Bob')], layout);
    expect(objects.map(o => [o.objectId, o.group?.id ?? null])).toEqual([
      [2, 'g2'],
      [3, 'g1'],
      [1, 'g1'],
    ]);
    // a group with no exported member has no folder; folder names are unique
    expect(groups.map(g => [g.id, g.folder, g.members])).toEqual([
      ['g1', 'The Cast', [3, 1]],
      ['g2', 'The Cast (2)', [2]],
    ]);
  });

  it('names roto group folders as tracks/export.py does', () => {
    const {groups} = groupExport('folder', [obj(1, 'Ann'), obj(2, 'Cup'), obj(3, 'Bob')], layout);
    expect(groups.map(g => g.folder)).toEqual(['the_cast', 'the_cast_2']);
  });

  it('puts grouped files in their group folder, and a union beside them', () => {
    const {objects, groups} = groupExport('videos', [obj(1, 'Ann'), obj(4, 'Solo')], {order: [], groups: [cast]});
    expect(objects.map(o => exportPath(o, groups, '.mp4'))).toEqual(['The Cast/Ann.mp4', 'Solo.mp4']);
    expect(unionPath(groups[0], objects, '.mp4')).toBe('The Cast/The Cast union.mp4');
    // a member already named like the union file keeps its name; the union moves aside
    const clash = groupExport('videos', [obj(1, 'The Cast union')], {order: [], groups: [cast]});
    expect(unionPath(clash.groups[0], clash.objects, '.mp4')).toBe('The Cast/The Cast union (2).mp4');
  });

  it('records each object’s group in the README', () => {
    const {objects, groups} = groupExport('videos', [obj(1, 'Ann'), obj(4, 'Solo')], {order: [], groups: [cast]});
    const text = readme('videos', prov, objects, groups, true);
    expect(text).toContain('Ann: object id 1, named "Ann", tracked, group "The Cast"');
    expect(text).toContain('Solo: object id 4, named "Solo", tracked\n');
    expect(text).toContain('The Cast: folder "The Cast", 1 object, with a union mask');
  });

  it('records groups in the roto folder’s JSON, with a folder per group', () => {
    const {objects, groups} = groupExport('folder', [obj(1, 'ann'), obj(4, 'solo')], {order: [], groups: [cast]});
    const files = rotoDecisions(prov, objects, () => new Map(), () => 24, groups, false);
    const products = JSON.parse(files['products.json']).products;
    expect(products[0].meta).toEqual({sam_ui_object: 1, name: 'ann', group: {id: 'g1', name: 'The Cast'}});
    expect(products[1].meta).toEqual({sam_ui_object: 4, name: 'solo'});
    const notes = JSON.parse(files['notes/sam-ui-export.json']);
    expect(notes.products.ann.group).toEqual({id: 'g1', name: 'The Cast'});
    expect(notes.products.solo.group).toBeNull();
    expect(notes.groups).toEqual([{id: 'g1', name: 'The Cast', color: '#ff4fa3', folder: 'the_cast', members: ['ann'], union: false}]);
    expect(JSON.parse(files['data/groups/the_cast/group.json'])).toEqual({id: 'g1', name: 'The Cast', color: '#ff4fa3', members: ['ann'], union: false});
    expect(unionMatteName(groups[0], 0)).toBe('data/groups/the_cast/union/00001.png');
  });
});
