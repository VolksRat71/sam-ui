// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The video preview: the worker-drawn canvas, fitted to its pane, with the
// click layer and the active object's points on top. Clicks follow Meta's
// demo: left click adds a point of the selected kind, right click the other
// kind, clicking a point removes it. The view zooms (pinch, or Ctrl/Cmd +
// wheel, or the buttons) and pans (wheel, middle drag, or Alt + drag). Only
// the video and its masks are pixels, scaled by the zoom; the point markers
// are an SVG overlay outside the zoomed box, placed in video coordinates, so
// they stay crisp, keep their size, and never cover what they mark. On a
// touch screen a tap adds a point of the selected kind, a long press the
// other kind, one finger pans a zoomed view and two fingers pinch
// (lib/gestures.ts).
import {AddFilled, SubtractFilled, ZoomIn, ZoomOut} from '@carbon/icons-react';
import {useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent} from 'react';
import {labelFor, longPressStartsOn} from '~/lib/gestures';
import {objectName} from '~/state/fileNames';
import {FIT, panBy, toScreen, zoomAt, type View} from '~/state/view';
import type {StudioSessionApi} from '~/workspace/useStudioSession';
import useTouchGestures from '~/workspace/useTouchGestures';
import CorrectionNudge from './CorrectionNudge';

export type LabelMode = 'positive' | 'negative';

type Props = {
  session: StudioSessionApi;
  mode: LabelMode;
  onModeChange: (mode: LabelMode) => void;
};

