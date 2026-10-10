// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// One target's effect clips (a layer's, or the background's) as a band under
// its timeline row: a labelled block per clip, on its frames. Overlapping
// clips stack, the one drawn on top shown higher (clipLines); clips that do
// not overlap share a line, so the band stays short. Click selects; drag the
// body to move, either end to trim, snapping to whole frames. From the
// keyboard: Left / Right go to the previous / next clip, Alt Left / Right
// move it a frame (Shift: ten), Alt [ / Alt ] trim its start / end to the
// playhead (After Effects' keys), Alt Up / Down move it up / down its layer's
// stack, Delete removes it, Enter opens its settings, Escape drops the
// selection (S and D, split and duplicate, are the window's). One Tab stop per band.
import {useRef, type CSSProperties, type KeyboardEvent, type PointerEvent} from 'react';
import {type EffectClip, clipLines} from '~/state/effectClips';
import type {StudioSessionApi} from '~/workspace/useStudioSession';
import {clipFrames, clipTitle} from './effectPresentation';

type Props = {
  clips: EffectClip[];
  name: string;
  session: StudioSessionApi;
  pos: (frame: number) => number;
};

type Drag = {id: string; edge: 'move' | 'start' | 'end'; from: number; start: number; x: number; moved: boolean; step: string; last: number};

/** The Effects dock's settings for the selected clip, opened and focused (Enter on a clip). */
function openSettings() {
  document.getElementById('tab-effects')?.click();
  const header = document.querySelector<HTMLButtonElement>('[data-section="effects"] .section-header');
  if (header?.getAttribute('aria-expanded') === 'false') header.click();
  requestAnimationFrame(() => (document.querySelector<HTMLElement>('.fx-settings input:not(:disabled)') ?? document.querySelector<HTMLElement>('.fx-settings button:not(:disabled)'))?.focus());
}

export default function EffectClipBand({clips, name, session, pos}: Props) {
  const {frame, selectedClipId} = session;
  const n = session.meta.numFrames;
  const band = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const {line, count} = clipLines(clips);
  const ordered = [...clips].sort((a, b) => a.start - b.start || (line.get(a.id) ?? 0) - (line.get(b.id) ?? 0));
  const stop = ordered.find(c => c.id === selectedClipId) ?? ordered[0];

  const frameAt = (clientX: number) => {
    const rect = band.current?.getBoundingClientRect();
    if (rect == null || rect.width <= 0 || n <= 1) return 0;
    return Math.round((Math.min(Math.max(0, clientX - rect.left), rect.width) / rect.width) * (n - 1));
  };
  const select = (c: EffectClip) => {
    if (c.target.kind === 'object' && c.target.id !== session.state.activeId) session.selectObject(c.target.id);
    session.selectClip(c.id);
  };
  const focusClip = (id: string) => band.current?.querySelector<HTMLElement>(`[data-clip="${id}"]`)?.focus();

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>, c: EffectClip) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    select(c);
    e.currentTarget.focus(); // Safari does not focus a clicked button: Delete and the arrows need it
    const edge = ((e.target as HTMLElement).dataset.edge as Drag['edge'] | undefined) ?? 'move';
    drag.current = {id: c.id, edge, from: frameAt(e.clientX), start: c.start, x: e.clientX, moved: false, step: `${c.id}:drag:${e.timeStamp}`, last: NaN};
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (d == null || (!d.moved && Math.abs(e.clientX - d.x) < 3)) return;
    d.moved = true;
    const f = frameAt(e.clientX);
    const to = d.edge === 'move' ? d.start + (f - d.from) : d.edge === 'start' ? f : f + 1;
    if (to === d.last) return;
    d.last = to;
    if (d.edge === 'move') session.moveClip(d.id, to, d.step);
    else session.trimClip(d.id, d.edge, to, d.step);
  };
  const endDrag = (e: PointerEvent<HTMLButtonElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, c: EffectClip) => {
    if (e.metaKey || e.ctrlKey) return; // Cmd-Z and the like stay the window's
    const at = ordered.indexOf(c);
    const go = (to: EffectClip | undefined) => {
      if (to != null) { select(to); focusClip(to.id); }
    };
    let handled = true;
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      session.moveClip(c.id, c.start + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1), `${c.id}:nudge`);
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      session.reorderClip(c.id, e.key === 'ArrowUp' ? 'up' : 'down');
    } else if (e.altKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
      if (e.code === 'BracketLeft') session.trimClip(c.id, 'start', frame);
      else session.trimClip(c.id, 'end', frame + 1);
    } else if (e.altKey) {
      handled = false;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      go(ordered[at + (e.key === 'ArrowRight' ? 1 : -1)]);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      const next = ordered[at + 1] ?? ordered[at - 1];
      session.removeClip(c.id);
      if (next != null) requestAnimationFrame(() => focusClip(next.id));
    } else if (e.key === 'Enter') {
      select(c);
      openSettings();
    } else if (e.key === 'Escape') {
      session.selectClip(null);
    } else {
      handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  return (
    <div className="fx-band" ref={band} role="group" aria-label={`${name} effect clips`} style={{'--fx-lines': count} as CSSProperties} onClick={e => e.stopPropagation()}>
      {n > 0 && <div className="playhead" style={{left: pos(frame)}} />}
      {ordered.map(c => {
        const selected = c.id === selectedClipId;
        const left = pos(c.start);
        const label = `${clipTitle(c)}, ${clipFrames(c)}${frame >= c.start && frame < c.end ? ', on this frame' : ''}`;
        return (
          <button
            key={c.id}
            type="button"
            data-clip={c.id}
            className={`fx-clip${selected ? ' selected' : ''}`}
            tabIndex={c === stop ? 0 : -1}
            aria-pressed={selected}
            aria-label={`${name}: ${label}`}
            aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+BracketLeft Alt+BracketRight Alt+ArrowUp Alt+ArrowDown S D Delete Enter"
            title={`${label}. Drag to move, drag an end to trim; Alt+Left / Right move a frame, Alt+[ / Alt+] trim to the playhead, Alt+Up / Down change the stack order, S splits at the playhead, D duplicates`}
            style={{left, width: Math.max(8, pos(c.end - 1) - left), top: `calc(${line.get(c.id) ?? 0} * var(--fx-line))`}}
            // the layer row is draggable (reorder): a native drag from here would cancel this pointer
            onMouseDown={e => e.preventDefault()}
            onPointerDown={e => onPointerDown(e, c)}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={e => onKeyDown(e, c)}>
            <span className="fx-clip-handle" data-edge="start" aria-hidden="true" />
            <span className="fx-clip-name">{clipTitle(c)}</span>
            <span className="fx-clip-handle" data-edge="end" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
