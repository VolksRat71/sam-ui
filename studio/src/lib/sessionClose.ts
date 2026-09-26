// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// A video's session closes when its Workspace unmounts. Deleting that video
// must wait for the close (the backend refuses to delete a video open in any
// session), so each close is recorded here by video path.
const closing = new Map<string, Promise<void>>();

export function recordClose(path: string, done: Promise<void>): void {
  closing.set(path, done);
  done.finally(() => {
    if (closing.get(path) === done) {
      closing.delete(path);
    }
  });
}

/** Resolves once this page has closed its session on `path` (at once if it has none). */
export function whenClosed(path: string): Promise<void> {
  return closing.get(path) ?? Promise.resolve();
}
