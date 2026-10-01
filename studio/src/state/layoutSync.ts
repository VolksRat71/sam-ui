// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// When studio may save the object layout (state/layout.ts). A save writes the
// whole layout.json, so a save made from a layout that was never loaded (an
// error, a network failure) would replace the stored groups with none. Saves
// therefore open only after a load that read the stored layout: a backend
// that answered, or OPFS. A backend from before layouts (the route is missing)
// keeps creation order and is never written.

import {EMPTY_LAYOUT, type Layout, parseLayout} from './layout';

/** POST /object_layout's answer, read. `status` null: the request never got an answer. */
export function layoutFromResponse(status: number | null, body: unknown): {layout: Layout; supported: boolean} {
  if (status == null) {
    throw new Error('could not reach the backend for the object order and groups');
  }
  if (status === 404 || status === 405) {
    return {layout: EMPTY_LAYOUT, supported: false}; // a backend from before layouts
  }
  if (status < 200 || status >= 300) {
    throw new Error(`object_layout: HTTP ${status}`);
  }
  return {layout: parseLayout((body as {layout?: unknown} | null)?.layout), supported: true};
}

/**
 * savable: the stored layout was read, so a save keeps what is stored.
 * baseline: the layout (JSON) as last loaded or saved; null right after loading.
 */
export type SaveGate = {savable: boolean; baseline: string | null};

/** No load has succeeded: nothing is saved. */
export const CLOSED_GATE: SaveGate = {savable: false, baseline: null};

/**
 * What to do with the layout now on screen (`json`): save it, or not.
 * `blocked`: it changed, but saving is closed (the page may say so once).
 */
export function saveStep(gate: SaveGate, json: string): {save: boolean; blocked: boolean; gate: SaveGate} {
  if (gate.baseline == null || json === gate.baseline) {
    return {save: false, blocked: false, gate: {...gate, baseline: json}};
  }
  return {save: gate.savable, blocked: !gate.savable, gate: {...gate, baseline: json}};
}
