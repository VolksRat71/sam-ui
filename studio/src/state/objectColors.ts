// sam-ui (Apache-2.0). Browser-local display choices; never seed or track data.
import {colorFor} from './objects';

export type ObjectColors = Record<number, string>;
export function parseObjectColors(raw: unknown): ObjectColors {
  const colors: ObjectColors = {};
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return colors;
  for (const [id, color] of Object.entries(raw)) {
    if (/^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && typeof color === 'string' && /^#[\da-f]{6}$/i.test(color)) {
      colors[Number(id)] = color.toLowerCase();
    }
  }
  return colors;
}

/** Mutate rendering ink only; masks and click arrays retain their identity. */
export function recolorTracklets(tracklets: Iterable<{id: number; color: string}>, colors: ObjectColors): void {
  for (const t of tracklets) t.color = colors[t.id] ?? colorFor(t.id);
}
