// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The Review section: the audit queue (state/audit.ts, draft 7), a few stops
// worth a look instead of every frame. Each stop says why (its reasons, in
// words) and its score; clicking one shows it, . and , step through them in
// rank order, and Looks right (Y) marks it reviewed and moves on. A stop that
// is wrong is corrected the normal way: click on the preview, then track.
// On the timeline a stop is a downward triangle above its lane, and a
// reviewed stop a check mark: told by shape, never by colour alone.
import {useState} from 'react';
import {REVIEW_LABELS, REVIEW_SCORE_MAX, reviewSpans, visibleReviewSpans} from './reviewPresentation';
import {objectName} from '~/state/fileNames';
import {describeStop} from '~/state/audit';
import type {StudioSessionApi} from '~/workspace/useStudioSession';

/** A stop's mark: a downward triangle, or a check once reviewed. */
export function ReviewGlyph({reviewed, size = 10}: {reviewed: boolean; size?: number}) {
  return (
    <svg className="review-glyph" width={size} height={size} viewBox="0 0 10 10" aria-hidden="true">
      {reviewed ? (
        <path d="M1.5 5.2 L4 7.8 L8.6 2.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M0.8 1.5 H9.2 L5 8.8 Z" fill="currentColor" />
      )}
    </svg>
  );
}

export default function ReviewSection({session}: {session: StudioSessionApi}) {
  const {review, state} = session;
  const [minimum, setMinimum] = useState(0.5);
  const [limit, setLimit] = useState(20);
  const [sort, setSort] = useState<'priority' | 'frame'>('priority');
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  const nameOf = (id: number) => objectName(state.objects.find(o => o.id === id) ?? {id});
  if (review == null || Object.keys(review.objects).length === 0) return <div className="empty">Track a layer to find frames worth reviewing.</div>;
  if (!review.supported) return <div className="empty">This backend cannot list review markers. Update it to enable review.</div>;
  const queue = review.queue;
  const scoped = scope === 'selected' ? queue.filter(e => e.objectId === state.activeId) : queue;
  const spans = reviewSpans(scoped);
  const shown = visibleReviewSpans(spans, minimum, limit, sort);
  const pending = queue.filter(e => e.objectId === state.activeId && !e.reviewed);
  const current = session.currentStop;
  const changed = Object.entries(review.objects).filter(([, o]) => o.state === 'stale').map(([id]) => nameOf(Number(id)));
  return <div className="review">
    <div className="review-current">
      {current == null ? <strong>Select a marker to inspect its matte.</strong> : <>
        <strong>{nameOf(current.objectId)} · Frame {current.frame + 1}</strong>
        <p>{current.reasons.map(r => REVIEW_LABELS[r.kind]).join(', ')}</p>
      </>}
      <div className="object-actions">
        <button className="button" disabled={queue.length === 0} onClick={() => session.stepReview(-1)}>Previous <kbd>,</kbd></button>
        <button className="button" disabled={queue.length === 0} onClick={() => session.stepReview(1)}>Next <kbd>.</kbd></button>
        <button className="button primary" disabled={current == null} onClick={() => current && session.markReviewed(current, !current.reviewed, true)}>{current?.reviewed ? 'Reopen' : 'Looks right (Y)'}</button>
      </div>
    </div>
    <div className="review-filters">
      <label>Layers<select value={scope} onChange={e => setScope(e.target.value as 'all' | 'selected')}><option value="all">All layers</option><option value="selected">Selected layer</option></select></label>
      <label>Sort<select value={sort} onChange={e => setSort(e.target.value as 'priority' | 'frame')}><option value="priority">Highest score first</option><option value="frame">Frame order</option></select></label>
      <label>Top spans<select value={limit} onChange={e => setLimit(Number(e.target.value))}><option value={20}>20</option><option value={50}>50</option><option value={Infinity}>All</option></select></label>
      <label>Minimum score<select value={minimum} onChange={e => setMinimum(Number(e.target.value))}><option value={0}>0 (all)</option><option value={0.5}>0.5</option><option value={2}>2</option><option value={4}>4</option></select></label>
    </div>
    <p className="review-scale">Score: 0–{REVIEW_SCORE_MAX} priority points. Higher means more or stronger review signals, not confidence. A span shows its highest stop score.</p>
    <p className="review-summary">Showing {shown.length} of {spans.length} spans ({scoped.length} stops). Adjacent stops on the same layer are grouped.</p>
    <p className="review-keys muted">Previous / Next and <kbd>,</kbd> <kbd>.</kbd> use the full queue in priority order, independent of these display filters.</p>
    {state.activeId != null && <button className="button review-accept-all" disabled={pending.length === 0} onClick={() => pending.forEach(e => session.markReviewed(e, true, false))}>
      Looks right: all {pending.length} stops for {nameOf(state.activeId)}
    </button>}
    {changed.length > 0 && <p className="object-hint">{changed.join(', ')} changed. Track again to refresh these review markers.</p>}
    {shown.length === 0 && <p className="empty">{queue.length === 0 ? 'No review signals found. Inspect the matte before exporting.' : 'No spans match these filters. Lower the minimum score or show all layers.'}</p>}
    <ol className="review-list">
      {shown.map(span => {
        const here = current != null && span.stops.some(e => e.objectId === current.objectId && e.frame === current.frame);
        const label = `${nameOf(span.objectId)} · ${span.start === span.end ? `frame ${span.start + 1}` : `frames ${span.start + 1}–${span.end + 1}`}`;
        const reasons = [...new Set(span.stops.flatMap(e => e.reasons.map(r => REVIEW_LABELS[r.kind])))];
        return <li key={`${span.objectId}:${span.start}:${span.reviewed}`} className={`review-item${here ? ' current' : ''}${span.reviewed ? ' reviewed' : ''}`}>
          <button className="review-go" onClick={() => session.goToStop(span.peak)} aria-current={here ? 'true' : undefined} title={describeStop(span.peak)} aria-label={`${label}, score ${span.score.toFixed(1)} of ${REVIEW_SCORE_MAX}. ${reasons.join(', ')}`}>
            <span className="review-mark-icon"><ReviewGlyph reviewed={span.reviewed} /></span>
            <span className="review-where">{label}</span>
            <span className="review-score">{span.score.toFixed(1)} / {REVIEW_SCORE_MAX}</span>
            <span className="review-why">{reasons.join(' · ')}</span>
          </button>
          <button className="button compact subtle" onClick={() => span.stops.forEach(e => session.markReviewed(e, !span.reviewed, false))}>{span.reviewed ? 'Reopen span' : 'Looks right'}</button>
        </li>;
      })}
    </ol>
  </div>;
}
