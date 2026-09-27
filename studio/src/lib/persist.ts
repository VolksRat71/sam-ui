// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The browser engine's models (Cache Storage) and, with no backend, the
// user's videos, seeds and tracks (OPFS) are site data, which a browser may
// evict under storage pressure unless the site's storage is persistent.
// Ask once; the browser decides (Chrome grants it quietly for a site used
// often or installed, Firefox may ask), and without it everything still
// works, only a later visit may download the model again.
let asked = false;

export function requestPersistentStorage(): void {
  if (asked) {
    return;
  }
  asked = true;
  try {
    void navigator.storage?.persist?.().catch(() => {});
  } catch {
    // not offered here: best effort
  }
}
