// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The engine picker beside Track: which engine Track runs and the preview
// shows. A disabled engine says why on hover or focus, and links to where to
// get it when it has somewhere to go (a Pages build's SAM 3 entry points at
// the desktop release). With the browser engine chosen, its model size
// (512 fp16 or 1024 fp32) and hole fill sit next to it.
import {BROWSER_ENGINE, engineLabel} from '~/state/engines';
import {type Quality, VARIANTS} from '~/local/sam2/config';
import type {StudioSessionApi} from '~/workspace/useStudioSession';

type Props = {session: StudioSessionApi};

const MB = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

export default function EnginePicker({session}: Props) {
  const {state, engines, localOptions} = session;
  if (engines.length < 2) {
    return null;
  }
  const browserBusy = state.jobs.some(j => j.engine === BROWSER_ENGINE);
  return (
    <>
      <div className="engine-picker" role="group" aria-label="Track with">
        {engines.map(e =>
          e.available ? (
            <button
              key={e.name}
              className={state.engine === e.name ? 'toggle selected' : 'toggle'}
              onClick={() => session.setEngine(e.name)}
              title={
                e.local
                  ? `Track and click in this browser with ${engineLabel(e.name)} (WebGPU)${e.loaded ? '' : '; downloads its model on first use'}`
                  : `Track with and show ${engineLabel(e.name)} (${e.model})${e.loaded ? '' : '; loads on first use, about 30 s'}`
              }>
              {engineLabel(e.name)}
            </button>
          ) : (
            <span key={e.name} className="engine-off" tabIndex={0} aria-disabled="true">
              <button className="toggle" disabled>
                {engineLabel(e.name)}
              </button>
              <span className="engine-tip" role="tooltip">
                {engineLabel(e.name)} cannot run here: {e.reason ?? 'unavailable'}.
                {e.href != null && (
                  <>
                    {' '}
                    <a href={e.href} target="_blank" rel="noreferrer">
                      Get it
                    </a>
                  </>
                )}
              </span>
            </span>
          ),
        )}
      </div>
      {state.engine === BROWSER_ENGINE && (
        <div className="engine-picker" role="group" aria-label="Browser model size">
          {([512, 1024] as Quality[]).map(q => (
            <button
              key={q}
              className={localOptions.quality === q ? 'toggle selected' : 'toggle'}
              disabled={browserBusy}
              onClick={() => session.setLocalOptions({...localOptions, quality: q})}
              title={`${VARIANTS[q].label}, ${MB(VARIANTS[q].bytes)} download${browserBusy ? ' (not while a browser job runs)' : ''}`}>
              {q}
            </button>
          ))}
          <label className="toggle" title="Fill background holes of 8 px or less in each mask, as SAM 2 does upstream">
            <input
              type="checkbox"
              checked={localOptions.fillHoleArea > 0}
              disabled={browserBusy}
              onChange={e => session.setLocalOptions({...localOptions, fillHoleArea: e.target.checked ? 8 : 0})}
            />
            Fill holes
          </label>
        </div>
      )}
    </>
  );
}
