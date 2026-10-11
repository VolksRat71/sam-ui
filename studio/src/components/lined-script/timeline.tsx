// sam-ui (Apache-2.0). New file, not from SAM 2.
import {ChevronDown, View, ViewOff} from '@carbon/icons-react';
import type {ButtonHTMLAttributes, CSSProperties, ReactNode} from 'react';
import {StudioButton} from './controls';
import {rangeGeometry} from './geometry';
import type {FrameRange} from '../../state/ranges';
import type {EffectClip} from '../../state/effectClips';

type InkProps = {color: string};
export type CoverageSpan = Pick<FrameRange, 'start' | 'end'> & {kind: 'holds' | 'absent' | 'unconfirmed'};
export function TimelineSurface({id, children}: {id?: string; children?: ReactNode}) {
  return <section id={id} className="ls-timeline" aria-label="Layer timeline">{children}</section>;
}
export function LayerRow({id, children, selected = false}: {id?: string; children?: ReactNode; selected?: boolean}) {
  return <div id={id} className="ls-layer-row" data-selected={selected}>{children}</div>;
}
export function TimelineText({id, children, muted = false, className = ''}: {id?: string; children: ReactNode; muted?: boolean; className?: string}) {
  return <span id={id} className={`ls-timeline-text ${muted ? 'ls-muted' : ''} ${className}`}>{children}</span>;
}
export function LayerVisibility({visible, ...props}: ButtonHTMLAttributes<HTMLButtonElement> & {visible: boolean}) {
  const Icon = visible ? View : ViewOff;
  return <StudioButton {...props} className="ls-layer-icon" aria-pressed={visible}><Icon size={18} aria-hidden="true" /></StudioButton>;
}
export function LayerMenu(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <StudioButton {...props} className="ls-layer-icon" aria-haspopup="menu"><ChevronDown size={14} aria-hidden="true" /></StudioButton>;
}
export function CoverageLine({id, color, spans, numFrames}: InkProps & {id?: string; spans: readonly CoverageSpan[]; numFrames: number}) {
  return <div id={id} className="ls-coverage" style={{'--matte-ink': color} as CSSProperties} role="img" aria-label={spans.map(s => `Frames ${s.start + 1}–${s.end + 1}: ${s.kind === 'holds' ? 'matte holds' : s.kind === 'absent' ? 'absent' : 'unconfirmed'}`).join('; ')}>
    {spans.map((span, i) => {
      const box = rangeGeometry(span, numFrames, 'inclusive');
      return <span key={i} className={`ls-coverage-span ls-coverage-${span.kind}`} style={{left: `${box.left}%`, width: `${box.width}%`}}>{span.kind === 'absent' && <svg width="100%" height="9" aria-hidden="true"><defs><pattern id={`${id}-wave-${i}`} width="16" height="9" patternUnits="userSpaceOnUse"><path d="M0 4.5 Q4 .5 8 4.5 T16 4.5" fill="none" stroke="currentColor" strokeWidth="1" /></pattern></defs><rect width="100%" height="9" fill={`url(#${id}-wave-${i})`} /></svg>}</span>;
    })}
  </div>;
}
export function CoverageCap({id, color, end = false}: InkProps & {id?: string; end?: boolean}) {
  return <span id={id} className={`ls-coverage-cap ${end ? 'ls-cap-end' : ''}`} style={{color}} aria-hidden="true" />;
}
export function Keyframe({color, frameIndex, ...props}: InkProps & ButtonHTMLAttributes<HTMLButtonElement> & {frameIndex: number}) {
  return <StudioButton {...props} className="ls-keyframe" aria-label={`Keyframe at frame ${frameIndex + 1}`} style={{color}}><svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path d="M9 2 16 9 9 16 2 9Z" fill="currentColor" stroke="#141517" strokeWidth="1" /></svg></StudioButton>;
}
export function LookClip({id, clip, numFrames, color, style, ...props}: InkProps & ButtonHTMLAttributes<HTMLButtonElement> & {clip: Pick<EffectClip, 'start' | 'end' | 'effect'>; numFrames: number}) {
  const box = rangeGeometry(clip, numFrames, 'exclusive');
  return <StudioButton id={id} {...props} className="ls-look-clip" aria-label={`${clip.effect}, frames ${clip.start + 1}–${clip.end}`} style={{...style, '--matte-ink': color, left: `${box.left}%`, width: `${box.width}%`} as CSSProperties}><span /></StudioButton>;
}
export function InspectionMark({src, layerName, frameIndex, ...props}: ButtonHTMLAttributes<HTMLButtonElement> & {src: string; layerName: string; frameIndex: number}) {
  return <StudioButton {...props} className="ls-inspection" aria-label={`Inspect ${layerName} matte at frame ${frameIndex + 1}`}><img src={src} alt="" /></StudioButton>;
}
export function FrameRuler({id, children}: {id?: string; children?: ReactNode}) {
  return <div id={id} className="ls-ruler" role="group" aria-label="Frame ruler">{children}</div>;
}
export function RulerTicks({id, numFrames, step = 5}: {id?: string; numFrames: number; step?: number}) {
  const count = Math.max(0, Math.ceil(numFrames / Math.max(1, step)));
  return <div id={id} className="ls-ruler-ticks" aria-hidden="true">{Array.from({length: count}, (_, i) => <span key={i} style={{left: `${i * Math.max(1, step) / numFrames * 100}%`, height: i % 5 === 0 ? '8px' : '5px'}} />)}</div>;
}
export function PlayheadLabel({frameIndex, ...props}: ButtonHTMLAttributes<HTMLButtonElement> & {frameIndex: number}) {
  return <StudioButton {...props} className="ls-playhead-label" aria-label={`Current frame ${frameIndex + 1}`}>{frameIndex + 1}</StudioButton>;
}
export function PlayheadLine({id}: {id?: string}) {
  return <span id={id} className="ls-playhead-line" aria-hidden="true" />;
}
