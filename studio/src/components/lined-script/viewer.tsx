// sam-ui (Apache-2.0). New file, not from SAM 2.
import {Overlay, Opacity, Crop, Contrast} from '@carbon/icons-react';
import type {ButtonHTMLAttributes, ReactNode} from 'react';
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
export function FrameThumbnail({id, frameIndex, current, children, ...props}: ButtonHTMLAttributes<HTMLButtonElement> & {frameIndex: number; current: boolean}) {
  return <StudioButton id={id} {...props} className="ls-frame-thumbnail" aria-label={`Go to frame ${frameIndex + 1}`} aria-current={current ? 'true' : undefined}>{children}</StudioButton>;
}
export function Filmstrip({id, children}: {id?: string; children?: ReactNode}) {
  return <nav id={id} className="ls-filmstrip" aria-label="Footage frames">{children}</nav>;
}
export function Sprockets({id}: {id?: string}) {
  return <div id={id} className="ls-sprockets" aria-hidden="true">{Array.from({length: 83}, (_, i) => <span key={i} />)}</div>;
}
export function CurrentFrameOutline({id}: {id?: string}) {
  return <span id={id} className="ls-frame-outline" aria-hidden="true" />;
}
