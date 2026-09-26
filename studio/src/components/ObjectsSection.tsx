// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The Objects list: one row per object with Meta's colour-block thumbnail,
// its track state, and its own Clear track / Remove actions.
import {Add, Export, TrashCan, Reset} from '@carbon/icons-react';
import {OBJECT_LIMIT} from '~/config';
import {engineLabel} from '~/state/engines';
import {clearTarget, isTracking, needsPositiveClick, seedFrames, type StudioObject} from '~/state/objects';
import type {StudioSessionApi} from '~/workspace/useStudioSession';

type Props = {session: StudioSessionApi; onExport: () => void};

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

function describe(o: StudioObject): string {
  const seeds = seedFrames(o);
  const clicks =
    seeds.length === 0
      ? 'no clicks yet'
      : `clicks on ${seeds.length === 1 ? 'frame' : 'frames'} ${seeds.map(f => f + 1).join(', ')}`;
  const track = o.frames != null ? ` · track ${o.frames[0] + 1}–${o.frames[1] + 1}` : '';
  return clicks + track;
}

export default function ObjectsSection({session, onExport}: Props) {
  const {state, tracklets, frame, canAdd, busy} = session;
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
                  <span>Object {o.id + 1}</span>
                  <StateBadge o={o} />
                </div>
                <div className="object-meta">{describe(o)}</div>
                {session.engines.length > 1 && (
                  <div className="engine-badges">
                    {session.engines.map(e => {
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
                {active && needsPositiveClick(o, frame) && (
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
      <div className="objects-footer">
        <button
          className="button"
          onClick={onExport}
          disabled={!state.objects.some(o => o.state === 'tracked' || o.state === 'stale')}
          title="Write tracked objects as a rotoscoping working folder">
          <Export size={16} /> Export for rotoscoping…
        </button>
      </div>
    </div>
  );
}
