// sam-ui (Apache-2.0). Presentation only: keep the audit queue and its identities intact.
import {WEIGHTS, type QueueEntry, type ReasonKind} from '~/state/audit';

export const REVIEW_SCORE_MAX = Object.values(WEIGHTS).reduce((sum, weight) => sum + weight, 0);
export const REVIEW_LABELS: Record<ReasonKind, string> = {
  flag: 'Correction marker', disagree: 'Engines disagree', reappear: 'Layer reappears',
  candidate: 'Unconfirmed span', start: 'Matte begins', stop: 'Matte ends',
  area: 'Matte size changed', jump: 'Position changed', components: 'Matte pieces changed', retrack: 'Tracking boundary',
};
export type ReviewSpan = {
  objectId: number; start: number; end: number; reviewed: boolean; score: number;
  peak: QueueEntry; stops: QueueEntry[];
};

/** Merge touching spans per layer and review state; every original stop remains actionable. */
export function reviewSpans(queue: readonly QueueEntry[]): ReviewSpan[] {
  const sorted = [...queue].sort((a, b) => a.objectId - b.objectId || Number(a.reviewed) - Number(b.reviewed) || a.start - b.start || a.frame - b.frame);
  const spans: ReviewSpan[] = [];
  for (const stop of sorted) {
    const last = spans[spans.length - 1];
    if (last && last.objectId === stop.objectId && last.reviewed === stop.reviewed && stop.start <= last.end + 1) {
      last.end = Math.max(last.end, stop.end);
      last.stops.push(stop);
      if (stop.score > last.score) { last.score = stop.score; last.peak = stop; }
    } else {
      spans.push({objectId: stop.objectId, start: stop.start, end: stop.end, reviewed: stop.reviewed, score: stop.score, peak: stop, stops: [stop]});
    }
  }
  return spans.sort((a, b) => b.score - a.score || a.objectId - b.objectId || a.start - b.start);
}

export function visibleReviewSpans(spans: readonly ReviewSpan[], minimum: number, limit: number, sort: 'priority' | 'frame'): ReviewSpan[] {
  // Top N always means the highest-priority N; frame sorting only changes their display order.
  const top = [...spans].filter(s => s.score >= minimum).sort((a, b) => b.score - a.score || a.start - b.start).slice(0, limit);
  return sort === 'frame' ? top.sort((a, b) => a.start - b.start || a.objectId - b.objectId) : top;
}
