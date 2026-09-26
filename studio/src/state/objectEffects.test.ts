// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {
  DEFAULT_EFFECT,
  EffectMap,
  effectOf,
  exportEffects,
  parseEffectMap,
  pickEffect,
  pruneEffects,
} from './objectEffects';

describe('per-object effects', () => {
  it("Nate's sequence: focus A, set Original, focus B: A is still Original, also after B changes", () => {
    const A = 0;
    const B = 1;
    let map: EffectMap = {};
    // focus A (focus is only which object the buttons edit), pick Original
    map = pickEffect(map, A, 'Cutout', 4);
    expect(effectOf(map, A)).toEqual({name: 'Cutout', variant: 0});
    // focus B: nothing changes for A, and B shows its own effect (the default)
    expect(effectOf(map, A).name).toBe('Cutout');
    expect(effectOf(map, B)).toEqual(DEFAULT_EFFECT);
    // set B's effect: A keeps Original
    map = pickEffect(map, B, 'PixelateMask', 3);
    expect(effectOf(map, A)).toEqual({name: 'Cutout', variant: 0});
    expect(effectOf(map, B)).toEqual({name: 'PixelateMask', variant: 0});
  });

  it('picking the current effect again cycles its variants, for that object only', () => {
    let map = pickEffect({}, 0, 'Burst', 4);
    map = pickEffect(map, 1, 'Burst', 4);
    map = pickEffect(map, 0, 'Burst', 4);
    map = pickEffect(map, 0, 'Burst', 4);
    expect(effectOf(map, 0).variant).toBe(2);
    expect(effectOf(map, 1).variant).toBe(0);
    map = pickEffect(map, 0, 'Burst', 4);
    map = pickEffect(map, 0, 'Burst', 4);
    expect(effectOf(map, 0).variant).toBe(0); // wraps
  });

  it('new and restored objects start on Overlay; removed objects are dropped', () => {
    const map = pickEffect(pickEffect({}, 0, 'Cutout', 4), 3, 'Scope', 6);
    expect(effectOf(map, 7)).toEqual({name: 'Overlay', variant: 0});
    expect(Object.keys(pruneEffects(map, [3, 7])).map(Number)).toEqual([3]);
  });

  it('an export renders untouched objects as Original by default, or as shown', () => {
    const map = pickEffect({}, 0, 'PixelateMask', 3); // A chose Pixelate, B and C untouched
    expect(exportEffects(map, [0, 1, 2], 'original')).toEqual({
      0: {name: 'PixelateMask', variant: 0},
      1: {name: 'Cutout', variant: 0},
      2: {name: 'Cutout', variant: 0},
    });
    expect(exportEffects(map, [0, 1], 'shown')[1]).toEqual({name: 'Overlay', variant: 0});
    // an object explicitly set to Overlay keeps it: it was chosen
    expect(exportEffects(pickEffect({}, 1, 'Overlay', 4), [1], 'original')[1].name).toBe('Overlay');
  });

  it('reads a stored map defensively', () => {
    expect(parseEffectMap({'2': {name: 'Cutout', variant: 1}, x: {name: 'y'}, '3': 'bad', '4': {variant: 1}})).toEqual({
      2: {name: 'Cutout', variant: 1},
    });
    expect(parseEffectMap(null)).toEqual({});
  });
});
