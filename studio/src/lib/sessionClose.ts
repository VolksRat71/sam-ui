// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// A video's session closes when its Workspace unmounts. Deleting that video
// must wait for the close (the backend refuses to delete a video open in any
// session), so each open session and each close is recorded here by path.
import {API_ENDPOINT} from '~/config';

const open = new Set<string>();
const closing = new Map<string, Promise<void>>();

export function recordOpen(path: string): void {
  open.add(path);
}

export function recordClose(path: string, done: Promise<void>): void {
  open.delete(path);
  closing.set(path, done);
  done.finally(() => {
    if (closing.get(path) === done) {
      closing.delete(path);
    }
  });
}

/**
 * Resolves once this page has no session on `path`: at once if it never had
 * one, else when its Workspace has unmounted and the close has gone through.
 * Rejects if the Workspace is still mounted after `timeoutMs`.
 */
export async function whenClosed(path: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (open.has(path)) {
    if (Date.now() > deadline) {
      throw new Error(`the session on ${path} did not close`);
    }
    await new Promise(r => setTimeout(r, 25));
  }
  await closing.get(path);
}

/**
 * Close a session while the page unloads: a keepalive fetch, which the
 * browser sends even after the page is gone (a worker message would not be).
 */
export function closeSessionOnUnload(sessionId: string): void {
  try {
    void fetch(`${API_ENDPOINT}/graphql`, {
      method: 'POST',
      keepalive: true,
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        query: 'mutation($s: String!) { closeSession(input: {sessionId: $s}) { success } }',
        variables: {s: sessionId},
      }),
    }).catch(() => {});
  } catch {
    // the page is going; the backend's idle expiry closes it later
  }
}
