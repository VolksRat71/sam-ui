// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Per-object effects. Each object keeps its own selected-object effect (one
// of Meta's highlight effects) and variant until the user changes it;
// focusing an object only chooses which object the effect buttons edit. An
// object with no entry is "untouched" and shows the Overlay. The background
// effect is separate and global (one per video).

export type ObjectEffect = {name: string; variant: number};
/** By object id. An object with no entry has not been given an effect. */
export type EffectMap = Record<number, ObjectEffect>;

export const OVERLAY = 'Overlay';
/** Meta's "Original" highlight: the object as it is in the video. */
export const ORIGINAL = 'Cutout';
export const DEFAULT_EFFECT: ObjectEffect = {name: OVERLAY, variant: 0};

/** How an export draws objects that were never given an effect. */
export type UntouchedMode = 'original' | 'shown';

export function effectOf(map: EffectMap, id: number): ObjectEffect {
  return map[id] ?? DEFAULT_EFFECT;
}

/**
 * Give object `id` the effect `name`. Picking the effect it already has moves
 * to the next variant, as Meta's demo does. No other object changes.
 */
export function pickEffect(map: EffectMap, id: number, name: string, numVariants: number): EffectMap {
  const current = effectOf(map, id);
  const variant = current.name === name ? (current.variant + 1) % Math.max(1, numVariants) : 0;
  return {...map, [id]: {name, variant}};
}

/** Drop the entries of objects that no longer exist. */
export function pruneEffects(map: EffectMap, ids: ReadonlyArray<number>): EffectMap {
  const keep = new Set(ids);
  const out: EffectMap = {};
  for (const [k, v] of Object.entries(map)) {
    if (keep.has(Number(k))) {
      out[Number(k)] = v;
    }
  }
  return out;
}

/**
 * The effects an export renders: every object's own effect; an untouched
 * object renders as Original (unchanged) by default, or as the preview shows
 * it (the Overlay) with 'shown'. Nothing the user did not choose ends up in
 * the file unless asked for.
 */
export function exportEffects(map: EffectMap, ids: ReadonlyArray<number>, untouched: UntouchedMode): EffectMap {
  const out: EffectMap = {};
  for (const id of ids) {
    out[id] = map[id] ?? (untouched === 'original' ? {name: ORIGINAL, variant: 0} : DEFAULT_EFFECT);
  }
  return out;
}

/** Read a stored map, tolerating anything malformed (it comes from localStorage). */
export function parseEffectMap(raw: unknown): EffectMap {
  const out: EffectMap = {};
  if (raw == null || typeof raw !== 'object') {
    return out;
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(k);
    const e = v as {name?: unknown; variant?: unknown} | null;
    if (Number.isInteger(id) && e != null && typeof e.name === 'string') {
      out[id] = {name: e.name, variant: Number.isInteger(e.variant) ? (e.variant as number) : 0};
    }
  }
  return out;
}
