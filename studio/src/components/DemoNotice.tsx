// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The browser engine is a demo: it runs SAM 2.1 tiny. Studio says so without
// nagging: a banner, once, when the browser engine is the only one there is
// (no backend), until dismissed (remembered where storage allows; without
// storage it shows again next time), and a small tag beside the engine
// button while the browser engine is chosen. No modals, nothing per export.
import {Close} from '@carbon/icons-react';
import {useState} from 'react';
import {RELEASES_URL} from '~/state/engines';

const DISMISSED_KEY = 'sam-ui-studio:demo-banner-dismissed';

export const DEMO_TEXT =
  'The browser version runs SAM 2.1 tiny and is mainly a demo. The desktop app runs SAM 2.1 large and SAM 3 (SAM 3 needs access approval on Hugging Face), with much better masks. Tested in Chrome.';

/** Where the demo banner sits, when this browser cannot run the browser engine at all. */
export function UnsupportedNotice() {
  return (
    <div className="demo-banner unsupported" role="alert">
      <span>
        This browser can&apos;t run the browser demo (it needs WebGPU). Use Chrome or Edge on a desktop, or{' '}
        <a href={RELEASES_URL} target="_blank" rel="noreferrer">
          download the desktop app
        </a>
        .
      </span>
    </div>
  );
}

function dismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function DemoBanner({show}: {show: boolean}) {
  const [hidden, setHidden] = useState(dismissed);
  if (!show || hidden) {
    return null;
  }
  const dismiss = () => {
    setHidden(true);
    try {
      window.localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // not remembered: it shows again next time
    }
  };
  return (
    <div className="demo-banner" role="note">
      <span>
        {DEMO_TEXT}{' '}
        <a href={RELEASES_URL} target="_blank" rel="noreferrer">
          Download the desktop app
        </a>
      </span>
      <button className="icon-button" onClick={dismiss} title="Dismiss" aria-label="Dismiss">
        <Close size={16} />
      </button>
    </div>
  );
}

/** Beside the engine button while the browser engine is chosen. */
export function DemoTag() {
  return (
    <span className="engine-off demo-tag" tabIndex={0}>
      <span className="engine-chip">Demo · tiny model</span>
      <span className="engine-tip" role="tooltip">
        The browser engine runs SAM 2.1 tiny, mainly as a demo; the desktop app runs SAM 2.1 large and SAM 3.{' '}
        <a href={RELEASES_URL} target="_blank" rel="noreferrer">
          Download the desktop app
        </a>
      </span>
    </span>
  );
}
