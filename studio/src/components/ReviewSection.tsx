// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The Review section: the audit queue (state/audit.ts, draft 7), a few stops
// worth a look instead of every frame. Each stop says why (its reasons, in
// words) and its score; clicking one shows it, . and , step through them in
// rank order, and Looks right (Y) marks it reviewed and moves on. A stop that
// is wrong is corrected the normal way: click on the preview, then track.
// On the timeline a stop is a downward triangle above its lane, and a
// reviewed stop a check mark: told by shape, never by colour alone.
import {objectName} from '~/state/fileNames';
import {KIND_LABELS, describeStop, stopLabel} from '~/state/audit';
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
  const nameOf = (id: number) => objectName(state.objects.find(o => o.id === id) ?? {id});
  if (review == null) {
    return <div className="empty">Track an object to get its review queue.</div>;
  }
  if (!review.supported) {
    return <div className="empty">This backend has no review queue yet. Update it to get one.</div>;
  }
  const queue = review.queue;
  const nFrames = Math.max(0, ...Object.values(review.objects).map(o => o.nFrames));
  const stale = Object.entries(review.objects)
    .filter(([, o]) => o.state === 'stale')
    .map(([id]) => nameOf(Number(id)));
  const reviewed = queue.filter(e => e.reviewed).length;
  if (Object.keys(review.objects).length === 0) {
    return <div className="empty">Track an object to get its review queue.</div>;
  }
  return (
    <div className="review">
      <div className="review-summary">
        {queue.length === 0 ? (
          <span>Nothing stood out: no frame needs a look.</span>
        ) : (
          <span>
            <strong>{queue.length}</strong> {queue.length === 1 ? 'stop' : 'stops'} to check, of {nFrames} frames
            {reviewed > 0 && <span className="muted"> · {reviewed} reviewed</span>}
          </span>
        )}
        <span className="muted review-keys">
          <kbd>.</kbd> <kbd>,</kbd> step · <kbd>Y</kbd> looks right · click the preview to correct
        </span>
      </div>
      {stale.length > 0 && (
        <div className="object-hint">
          {stale.join(', ')} changed since {stale.length === 1 ? 'its' : 'their'} last track: track again to refresh the stops.
        </div>
      )}
      <ol className="review-list">
        {queue.map(e => {
          const here = session.currentStop === e || (session.currentStop?.objectId === e.objectId && session.currentStop.frame === e.frame);
          const o = state.objects.find(x => x.id === e.objectId);
          return (
            <li key={`${e.objectId}:${e.frame}`} className={`review-item${here ? ' current' : ''}${e.reviewed ? ' reviewed' : ''}`}>
              <button
                className="review-go"
                onClick={() => session.goToStop(e)}
                aria-current={here ? 'true' : undefined}
                title={describeStop(e)}
                aria-label={stopLabel(e, nameOf(e.objectId))}>
                <span className="review-mark-icon">
                  <ReviewGlyph reviewed={e.reviewed} />
                </span>
                <span className="swatch" style={{background: o?.color}} />
                <span className="review-where">
                  {nameOf(e.objectId)} · frame {e.frame + 1}
                </span>
                <span className="muted review-score">{e.score.toFixed(1)}</span>
                <span className="review-why">
                  {e.reasons.map(r => (
                    <span key={r.kind} className="review-reason" title={`Frame ${r.frame + 1}: ${r.detail}`}>
                      {KIND_LABELS[r.kind]}
                    </span>
                  ))}
                </span>
              </button>
              <button
                className="button compact subtle"
                onClick={() => session.markReviewed(e, !e.reviewed, here)}
                title={e.reviewed ? 'Open this stop again' : 'The masks here look right (Y): mark this stop reviewed and go to the next'}>
                {e.reviewed ? 'Reopen' : 'Looks right'}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
