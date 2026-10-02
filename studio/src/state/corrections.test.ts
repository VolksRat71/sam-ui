// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {isNeedsPositive, needsPositive, planClicks} from './corrections';

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
