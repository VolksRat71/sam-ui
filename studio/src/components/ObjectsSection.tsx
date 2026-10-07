// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The Objects list: one row per object with Meta's colour-block thumbnail,
// its track state, and its own Clear track / Remove actions. The selected
// object also has Undo / Redo (Cmd-Z / Shift-Cmd-Z), its kept track versions,
// and "Move these clicks to" for clicks on this frame that went to it by mistake.
// Objects can be dragged into another order and into named, coloured groups
// (issue #21); Alt-Up / Alt-Down, the arrow buttons and the Group menu do
// the same from the keyboard. The order is also the lanes' and the exports'.
// The selected object's row also takes a text prompt for the frame on screen
// (SAM 3 only; with another engine the field is disabled and says why).
import {
  Add,
  OverflowMenuHorizontal,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Edit,
  FolderAdd,
  Redo,
  TrashCan,
  Reset,
  Search,
  Undo,
  View,
  ViewOff,
} from '@carbon/icons-react';
import {trackPresentation} from './trackPresentation';
import {createPortal} from 'react-dom';
import {highlightEffects, moreEffects} from '@/common/components/effects/EffectsUtils';
import {useEffect, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode} from 'react';
import {OBJECT_LIMIT} from '~/config';
import {BROWSER_ENGINE, engineLabel, textPromptNote} from '~/state/engines';
import {NAME_MAX, objectName} from '~/state/fileNames';
import {moveTargets, parseCreated, undoBlock, versionLabel} from '~/state/history';
import {
  GROUP_NAME_MAX,
  MAX_GROUPS,
  arrange,
  layoutReducer,
  listItems,
  type DropTarget,
  type Layout,
  type LayoutAction,
  type ObjectGroup,
} from '~/state/layout';
import {
  clearTarget,
  groupDirtyIds,
  isTracking,
  seedFrames,
  type StudioObject,
} from '~/state/objects';
import type {StudioSessionApi} from '~/workspace/useStudioSession';

type Props = {session: StudioSessionApi; renderLane?: (o: StudioObject) => ReactNode; inspector?: HTMLElement | null};

function StateBadge({o}: {o: StudioObject}) {
  const track = trackPresentation(o.state, o.running);
  return <span className={`badge ${track.kind}`} title={track.detail}>{track.label}</span>;
}

/** After Enter / Escape closes a rename field, focus goes back to its pencil, or, when that is no Tab stop, to the lane or the group header's first shown control. */
function refocusAfterRename(pencil: HTMLButtonElement | null) {
  const shown = (e: Element) => e.getClientRects().length > 0;
  if (pencil == null) return;
  if (pencil.tabIndex >= 0 && shown(pencil)) pencil.focus();
  else (pencil.closest<HTMLElement>('[data-layer-option]') ?? [...(pencil.closest('.group-header')?.querySelectorAll<HTMLElement>('button, summary') ?? [])].find(shown))?.focus();
}

