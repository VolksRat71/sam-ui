import {expect, it} from 'vitest';
import {clampPanelLayout, DEFAULT_PANEL_LAYOUT, panelLimits} from './panelLayout';

it('preserves measured defaults and normalized user sizes across viewports', () => {
  for (const [width, height] of [[1600, 1000], [1440, 900], [800, 600]]) {
    expect(clampPanelLayout(DEFAULT_PANEL_LAYOUT, width, height)).toEqual(DEFAULT_PANEL_LAYOUT);
    if (width >= 1440) expect(clampPanelLayout({columns: -.1, rows: -.05}, width, height)).toEqual({columns: -.1, rows: -.05});
  }
});
it('clamps both axes to usable physical minima and rejects corrupt persisted offsets', () => {
  const limits = panelLimits(1600, 1000);
  const small = clampPanelLayout({columns: -9, rows: -9}, 1600, 1000);
  const large = clampPanelLayout({columns: 9, rows: 9}, 1600, 1000);
  expect((.7438 + small.columns) * 1600).toBeCloseTo(480);
  expect((.51 + small.rows) * 1000).toBeCloseTo(300);
  expect((.2375 - large.columns) * 1600).toBeCloseTo(320);
  expect((.297 - large.rows) * 1000).toBeCloseTo(180);
  expect(small.columns).toBe(limits.columns.min);
  expect(large.rows).toBe(limits.rows.max);
  expect(clampPanelLayout({columns: NaN, rows: 'bad'}, 1600, 1000)).toEqual(DEFAULT_PANEL_LAYOUT);
  expect(clampPanelLayout(null, 1600, 1000)).toEqual(DEFAULT_PANEL_LAYOUT);
});

it('leaves an untouched or reset axis at its measured default on compact viewports', () => {
  expect(clampPanelLayout({columns: 0, rows: -10 / 600}, 800, 600)).toEqual({columns: 0, rows: -10 / 600});
  expect(clampPanelLayout({columns: -.12, rows: 0}, 800, 600)).toEqual({columns: -.12, rows: 0});
  expect(clampPanelLayout({columns: 10 / 800, rows: 0}, 800, 600)).toEqual(DEFAULT_PANEL_LAYOUT);
  expect(clampPanelLayout({columns: 0, rows: 10 / 600}, 800, 600)).toEqual(DEFAULT_PANEL_LAYOUT);
  const customized = clampPanelLayout({columns: -.12, rows: -.05}, 800, 600);
  expect(clampPanelLayout({...customized, columns: 0}, 800, 600)).toEqual({columns: 0, rows: customized.rows});
  expect(clampPanelLayout({...customized, rows: 0}, 800, 600)).toEqual({columns: customized.columns, rows: 0});
});
it('restores saved wide-screen intent against its actual viewport dimensions', () => {
  const stored = JSON.parse(JSON.stringify({columns: .1, rows: .05}));
  expect(clampPanelLayout(stored, 2560, 1440)).toEqual(stored);
  expect(clampPanelLayout(stored, 1600, 1000).columns).toBeLessThan(stored.columns);
});
