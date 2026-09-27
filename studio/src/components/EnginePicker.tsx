// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The one engine control, beside Track: which engine Track runs and the
// preview shows. The top bar shows only the current engine (with the browser
// engine's model size, and its download progress while it loads); the rest
// is in a popover:
//   - every engine of this mode, as a radio list; one that cannot run is
//     listed disabled with its reason, and a link when it has one;
//   - inside the browser entry: its model size (512 fp16 or 1024 fp32) and
//     hole fill, and a status line (download size, cached, loading, WebGPU).
// The browser-only build keeps the same dropdown: SAM 2.1 large and SAM 3
// are listed in it, disabled, and their tooltips link to the desktop app,
// so the top bar holds one control whatever the build.
import {ChevronDown} from '@carbon/icons-react';
import {useEffect, useRef, useState} from 'react';
import {modelAvailability} from '~/local/models';
import {type Quality, VARIANTS} from '~/local/sam2/config';
import {BROWSER_ENGINE, engineLabel} from '~/state/engines';
import type {EngineInfo} from '~/worker/protocol';
import type {StudioSessionApi} from '~/workspace/useStudioSession';
import {desktopBridge} from '~/lib/desktop';

type Props = {session: StudioSessionApi};
type Availability = Record<Quality, 'local' | 'cached' | 'download' | null>;

const MB = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;
const QUALITIES: Quality[] = [512, 1024];

const labelOf = (e: EngineInfo) => e.label ?? engineLabel(e.name);

/** Why an engine cannot run here, with its link: the tooltip of a disabled entry. */
function Why({engine}: {engine: EngineInfo}) {
  const desktop = desktopBridge();
  return (
    <span className="engine-tip" role="tooltip">
      {engine.reason ?? 'Not available here.'}
      {engine.href != null && (
        <>
          {' '}
          <a href={engine.href} target="_blank" rel="noreferrer">
            Download the desktop app
          </a>
        </>
      )}
      {desktop != null && engine.name === 'sam3' && /weights/i.test(engine.reason ?? '') && (
        <button type="button" className="button small engine-setup" onClick={() => desktop.setupSam3()}>
          Set up SAM 3…
        </button>
      )}
    </span>
  );
}

export default function EnginePicker({session}: Props) {
  const {state, engines, localOptions, localModel} = session;
  const [open, setOpen] = useState(false);
  const [availability, setAvailability] = useState<Availability>({512: null, 1024: null});
  const root = useRef<HTMLDivElement>(null);

  // the popover closes on a click outside it, or Escape
  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (root.current != null && !root.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // where each browser model would load from, looked up when the popover opens
  const readyQuality = localModel?.status === 'ready' ? localModel.quality : null;
  useEffect(() => {
    if (!open || !engines.some(e => e.local && e.available)) {
      return;
    }
    let stale = false;
    void Promise.all(QUALITIES.map(q => modelAvailability(VARIANTS[q]).catch(() => null))).then(([a, b]) => {
      if (!stale) {
        setAvailability({512: a, 1024: b});
      }
    });
    return () => {
      stale = true;
    };
  }, [open, engines, readyQuality]);

  if (engines.length === 0) {
    return null;
  }
  const isBrowser = state.engine === BROWSER_ENGINE;
  const browserBusy = state.jobs.some(j => j.engine === BROWSER_ENGINE);
  const loading = localModel?.status === 'loading' ? localModel : null;
  const summary = `${engineLabel(state.engine)}${isBrowser ? ` · ${localOptions.quality}` : ''}`;

  const choose = (name: string) => {
    session.setEngine(name);
    if (name !== BROWSER_ENGINE) {
      setOpen(false);
    }
  };

  const statusLine = (q: Quality): string => {
    if (localModel?.quality === q) {
      if (localModel.status === 'loading') {
        return `Loading: ${MB(localModel.loaded)} of ${MB(localModel.total)}`;
      }
      if (localModel.status === 'ready') {
        return 'Loaded';
      }
      if (localModel.status === 'failed') {
        return `Could not load: ${localModel.error}`;
      }
    }
    const a = availability[q];
    return a === 'local' ? 'From studio/.models' : a === 'cached' ? 'Cached in this browser' : `${MB(VARIANTS[q].bytes)} download on first use`;
  };

  const browserOptions = (
    <div className="engine-suboptions">
      <div className="segmented" role="radiogroup" aria-label="Browser model size">
        {QUALITIES.map(q => (
          <button
            key={q}
            role="radio"
            aria-checked={localOptions.quality === q}
            className={localOptions.quality === q ? 'toggle selected' : 'toggle'}
            disabled={browserBusy}
            title={browserBusy ? 'Not while a browser job runs' : VARIANTS[q].label}
            onClick={() => {
              session.setEngine(BROWSER_ENGINE);
              if (q !== localOptions.quality) {
                session.setLocalOptions({...localOptions, quality: q});
              }
            }}>
            {q} px
          </button>
        ))}
      </div>
      <p className="engine-status">
        {VARIANTS[localOptions.quality].label}. {statusLine(localOptions.quality)}.
      </p>
      <label className="engine-check" title="Fill background holes of 8 px or less in each mask, as upstream SAM 2 does">
        <input
          type="checkbox"
          checked={localOptions.fillHoleArea > 0}
          disabled={browserBusy}
          onChange={e => session.setLocalOptions({...localOptions, fillHoleArea: e.target.checked ? 8 : 0})}
        />
        Fill small holes
      </label>
    </div>
  );

  const button = (
    <button
      className="button engine-button"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => setOpen(o => !o)}
      title="Choose the engine Track runs and the preview shows">
      <span>{summary}</span>
      {loading != null && (
        <span className="muted">
          {MB(loading.loaded)}/{MB(loading.total)}
        </span>
      )}
      <ChevronDown size={16} />
      {loading != null && (
        <span className="engine-progress">
          <span style={{width: `${Math.min(100, (loading.loaded / Math.max(loading.total, 1)) * 100)}%`}} />
        </span>
      )}
    </button>
  );

  return (
    <div className="engine-picker" ref={root}>
      {button}
      {open && (
        <div className="engine-menu" role="dialog" aria-label="Engine">
          <div role="radiogroup" aria-label="Track with">
            {engines.map(e =>
              e.available ? (
                <div key={e.name} className={state.engine === e.name ? 'engine-option selected' : 'engine-option'}>
                  <button role="radio" aria-checked={state.engine === e.name} className="engine-option-head" onClick={() => choose(e.name)}>
                    <span className="engine-radio" />
                    <span className="engine-name">{labelOf(e)}</span>
                    <span className="muted">
                      {e.local ? (e.hint ?? 'in this browser') : e.loaded ? e.model : `${e.model}, loads on first use`}
                    </span>
                  </button>
                  {e.local && browserOptions}
                </div>
              ) : (
                <div key={e.name} className="engine-option disabled engine-off" tabIndex={0} aria-disabled="true">
                  <div className="engine-option-head">
                    <span className="engine-radio" />
                    <span className="engine-name">{labelOf(e)}</span>
                    <span className="muted">{e.href != null ? 'desktop app' : 'not available'}</span>
                  </div>
                  <Why engine={e} />
                </div>
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}
