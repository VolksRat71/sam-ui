// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The bottom pane: transport controls, a filmstrip scrubber with a playhead,
// and one swimlane per object in the style of Meta's TrackletSwimlane (a thin
// line in the object's colour, solid where it has a mask, a dot on each frame
// that holds clicks). Review flags (F) mark frames to correct later.
// Dragging across a lane selects a span of frames, which the transport can
// mark absent (the object is not in the shot), present (it is there) or
// unmark (unknown). A window no click reaches carries a hint.
// Every frame of a lane is one of four kinds (state/ranges.ts), each drawn by
// shape, not colour, and named in the legend and in each block's label:
//   unknown    the plain thin line;
//   candidate  a dotted outline: a model or tool thinks the object is there.
//              Clicking one (or ] / [ to step through them) shows its source
//              and score, with Present (P), Absent (A) and Reject (R);
//   present    a solid bracket under the lane: confirmed there;
//   absent     a hatched block: confirmed not in the shot.
// The tracked segments (the solid line in the object's colour) stay derived
// output, drawn apart from all four.
// Lanes follow the Objects list's order (issue #21), with a group's colour by the name.
// The review queue's stops (draft 7) sit above their lane as downward
// triangles, a check once reviewed; with one on screen, the transport says
// why it is there and offers Looks right (Y) and the next stop (.).
import {
  ChevronLeft,
  ChevronRight,
  Flag,
  FlagFilled,
  PauseFilled,
  PlayFilledAlt,
} from '@carbon/icons-react';
import {useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent} from 'react';
import {KIND_LABELS, stopLabel} from '~/state/audit';
import {objectName} from '~/state/fileNames';
import {flagsOf} from '~/state/flags';
import {seedFrames} from '~/state/objects';
import {
  ABSENT,
  CANDIDATE,
  type Mark,
  PRESENT,
  describeRange,
  nextRange,
  provenanceLabel,
  spanKinds,
  stateAt,
  timelineView,
  unseededWindows,
} from '~/state/ranges';
import type {StudioObject} from '~/state/objects';
import type {StudioSessionApi} from '~/workspace/useStudioSession';
import {ReviewGlyph} from './ReviewSection';

const FILMSTRIP_HEIGHT = 44;

type Props = {session: StudioSessionApi};

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el == null) {
      return;
    }
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return {ref, width};
}

/** A span of one object's frames picked on its lane, inclusive, in drag order. */
type Selection = {id: number; start: number; end: number};
/** A candidate picked for review, by its object and span. */
type Picked = {id: number; start: number; end: number};

function candidatesOf(o: StudioObject | undefined): Mark[] {
  return o?.marks.filter(m => m.state === CANDIDATE) ?? [];
}

