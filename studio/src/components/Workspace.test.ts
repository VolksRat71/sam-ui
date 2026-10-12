import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it, vi} from 'vitest';
import {initialState} from '~/state/objects';
import Workspace from './Workspace';

vi.mock('~/workspace/useStudioSession', () => ({default: () => ({state: initialState, dirty: [], meta: {numFrames: 0, fps: 24, width: 1280, height: 720, decoded: false}, frame: 0, matteView: 'overlay', ordered: [], review: null, effectDoc: null, engines: [], backend: true, webgpu: true, foreignJobs: [], warning: null, agentActivity: [], agentJobIds: new Set()})}));
vi.mock('./Preview', () => ({default: () => createElement('div', {'data-capability': 'preview'})}));
vi.mock('./Timeline', () => ({default: () => createElement('div', {'data-capability': 'timeline'})}));
vi.mock('./EnginePicker', () => ({default: () => createElement('div', {'data-capability': 'engine'})}));
vi.mock('./UpdateBanner', () => ({default: () => null}));
vi.mock('./ExportMenu', () => ({default: () => createElement('div', {'data-capability': 'export'})}));

it('mounts one live workspace with retained capabilities and unavailable matte controls disabled', () => {
  const renderMedia = vi.fn(() => createElement('div', {'data-capability': 'media'}));
  const html = renderToStaticMarkup(createElement(Workspace, {video: {path: 'fixture.mp4'} as never, renderMedia}));
  const regions = ['slate', 'viewer', 'inspector', 'filmstrip', 'timeline', 'workspace-tools'];
  expect([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]).filter(id => regions.includes(id))).toEqual(regions);
  for (const name of ['preview', 'timeline', 'engine', 'export', 'media']) {
    expect([...html.matchAll(new RegExp(`data-capability="${name}"`, 'g'))]).toHaveLength(1);
  }
  expect(renderMedia).toHaveBeenCalledTimes(1);
  expect(html).toMatch(/id="view-alpha"[^>]*disabled=""/);
  expect(html).toMatch(/id="view-edge"[^>]*disabled=""/);
  expect(html).toMatch(/id="view-dim"[^>]*disabled=""/);
  expect(html).toContain('id="workspace-tools"');
  expect(html).toContain('hidden="" aria-label="Workspace controls"');
});
