import {describe, expect, it} from 'vitest';
import type {QueueEntry} from '~/state/audit';
import {reviewSpans, visibleReviewSpans} from './reviewPresentation';

const stop = (objectId: number, frame: number, start: number, end: number, score = 1, reviewed = false): QueueEntry => ({objectId, frame, start, end, score, reviewed, reviewedAt: null, reasons: []});
describe('review display spans', () => {
  it('merges touching stops without losing their identities or mutating the queue', () => {
    const queue = [stop(1, 8, 6, 10, 3), stop(1, 2, 1, 5, 2), stop(1, 14, 13, 15)];
    const original = JSON.stringify(queue);
    const spans = reviewSpans(queue);
    expect(spans.map(s => [s.start, s.end])).toEqual([[1, 10], [13, 15]]);
    expect(spans[0].stops).toEqual([queue[1], queue[0]]);
    expect(spans[0].peak).toBe(queue[0]);
    expect(JSON.stringify(queue)).toBe(original);
  });
  it('keeps layers and reviewed states separate even when spans overlap', () => {
    expect(reviewSpans([stop(1, 3, 1, 5), stop(2, 3, 1, 5), stop(1, 4, 2, 6, 1, true)])).toHaveLength(3);
  });
  it('takes the highest-priority N above the threshold before ordering by frame', () => {
    const spans = reviewSpans([stop(1, 1, 1, 1, 1), stop(1, 10, 10, 10, 5), stop(2, 5, 5, 5, 3)]);
    expect(visibleReviewSpans(spans, 2, 2, 'frame').map(s => s.score)).toEqual([3, 5]);
    expect(visibleReviewSpans(spans, 4, 20, 'priority').map(s => s.score)).toEqual([5]);
    expect(visibleReviewSpans([], 0, 20, 'frame')).toEqual([]);
  });
});
