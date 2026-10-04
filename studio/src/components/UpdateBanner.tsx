// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The desktop app found a newer release (desktop/src/update-check.js): a
// banner under the top bar, like the demo banner, with the release link and a
// close. The close is kept by the app, per version. Nothing in a browser.
import {Close} from '@carbon/icons-react';
import {useEffect, useMemo, useState} from 'react';
import {asReleaseNotice, type ReleaseNotice, updateText, updatesBridge} from '~/lib/updates';

export default function UpdateBanner() {
  const bridge = useMemo(updatesBridge, []);
  const [release, setRelease] = useState<ReleaseNotice | null>(null);

  useEffect(() => {
    if (bridge == null) {
      return;
    }
    let live = true;
    // subscribe first, then ask: a check that ends in between is not missed
    const off = bridge.onAvailable(r => {
      const next = asReleaseNotice(r);
      if (next != null) {
        setRelease(next);
      }
    });
    bridge.pending().then(
      r => live && setRelease(prev => prev ?? asReleaseNotice(r)),
      () => {},
    );
    return () => {
      live = false;
      off();
    };
  }, [bridge]);

  if (bridge == null || release == null) {
    return null;
  }
  const dismiss = () => {
    bridge.dismiss(release.version);
    setRelease(null);
  };
  return (
    <div className="demo-banner update-banner" role="status">
      <span>
        {updateText(release)}{' '}
        <a
          href={release.url}
          onClick={e => {
            e.preventDefault();
            bridge.openRelease();
          }}>
          View the release
        </a>
      </span>
      <button className="icon-button" onClick={dismiss} title="Dismiss" aria-label="Dismiss">
        <Close size={16} />
      </button>
    </div>
  );
}
