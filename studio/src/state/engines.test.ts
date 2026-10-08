// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import type {EngineInfo} from '~/worker/protocol';
import {BROWSER_ENGINE, discoverTextNote, engineLabel, pickerEngines, RELEASES_URL, textPromptNote, textPrompts, unavailableReason} from './engines';

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
    expect(e.reason).toBe('Needs WebGPU (Chrome or Edge on desktop)');
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

describe('textPrompts', () => {
  const s2 = {...sam2, text: false, textReason: 'this engine takes clicks only; text prompts need SAM 3'};
  const s3 = {...sam3, available: true, reason: null, text: true, textReason: null};
  const browser = pickerEngines([], {webgpu: true, backend: true}).find(e => e.name === BROWSER_ENGINE)!;

  it('are on for an engine that reads text', () => {
    expect(textPrompts([s2, s3], 'sam3')).toEqual({ok: true, why: null});
  });

  it('point at SAM 3 from an engine that takes clicks only', () => {
    expect(textPrompts([s2, s3], 'sam2')).toEqual({ok: false, why: 'SAM 2 takes clicks only. Switch the engine to SAM 3 to find an object by text.'});
    expect(textPrompts([s2, s3, browser], BROWSER_ENGINE).why).toBe(
      'Browser · SAM 2.1 tiny takes clicks only. Switch the engine to SAM 3 to find an object by text.',
    );
  });

  it('say why when no engine here reads text', () => {
    const off = {...s3, available: false, text: false, textReason: 'no SAM 3 weights at /x'};
    expect(textPrompts([s2, off], 'sam2')).toEqual({ok: false, why: 'Text prompts need SAM 3, which cannot run here: no SAM 3 weights at /x.'});
    // an older backend reports no text at all; the browser-only build has only the desktop entries
    expect(textPrompts([sam2, sam3], 'sam2').why).toBe('Text prompts need SAM 3 in the desktop app.');
    expect(textPrompts(pickerEngines([], {webgpu: true, backend: false}), BROWSER_ENGINE).why).toBe(
      'Text prompts need SAM 3 in the desktop app.',
    );
  });
});

describe('textPromptNote', () => {
  const r = {objectId: 1, frameIndex: 11, text: 'dog', engine: 'sam3', matched: true, score: 0.914, instances: 1};
  it('says what a prompt found, and that clicks refine it', () => {
    expect(textPromptNote(r)).toBe('Found "dog" on frame 12 (score 0.91). Click to correct it.');
    expect(textPromptNote({...r, instances: 3})).toBe(
      'Found 3 matches for "dog" on frame 12 and took the best (score 0.91). Click to correct it, or to pick another.',
    );
  });
  it('says when nothing matched', () => {
    expect(textPromptNote({...r, matched: false, instances: 0, score: 0.02})).toBe('No "dog" found on frame 12. Try other words, or click the object.');
  });
});

describe('discoverTextNote', () => {
  const hit = (start: number, end: number) => ({start, end, score: 0.95, hits: 5, best: {frame: start, score: 0.97, box: null}});
  const r = {text: 'dog', intervals: [hit(40, 99), hit(180, 268)], calls: 38, seconds: 29.9, canceled: false};
  it('lists the appearances from frame 1, and how to walk them', () => {
    expect(discoverTextNote(r)).toBe(
      'Found "dog" 2 times: frames 41–100, 181–269 (38 frames checked in 30 s). Marked as candidates: ] and [ walk them, P or A confirms, R rejects.',
    );
    expect(discoverTextNote({...r, intervals: [hit(0, 9)]})).toMatch(/^Found "dog" once: frames 1–10 .*a candidate:/);
  });
  it('says when nothing was found, or the scan was stopped', () => {
    expect(discoverTextNote({...r, intervals: [], calls: 26})).toBe(
      'No "dog" found anywhere in the clip (26 frames checked in 30 s). Try other words, or click the object.',
    );
    expect(discoverTextNote({...r, canceled: true})).toBe('Stopped looking for "dog". Nothing was marked.');
  });
});
