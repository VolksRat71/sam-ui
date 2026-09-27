// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Whether studio runs with a backend or in the browser alone. That is the
// build's choice, never a guess: the browser-only build (VITE_API_ENDPOINT=
// none) has no backend, and every other build is the UI of its backend. A
// backend that is slow to answer (the desktop app's first /engines imports
// transformers) or down is waited for, then reported; studio does not quietly
// turn into the browser demo, which would hide the user's models and media.
import {API_ENDPOINT, NO_BACKEND_BUILD} from '~/config';

export function isOffline(): boolean {
  return NO_BACKEND_BUILD;
}

export type WaitOptions = {
  /** Give up after this long, ms. */
  totalMs?: number;
  /** Each attempt's own limit, ms. */
  attemptMs?: number;
  /** Pause between attempts, ms. */
  retryMs?: number;
  fetchFn?: typeof fetch;
};

/**
 * Resolve once the backend answers GET /engines (any HTTP answer counts: an
 * older backend may lack the route). Rejects after `totalMs` without one.
 */
export async function waitForBackend(opts: WaitOptions = {}): Promise<void> {
  const {totalMs = 60_000, attemptMs = 20_000, retryMs = 1_000, fetchFn = fetch} = opts;
  const deadline = Date.now() + totalMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.min(attemptMs, Math.max(1, deadline - Date.now())));
    try {
      await fetchFn(`${API_ENDPOINT}/engines`, {signal: ctl.signal});
      return;
    } catch (err) {
      last = err;
    } finally {
      clearTimeout(timer);
    }
    await new Promise(r => setTimeout(r, retryMs));
  }
  throw new Error(`the backend at ${API_ENDPOINT} did not answer${last instanceof Error ? ` (${last.message})` : ''}`);
}
