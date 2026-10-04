// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The desktop app's update banner: the `updates` half of its bridge
// (desktop/src/app-preload.js). The check itself runs in the app's main
// process (desktop/src/update-check.js); studio only shows what it found, and
// asks main to open the link or to stop showing that version. A browser, the
// dev server or an older desktop app has no `updates`, so it shows nothing.
export type ReleaseNotice = {version: string; name: string; url: string; current: string};

export type UpdatesBridge = {
  /** What the last check found, or null. Not trusted: see asReleaseNotice. */
  pending(): Promise<unknown>;
  /** A newly found release; returns the unsubscribe. */
  onAvailable(cb: (release: unknown) => void): () => void;
  /** Stop showing this version at start (a newer one shows again). */
  dismiss(version: string): void;
  /** Main opens the release page it checked, never a link from here. */
  openRelease(): void;
};

export function updatesBridge(): UpdatesBridge | null {
  const u = (globalThis as {samUiDesktop?: {updates?: Partial<UpdatesBridge>}}).samUiDesktop?.updates;
  return u != null && typeof u.pending === 'function' && typeof u.onAvailable === 'function' ? (u as UpdatesBridge) : null;
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const RELEASES = 'https://github.com/VolksRat71/sam-ui/releases';

/** The bridge's payload as a banner can show it, or null for anything else. */
export function asReleaseNotice(x: unknown): ReleaseNotice | null {
  if (x == null || typeof x !== 'object') {
    return null;
  }
  const {version, name, url, current} = x as Record<string, unknown>;
  if (typeof version !== 'string' || !VERSION.test(version) || typeof current !== 'string' || typeof url !== 'string') {
    return null;
  }
  if (url !== RELEASES && !url.startsWith(`${RELEASES}/`)) {
    return null;
  }
  return {version, current, url, name: typeof name === 'string' ? name : `sam-ui v${version}`};
}

export function updateText(r: ReleaseNotice): string {
  return `sam-ui ${r.version} is available (you have ${r.current}). It doesn't install itself yet: download it from the release page and replace the app.`;
}
