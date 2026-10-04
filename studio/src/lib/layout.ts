// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The editor's layouts by viewport. The desktop layout (resizable panes) is
// every viewport at least DESKTOP_MIN_WIDTH wide; below that the panes stack
// (responsive.css) and the side panel becomes tabs (Sidebar.tsx). The CSS
// media queries in responsive.css use these same numbers: keep them in step.
import {useEffect, useState} from 'react';

export type Layout = 'desktop' | 'tablet' | 'phone-landscape' | 'phone-portrait';

/** At or above this width (CSS px) the desktop layout applies, unchanged. */
export const DESKTOP_MIN_WIDTH = 1024;
/** Below this width a portrait viewport is a phone. */
export const PHONE_MAX_WIDTH = 600;
/** A landscape viewport this short or shorter is a phone on its side. */
export const PHONE_LANDSCAPE_MAX_HEIGHT = 500;

/** Matches every layout but the desktop one. */
export const COMPACT_QUERY = `(max-width: ${DESKTOP_MIN_WIDTH - 0.02}px)`;

/**
 * The layout for a viewport. Width decides first, so a short but wide
 * desktop window keeps the desktop layout; a short landscape viewport below
 * that is a phone on its side, whatever its width; a narrow one is a phone
 * held upright; anything else (an iPad, an unfolded foldable) is a tablet.
 */
export function layoutFor(width: number, height: number): Layout {
  if (width >= DESKTOP_MIN_WIDTH) {
    return 'desktop';
  }
  if (width > height && height <= PHONE_LANDSCAPE_MAX_HEIGHT) {
    return 'phone-landscape';
  }
  if (width < PHONE_MAX_WIDTH) {
    return 'phone-portrait';
  }
  return 'tablet';
}

export function isCompact(layout: Layout): boolean {
  return layout !== 'desktop';
}

/** Whether a media query matches, following it as the viewport changes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => globalThis.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const mq = globalThis.matchMedia?.(query);
    if (mq == null) {
      return;
    }
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [query]);
  return matches;
}
