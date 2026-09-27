// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The one Export menu in the top bar:
//   - Masks: mask videos (.zip), or the PNG / roto working folder (the
//     backend writes it for server tracks; studio zips it for browser tracks
//     or with no backend);
//   - Vector JSON (.zip): outlines per frame, contours.py's format;
//   - Export to After Effects: not yet (disabled, and says why);
//   - and the video with effects, as before.
// The mask items take every object with a track on the engine on screen.
import {ChevronDown, Download} from '@carbon/icons-react';
import {useEffect, useRef, useState} from 'react';
import {BROWSER_ENGINE, RELEASES_URL} from '~/state/engines';
import type {StudioSessionApi} from '~/workspace/useStudioSession';

export type ExportChoice = 'videos' | 'folder' | 'vectors' | 'effects';

type Props = {session: StudioSessionApi; onChoose: (c: ExportChoice) => void};

/** A menu item that cannot be used yet: why on hover or focus, with a link when there is one. */
function Unavailable({label, why, href}: {label: string; why: string; href?: string}) {
  return (
    <div className="menu-item disabled engine-off" tabIndex={0} aria-disabled="true">
      <span>{label}</span>
      <span className="engine-tip" role="tooltip">
        {why}
        {href != null && (
          <>
            {' '}
            <a href={href} target="_blank" rel="noreferrer">
              Get it
            </a>
          </>
        )}
      </span>
    </div>
  );
}

export default function ExportMenu({session, onChoose}: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const {state, meta} = session;
  const tracked = state.objects.filter(o => o.state === 'tracked' || o.state === 'stale').length;

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (e: MouseEvent) => root.current != null && !root.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (c: ExportChoice) => {
    setOpen(false);
    onChoose(c);
  };
  const noTracks = tracked === 0 ? 'Track an object first' : undefined;
  const folderHow =
    !session.backend || state.engine === BROWSER_ENGINE
      ? 'A zip of the working folder, built in the browser'
      : 'Written by the backend, under its export root';

  return (
    <div className="export-menu" ref={root}>
      <button className="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)} disabled={!meta.decoded}>
        <Download size={16} /> Export <ChevronDown size={16} />
      </button>
      {open && (
        <div className="engine-menu menu" role="menu">
          <div className="menu-heading">Masks{tracked > 0 ? ` · ${tracked} ${tracked === 1 ? 'object' : 'objects'}` : ''}</div>
          <button className="menu-item" role="menuitem" disabled={tracked === 0} title={noTracks} onClick={() => choose('videos')}>
            <span>Mask videos (.zip)</span>
            <span className="muted">one black and white MP4 per object</span>
          </button>
          <button className="menu-item" role="menuitem" disabled={tracked === 0} title={noTracks ?? folderHow} onClick={() => choose('folder')}>
            <span>PNG sequence / roto working folder</span>
            <span className="muted">{folderHow.toLowerCase()}</span>
          </button>
          <div className="menu-sep" />
          <button className="menu-item" role="menuitem" disabled={tracked === 0} title={noTracks} onClick={() => choose('vectors')}>
            <span>Vector JSON (.zip)</span>
            <span className="muted">outlines per frame, for After Effects masks</span>
          </button>
          {session.backend ? (
            <Unavailable label="Export to After Effects" why="Coming soon, via the AE MCP." />
          ) : (
            <Unavailable label="Export to After Effects" why="Needs the desktop app." href={RELEASES_URL} />
          )}
          <div className="menu-sep" />
          <button className="menu-item" role="menuitem" onClick={() => choose('effects')}>
            <span>Video with effects (.mp4)</span>
            <span className="muted">the preview as you see it, rendered</span>
          </button>
        </div>
      )}
    </div>
  );
}