/** The object's name; double-click it, or the pencil, to rename in place. In a lane the pencil is no Tab stop (the lane's Enter opens the inspector's). */
function ObjectName({o, onRename, lane = false}: {o: StudioObject; onRename: (name: string) => void; lane?: boolean}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const done = useRef(false);
  const refocus = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const pencil = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    } else if (refocus.current) {
      refocus.current = false;
      refocusAfterRename(pencil.current);
    }
  }, [editing]);
  const start = () => {
    done.current = false;
    setDraft(o.name ?? objectName(o));
    setEditing(true);
  };
  const finish = (save: boolean, keyboard = false) => {
    if (done.current) {
      return; // Enter, then the blur it causes
    }
    done.current = true;
    refocus.current = keyboard;
    setEditing(false);
    if (save && draft.trim() !== (o.name ?? objectName(o))) {
      onRename(draft);
    }
  };
  if (editing) {
    return (
      <input
        ref={input}
        className="object-name-input"
        value={draft}
        maxLength={NAME_MAX}
        aria-label={`Rename ${objectName(o)}`}
        onClick={e => e.stopPropagation()}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={e => {
          e.stopPropagation(); // not the video's shortcuts
          if (e.key === 'Enter') {
            e.preventDefault(); // or its keypress clicks the pencil focus returns to
            finish(true, true);
          } else if (e.key === 'Escape') {
            finish(false, true);
          }
        }}
      />
    );
  }
  return (
    <span className="object-name">
      <span
        className="object-name-text"
        title="Double-click to rename"
        onDoubleClick={e => {
          e.stopPropagation();
          start();
        }}>
        {objectName(o)}
      </span>
      <button
        ref={pencil}
        tabIndex={lane ? -1 : undefined}
        className="icon-button small rename-button"
        title="Rename"
        aria-label={`Rename ${objectName(o)}`}
        onClick={e => {
          e.stopPropagation();
          start();
        }}>
        <Edit size={14} />
      </button>
    </span>
  );
}

