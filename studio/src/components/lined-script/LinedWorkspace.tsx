// sam-ui (Apache-2.0). Presentation adapter; existing components retain editing behavior.
import {useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode} from 'react';
import {readJson, writeJson} from '../../lib/storage';
import {clampPanelLayout, DEFAULT_PANEL_LAYOUT, panelLimits, type PanelLayout} from './panelLayout';
import {isAeVideo} from '../../state/aeBridge';
import {objectName, NAME_MAX} from '../../state/fileNames';
import type {StudioSessionApi} from '../../workspace/useStudioSession';
import EnginePicker from '../EnginePicker';
import EffectsSection from '../EffectsSection';
import ExportMenu, {type ExportChoice} from '../ExportMenu';
import Preview, {type LabelMode} from '../Preview';
import Timeline from '../Timeline';
import {trackPresentation} from '../trackPresentation';
import {effectTitle} from '../effectPresentation';
import {SlateText, TransportButton, AELink, Disclosure, FieldLabel, NameField, StatusField, MatteColor, LookControl, TrackButton, Rule} from './controls';
import {GateBracket, MatteViewButton} from './viewer';
import {formatTimecode} from './geometry';
import LiveFilmstrip from './LiveFilmstrip';
import './lined-script.css';
import './filmstrip.css';
import './hero-layout.css';
import './lined-live.css';