export default function Timeline({session}: Props) {
  const {bridge, meta, frame, playing, state, tracklets, seek, togglePlay} = session;
  const n = meta.numFrames;
  const {ref: trackRef, width} = useWidth();
  const filmstripRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);
  const [selection, setSelectionState] = useState<Selection | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const laneDrag = useRef<{id: number; from: number; x: number; moved: boolean} | null>(null);
  // a drag selection and a picked candidate are never both open
  const setSelection = useCallback((s: Selection | null) => {
    setSelectionState(s);
    if (s != null) {
      setPicked(null);
    }
  }, []);
  const pick = useCallback(
    (id: number, c: Mark | null) => {
      setPicked(c == null ? null : {id, start: c.start, end: c.end});
      if (c != null) {
        setSelectionState(null);
        session.selectObject(id);
        seek(c.start);
      }
    },
    [session, seek],
  );

  const selected = selection == null ? undefined : state.objects.find(o => o.id === selection.id);
  useEffect(() => {
    if (selection != null && selected == null) {
      setSelection(null);
    }
  }, [selection, selected, setSelection]);
  const pickedObject = picked == null ? undefined : state.objects.find(o => o.id === picked.id);
  const pickedMark = candidatesOf(pickedObject).find(m => m.start === picked?.start && m.end === picked?.end) ?? null;
  useEffect(() => {
    if (picked != null && pickedMark == null) {
      setPicked(null); // confirmed, rejected or gone
    }
  }, [picked, pickedMark]);

  /** Act on the picked candidate, then pick the object's next one (review in one pass). */
  const decide = useCallback(
    (how: 'present' | 'absent' | 'reject') => {
      if (pickedObject == null || pickedMark == null) {
        return;
      }
      const next = nextRange(candidatesOf(pickedObject), pickedMark.end, 1);
      if (how === 'reject') {
        session.rejectCandidate(pickedObject.id, pickedMark);
      } else {
        session.confirmCandidate(pickedObject.id, pickedMark, how === 'present' ? PRESENT : ABSENT);
      }
      pick(pickedObject.id, next);
    },
    [pickedObject, pickedMark, session, pick],
  );

  // keyboard: Escape drops the selection or the picked candidate; ] and [ step
  // through the selected object's candidates; P, A and R decide the picked one
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || (target != null && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) {
        return;
      }
      if (document.querySelector('.modal-backdrop') != null) {
        return; // a dialog is open: its keys are its own
      }
      if (e.key === 'Escape') {
        setSelection(null);
        setPicked(null);
        return;
      }
      if (e.key === ']' || e.key === '[') {
        // the picked candidate's object, else the selected one, else the first lane with candidates
        const o =
          pickedObject ??
          state.objects.find(x => x.id === state.activeId) ??
          session.ordered.find(x => candidatesOf(x).length > 0);
        const from = pickedMark != null ? (e.key === ']' ? pickedMark.end : pickedMark.start) : frame + (e.key === ']' ? -1 : 1);
        const c = o == null ? null : nextRange(candidatesOf(o), from, e.key === ']' ? 1 : -1);
        if (o != null && c != null) {
          e.preventDefault();
          pick(o.id, c);
        }
        return;
      }
      if (pickedMark == null) {
        return;
      }
      const key = e.key.toLowerCase();
      if (key === 'p' || key === 'a' || key === 'r') {
        e.preventDefault();
        decide(key === 'p' ? 'present' : key === 'a' ? 'absent' : 'reject');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickedObject, pickedMark, state.objects, state.activeId, session.ordered, frame, pick, decide, setSelection]);

  const pos = useCallback(
    (index: number) => (n <= 1 ? 0 : (index / (n - 1)) * width),
    [n, width],
  );

  // Meta's filmstrip, drawn by the worker once decoding is done
  useEffect(() => {
    if (bridge == null || !meta.decoded || width < 1) {
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      bridge.createFilmstrip(Math.round(width), FILMSTRIP_HEIGHT).then(bitmap => {
        const canvas = filmstripRef.current;
        if (cancelled || canvas == null) {
          bitmap.close();
          return;
        }
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
        bitmap.close();
      });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [bridge, meta.decoded, width]);

  function frameAt(event: PointerEvent<HTMLDivElement>): number {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.min(Math.max(0, event.clientX - rect.left), rect.width);
    return rect.width <= 0 || n <= 1 ? 0 : Math.round((x / rect.width) * (n - 1));
  }

  const ticks = n > 0 ? tickFrames(n, width) : [];
  const span = selection == null ? null : {a: Math.min(selection.start, selection.end), b: Math.max(selection.start, selection.end)};
  const covered = selected != null && span != null ? spanKinds(timelineView(selected.ranges, selected.marks), span.a, span.b) : null;
  const active = state.objects.find(o => o.id === state.activeId);
  const activeView = active == null ? [] : timelineView(active.ranges, active.marks);
  const kindHere = stateAt(activeView, frame);
  const markHere = activeView.find(r => r.start <= frame && frame <= r.end);

  return (
    <div className="timeline">
      <div className="transport">
        <button className="icon-button" onClick={() => seek(frame - 1)} title="Previous frame (Left)">
          <ChevronLeft size={18} />
        </button>
        <button className="icon-button play" onClick={togglePlay} disabled={n === 0} title="Play / pause (Space)">
          {playing ? <PauseFilled size={18} /> : <PlayFilledAlt size={18} />}
        </button>
        <button className="icon-button" onClick={() => seek(frame + 1)} title="Next frame (Right)">
          <ChevronRight size={18} />
        </button>
        <button
          className="icon-button"
          onClick={session.toggleFlag}
          disabled={state.activeId == null || n === 0}
          aria-pressed={state.activeId != null && flagsOf(session.flags, state.activeId).includes(frame)}
          title="Flag this frame of the selected object for a correction (F)">
          {state.activeId != null && flagsOf(session.flags, state.activeId).includes(frame) ? (
            <FlagFilled size={16} />
          ) : (
            <Flag size={16} />
          )}
        </button>
        <span className="frame-counter">
          Frame <strong>{n > 0 ? frame + 1 : 0}</strong> / {n}
          {meta.fps > 0 && (
            <span className="muted"> · {(frame / meta.fps).toFixed(2)} s · {Math.round(meta.fps)} fps</span>
          )}
          {!meta.decoded && n > 0 && <span className="muted"> · decoding…</span>}
          {active != null && selection == null && picked == null && kindHere !== 'unknown' && (
            <span className="absent-note">
              {' · '}
              {objectName(active)}
              {kindHere === 'absent'
                ? ' is marked absent here'
                : kindHere === 'present'
                  ? ' is confirmed present here'
                  : ` may be here: candidate (${markHere != null && markHere.state === CANDIDATE ? provenanceLabel(markHere) : ''}), ] to review`}
            </span>
          )}
        </span>
        {session.currentStop != null && picked == null && selection == null && (() => {
          const stop = session.currentStop;
          const queue = session.review?.queue ?? [];
          const at = queue.findIndex(e => e.objectId === stop.objectId && e.frame === stop.frame);
          const o = state.objects.find(x => x.id === stop.objectId);
          return (
            <span className="range-bar review-bar" role="group" aria-label="Review stop">
              <ReviewGlyph reviewed={stop.reviewed} />
              <span title={stop.reasons.map(r => `Frame ${r.frame + 1}: ${r.detail}`).join('\n')}>
                Review {at + 1}/{queue.length}: {o != null ? objectName(o) : `Object ${stop.objectId}`}
                <span className="muted"> · {stop.reasons.map(r => KIND_LABELS[r.kind]).join(', ')}</span>
                {stop.reviewed && <span className="muted"> · reviewed</span>}
              </span>
              <button
                className="button compact"
                onClick={() => session.markReviewed(stop, !stop.reviewed, true)}
                title={stop.reviewed ? 'Open this stop again' : 'The masks here look right (Y): mark the stop reviewed and go to the next one. To fix them, click on the preview instead'}>
                {stop.reviewed ? 'Reopen' : (
                  <>
                    Looks right <kbd>Y</kbd>
                  </>
                )}
              </button>
              <button className="button subtle compact" onClick={() => session.stepReview(1)} title="The next stop in the queue (.); , goes back">
                Next <kbd>.</kbd>
              </button>
            </span>
          );
        })()}
        {pickedObject != null && pickedMark != null && (
          <span className="range-bar candidate-bar" role="group" aria-label="Candidate to review">
            <span>
              {objectName(pickedObject)}: candidate, frames {pickedMark.start + 1}–{pickedMark.end + 1}
              <span className="muted"> · {provenanceLabel(pickedMark)}</span>
            </span>
            <button
              className="button compact"
              onClick={() => decide('present')}
              title="The object is there on these frames (P). Annotation only: the track is unchanged">
              Present <kbd>P</kbd>
            </button>
            <button
              className="button compact"
              onClick={() => decide('absent')}
              title="The object is not in the shot on these frames (A): they go empty and the track is re-tracked around them. Undoable">
              Absent <kbd>A</kbd>
            </button>
            <button className="button compact" onClick={() => decide('reject')} title="Not a candidate: the frames go back to unknown (R)">
              Reject <kbd>R</kbd>
            </button>
            <button className="button subtle compact" onClick={() => setPicked(null)} title="Cancel (Esc); ] and [ step through candidates">
              Cancel
            </button>
          </span>
        )}
        {selection != null && selected != null && span != null && (
          <span className="range-bar" role="group" aria-label="Selected frames">
            <span>
              {objectName(selected)}: frames {span.a + 1}–{span.b + 1}
            </span>
            {!(covered?.size === 1 && covered.has(ABSENT)) && (
              <button
                className="button compact"
                onClick={() => {
                  session.setRange(selected.id, span.a, span.b, ABSENT);
                  setSelection(null);
                }}
                title="The object is not in the shot on these frames: they stay empty, are never tracked or exported, and each side of the gap is tracked from its own clicks">
                Mark absent
              </button>
            )}
            {!(covered?.size === 1 && covered.has(PRESENT)) && (
              <button
                className="button compact"
                onClick={() => {
                  session.setRange(selected.id, span.a, span.b, PRESENT);
                  setSelection(null);
                }}
                title="The object is there on these frames (confirmed). Annotation only: no track goes stale">
                Mark present
              </button>
            )}
            {!(covered?.size === 1 && covered.has('unknown')) && (
              <button
                className="button compact"
                onClick={() => {
                  session.setRange(selected.id, span.a, span.b, null);
                  setSelection(null);
                }}
                title="Back to unknown: clears absent, present and candidate ranges here (absent frames are tracked again after a re-track)">
                Unmark
              </button>
            )}
            <button className="button subtle compact" onClick={() => setSelection(null)} title="Cancel (Esc)">
              Cancel
            </button>
          </span>
        )}
      </div>
      <div className="lanes">
        <div className="lane-labels">
          <div className="lane-label scrub-label">Video</div>
          {session.ordered.map(o => {
            const group = state.layout.groups.find(g => g.members.includes(o.id));
            return (
              <div key={o.id} className="lane-label" style={{color: o.id === state.activeId ? '#fff' : undefined}}>
                {group != null && <span className="lane-group-mark" style={{background: group.color}} title={group.name} />}
                {objectName(o)}
              </div>
            );
          })}
        </div>
        <div className="lane-tracks" ref={trackRef}>
          <div
            className="scrubber"
            onPointerDown={e => {
              dragging.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              seek(frameAt(e));
            }}
            onPointerMove={e => {
              if (dragging.current) {
                seek(frameAt(e));
              }
            }}
            onPointerUp={e => {
              dragging.current = false;
              e.currentTarget.releasePointerCapture(e.pointerId);
            }}>
            <canvas ref={filmstripRef} className="filmstrip" />
            <div className="ticks">
              {ticks.map(t => (
                <span key={t} className="tick" style={{left: pos(t)}}>
                  {t + 1}
                </span>
              ))}
            </div>
          </div>
          {session.ordered.map(o => {
            const lane = tracklets.get(o.id);
            const sel = selection?.id === o.id && span != null ? span : null;
            return (
              <div
                key={o.id}
                className="swimlane"
                onPointerDown={e => {
                  if (e.button !== 0 || (e.target as HTMLElement).closest('button') != null || n === 0) {
                    return;
                  }
                  laneDrag.current = {id: o.id, from: frameAt(e), x: e.clientX, moved: false};
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={e => {
                  const d = laneDrag.current;
                  if (d == null || d.id !== o.id) {
                    return;
                  }
                  if (!d.moved && Math.abs(e.clientX - d.x) < 4) {
                    return; // a click, so far
                  }
                  d.moved = true;
                  setSelection({id: o.id, start: d.from, end: frameAt(e)});
                }}
                onPointerUp={e => {
                  const d = laneDrag.current;
                  laneDrag.current = null;
                  if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                    e.currentTarget.releasePointerCapture(e.pointerId);
                  }
                  if (d != null && !d.moved) {
                    setSelection(null); // a plain click on a lane drops the selection
                  }
                }}
                onClick={() => session.selectObject(o.id)}>
                <div className="swimlane-line" style={{background: o.color}} />
                {lane?.segments.map(([a, b]) => (
                  <div
                    key={a}
                    className="swimlane-segment"
                    style={{background: o.color, left: pos(a), width: Math.max(2, pos(b) - pos(a))}}
                  />
                ))}
                {[...o.ranges, ...o.marks.filter(m => m.state === PRESENT)].map(r => (
                  <button
                    key={`${r.state}-${r.start}`}
                    className={r.state === ABSENT ? 'swimlane-absent' : 'swimlane-present'}
                    title={`${describeRange(r)}. Click to select, then Unmark.`}
                    aria-label={describeRange(r)}
                    style={{left: pos(r.start), width: Math.max(4, pos(Math.min(r.end, n - 1)) - pos(r.start))}}
                    onClick={e => {
                      e.stopPropagation();
                      session.selectObject(o.id);
                      setSelection({id: o.id, start: r.start, end: Math.min(r.end, Math.max(0, n - 1))});
                    }}
                  />
                ))}
                {candidatesOf(o).map(c => {
                  const on = picked?.id === o.id && picked.start === c.start && picked.end === c.end;
                  return (
                    <button
                      key={`candidate-${c.start}`}
                      className={`swimlane-candidate${on ? ' picked' : ''}`}
                      title={`${describeRange(c)}. Click to review (] and [ step through candidates).`}
                      aria-label={describeRange(c)}
                      aria-pressed={on}
                      style={{left: pos(c.start), width: Math.max(6, pos(Math.min(c.end, n - 1)) - pos(c.start))}}
                      onClick={e => {
                        e.stopPropagation();
                        pick(o.id, on ? null : c);
                      }}
                    />
                  );
                })}
                {unseededWindows(seedFrames(o), o.ranges, n).map(w => (
                  <span
                    key={`hint-${w.lo}`}
                    className="swimlane-hint"
                    style={{left: pos(w.lo), width: Math.max(0, pos(w.hi) - pos(w.lo))}}
                    title={`Frames ${w.lo + 1}–${w.hi + 1} have no clicks: nothing is tracked there`}>
                    click the object {w.side} the gap
                  </span>
                ))}
                {sel != null && (
                  <div className="swimlane-selection" style={{left: pos(sel.a), width: Math.max(2, pos(sel.b) - pos(sel.a))}} />
                )}
                {session.disagreement.get(o.id)?.flagged.map(f => (
                  <button
                    key={`flag-${f}`}
                    className="swimlane-flag"
                    title={`Frame ${f + 1}: SAM 2 and SAM 3 disagree`}
                    style={{left: pos(f) - 1}}
                    onClick={e => {
                      e.stopPropagation();
                      session.selectObject(o.id);
                      seek(f);
                    }}
                  />
                ))}
                {flagsOf(session.flags, o.id).map(f => (
                  <button
                    key={`mark-${f}`}
                    className="swimlane-mark"
                    title={`Frame ${f + 1}: flagged for a correction (F on it unflags; clicks there clear it)`}
                    style={{left: pos(f) - 1}}
                    onClick={e => {
                      e.stopPropagation();
                      session.selectObject(o.id);
                      seek(f);
                    }}
                  />
                ))}
                {(session.review?.queue ?? [])
                  .filter(e => e.objectId === o.id)
                  .map(e => (
                    <button
                      key={`review-${e.frame}`}
                      className={`swimlane-review${e.reviewed ? ' reviewed' : ''}${session.currentStop === e ? ' current' : ''}`}
                      title={stopLabel(e, objectName(o))}
                      aria-label={stopLabel(e, objectName(o))}
                      style={{left: pos(e.frame) - 5}}
                      onClick={ev => {
                        ev.stopPropagation();
                        session.goToStop(e);
                      }}>
                      <ReviewGlyph reviewed={e.reviewed} size={9} />
                    </button>
                  ))}
                {seedFrames(o).map(f => (
                  <button
                    key={f}
                    className="swimlane-seed"
                    title={`Clicks on frame ${f + 1}`}
                    style={{left: pos(f) - 6, background: o.color}}
                    onClick={e => {
                      e.stopPropagation();
                      session.selectObject(o.id);
                      seek(f);
                    }}
                  />
                ))}
              </div>
            );
          })}
          {n > 0 && <div className="playhead" style={{left: pos(frame)}} />}
        </div>
      </div>
      {session.ordered.length > 0 && (
        <ul className="lane-legend" aria-label="Timeline legend">
          <li>
            <span className="legend-swatch legend-tracked" />
            tracked
          </li>
          <li>
            <span className="legend-swatch legend-unknown" />
            unknown
          </li>
          <li>
            <span className="legend-swatch swimlane-candidate" />
            candidate (unconfirmed)
          </li>
          <li>
            <span className="legend-swatch swimlane-present" />
            present
          </li>
          <li>
            <span className="legend-swatch swimlane-absent" />
            absent
          </li>
          <li>
            <span className="legend-glyph">
              <ReviewGlyph reviewed={false} />
            </span>
            review stop
          </li>
          <li>
            <span className="legend-glyph reviewed">
              <ReviewGlyph reviewed />
            </span>
            reviewed
          </li>
          <li className="muted">drag a lane to mark · ] [ review candidates · . , review stops</li>
        </ul>
      )}
    </div>
  );
}

/** Frame labels spaced to fit, on round numbers. */
function tickFrames(n: number, width: number): number[] {
  if (width <= 0) {
    return [0];
  }
  const maxTicks = Math.max(2, Math.floor(width / 70));
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
  const step = steps.find(s => n / s <= maxTicks) ?? Math.ceil(n / maxTicks);
  const out: number[] = [];
  for (let f = 0; f < n; f += step) {
    out.push(f);
  }
  return out;
}
