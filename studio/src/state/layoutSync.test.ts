// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {EMPTY_LAYOUT} from './layout';
import {CLOSED_GATE, type SaveGate, layoutFromResponse, saveStep} from './layoutSync';

const cast = {id: 'g1', name: 'Cast', color: '#ff4fa3', members: [1], collapsed: false, hidden: false};

describe('layoutFromResponse', () => {
  it('reads a stored layout', () => {
    expect(layoutFromResponse(200, {layout: {order: [1], groups: [cast]}})).toEqual({
      layout: {order: [1], groups: [cast]},
      supported: true,
    });
  });

  it('calls only a missing route unsupported', () => {
    expect(layoutFromResponse(404, null)).toEqual({layout: EMPTY_LAYOUT, supported: false});
    expect(layoutFromResponse(405, null)).toEqual({layout: EMPTY_LAYOUT, supported: false});
  });

  it('throws on a network error or a server error: the stored layout is unknown, not empty', () => {
    expect(() => layoutFromResponse(null, null)).toThrow(/could not reach/);
    expect(() => layoutFromResponse(500, null)).toThrow(/HTTP 500/);
  });
});

describe('saveStep', () => {
  const opened: SaveGate = {savable: true, baseline: null};

  it('takes the first layout after a load as the baseline, then saves each change', () => {
    let gate = opened;
    let step = saveStep(gate, 'a');
    expect(step.save).toBe(false);
    gate = step.gate;
    expect(saveStep(gate, 'a').save).toBe(false);
    step = saveStep(gate, 'b');
    expect(step.save).toBe(true);
    expect(saveStep(step.gate, 'b').save).toBe(false);
  });

  it('never saves after a failed or unsupported load, so the stored groups are not overwritten', () => {
    let gate = CLOSED_GATE;
    for (const json of ['empty', 'one new object', 'a group']) {
      const step = saveStep(gate, json);
      expect(step.save).toBe(false);
      gate = step.gate;
    }
    // a change is reported, so the page can say the order will not be kept
    expect(saveStep({...CLOSED_GATE, baseline: 'x'}, 'y').blocked).toBe(true);
    expect(saveStep({...CLOSED_GATE, baseline: 'x'}, 'x').blocked).toBe(false);
  });
});
