// sam-ui (Apache-2.0). Presentation adapter; existing components retain editing behavior.
import {useEffect, useState, type ReactNode} from 'react';
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
  return <main className="ls-kit lined-editor" aria-label="Rotoscoping workspace">
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
    <aside id="workspace-tools" className="lined-tools" hidden={!toolsOpen} aria-label="Workspace controls">
      <button className="button" onClick={() => setToolsOpen(false)}>Close workspace controls</button>
      {utilities}
      <details open><summary>Layer actions</summary><div ref={setInspector} /></details>
      <details><summary>Media</summary>{renderMedia(session.state.jobs.length > 0)}</details>
    </aside>
  </main>;
}
