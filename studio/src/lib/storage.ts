// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// localStorage for per-browser conveniences only (pane sizes, collapsed
// sections, the last video, this browser's uploads). Every access can throw
// (private mode, blocked storage), so the UI must work without it.
export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // not persisted; fine
  }
}

/** For react-resizable-panels' autoSaveId. */
export const panelStorage = {
  getItem(name: string): string | null {
    try {
      return window.localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem(name: string, value: string): void {
    try {
      window.localStorage.setItem(name, value);
    } catch {
      // not persisted; fine
    }
  },
};
