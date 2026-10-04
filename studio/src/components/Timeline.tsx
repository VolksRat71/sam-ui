// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The bottom pane: transport controls, a filmstrip scrubber with a playhead,
// and one swimlane per object in the style of Meta's TrackletSwimlane (a thin
// line in the object's colour, solid where it has a mask, a dot on each frame
// that holds clicks). Review flags (F) mark frames to correct later.
// Dragging across a lane selects a span of frames, which the transport can
// mark absent (the object is not in the shot) or unmark; an absent range is a
// hatched block on the lane, and a window no click reaches carries a hint.
// Lanes follow the Objects list's order (issue #21), with a group's colour by the name.
import {
  ChevronLeft,
  ChevronRight,
  Flag,
  FlagFilled,
  PauseFilled,
  PlayFilledAlt,
} from '@carbon/icons-react';
import {useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent} from 'react';
import {objectName} from '~/state/fileNames';
import {flagsOf} from '~/state/flags';
import {seedFrames} from '~/state/objects';
import {ABSENT, spanState, unseededWindows} from '~/state/ranges';
import type {StudioSessionApi} from '~/workspace/useStudioSession';

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

export default function Timeline({session}: Props) {
  const {bridge, meta, frame, playing, state, tracklets, seek, togglePlay} = session;
  const n = meta.numFrames;
  const {ref: trackRef, width} = useWidth();
  const filmstripRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const laneDrag = useRef<{id: number; from: number; x: number; moved: boolean} | null>(null);

  // Escape drops the selection; so does removing its object
  useEffect(() => {
    if (selection == null) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelection(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection]);
  const selected = selection == null ? undefined : state.objects.find(o => o.id === selection.id);
  useEffect(() => {
    if (selection != null && selected == null) {
      setSelection(null);
    }
  }, [selection, selected]);

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
  const covered = selected != null && span != null ? spanState(selected.ranges, span.a, span.b) : null;
  const active = state.objects.find(o => o.id === state.activeId);
  const absentHere = active?.ranges.some(r => r.start <= frame && frame <= r.end) ?? false;

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
          {absentHere && active != null && selection == null && (
            <span className="absent-note"> · {objectName(active)} is marked absent here</span>
          )}
        </span>
        {selection != null && selected != null && span != null && (
          <span className="range-bar" role="group" aria-label="Selected frames">
            <span>
              {objectName(selected)}: frames {span.a + 1}–{span.b + 1}
            </span>
            {covered !== 'absent' && (
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
            {covered !== 'present' && (
              <button
                className="button compact"
                onClick={() => {
                  session.setRange(selected.id, span.a, span.b, null);
                  setSelection(null);
                }}
                title="Track these frames again (after a re-track)">
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
                {o.ranges.map(r => (
                  <button
                    key={`absent-${r.start}`}
                    className="swimlane-absent"
                    title={`Frames ${r.start + 1}–${r.end + 1}: marked absent (not in the shot). Click to select, then Unmark.`}
                    style={{left: pos(r.start), width: Math.max(4, pos(Math.min(r.end, n - 1)) - pos(r.start))}}
                    onClick={e => {
                      e.stopPropagation();
                      session.selectObject(o.id);
                      setSelection({id: o.id, start: r.start, end: Math.min(r.end, Math.max(0, n - 1))});
                    }}
                  />
                ))}
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
