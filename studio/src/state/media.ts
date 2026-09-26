// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Which videos may be deleted, and what to show once one is gone. The backend
// deletes uploads only (the gallery can hold source footage) and checks the
// same rules; the UI never offers Remove where the backend would refuse.

/** An upload the backend will delete: under uploads/, and no path tricks. */
export function isDeletable(path: string): boolean {
  return path.startsWith('uploads/') && !path.split('/').includes('..') && path.length > 'uploads/'.length;
}

/**
 * The video to open after `deleted` goes: the current one if it stays, else
 * its neighbour in the list (the next one, or the one before at the end),
 * else none (the empty state).
 */
export function afterDelete<T extends {path: string}>(videos: ReadonlyArray<T>, deleted: string, current: T | null): T | null {
  if (current != null && current.path !== deleted) {
    return current;
  }
  const at = videos.findIndex(v => v.path === deleted);
  const rest = videos.filter(v => v.path !== deleted);
  if (rest.length === 0) {
    return null;
  }
  return rest[Math.min(Math.max(at, 0), rest.length - 1)];
}
