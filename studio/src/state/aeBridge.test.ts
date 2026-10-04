// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {zip} from '~/lib/zip';
import {aeExportOffer, bridgeNotice, describeItem, isAeVideo, vectorsFromZip} from './aeBridge';
import {vectorJson} from './contours';

describe('aeExportOffer', () => {
  const base = {desktop: true, backend: true, videoPath: 'linked/abc.mov', tracked: 2};

  it('is ready for a tracked video opened from After Effects, in the desktop app', () => {
    expect(aeExportOffer(base)).toEqual({kind: 'ready'});
  });

  it('says desktop only in a browser, and links the desktop app', () => {
    const o = aeExportOffer({...base, desktop: false});
    expect(o.kind).toBe('unavailable');
    expect(o.kind === 'unavailable' && o.why).toMatch(/Desktop app only/);
    expect(o.kind === 'unavailable' && o.href).toMatch(/releases/);
    expect(aeExportOffer({...base, desktop: false, backend: false})).toMatchObject({why: 'Needs the desktop app.'});
  });

  it('asks for an AE-opened video, then for a track', () => {
    expect(aeExportOffer({...base, videoPath: 'uploads/x.mp4'})).toMatchObject({kind: 'unavailable', why: expect.stringMatching(/Open from After Effects/)});
    expect(aeExportOffer({...base, tracked: 0})).toMatchObject({why: 'Track an object first.'});
  });
});

describe('isAeVideo', () => {
  it('is a linked path, and no path tricks', () => {
    expect(isAeVideo('linked/abc.mov')).toBe(true);
    expect(isAeVideo('linked/')).toBe(false);
    expect(isAeVideo('linked/../uploads/x.mp4')).toBe(false);
    expect(isAeVideo('gallery/linked/x.mp4')).toBe(false);
  });
});

describe('bridgeNotice', () => {
  it('links the install when the bridge is missing or old, and says how to open AE when it is closed', () => {
    expect(bridgeNotice({state: 'not-installed', message: 'x'}).link?.href).toBe('https://github.com/VolksRat71/after-effects-mcp-vision');
    expect(bridgeNotice({state: 'outdated', message: 'x'}).link?.label).toMatch(/Update/);
    const closed = bridgeNotice({state: 'not-running', message: 'x'});
    expect(closed.link).toBeNull();
    expect(closed.text).toMatch(/Open After Effects/);
    expect(bridgeNotice({state: 'mismatch', message: 'The file changed.'})).toEqual({text: 'The file changed.', link: null});
  });
});

describe('describeItem', () => {
  it('rounds the rate as AE shows it', () => {
    expect(describeItem({width: 1920, height: 1080, frameRate: 23.9760246276855, frames: 300})).toBe('1920×1080 · 23.976 fps · 300 frames');
  });
});

describe('vectorsFromZip', () => {
  it('reads the Vector JSON of a vectors export back, in object order, skipping the README', () => {
    const mask = (x: number) => Uint8Array.from({length: 20 * 20}, (_, i) => (i % 20 >= x && i % 20 < x + 10 && i < 200 ? 1 : 0));
    const meta = (id: number, name: string) => ({engine: 'sam2', model: 'large', object: {id, name}, fps: 24, w: 20, h: 20, frames: 2});
    const a = vectorJson(meta(1, 'car'), i => mask(i), {minArea: 1});
    const b = vectorJson(meta(2, 'dog'), () => null, {minArea: 1});
    const bytes = zip([
      {name: 'README.txt', data: 'sam-ui export'},
      {name: 'car.json', data: JSON.stringify(a)},
      {name: 'dog.json', data: JSON.stringify(b)},
    ]);
    expect(vectorsFromZip(bytes)).toEqual([a, b]);
    expect(() => vectorsFromZip(zip([{name: 'x.json', data: '{"version": 2}'}]))).toThrow(/not Vector JSON/);
  });
});
