// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The bottom pane: transport controls, a filmstrip scrubber with a playhead,
// and one swimlane per object in the style of Meta's TrackletSwimlane (a thin
// line in the object's colour, solid where it has a mask, a dot on each frame
// that holds clicks).
import {
  ChevronLeft,
  ChevronRight,
  PauseFilled,
  PlayFilledAlt,
} from '@carbon/icons-react';
import {useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent} from 'react';
import {seedFrames} from '~/state/objects';
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

export default function Timeline({session}: Props) {
  const {bridge, meta, frame, playing, state, tracklets, seek, togglePlay} = session;
  const n = meta.numFrames;
  const {ref: trackRef, width} = useWidth();
  const filmstripRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);

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
        <span className="frame-counter">
          Frame <strong>{n > 0 ? frame + 1 : 0}</strong> / {n}
          {meta.fps > 0 && (
            <span className="muted"> · {(frame / meta.fps).toFixed(2)} s · {Math.round(meta.fps)} fps</span>
          )}
          {!meta.decoded && n > 0 && <span className="muted"> · decoding…</span>}
        </span>
      </div>
      <div className="lanes">
        <div className="lane-labels">
          <div className="lane-label scrub-label">Video</div>
          {state.objects.map(o => (
            <div key={o.id} className="lane-label" style={{color: o.id === state.activeId ? '#fff' : undefined}}>
              Object {o.id + 1}
            </div>
          ))}
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
          {state.objects.map(o => {
            const lane = tracklets.get(o.id);
            return (
              <div key={o.id} className="swimlane" onClick={() => session.selectObject(o.id)}>
                <div className="swimlane-line" style={{background: o.color}} />
                {lane?.segments.map(([a, b]) => (
                  <div
                    key={a}
                    className="swimlane-segment"
                    style={{background: o.color, left: pos(a), width: Math.max(2, pos(b) - pos(a))}}
                  />
                ))}
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
