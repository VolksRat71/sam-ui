// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The Objects list: one row per object with Meta's colour-block thumbnail,
// its track state, and its own Clear track / Remove actions. The selected
// object's row also takes a text prompt for the frame on screen (SAM 3 only;
// with another engine the field is disabled and says why).
import {Add, Edit, Search, TrashCan, Reset} from '@carbon/icons-react';
import {useEffect, useRef, useState} from 'react';
import {OBJECT_LIMIT} from '~/config';
import {engineLabel, textPromptNote} from '~/state/engines';
import {NAME_MAX, objectName} from '~/state/fileNames';
import {clearTarget, isTracking, needsPositiveClick, seedFrames, type StudioObject} from '~/state/objects';
import {maskedAt} from '~/state/segments';
import type {StudioSessionApi} from '~/workspace/useStudioSession';

type Props = {session: StudioSessionApi};

function StateBadge({o}: {o: StudioObject}) {
  if (isTracking(o)) {
    return (
      <span className="badge running">
        <span className="spinner small" /> tracking
      </span>
    );
  }
  return <span className={`badge ${o.state}`}>{o.state}</span>;
}

/** The object's name; double-click it, or the pencil, to rename in place. */
function ObjectName({o, onRename}: {o: StudioObject; onRename: (name: string) => void}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const done = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);
  const start = () => {
    done.current = false;
    setDraft(o.name ?? objectName(o));
    setEditing(true);
  };
  const finish = (save: boolean) => {
    if (done.current) {
      return; // Enter, then the blur it causes
    }
    done.current = true;
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
            finish(true);
          } else if (e.key === 'Escape') {
            finish(false);
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

function describe(o: StudioObject): string {
  const clicked = seedFrames(o).filter(f => (o.points[f]?.length ?? 0) > 0);
  const texts = Object.entries(o.texts).map(([f, t]) => `"${t}" on frame ${Number(f) + 1}`);
  const clicks =
    clicked.length === 0
      ? texts.length === 0
        ? 'no clicks yet'
        : ''
      : `clicks on ${clicked.length === 1 ? 'frame' : 'frames'} ${clicked.map(f => f + 1).join(', ')}`;
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

export default function ObjectsSection({session}: Props) {
  const {state, tracklets, frame, canAdd, busy} = session;
  // a badge per engine that could hold a track here (not the desktop-only entries of a browser-only build)
  const badgeEngines = session.engines.filter(e => e.href == null);
  return (
    <div className="objects">
      <div className="objects-actions">
        <button className="button" onClick={session.addObject} disabled={!canAdd}>
          <Add size={16} /> Add object
        </button>
        <span className="muted small">
          {state.objects.length} / {OBJECT_LIMIT}
        </span>
      </div>
      {state.objects.length === 0 && (
        <p className="empty">
          No objects yet. Click something in the video to add one, or press Add object first.
        </p>
      )}
      <ul className="object-list">
        {state.objects.map(o => {
          const t = tracklets.get(o.id);
          const active = o.id === state.activeId;
          return (
            <li
              key={o.id}
              className={active ? 'object-row active' : 'object-row'}
              onClick={() => session.selectObject(active ? null : o.id)}>
              <div className="thumb" style={{backgroundColor: o.color}}>
                {t?.thumbnail != null && (
                  <div className="thumb-image" style={{backgroundImage: `url(${t.thumbnail})`}} />
                )}
              </div>
              <div className="object-body">
                <div className="object-title">
                  <ObjectName o={o} onRename={name => session.renameObject(o.id, name)} />
                  <StateBadge o={o} />
                </div>
                <div className="object-meta">{describe(o)}</div>
                {badgeEngines.length > 1 && (
                  <div className="engine-badges">
                    {badgeEngines.map(e => {
                      const t = o.engines[e.name];
                      const st = t?.state ?? 'untracked';
                      return (
                        <span
                          key={e.name}
                          className={`engine-badge ${st}${e.name === state.engine ? ' current' : ''}`}
                          title={`${engineLabel(e.name)}: ${st}${t?.frames ? `, frames ${t.frames[0] + 1}-${t.frames[1] + 1}` : ''}`}>
                          {engineLabel(e.name)} {st}
                        </span>
                      );
                    })}
                  </div>
                )}
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
                {active && needsPositiveClick(o, frame, maskedAt(t?.segments, frame)) && (
                  <div className="object-hint">Add a positive click to keep part of the object</div>
                )}
                {o.error != null && <div className="object-error">Track failed: {o.error}</div>}
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
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