/** The selected object's Undo / Redo, its kept versions, and moving this frame's clicks elsewhere. */
function HistoryControls({o, session}: {o: StudioObject; session: StudioSessionApi}) {
  const [open, setOpen] = useState(false);
  const {state, frame, busy} = session;
  const targets = moveTargets(state, o.id, frame);
  const versions = o.history.versions;
  // with a backend, the list restores the backend's versions; the browser's come back with undo
  const restorable = (engine: string) => !(session.backend && engine === BROWSER_ENGINE);
  const blocked = (which: 'undo' | 'redo') => {
    const why = undoBlock(o, which);
    return why != null && (isTracking(o) || session.pending === 0) ? why : null;
  };
  return (
    <div className="object-history" onClick={e => e.stopPropagation()}>
      <div className="object-actions">
        <button
          className="link-button"
          disabled={busy || blocked('undo') != null}
          onClick={() => session.stepSeeds('undo', o.id)}
          title={blocked('undo') ?? 'Undo the last click or range change (⌘Z); a kept track comes back with no re-track'}>
          <Undo size={14} /> Undo
        </button>
        <button
          className="link-button"
          disabled={busy || blocked('redo') != null}
          onClick={() => session.stepSeeds('redo', o.id)}
          title={blocked('redo') ?? 'Redo (⇧⌘Z)'}>
          <Redo size={14} /> Redo
        </button>
        <button
          className="link-button"
          aria-expanded={open}
          disabled={versions.length === 0}
          onClick={() => setOpen(v => !v)}
          title={versions.length === 0 ? 'No track of this object is kept yet' : 'Tracks kept for earlier clicks'}>
          Versions ({versions.length})
        </button>
      </div>
      {targets.length > 0 && (
        <label className="move-clicks">
          <span>Move these clicks to</span>
          <select
            value=""
            disabled={busy}
            aria-label={`Move ${objectName(o)}'s clicks on frame ${frame + 1} to another object`}
            onChange={e => e.target.value !== '' && session.moveClicks(Number(e.target.value))}>
            <option value="" disabled>
              object…
            </option>
            {targets.map(t => {
              const target = state.objects.find(x => x.id === t.id);
              return (
                <option key={t.id} value={t.id} disabled={t.blocked != null}>
                  {target != null ? objectName(target) : `Object ${t.id}`}
                  {t.blocked != null ? ` (${t.blocked})` : ''}
                </option>
              );
            })}
          </select>
        </label>
      )}
      {open && versions.length > 0 && (
        <ul className="version-list">
          {versions.map(v => (
            <li key={`${v.engine}:${v.key}`}>
              <button
                className={v.current ? 'version current' : 'version'}
                disabled={busy || v.current || isTracking(o) || !restorable(v.engine)}
                onClick={() => session.restoreVersion(o.id, v.key, v.engine)}
                title={
                  v.current
                    ? 'The clicks the object has now'
                    : !restorable(v.engine)
                      ? `${engineLabel(v.engine)} tracks come back with Undo`
                      : `Go back to these clicks and this track${parseCreated(v.created) != null ? `, tracked ${parseCreated(v.created)!.toLocaleString()}` : ''} (undoable)`
                }>
                <span>{versionLabel(v)}</span>
                {v.bounded && <span className="muted">around changed keyframes</span>}
                {v.current && <span className="badge tracked">current</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function describe(o: StudioObject): string {
  const clicked = seedFrames(o).filter(f => (o.points[f]?.length ?? 0) > 0);
  const texts = Object.entries(o.texts).map(([f, t]) => `"${t}" on frame ${Number(f) + 1}`);
  const clicks =
    clicked.length === 0
      ? texts.length === 0
        ? 'no clicks yet'
        : ''
      : `keyframes on ${clicked.length === 1 ? 'frame' : 'frames'} ${clicked.map(f => f + 1).join(', ')}`;
  const track = o.frames != null ? `track ${o.frames[0] + 1}–${o.frames[1] + 1}` : '';
  return [clicks, texts.join(', '), track].filter(x => x !== '').join(' · ');
}

/** "Find by text" for the selected object, on the frame on screen. */
function TextPrompt({o, session}: {o: StudioObject; session: StudioSessionApi}) {
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const {ok, why} = session.textSupport;
  const disabled = !ok || session.busy || running || isTracking(o);
  const submit = () => {
    const text = draft.trim();
    if (disabled || text === '') {
      return;
    }
    setRunning(true);
    setNote(null);
    void session.textPrompt(o.id, text).then(r => {
      setRunning(false);
      if (r != null) {
        setNote(textPromptNote(r));
      }
    });
  };
  return (
    <div className="text-prompt" onClick={e => e.stopPropagation()}>
      <form
        className="text-prompt-row"
        onSubmit={e => {
          e.preventDefault();
          submit();
        }}>
        <input
          className="text-prompt-input"
          value={draft}
          maxLength={200}
          placeholder={ok ? 'Find by text, e.g. dog' : 'Find by text (SAM 3)'}
          aria-label={`Find ${objectName(o)} by text on frame ${session.frame + 1}`}
          title={why ?? `Segment what these words describe on frame ${session.frame + 1}; its best match becomes this frame's mask`}
          disabled={disabled}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => e.stopPropagation()} // not the video's shortcuts
        />
        <button className="button small" type="submit" disabled={disabled || draft.trim() === ''}>
          {running ? <span className="spinner small" /> : <Search size={14} />} Find
        </button>
      </form>
      {why != null && <div className="object-meta text-prompt-why">{why}</div>}
      {why == null && note != null && <div className="object-meta">{note}</div>}
    </div>
  );
}

/** What is being dragged in the list: an object or a whole group. */
type Dragged = {kind: 'object'; id: number} | {kind: 'group'; id: string};
const DRAG_TYPE = 'application/x-sam-ui-layout';

function readDragged(e: DragEvent): Dragged | null {
  try {
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    return raw === '' ? null : (JSON.parse(raw) as Dragged);
  } catch {
    return null;
  }
}

/** Above or below the middle of the element under the pointer. */
function half(e: DragEvent): 'before' | 'after' {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientY < r.top + r.height / 2 ? 'before' : 'after';
}

/** Alt-Up / Alt-Down: the keyboard's way to reorder. */
function stepKey(e: KeyboardEvent): -1 | 1 | null {
  if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) {
    return null;
  }
  e.preventDefault();
  e.stopPropagation(); // not the video's shortcuts
  return e.key === 'ArrowUp' ? -1 : 1;
}

/** Whether a reorder would change anything (a move past the end does not). */
function moves(layout: Layout, action: LayoutAction): boolean {
  return JSON.stringify(layoutReducer(layout, action, layout.order)) !== JSON.stringify(layout);
}

/** The effects a group can give all of its members: the selected-object ones. */
const GROUP_EFFECTS = [...highlightEffects, ...moreEffects].filter(
  (e, i, all) => all.findIndex(x => x.effectName === e.effectName) === i,
);

function ObjectRow({
  o,
  session,
  layout,
  dragged,
  setDragged,
  renderLane,
  inspector,
}: {
  o: StudioObject;
  session: StudioSessionApi;
  layout: Layout;
  dragged: Dragged | null;
  setDragged: (d: Dragged | null) => void;
  renderLane?: (o: StudioObject) => ReactNode; inspector?: HTMLElement | null;
}) {
  const {state, busy} = session;
  const [drop, setDrop] = useState<'before' | 'after' | null>(null);
  const active = o.id === state.activeId;
  const group = layout.groups.find(g => g.members.includes(o.id)) ?? null;
  const stepAction = (dir: -1 | 1): LayoutAction => ({type: 'stepObject', id: o.id, dir});
  const step = (dir: -1 | 1) => session.layoutAction(stepAction(dir));
  const name = objectName(o);
  return (
    <li
      role="presentation"
      className={`object-row${active ? ' active' : ''}${drop != null ? ` drop-${drop}` : ''}${dragged?.kind === 'object' && dragged.id === o.id ? ' dragging' : ''}`}
      style={{'--lane-ink': o.color} as CSSProperties}
      draggable
      onDragStart={e => {
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({kind: 'object', id: o.id}));
        e.dataTransfer.effectAllowed = 'move';
        setDragged({kind: 'object', id: o.id});
      }}
      onDragEnd={() => setDragged(null)}
      onDragOver={e => {
        if (dragged == null || (dragged.kind === 'object' && dragged.id === o.id)) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        setDrop(half(e));
      }}
      onDragLeave={() => setDrop(null)}
      onDrop={e => {
        e.preventDefault();
        e.stopPropagation();
        setDrop(null);
        const d = readDragged(e) ?? dragged;
        setDragged(null);
        if (d == null) {
          return;
        }
        const where = half(e);
        if (d.kind === 'object') {
          const to: DropTarget = where === 'before' ? {before: o.id} : {after: o.id};
          session.layoutAction({type: 'moveObject', id: d.id, to});
        } else if (group == null || group.id !== d.id) {
          // a group dropped on an object goes before it (or before that object's group)
          session.layoutAction({type: 'moveGroup', groupId: d.id, before: {object: o.id}});
        }
      }}
      onClick={() => session.selectObject(active ? null : o.id)}>
      <div className="layer-controls">
        <div className="layer-summary" role="option" aria-selected={active} aria-label={`${name}, ${trackPresentation(o.state, o.running).label}`} data-layer-option={o.id} tabIndex={active ? 0 : -1}
          onKeyDown={e => {
            if (e.target !== e.currentTarget) return; // Enter on the rename pencil is the pencil's
            const dir = stepKey(e);
            if (dir != null) { step(dir); return; }
            if (e.key === 'Enter' && inspector != null) {
              e.preventDefault(); e.stopPropagation();
              session.selectObject(o.id);
              document.getElementById('tab-info')?.click();
              const header = document.querySelector<HTMLButtonElement>('[data-section="info"] .section-header');
              if (header?.getAttribute('aria-expanded') === 'false') header.click();
              requestAnimationFrame(() => {
                const controls = inspector.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled), summary, select:not(:disabled)');
                controls[0]?.focus();
              });
            }
          }}>
          <span className="layer-swatch" aria-hidden="true" />
          <ObjectName o={o} onRename={n => session.renameObject(o.id, n)} lane />
          <StateBadge o={o} />
          {active ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        </div>
        {active && <div className="layer-detail-summary">{describe(o)}</div>}
        {active && inspector != null && createPortal(<div className="object-body layer-details" onClick={e => e.stopPropagation()}>
          <div className="object-title"><ObjectName o={o} onRename={n => session.renameObject(o.id, n)} /></div>
          <div className="layer-color-control">
            <label>Mask color <input type="color" aria-label={`Mask color for ${name}`} value={o.color} onChange={e => session.setObjectColor(o.id, e.target.value)} /></label>
            <button className="button subtle compact" disabled={session.objectColors[o.id] == null} onClick={() => session.setObjectColor(o.id, null)}>Reset color</button>
            <span className="muted small">Saved for this clip in this browser.</span>
          </div>
        <div className="object-meta">{describe(o)}</div>
        {session.disagreement.get(o.id) != null && (
          <div
            className={session.disagreement.get(o.id)!.flagged.length > 0 ? 'object-hint' : 'object-meta'}
            title="Mask IoU between the SAM 2 and SAM 3 tracks; flagged frames are marked on the timeline">
            SAM 2 vs SAM 3: mean IoU {session.disagreement.get(o.id)!.meanIou?.toFixed(2) ?? '?'}
            {session.disagreement.get(o.id)!.flagged.length > 0
              ? ` · ${session.disagreement.get(o.id)!.flagged.length} frames disagree`
              : ' · they agree'}
          </div>
        )}
        {active && <TextPrompt o={o} session={session} />}
        {o.error != null && <div className="object-error">Track failed: {o.error}</div>}
        <details className="layer-history"><summary>Keyframe history and versions</summary><HistoryControls o={o} session={session} /></details>
        <div className="object-actions" onClick={e => e.stopPropagation()}>
          {(() => {
            const target = clearTarget(o, state.engine);
            const which =
              target == null
                ? 'track'
                : target.engine == null
                  ? 'all tracks'
                  : target.engine === state.engine && !target.others
                    ? 'track'
                    : `${engineLabel(target.engine)} track`;
            return (
              <button
                className="link-button"
                disabled={busy || target == null}
                onClick={() => target != null && session.clearTrack(o.id, target.engine)}
                title={
                  target == null
                    ? isTracking(o)
                      ? 'A track job holds this object'
                      : 'This object has no track to clear'
                    : `Forget this object's cached ${which}; its clicks stay`
                }>
                <Reset size={14} /> Clear {which}
              </button>
            );
          })()}
          <button
            className="link-button danger"
            disabled={busy || isTracking(o)}
            onClick={() => session.removeObject(o.id)}
            title="Remove the object, its clicks and its track">
            <TrashCan size={14} /> Remove
          </button>
          <span className="layout-actions">
            <button
              className="link-button"
              disabled={!moves(layout, stepAction(-1))}
              onClick={() => step(-1)}
              title="Move up (Alt-Up)"
              aria-label={`Move ${name} up`}>
              <ArrowUp size={14} />
            </button>
            <button
              className="link-button"
              disabled={!moves(layout, stepAction(1))}
              onClick={() => step(1)}
              title="Move down (Alt-Down)"
              aria-label={`Move ${name} down`}>
              <ArrowDown size={14} />
            </button>
            {layout.groups.length > 0 && (
              <select
                className="group-select"
                value={group?.id ?? ''}
                aria-label={`Group of ${name}`}
                title="The group this object is in"
                onChange={e => session.layoutAction({type: 'setGroup', id: o.id, groupId: e.target.value === '' ? null : e.target.value})}>
                <option value="">No group</option>
                {layout.groups.map(g => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            )}
          </span>
        </div>
      </div>, inspector)}
      </div>
      {renderLane?.(o)}
    </li>
  );
}

/** A group's name; double-click it, or the pencil, to rename in place. */
function GroupName({group, onRename}: {group: ObjectGroup; onRename: (name: string) => void}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const done = useRef(false);
  const refocus = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const pencil = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    } else if (refocus.current) {
      refocus.current = false;
      refocusAfterRename(pencil.current);
    }
  }, [editing]);
  const start = () => {
    done.current = false;
    setDraft(group.name);
    setEditing(true);
  };
  const finish = (save: boolean, keyboard = false) => {
    if (done.current) {
      return;
    }
    done.current = true;
    refocus.current = keyboard;
    setEditing(false);
    if (save && draft.trim() !== group.name) {
      onRename(draft);
    }
  };
  if (editing) {
    return (
      <input
        ref={input}
        className="object-name-input"
        value={draft}
        maxLength={GROUP_NAME_MAX}
        aria-label={`Rename group ${group.name}`}
        onClick={e => e.stopPropagation()}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={e => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault(); // or its keypress clicks the pencil focus returns to
            finish(true, true);
          } else if (e.key === 'Escape') {
            finish(false, true);
          }
        }}
      />
    );
  }
  return (
    <span className="object-name">
      <span className="object-name-text" title="Double-click to rename" onDoubleClick={start}>
        {group.name}
      </span>
      <button ref={pencil} className="icon-button small rename-button" title="Rename" aria-label={`Rename group ${group.name}`} onClick={start}>
        <Edit size={14} />
      </button>
    </span>
  );
}

function GroupBlock({
  group,
  session,
  layout,
  dragged,
  setDragged,
  renderLane,
  inspector,
}: {
  group: ObjectGroup;
  session: StudioSessionApi;
  layout: Layout;
  dragged: Dragged | null;
  setDragged: (d: Dragged | null) => void;
  renderLane?: (o: StudioObject) => ReactNode; inspector?: HTMLElement | null;
}) {
  const {state, busy} = session;
  const [drop, setDrop] = useState<'into' | 'before' | null>(null);
  const members = group.members.map(id => state.objects.find(o => o.id === id)).filter((o): o is StudioObject => o != null);
  const toTrack = groupDirtyIds(state, group.id);
  const clearable = members.filter(o => clearTarget(o, state.engine) != null);
  const anyHeld = members.some(isTracking);
  const stepAction = (dir: -1 | 1): LayoutAction => ({type: 'stepGroup', groupId: group.id, dir});
  const step = (dir: -1 | 1) => session.layoutAction(stepAction(dir));
  const count = `${members.length} ${members.length === 1 ? 'layer' : 'layers'}`;
  return (
    <li role="group" aria-label={group.name} className={`object-group${group.hidden ? ' hidden-group' : ''}`} style={{borderColor: group.color}}>
      <div
        className={`group-header${drop != null ? ` drop-${drop}` : ''}`}
        draggable
        onDragStart={e => {
          e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({kind: 'group', id: group.id}));
          e.dataTransfer.effectAllowed = 'move';
          setDragged({kind: 'group', id: group.id});
        }}
        onDragEnd={() => setDragged(null)}
        onDragOver={e => {
          if (dragged == null || (dragged.kind === 'group' && dragged.id === group.id)) {
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          setDrop(dragged.kind === 'object' ? 'into' : 'before');
        }}
        onDragLeave={() => setDrop(null)}
        onDrop={e => {
          e.preventDefault();
          e.stopPropagation();
          setDrop(null);
          const d = readDragged(e) ?? dragged;
          setDragged(null);
          if (d?.kind === 'object') {
            session.layoutAction({type: 'moveObject', id: d.id, to: {group: group.id}});
          } else if (d?.kind === 'group' && d.id !== group.id) {
            session.layoutAction({type: 'moveGroup', groupId: d.id, before: {group: group.id}});
          }
        }}>
        <div className="group-title">
          <button
            className="icon-button small"
            aria-expanded={!group.collapsed}
            aria-label={`${group.collapsed ? 'Expand' : 'Collapse'} group ${group.name}`}
            title={`${group.collapsed ? 'Expand' : 'Collapse'} (drag the header to move the group; Alt-Up / Alt-Down)`}
            onClick={() => session.updateGroup(group.id, {collapsed: !group.collapsed})}
            onKeyDown={e => {
              const dir = stepKey(e);
              if (dir != null) {
                step(dir);
              }
            }}>
            {group.collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
          </button>
          <span className="layer-swatch" style={{background: group.color}} aria-hidden="true" />
          <GroupName group={group} onRename={name => session.updateGroup(group.id, {name})} />
          <span className="muted small">{count}</span>
          <button
            className="icon-button small"
            aria-pressed={group.hidden}
            aria-label={`${group.hidden ? 'Show' : 'Hide'} group ${group.name} in the preview`}
            title={group.hidden ? 'Show in the preview' : 'Hide in the preview (exports keep it)'}
            onClick={() => session.updateGroup(group.id, {hidden: !group.hidden})}>
            {group.hidden ? <ViewOff size={16} /> : <View size={16} />}
          </button>
        </div>
        <details className="group-options"><summary aria-label={`Actions for ${group.name}`} title="Group actions"><OverflowMenuHorizontal size={16} /></summary><div className="object-actions group-actions">
          <input
            type="color"
            className="group-color"
            value={group.color}
            aria-label={`Colour of group ${group.name}`}
            title="Group colour"
            onChange={e => session.updateGroup(group.id, {color: e.target.value})}
          />

          <button
            className="link-button"
            disabled={busy || toTrack.length === 0}
            onClick={() => session.trackGroup(group.id)}
            title={toTrack.length === 0 ? 'No member is changed or untracked' : `Track the ${toTrack.length} changed or untracked ${toTrack.length === 1 ? 'member' : 'members'}`}>
            Track ({toTrack.length})
          </button>
          <button
            className="link-button"
            disabled={busy || clearable.length === 0}
            onClick={() => session.clearGroupTracks(group.id)}
            title="Forget the members' cached tracks; their clicks stay">
            <Reset size={14} /> Clear tracks
          </button>
          <select
            className="group-select"
            value=""
            disabled={members.length === 0}
            aria-label={`Give every member of ${group.name} an effect`}
            title="Give every member this effect"
            onChange={e => e.target.value !== '' && session.setGroupEffect(group.id, e.target.value)}>
            <option value="" disabled>
              Effect…
            </option>
            {GROUP_EFFECTS.map(fx => (
              <option key={fx.effectName} value={fx.effectName}>
                {fx.title}
              </option>
            ))}
          </select>
          <button
            className="link-button"
            disabled={!moves(layout, stepAction(-1))}
            onClick={() => step(-1)}
            aria-label={`Move group ${group.name} up`}
            title="Move the group up (Alt-Up)">
            <ArrowUp size={14} />
          </button>
          <button
            className="link-button"
            disabled={!moves(layout, stepAction(1))}
            onClick={() => step(1)}
            aria-label={`Move group ${group.name} down`}
            title="Move the group down (Alt-Down)">
            <ArrowDown size={14} />
          </button>
          <button
            className="link-button danger"
            disabled={anyHeld}
            onClick={() => session.layoutAction({type: 'removeGroup', groupId: group.id})}
            title="Delete the group; its objects stay, ungrouped">
            <TrashCan size={14} /> Ungroup
          </button>
        </div></details>
      </div>
      {!group.collapsed && (
        <ul className="object-list group-members" role="presentation">
          {members.map(o => (
            <ObjectRow key={o.id} o={o} session={session} layout={layout} dragged={dragged} setDragged={setDragged} renderLane={renderLane} inspector={inspector} />
          ))}
          {members.length === 0 && <li className="empty small">Drag objects here, or pick this group in an object's Group menu.</li>}
        </ul>
      )}
    </li>
  );
}

export default function ObjectsSection({session, renderLane, inspector}: Props) {
  const {state, canAdd} = session;
  const [groupFilter, setGroupFilter] = useState('');
  const [dragged, setDragged] = useState<Dragged | null>(null);
  const layout = arrange(state.layout, state.objects.map(o => o.id));
  const byId = new Map(state.objects.map(o => [o.id, o]));
  return (
    <div className="objects">
      <div className="objects-actions">
        <label className="group-filter">Show <select aria-label="Filter layers by group" value={groupFilter} onChange={e => setGroupFilter(e.target.value)}>
          <option value="">All layers</option>
          <option value="ungrouped">Ungrouped</option>
          {state.layout.groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select></label>
        <span className="objects-buttons">
          <button
            className="button"
            onClick={session.addObject}
            disabled={!canAdd}
            title={state.objects.length >= OBJECT_LIMIT ? `A video holds at most ${OBJECT_LIMIT} objects` : undefined}>
            <Add size={16} /> Add layer
          </button>
          <button
            className="button subtle"
            onClick={() => session.addGroup()}
            disabled={state.layout.groups.length >= MAX_GROUPS}
            title={
              state.layout.groups.length >= MAX_GROUPS
                ? `A video holds at most ${MAX_GROUPS} groups`
                : state.activeId != null
                  ? 'A new group holding the selected object'
                  : 'A new, empty group'
            }>
            <FolderAdd size={16} /> New group
          </button>
        </span>
      </div>
      {state.objects.length === 0 && (
        <p className="empty">
          {session.status !== 'ready' || session.repainting ? 'Loading layers…' : 'No layers yet. Click the footage to add one, or choose Add layer.'}
        </p>
      )}
      <ul className="object-list" role="listbox" aria-label="Layers" onKeyDown={e => {
        if (!(e.target instanceof HTMLElement) || !e.target.hasAttribute('data-layer-option') || e.altKey || e.ctrlKey || e.metaKey) return;
        const options = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-layer-option]')];
        const at = options.indexOf(e.target);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : e.key === 'ArrowDown' ? Math.min(options.length - 1, at + 1) : e.key === 'ArrowUp' ? Math.max(0, at - 1) : -1;
        if (next >= 0) { e.preventDefault(); e.stopPropagation(); session.selectObject(Number(options[next].dataset.layerOption)); options[next].focus(); }
        if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); session.selectObject(Number(e.target.dataset.layerOption)); }
      }} ref={el => {
        if (el != null) {
          const options = [...el.querySelectorAll<HTMLElement>('[data-layer-option]')];
          const selected = options.find(o => o.getAttribute('aria-selected') === 'true') ?? options[0];
          options.forEach(o => { o.tabIndex = o === selected ? 0 : -1; });
        }
      }}>
        {listItems(layout).filter(item => groupFilter === '' || (item.kind === 'group' ? item.group.id === groupFilter : groupFilter === 'ungrouped')).map(item =>
          item.kind === 'object' ? (
            byId.get(item.id) != null && (
              <ObjectRow key={item.id} o={byId.get(item.id)!} session={session} layout={layout} dragged={dragged} setDragged={setDragged} renderLane={renderLane} inspector={inspector} />
            )
          ) : (
            <GroupBlock key={item.group.id} group={item.group} session={session} layout={layout} dragged={dragged} setDragged={setDragged} renderLane={renderLane} inspector={inspector} />
          ),
        )}
      </ul>
      {dragged != null && (
        <div
          className="drop-end"
          onDragOver={e => e.preventDefault()}
          onDrop={e => {
            e.preventDefault();
            const d = readDragged(e) ?? dragged;
            setDragged(null);
            if (d?.kind === 'object') {
              session.layoutAction({type: 'moveObject', id: d.id, to: {end: true}});
            } else if (d?.kind === 'group') {
              session.layoutAction({type: 'moveGroup', groupId: d.id, before: null});
            }
          }}>
          Drop here: last, out of any group
        </div>
      )}
    </div>
  );
}
