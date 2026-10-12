// sam-ui (Apache-2.0). User offsets from the measured default, as viewport fractions.
export type PanelLayout = {columns: number; rows: number};
export const DEFAULT_PANEL_LAYOUT: PanelLayout = {columns: 0, rows: 0};

export function panelLimits(width: number, height: number) {
  const w = Math.max(1, width), h = Math.max(1, height);
  return {
    columns: {min: Math.min(480, w * .5) / w - .7438, max: Math.max(0, .2375 - Math.min(320, w * .35) / w)},
    rows: {min: Math.min(300, h * .4) / h - .51, max: Math.max(0, .297 - Math.min(180, h * .3) / h)},
  };
}

export function clampPanelLayout(value: unknown, width: number, height: number): PanelLayout {
  const saved = value as Partial<PanelLayout> | null;
  const limits = panelLimits(width, height);
  const clamp = (axis: keyof PanelLayout) => {
    const n = saved?.[axis];
    if (n === 0) return 0; // an untouched or reset axis keeps the measured default
    return typeof n === 'number' && Number.isFinite(n) ? Math.min(limits[axis].max, Math.max(limits[axis].min, n)) : 0;
  };
  return {columns: clamp('columns'), rows: clamp('rows')};
}
