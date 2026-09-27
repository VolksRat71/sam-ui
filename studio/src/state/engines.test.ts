// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import type {EngineInfo} from '~/worker/protocol';
import {BROWSER_ENGINE, engineLabel, pickerEngines, pickerLayout, RELEASES_URL, unavailableReason} from './engines';

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
  it('with a backend: its engines, then the browser engine with its hint', () => {
    const list = pickerEngines([sam2, sam3], {webgpu: true, backend: true});
    expect(list.map(e => [e.name, e.available])).toEqual([
      ['sam2', true],
      ['sam3', false],
      [BROWSER_ENGINE, true],
    ]);
    expect(list[2]).toMatchObject({local: true, default: false, hint: 'Lower quality, for quick previews'});
  });

  it('says what a disabled backend engine is missing, and how to set up SAM 3', () => {
    const [, s3] = pickerEngines([sam2, {...sam3, reason: 'no SAM 3 weights at /x/sam3-hf'}], {webgpu: true, backend: true});
    expect(s3.reason).toBe('Model not available: no SAM 3 weights at /x/sam3-hf. Set it up from Help → Set up SAM 3… in the desktop app.');
    const [s2] = pickerEngines([{...sam2, available: false, reason: 'no checkpoint'}], {webgpu: true, backend: true});
    expect(s2.reason).toBe('Model not available: no checkpoint.');
    expect(unavailableReason({name: 'sam3', reason: 'transformers is too old'})).toBe('Model not available: transformers is too old.');
  });

  it('disables the browser engine without WebGPU, and says why', () => {
    const e = pickerEngines([sam2], {webgpu: false, backend: true}).find(x => x.name === BROWSER_ENGINE)!;
    expect(e.available).toBe(false);
    expect(e.reason).toMatch(/WebGPU/);
  });

  it('with no backend: SAM 2.1 large and SAM 3 listed, disabled, linking to the desktop app; the browser is the one', () => {
    const list = pickerEngines([], {webgpu: true, backend: false});
    expect(list.map(e => [e.name, e.available])).toEqual([
      ['sam2', false],
      ['sam3', false],
      [BROWSER_ENGINE, true],
    ]);
    expect(list[0]).toMatchObject({model: 'sam2.1_hiera_large', reason: 'Requires the desktop app.', href: RELEASES_URL});
    expect(list[1]).toMatchObject({reason: 'Requires the desktop app.', href: RELEASES_URL});
    expect(list[2]).toMatchObject({default: true, hint: undefined});
  });
});

describe('pickerLayout', () => {
  it('is a menu with a choice, and a label beside the disabled ones without', () => {
    expect(pickerLayout(pickerEngines([sam2, sam3], {webgpu: true, backend: true})).single).toBe(false);
    const alone = pickerLayout(pickerEngines([], {webgpu: true, backend: false}));
    expect(alone.single).toBe(true);
    expect(alone.available.map(e => e.name)).toEqual([BROWSER_ENGINE]);
    expect(alone.disabled.map(e => [e.name, e.href])).toEqual([
      ['sam2', RELEASES_URL],
      ['sam3', RELEASES_URL],
    ]);
  });
});
