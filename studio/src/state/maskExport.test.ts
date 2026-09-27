// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {matteName, readme, rotoDecisions, type Provenance} from './maskExport';

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