type Props = {session: StudioSessionApi; videoPath: string; videoName: string; mode: LabelMode; onModeChange: (mode: LabelMode) => void; onExport: (choice: ExportChoice) => void; utilities: ReactNode; renderMedia: (locked: boolean) => ReactNode};
export default function LinedWorkspace({session, videoPath, videoName, mode, onModeChange, onExport, utilities, renderMedia}: Props) {
  const workspace = useRef<HTMLElement>(null);
  const drag = useRef<{axis: keyof PanelLayout; pointer: number; origin: number; value: number} | null>(null);
  const [bounds, setBounds] = useState({width: 1600, height: 1000});
  const [layout, setLayout] = useState(DEFAULT_PANEL_LAYOUT);
  const [layoutReady, setLayoutReady] = useState(false);
  useEffect(() => {
    const element = workspace.current;
    if (element == null) return;
    let initial = true;
    const resize = () => {
      const stored = initial ? readJson('sam-ui-lined:panels', DEFAULT_PANEL_LAYOUT) : undefined;
      initial = false;
      const next = {width: element.clientWidth, height: element.clientHeight};
      setBounds(next);
      setLayout(current => clampPanelLayout(stored === undefined ? current : stored, next.width, next.height));
      setLayoutReady(true);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {if (layoutReady) writeJson('sam-ui-lined:panels', layout);}, [layout, layoutReady]);
  const limits = panelLimits(bounds.width, bounds.height);
  const updateLayout = (axis: keyof PanelLayout, value: number) => setLayout(current => clampPanelLayout({...current, [axis]: value}, bounds.width, bounds.height));
  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const separator = (axis: keyof PanelLayout) => {
    const columns = axis === 'columns';
    const base = columns ? .7438 : .51;
    return <div className={`lined-panel-divider ${columns ? 'lined-panel-columns' : 'lined-panel-rows'}`} role="separator" tabIndex={0}
      aria-label={columns ? 'Resize viewer and inspector' : 'Resize workspace and timeline'} aria-orientation={columns ? 'vertical' : 'horizontal'}
      aria-controls={columns ? 'viewer inspector' : 'viewer inspector filmstrip timeline'} aria-valuemin={Math.round((base + Math.min(0, limits[axis].min)) * 100)} aria-valuemax={Math.round((base + Math.max(0, limits[axis].max)) * 100)} aria-valuenow={Math.round((base + layout[axis]) * 100)}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {axis, pointer: event.pointerId, origin: columns ? event.clientX : event.clientY, value: layout[axis]};
      }} onPointerMove={event => {
        const active = drag.current;
        if (active == null || active.axis !== axis || active.pointer !== event.pointerId) return;
        updateLayout(axis, active.value + ((columns ? event.clientX : event.clientY) - active.origin) / (columns ? bounds.width : bounds.height));
      }} onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={() => {drag.current = null;}}
      onDoubleClick={() => updateLayout(axis, 0)} onKeyDown={event => {
        const negative = columns ? 'ArrowLeft' : 'ArrowUp', positive = columns ? 'ArrowRight' : 'ArrowDown';
        const step = (event.shiftKey ? 40 : 10) / (columns ? bounds.width : bounds.height);
        let value: number;
        if (event.key === negative) value = layout[axis] - step;
        else if (event.key === positive) value = layout[axis] + step;
        else if (event.key === 'Home') value = limits[axis].min;
        else if (event.key === 'End') value = limits[axis].max;
        else if (event.key === 'Enter' || event.key === 'Escape') value = 0;
        else return;
        event.preventDefault(); event.stopPropagation(); updateLayout(axis, value);
      }} />;
  };
  const [toolsOpen, setToolsOpen] = useState(false);
  const [looksOpen, setLooksOpen] = useState(false);
  const [inspector, setInspector] = useState<HTMLDivElement | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  useEffect(() => {setNameDraft(null);}, [session.state.activeId]);
  const selected = session.state.objects.find(o => o.id === session.state.activeId);
  const clips = session.effectDoc?.clips.filter(c => c.target.kind === 'object' && c.target.id === selected?.id) ?? [];
  const clip = clips.find(c => c.id === session.selectedClipId) ?? clips.find(c => session.frame >= c.start && session.frame < c.end) ?? clips[0];
  const status = selected == null ? 'Select a layer' : trackPresentation(selected.state, selected.running).label;
  const color = selected?.color ?? '#b3b4b6';
  const saveName = () => {if (selected != null && nameDraft != null) session.renameObject(selected.id, nameDraft); setNameDraft(null);};
  return <main ref={workspace} className="ls-kit lined-editor" aria-label="Rotoscoping workspace" data-panels-resized={layout.columns !== 0 || layout.rows !== 0}
    style={{'--lined-column-delta': `${layout.columns * 100}cqw`, '--lined-row-delta': `${layout.rows * 100}cqh`} as CSSProperties}>
    <header id="slate" className="ls-slate">
      <button id="app-name" className="lined-brand" onClick={() => setToolsOpen(open => !open)} aria-expanded={toolsOpen} aria-controls="workspace-tools">sam-ui studio</button>
      <SlateText id="clip-name" className="ls-slate-clip">{videoName.replace(/\.mp4$/i, '')}</SlateText>
      <SlateText id="clip-size">{session.meta.width} x {session.meta.height}</SlateText>
      <SlateText id="clip-fps">{Number(session.meta.fps.toFixed(3))} fps</SlateText>
      <SlateText id="clip-length">{session.meta.numFrames} frames</SlateText>
      <span id="current-frame" className="ls-slate-text frame-counter">Frame <strong>{session.meta.numFrames > 0 ? session.frame + 1 : 0}</strong></span>
      {isAeVideo(videoPath) && <AELink id="ae-link" onClick={() => onExport('ae')} />}
      <SlateText id="timecode" timecode>{formatTimecode(session.frame, session.meta.fps)}</SlateText>
      <TransportButton id="transport-previous" action="previous" onClick={() => session.seek(session.frame - 1)} disabled={session.meta.numFrames === 0} />
      <TransportButton id="transport-play" action="play" playing={session.playing} onClick={session.togglePlay} disabled={session.meta.numFrames === 0} />
      <TransportButton id="transport-next" action="next" onClick={() => session.seek(session.frame + 1)} disabled={session.meta.numFrames === 0} />
      <ExportMenu session={session} videoPath={videoPath} onChoose={onExport} lined />
      {[258, 444, 555, 627, 735, 850, 1211].map(x => <Rule key={x} id={`slate-rule-${x}`} vertical />)}
    </header>
    <section id="viewer" className="lined-viewer" aria-label="Camera gate">
      <Preview session={session} mode={mode} onModeChange={onModeChange} presentation="lined" />
      {(['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map(corner => <GateBracket key={corner} id={`gate-${corner}`} corner={corner} />)}
    </section>
    <section id="inspector" className="ls-inspector" aria-label="Layer properties">
      {(['overlay', 'alpha', 'edge'] as const).map(view => <MatteViewButton id={`view-${view}`} key={view} mode={view} active={session.matteView === view} disabled={view !== 'overlay' && selected == null} onClick={() => session.setMatteView(view)} />)}
      <MatteViewButton id="view-dim" mode="dim" active={false} disabled title="A precise outside-matte dim view is still being completed." />
      <Disclosure id="layer-heading" expanded onClick={() => setToolsOpen(true)}>Layer</Disclosure>
      <FieldLabel id="name-label" htmlFor="layer-name">Name</FieldLabel>
      <NameField id="layer-name" aria-label="Layer name" disabled={selected == null} maxLength={NAME_MAX} value={nameDraft ?? (selected == null ? '' : objectName(selected))} onChange={event => setNameDraft(event.target.value)} onBlur={saveName} onKeyDown={event => {if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') setNameDraft(null);}} />
      <FieldLabel id="status-label" htmlFor="layer-status">Status</FieldLabel><StatusField id="layer-status">{status}</StatusField>
      <FieldLabel id="matte-color-label" htmlFor="matte-color">Matte colour</FieldLabel><MatteColor id="matte-color" color={color} disabled={selected == null} onChange={event => selected != null && session.setObjectColor(selected.id, event.target.value)} />
      <div className="lined-looks" data-section="effects">
        <Disclosure id="looks-heading" className="section-header" expanded={looksOpen} onClick={() => setLooksOpen(open => !open)}>Looks ({clips.length})</Disclosure>
        <LookControl id="look-outline" color={color} disabled={selected == null} onClick={() => {if (clip != null) session.selectClip(clip.id); setLooksOpen(true);}}>{clip == null ? 'Add a Look' : effectTitle(clip.target, clip.effect)}</LookControl>
        <div id="tab-effects" hidden={!looksOpen} className="lined-look-popover"><EffectsSection session={session} /></div>
      </div>
      <Disclosure id="tracking-heading" expanded onClick={() => setToolsOpen(true)}>Tracking</Disclosure>
      <FieldLabel id="engine-label" htmlFor="engine-picker">Engine</FieldLabel><div id="engine-picker"><EnginePicker session={session} /></div>
      <TrackButton id="track" loading={session.busy} disabled={session.dirty.length === 0} title={session.dirty.length === 0 ? 'Nothing to track' : `Track ${session.dirty.length} changed or untracked layers`} onClick={session.track}>Track</TrackButton>
      {[139, 322, 429].map(y => <Rule id={`inspector-rule-${y}`} key={y} />)}
    </section>
    <LiveFilmstrip session={session} />
    <section id="timeline" className="lined-timeline" aria-label="Layers and exact frame coverage"><Timeline session={session} inspector={inspector} presentation="lined" toolsOpen={toolsOpen} /></section>
    {separator('columns')}{separator('rows')}
    <aside id="workspace-tools" className="lined-tools" hidden={!toolsOpen} aria-label="Workspace controls">
      <button className="button" onClick={() => setToolsOpen(false)}>Close workspace controls</button>
      <button className="button" onClick={() => setLayout(DEFAULT_PANEL_LAYOUT)}>Reset panel sizes</button>
      {utilities}
      <details open><summary>Layer actions</summary><div ref={setInspector} /></details>
      <details><summary>Media</summary>{renderMedia(session.state.jobs.length > 0)}</details>
    </aside>
  </main>;
}
