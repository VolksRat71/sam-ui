// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Review flags: frames the user marked (F) while scrubbing as needing a
// correction, per object, so a clip can be reviewed first and fixed after.
// Each shows as a marker on the object's timeline lane; a flag clears once
// its frame gets clicks. Kept per video in this browser.

/** By object id: its flagged frames, sorted. An object with none has no entry. */
export type FlagMap = Record<number, number[]>;

export function flagsOf(map: FlagMap, id: number): number[] {
  return map[id] ?? [];
}

function withFrames(map: FlagMap, id: number, frames: number[]): FlagMap {
  const out = {...map};
  if (frames.length === 0) {
    delete out[id];
  } else {
    out[id] = frames;
  }
  return out;
}

/** Flag `frame` on object `id`, or unflag it if it was flagged. */
export function toggleFlag(map: FlagMap, id: number, frame: number): FlagMap {
  const frames = flagsOf(map, id);
  return withFrames(
    map,
    id,
    frames.includes(frame) ? frames.filter(f => f !== frame) : [...frames, frame].sort((a, b) => a - b),
  );
}

/** Drop the flag on `frame` (it was corrected). The same map when there was none. */
export function clearFlag(map: FlagMap, id: number, frame: number): FlagMap {
  const frames = flagsOf(map, id);
  return frames.includes(frame) ? withFrames(map, id, frames.filter(f => f !== frame)) : map;
}

/** Drop the flags of objects that no longer exist. */
export function pruneFlags(map: FlagMap, ids: ReadonlyArray<number>): FlagMap {
  const keep = new Set(ids);
  const out: FlagMap = {};
  for (const [k, v] of Object.entries(map)) {
    if (keep.has(Number(k))) {
      out[Number(k)] = v;
    }
  }
  return out;
}

/** Stored flags, keeping only whole-number object ids and frames. */
export function parseFlagMap(raw: unknown): FlagMap {
  const out: FlagMap = {};
  if (raw == null || typeof raw !== 'object') {
    return out;
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(k);
    if (!Number.isInteger(id) || !Array.isArray(v)) {
      continue;
    }
    const frames = [...new Set(v.filter((f): f is number => Number.isInteger(f) && f >= 0))].sort((a, b) => a - b);
    if (frames.length > 0) {
      out[id] = frames;
    }
  }
  return out;
}
