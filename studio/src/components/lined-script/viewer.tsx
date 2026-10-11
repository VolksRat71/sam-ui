// sam-ui (Apache-2.0). New file, not from SAM 2.
import {Overlay, Opacity, Crop, Contrast} from '@carbon/icons-react';
import {useRef, type ButtonHTMLAttributes, type PointerEvent, type ReactNode} from 'react';
import {StudioButton} from './controls';

type ViewMode = 'overlay' | 'alpha' | 'edge' | 'dim';
export function MatteViewButton({mode, active, ...props}: ButtonHTMLAttributes<HTMLButtonElement> & {mode: ViewMode; active: boolean}) {
  const Icon = {overlay: Overlay, alpha: Opacity, edge: Crop, dim: Contrast}[mode];
  const label = {overlay: 'Overlay', alpha: 'Alpha', edge: 'Edge', dim: 'Dim others'}[mode];
  return <StudioButton {...props} className="ls-view-mode" aria-pressed={active}><Icon size={24} aria-hidden="true" /><span>{label}</span></StudioButton>;
}
export function CameraGate({id, children}: {id?: string; children?: ReactNode}) {
  return <div id={id} className="ls-camera-gate">{children}</div>;
}
export function GateBracket({id, corner}: {id?: string; corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'}) {
  return <span id={id} className={`ls-gate-bracket ls-gate-${corner}`} aria-hidden="true" />;
}
/** The worker's live canvas remains the caller's child; review supplies an identified real still. */
export function FootageViewport({id, children, label}: {id?: string; children: ReactNode; label: string}) {
  return <div id={id} className="ls-footage" role="group" aria-label={label}>{children}</div>;
}
export function FrameThumbnail({id, children}: {id?: string; children?: ReactNode}) {
  return <div id={id} className="ls-frame-thumbnail" aria-hidden="true">{children}</div>;
}
export function Filmstrip({id, children, numFrames, frameIndex, onSeek}: {id?: string; children?: ReactNode; numFrames: number; frameIndex: number; onSeek: (frame: number) => void}) {
  const pointer = useRef<number | null>(null);
  const slider = useRef<HTMLDivElement>(null);
  const last = Math.max(0, numFrames - 1);
  const frame = Math.max(0, Math.min(last, frameIndex));
  function seekAt(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.min(Math.max(0, event.clientX - rect.left), rect.width);
    onSeek(rect.width <= 0 || numFrames <= 1 ? 0 : Math.round(x / rect.width * last));
  }
  function stopDrag(event: PointerEvent<HTMLDivElement>) {
    if (pointer.current !== event.pointerId) return;
    pointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return <div id={id} className="ls-filmstrip" role="group" aria-label="Filmstrip"
    onPointerDown={event => {
      if (numFrames < 1 || event.button !== 0 || pointer.current !== null || (event.target instanceof Element && event.target.closest('button'))) return;
      pointer.current = event.pointerId;
      slider.current?.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      seekAt(event);
    }}
    onPointerMove={event => {if (pointer.current === event.pointerId) seekAt(event);}}
    onPointerUp={stopDrag}
    onPointerCancel={stopDrag}
    onLostPointerCapture={event => {if (pointer.current === event.pointerId) pointer.current = null;}}
    onKeyDown={event => {
      if (numFrames < 1 || event.target !== slider.current) return;
      let next: number;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = frame - 1;
      else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = frame + 1;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = last;
      else return;
      event.preventDefault();
      event.stopPropagation();
      onSeek(Math.max(0, Math.min(last, next)));
    }}>{children}<div ref={slider} className="ls-filmstrip-scrub" role="slider" aria-label="Footage playhead" aria-orientation="horizontal" aria-valuemin={1} aria-valuemax={Math.max(1, numFrames)} aria-valuenow={frame + 1} aria-valuetext={numFrames > 0 ? `Frame ${frame + 1} of ${numFrames}` : 'No clip loaded'} aria-disabled={numFrames < 1} tabIndex={numFrames > 0 ? 0 : -1} /></div>;
}
export function Sprockets({id}: {id?: string}) {
  return <div id={id} className="ls-sprockets" aria-hidden="true">{Array.from({length: 83}, (_, i) => <span key={i} />)}</div>;
}
export function FilmstripPlayhead({id, frameIndex, numFrames}: {id?: string; frameIndex: number; numFrames: number}) {
  const left = numFrames <= 1 ? 0 : Math.max(0, Math.min(numFrames - 1, frameIndex)) / (numFrames - 1) * 100;
  return <span id={id} className="ls-filmstrip-playhead" style={{left: `min(${left}%, calc(100% - 2px))`}} aria-hidden="true" />;
}
