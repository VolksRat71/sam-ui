// Detail records are rendering annotations; never merge them into prompt seeds.
import {BROWSER_ENGINE} from './engines';
import {DataArray, decode, encode, type RLEObject} from '@/jscocotools/mask';
export type DetailRecord = {id: string; rect: [number, number, number, number]; points: [number, number, number][]; mask: RLEObject; geometry: {version: 'working-copy-v1'; width: number; height: number}};
export type DetailState = {enabled: boolean; objects: Record<number, Record<number, DetailRecord[]>>};
export type DetailOperation = 'detail_state' | 'detail_frame' | 'preview_detail_crop' | 'apply_detail_crop' | 'remove_detail_crop';
export function combineDetail(base: RLEObject | undefined, details: DetailRecord[]): RLEObject | undefined {
  if (details.length === 0 || base == null) return base;
  const original = decode([base]).data;
  if (!original.some(Boolean)) return base;
  const {width: w, height: h} = details[0].geometry;
  if (base && (base.size[0] !== h || base.size[1] !== w)) throw new Error('Detail raster does not match this frame');
  const pixels = original.slice();
  for (const d of details) {
    const [x0, y0, x1, y1] = d.rect;
    if (d.geometry.width !== w || d.geometry.height !== h || d.mask.size[0] !== y1 - y0 || d.mask.size[1] !== x1 - x0 || x0 < 0 || y0 < 0 || x1 > w || y1 > h) throw new Error('Invalid detail geometry');
    const crop = decode([d.mask]).data;
    for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) pixels[x * h + y] |= crop[(x - x0) * (y1 - y0) + y - y0];
  }
  return encode(new DataArray(pixels, [h, w, 1]))[0];
}

export function detailAvailable(backend: boolean, engine: string) { return backend && engine !== BROWSER_ENGINE; }
