// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {goneSteps, isNeedsPositive, needsPositive, planClicks, refusedAsAbsent} from './corrections';

describe('needsPositive', () => {
  it('is true for negatives only on SAM 2 and the browser engine', () => {
    expect(needsPositive([[0.5, 0.5, 0]], 'sam2')).toBe(true);
    expect(needsPositive([[0.5, 0.5, 0]], 'browser-sam2')).toBe(true);
    expect(needsPositive([[0.5, 0.5, 0]], 'unknown')).toBe(true);
  });
  it('is false on SAM 3, with a positive, or with no clicks', () => {
    expect(needsPositive([[0.5, 0.5, 0]], 'sam3')).toBe(false);
    expect(needsPositive([[0.1, 0.1, 1], [0.5, 0.5, 0]], 'sam2')).toBe(false);
    expect(needsPositive([], 'sam2')).toBe(false);
  });
});

describe('planClicks', () => {
  const pos: [number, number, 0 | 1] = [0.1, 0.1, 1];
  const neg: [number, number, 0 | 1] = [0.5, 0.5, 0];

  it('on SAM 2, deleting the last positive while negatives remain nudges and keeps the clicks', () => {
    const current = [pos, neg];
    const plan = planClicks(current, current.filter((_, i) => i !== 0), 'sam2');
    expect(plan.kind).toBe('nudge');
    expect(plan.points).toBe(current);
    expect(current).toEqual([pos, neg]);
  });

  it('on SAM 2, a first negative on an empty frame nudges', () => {
    expect(planClicks([], [neg], 'sam2')).toEqual({kind: 'nudge', points: []});
    expect(planClicks([], [neg], 'browser-sam2')).toEqual({kind: 'nudge', points: []});
    expect(planClicks([neg], [neg, neg], 'sam2')).toEqual({kind: 'nudge', points: [neg]});
  });

  it('sends a positive plus negatives, and an emptied frame, without a hint', () => {
    expect(planClicks([pos], [pos, neg], 'sam2')).toEqual({kind: 'send', points: [pos, neg], gone: false});
    expect(planClicks([neg], [], 'sam2')).toEqual({kind: 'send', points: [], gone: false});
  });

  it('on SAM 3, sends negatives only and asks whether the object is gone for a while', () => {
    expect(planClicks([pos, neg], [neg], 'sam3')).toEqual({kind: 'send', points: [neg], gone: true});
    expect(planClicks([], [neg], 'sam3')).toEqual({kind: 'send', points: [neg], gone: true});
    expect(planClicks([], [pos], 'sam3')).toEqual({kind: 'send', points: [pos], gone: false});
  });
});

describe('isNeedsPositive', () => {
  it('matches the backend refusal, bare or in Relay\'s wrapper', () => {
    expect(isNeedsPositive('needs_positive: SAM 2 needs a positive click on frame 3')).toBe(true);
    expect(
      isNeedsPositive(
        'No data returned for operation `StudioSessionAddPointsMutation`, got error(s): needs_positive: SAM 2 ' +
          'needs a positive click See the error `source` property for more information.',
      ),
    ).toBe(true);
    expect(isNeedsPositive(new Error('needs_positive: x'))).toBe(true);
  });
  it('ignores other errors', () => {
    expect(isNeedsPositive('session expired')).toBe(false);
    expect(isNeedsPositive('this needs_positive_thing is unrelated')).toBe(false);
    expect(isNeedsPositive(null)).toBe(false);
  });
});

describe('refusedAsAbsent', () => {
  const pos: [number, number, 0 | 1] = [0.1, 0.1, 1];
  const neg: [number, number, 0 | 1] = [0.5, 0.5, 0];

  it('refuses clicks with no positive on an absent frame, before any nudge', () => {
    expect(refusedAsAbsent([neg], true)).toBe(true);
    expect(refusedAsAbsent([neg, neg], true)).toBe(true);
    // planClicks would nudge "add a positive" here on SAM 2, which would end the absence, not trim
    expect(planClicks([], [neg], 'sam2').kind).toBe('nudge');
  });
  it('lets a positive through: it ends the absence at that frame', () => {
    expect(refusedAsAbsent([pos], true)).toBe(false);
    expect(refusedAsAbsent([neg, pos], true)).toBe(false);
  });
  it('lets an emptied frame through, and refuses nothing off a range', () => {
    expect(refusedAsAbsent([], true)).toBe(false);
    expect(refusedAsAbsent([neg], false)).toBe(false);
  });
});

describe('goneSteps ("Gone for a while?")', () => {
  it('from the SAM 2 nudge, clears the frame\'s kept clicks, then marks it absent until the next seed', () => {
    // [pos, neg] on 20, its positive deleted: the nudge kept both, and a
    // positive left inside the range would end it at its own start
    expect(goneSteps('nudge', [0, 20, 50], 20, 100)).toEqual([
      {kind: 'clearFrame', frame: 20},
      {kind: 'absent', start: 20, end: 49},
    ]);
  });

  it('from the nudge on a frame with no clicks, only marks it absent', () => {
    expect(goneSteps('nudge', [0, 50], 20, 100)).toEqual([{kind: 'absent', start: 20, end: 49}]);
    expect(goneSteps('nudge', [], 20, 100)).toEqual([{kind: 'absent', start: 20, end: 99}]);
  });

  it('from the SAM 3 hint, keeps the frame\'s negatives and only marks it absent', () => {
    expect(goneSteps('hint', [0, 20, 50], 20, 100)).toEqual([{kind: 'absent', start: 20, end: 49}]);
  });
});