function useFittedBox(aspect: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({width: 0, height: 0});
  useLayoutEffect(() => {
    const el = ref.current;
    if (el == null) {
      return;
    }
    const fit = () => {
      const {clientWidth: w, clientHeight: h} = el;
      if (w <= 0 || h <= 0 || !(aspect > 0)) {
        return;
      }
      const width = Math.min(w, h * aspect);
      setBox({width: Math.floor(width), height: Math.floor(width / aspect)});
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);
  return {ref, box};
}

export default function Preview({session, mode, onModeChange}: Props) {
  const {bridge, meta, state, frame, status, statusError, start} = session;
  const aspect = meta.width > 0 && meta.height > 0 ? meta.width / meta.height : 16 / 9;
  const {ref, box} = useFittedBox(aspect);
  const [size] = useState(() => ({width: dim(meta.width), height: dim(meta.height)}));

  // Hand each canvas element to the worker once. If React ever replaces the
  // element (a remount, a hot reload), the new one is handed over too and the
  // frame redrawn; the session itself starts once per worker.
  const canvasRef = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      // flags live on the element and the bridge, so they survive a hot reload
      if (bridge == null || canvas == null || canvas.dataset.transferred === 'yes') {
        return;
      }
      canvas.dataset.transferred = 'yes';
      try {
        bridge.setCanvas(canvas);
      } catch {
        return; // already handed to a worker (only after a hot reload)
      }
      if (bridge.started) {
        bridge.goToFrame(bridge.frame);
      } else {
        bridge.started = true;
        start();
      }
    },
    [bridge, start],
  );

  const active = state.objects.find(o => o.id === state.activeId);
  const points = active?.points[frame] ?? [];

  // zoom and pan
  const [view, setView] = useState<View>(FIT);
  const boxRef = useRef(box);
  boxRef.current = box;
  const pan = useRef<{x: number; y: number; moved: boolean} | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (el == null) {
      return;
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const {width, height} = boxRef.current;
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        const px = e.clientX - (rect.left + rect.width / 2);
        const py = e.clientY - (rect.top + rect.height / 2);
        setView(v => zoomAt(v, Math.exp(-e.deltaY * 0.01), px, py, width, height));
      } else {
        setView(v => panBy(v, -e.deltaX, -e.deltaY, width, height));
      }
    };
    el.addEventListener('wheel', onWheel, {passive: false});
    return () => el.removeEventListener('wheel', onWheel);
  }, [ref]);

  const zoomBy = (factor: number) => setView(v => zoomAt(v, factor, 0, 0, box.width, box.height));

  function onPanStart(e: PointerEvent<HTMLDivElement>) {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      e.preventDefault();
      pan.current = {x: e.clientX, y: e.clientY, moved: false};
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  }
  function onPanMove(e: PointerEvent<HTMLDivElement>) {
    const p = pan.current;
    if (p == null) {
      return;
    }
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (Math.abs(dx) + Math.abs(dy) > 0) {
      p.moved = true;
    }
    pan.current = {x: e.clientX, y: e.clientY, moved: p.moved};
    setView(v => panBy(v, dx, dy, box.width, box.height));
  }
  function onPanEnd(e: PointerEvent<HTMLDivElement>) {
    if (pan.current != null) {
      suppressClick.current = pan.current.moved || e.altKey;
      pan.current = null;
    }
  }
  function clickOk(): boolean {
    const ok = !suppressClick.current;
    suppressClick.current = false;
    return ok;
  }

  function toPoint(event: MouseEvent<HTMLElement>): [number, number] {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
  }

  const primary: 0 | 1 = mode === 'positive' ? 1 : 0;

  // touch: a tap is the click layer's click; the rest is gestures
  const layerRef = useRef<HTMLDivElement>(null);
  const touch = useTouchGestures({
    zoomed: () => view.zoom > 1,
    canLongPress: longPressStartsOn,
    onLongPress: (x, y) => {
      const rect = layerRef.current?.getBoundingClientRect();
      const label = labelFor('long-press', primary);
      if (rect == null || rect.width <= 0 || label == null) {
        return;
      }
      const nx = (x - rect.left) / rect.width;
      const ny = (y - rect.top) / rect.height;
      if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) {
        session.addPoint(nx, ny, label);
      }
    },
    onPan: (dx, dy) => setView(v => panBy(v, dx, dy, box.width, box.height)),
    onPinch: ({factor, midX, midY, dx, dy}) => {
      const rect = ref.current?.getBoundingClientRect();
      if (rect == null) {
        return;
      }
      const px = midX - (rect.left + rect.width / 2);
      const py = midY - (rect.top + rect.height / 2);
      setView(v => panBy(zoomAt(v, factor, px, py, box.width, box.height), dx, dy, box.width, box.height));
    },
  });
  const r = 8; // screen pixels, at any zoom
  const stroke = 2;

  return (
    <div className="preview">
      <div className="preview-toolbar">
        <div className="points-toggle" role="group" aria-label="Click adds">
          <button
            className={mode === 'positive' ? 'toggle selected' : 'toggle'}
            disabled={session.noEngine}
            onClick={() => onModeChange('positive')}
            title="Left click adds a positive point (right click: negative)">
            <AddFilled size={18} className="icon-positive" /> Add
          </button>
          <button
            className={mode === 'negative' ? 'toggle selected' : 'toggle'}
            disabled={session.noEngine}
            onClick={() => onModeChange('negative')}
            title="Left click adds a negative point (right click: positive)">
            <SubtractFilled size={18} className="icon-negative" /> Remove
          </button>
        </div>
        <div className="preview-status">
          {active != null ? (
            <span className="chip">
              <span className="swatch" style={{background: active.color}} />
              {objectName(active)}
            </span>
          ) : (
            <span className="muted">
              {state.objects.length === 0 ? 'Click the video to add an object' : 'Select an object, or click to add one'}
            </span>
          )}
        </div>
        <div className="zoom-controls">
          <button className="icon-button" onClick={() => zoomBy(1 / 1.5)} disabled={view.zoom <= 1} title="Zoom out">
            <ZoomOut size={18} />
          </button>
          <button className="zoom-level" onClick={() => setView(FIT)} title="Fit (reset zoom)">
            {Math.round(view.zoom * 100)}%
          </button>
          <button className="icon-button" onClick={() => zoomBy(1.5)} title="Zoom in (or pinch, Ctrl/Cmd + wheel)">
            <ZoomIn size={18} />
          </button>
        </div>
      </div>
      <div
        className="stage"
        ref={ref}
        onPointerDown={onPanStart}
        onPointerMove={onPanMove}
        onPointerUp={onPanEnd}
        onAuxClick={e => e.preventDefault()}
        {...touch.handlers}>
        <div className="stage-frame" style={{width: box.width, height: box.height}}>
        <div
          className={view.zoom >= 2 ? 'stage-box pixelated' : 'stage-box'}
          style={{transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`}}>
          {bridge != null && (
            // width/height are set once: a canvas handed to a worker cannot be resized here
            <canvas ref={canvasRef} className="stage-canvas" width={size.width} height={size.height} />
          )}
          <div
            ref={layerRef}
            className={session.busy ? 'click-layer busy' : 'click-layer'}
            onClick={e => touch.allowsClick() && clickOk() && session.addPoint(...toPoint(e), primary)}
            onContextMenu={e => {
              e.preventDefault();
              if (touch.allowsContextMenu() && clickOk()) {
                session.addPoint(...toPoint(e), primary === 1 ? 0 : 1);
              }
            }}
          />
        </div>
          <svg className="points-layer" width={box.width} height={box.height}>
            {points.map((p, i) => {
              const {x: cx, y: cy} = toScreen(view, box.width, box.height, p[0], p[1]);
              const positive = p[2] === 1;
              return (
                <g
                  key={i}
                  className="point"
                  onClick={e => {
                    e.stopPropagation();
                    session.removePoint(i);
                  }}>
                  {/* a finger-sized target, on touch screens only (responsive.css) */}
                  <circle className="point-hit" cx={cx} cy={cy} r={22} />
                  <circle cx={cx} cy={cy} r={r} fill={positive ? '#000000' : '#E6193B'} strokeWidth={stroke} />
                  <line x1={cx - r / 2} y1={cy} x2={cx + r / 2} y2={cy} strokeWidth={stroke} />
                  {positive && <line x1={cx} y1={cy - r / 2} x2={cx} y2={cy + r / 2} strokeWidth={stroke} />}
                </g>
              );
            })}
          </svg>
        </div>
        <CorrectionNudge nudge={session.nudge} hint={session.hint} sam3Available={session.sam3Available} onTrim={() => session.nudgeTrim(() => onModeChange('positive'))} onSam3={session.nudgeSam3} onGone={session.markGone} />
        {status !== 'ready' && (
          <div className="stage-overlay">
            {status === 'failed' ? (
              <span className="error">Could not start a session: {statusError}</span>
            ) : (
              <span className="loading">
                <span className="spinner" /> Starting session…
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}


function dim(n: number): number {
  return n > 0 ? Math.round(n) : 1;
}
