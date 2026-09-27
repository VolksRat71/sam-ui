// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Whether studio runs with a backend or in the browser alone. Decided once,
// at boot (main.tsx): the browser-only build has no backend, and any other
// build falls back to browser-only when its backend does not answer.
import {API_ENDPOINT, NO_BACKEND_BUILD} from '~/config';

let offline = NO_BACKEND_BUILD;

export function isOffline(): boolean {
  return offline;
}

/** Look for the backend (GET /engines); with none, studio runs in the browser alone. */
export async function detectBackend(timeoutMs = 3000): Promise<boolean> {
  if (NO_BACKEND_BUILD) {
    return false;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    await fetch(`${API_ENDPOINT}/engines`, {signal: ctl.signal});
    offline = false; // any answer is a backend (an old one may lack /engines)
  } catch {
    offline = true;
  } finally {
    clearTimeout(timer);
  }
  return !offline;
}
