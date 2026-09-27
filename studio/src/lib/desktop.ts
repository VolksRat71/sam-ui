// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// What the desktop app's main window exposes (desktop/src/app-preload.js).
// Absent anywhere else (a browser, the dev server), so callers show their
// desktop-only controls only when this returns a bridge.
export type DesktopBridge = {setupSam3(): void};

export function desktopBridge(): DesktopBridge | null {
  const b = (globalThis as {samUiDesktop?: Partial<DesktopBridge>}).samUiDesktop;
  return typeof b?.setupSam3 === 'function' ? (b as DesktopBridge) : null;
}
