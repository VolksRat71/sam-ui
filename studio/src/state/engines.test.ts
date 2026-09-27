// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import type {EngineInfo} from '~/worker/protocol';
import {BROWSER_ENGINE, engineLabel, pickerEngines, pickerLayout, RELEASES_URL} from './engines';

const sam2: EngineInfo = {name: 'sam2', model: 'sam2.1_hiera_large', default: true, available: true, reason: null, loaded: true};
const sam3: EngineInfo = {name: 'sam3', model: 'sam3', default: false, available: false, reason: 'no weights', loaded: false};

describe('engineLabel', () => {
  it('names the engines', () => {
    expect(engineLabel('sam2')).toBe('SAM 2');
    expect(engineLabel('sam3')).toBe('SAM 3');
    expect(engineLabel(BROWSER_ENGINE)).toBe('Browser · SAM 2.1 tiny');
    expect(engineLabel('other')).toBe('other');
  });
});

describe('pickerEngines', () => {
  it('lists the backend engines, then the browser engine', () => {
    const list = pickerEngines([sam2, sam3], {webgpu: true});
    expect(list.map(e => [e.name, e.available])).toEqual([
      ['sam2', true],
      ['sam3', false],
      [BROWSER_ENGINE, true],
    ]);
    expect(list[2].local).toBe(true);
    expect(list[2].default).toBe(false);
  });

  it('disables the browser engine without WebGPU, and says why', () => {
    const e = pickerEngines([sam2], {webgpu: false}).find(x => x.name === BROWSER_ENGINE)!;
    expect(e.available).toBe(false);
    expect(e.reason).toMatch(/WebGPU/);
  });

  it('on Pages, shows SAM 3 disabled with a link to the desktop release, and defaults to the browser', () => {
    const list = pickerEngines([], {webgpu: true, pages: true});
    expect(list.map(e => e.name)).toEqual(['sam3', BROWSER_ENGINE]);
    expect(list[0]).toMatchObject({available: false, href: RELEASES_URL});
    expect(list[1].default).toBe(true);
  });
});

describe('pickerLayout', () => {
  it('is a menu with a choice, and a label beside the disabled ones without', () => {
    expect(pickerLayout(pickerEngines([sam2, sam3], {webgpu: true})).single).toBe(false);
    const pages = pickerLayout(pickerEngines([], {webgpu: true, pages: true}));
    expect(pages.single).toBe(true);
    expect(pages.available.map(e => e.name)).toEqual([BROWSER_ENGINE]);
    expect(pages.disabled.map(e => [e.name, e.href])).toEqual([['sam3', RELEASES_URL]]);
  });
});
