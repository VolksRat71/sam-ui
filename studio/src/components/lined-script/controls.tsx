// sam-ui (Apache-2.0). New file, not from SAM 2.
import {ChevronDown, ChevronRight, Launch, PlayFilledAlt, PauseFilled, SkipBackFilled, SkipForwardFilled, Upload, View, Screen} from '@carbon/icons-react';
import type {ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes, ReactNode, SelectHTMLAttributes} from 'react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;
export function StudioButton({className = '', children, ...props}: ButtonProps) {
  return <button type="button" {...props} className={`ls-button ${className}`}>{children}</button>;
}
export function Slate({id, children}: {id?: string; children?: ReactNode}) {
  return <header id={id} className="ls-slate">{children}</header>;
}
export function SlateText({id, children, timecode = false, className = ''}: {id?: string; children: ReactNode; timecode?: boolean; className?: string}) {
  return <span id={id} className={`${timecode ? 'ls-timecode' : 'ls-slate-text'} ${className}`}>{children}</span>;
}
export function TransportButton({action, playing = false, ...props}: ButtonProps & {action: 'previous' | 'play' | 'next'; playing?: boolean}) {
  const Icon = action === 'previous' ? SkipBackFilled : action === 'next' ? SkipForwardFilled : playing ? PauseFilled : PlayFilledAlt;
  return <StudioButton aria-label={action === 'play' ? (playing ? 'Pause' : 'Play') : `${action === 'previous' ? 'Previous' : 'Next'} frame`} {...props} className="ls-transport"><Icon size={30} aria-hidden="true" /></StudioButton>;
}
export function ExportButton(props: ButtonProps) {
  return <StudioButton aria-haspopup="menu" aria-expanded={false} {...props} className="ls-export"><Upload size={18} aria-hidden="true" />Export<ChevronDown size={14} aria-hidden="true" /></StudioButton>;
}
export function AELink(props: ButtonProps) {
  return <StudioButton {...props} className="ls-ae" aria-label="After Effects connection">AE<Launch size={14} aria-hidden="true" /></StudioButton>;
}
export function Disclosure({expanded, children, className = '', ...props}: ButtonProps & {expanded: boolean}) {
  const Icon = expanded ? ChevronDown : ChevronRight;
  return <StudioButton {...props} className={`ls-disclosure ${className}`} aria-expanded={expanded}><Icon size={14} aria-hidden="true" />{children}</StudioButton>;
}
export function Inspector({id, children}: {id?: string; children?: ReactNode}) {
  return <section id={id} className="ls-inspector" aria-label="Layer properties">{children}</section>;
}
export function FieldLabel({id, htmlFor, children}: {id?: string; htmlFor: string; children: ReactNode}) {
  return <label id={id} htmlFor={htmlFor} className="ls-field-label">{children}</label>;
}
export function NameField(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className="ls-field" type="text" />;
}
export function EnginePicker(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className="ls-field ls-engine"><option value="sam2">SAM 2</option><option value="sam3">SAM 3</option></select>;
}
export function StatusField({id, children}: {id?: string; children: ReactNode}) {
  return <output id={id} className="ls-field ls-status" aria-live="polite">{children}</output>;
}
export function MatteColor({color, ...props}: InputHTMLAttributes<HTMLInputElement> & {color: string}) {
  return <input {...props} type="color" value={color} className="ls-color" aria-label={props['aria-label'] ?? 'Matte colour'} />;
}
export function LookControl({color, children, ...props}: ButtonProps & {color: string}) {
  return <StudioButton {...props} className="ls-look-control"><View size={20} aria-hidden="true" /><Screen size={22} aria-hidden="true" /><span>{children}</span><span className="ls-look-swatch" style={{backgroundColor: color}} /><ChevronRight size={14} aria-hidden="true" /></StudioButton>;
}
export function TrackButton({loading = false, children, ...props}: ButtonProps & {loading?: boolean}) {
  return <StudioButton {...props} disabled={props.disabled || loading} aria-busy={loading} className="ls-track"><span className="ls-clapper" aria-hidden="true" /><PlayFilledAlt size={22} aria-hidden="true" />{children ?? (loading ? 'Tracking…' : 'Track')}</StudioButton>;
}
export function Rule({id, vertical = false}: {id?: string; vertical?: boolean}) {
  return <span id={id} aria-hidden="true" className={`ls-rule ${vertical ? 'ls-rule-vertical' : ''}`} />;
}
export function MatteSwatch({color, ...props}: ButtonProps & {color: string}) {
  return <StudioButton {...props} className="ls-swatch" style={{'--matte-ink': color} as CSSProperties}><span aria-hidden="true" /></StudioButton>;
}
