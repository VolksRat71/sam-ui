import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it, vi} from 'vitest';
import {initialState} from '~/state/objects';
import Workspace from './Workspace';

vi.mock('~/workspace/useStudioSession', () => ({default: () => ({state: initialState, dirty: [], meta: {numFrames: 0}, engines: [], backend: true, webgpu: true, foreignJobs: [], warning: null})}));
vi.mock('react-resizable-panels', () => ({Panel: ({children}: {children: ReactNode}) => children, PanelGroup: ({children}: {children: ReactNode}) => children, PanelResizeHandle: () => null}));
vi.mock('./Sidebar', () => ({default: ({sections}: {sections: {id: string}[]}) => createElement('div', null, sections.map(s => createElement('span', {key: s.id, 'data-panel': s.id})))}));
vi.mock('./Preview', () => ({default: () => null}));
vi.mock('./Timeline', () => ({default: () => null}));
vi.mock('./UpdateBanner', () => ({default: () => null}));
vi.mock('./ExportMenu', () => ({default: () => null}));

it('mounts each dock panel once, in the approved order', () => {
  const html = renderToStaticMarkup(createElement(Workspace, {video: {path: 'fixture.mp4'} as never, renderMedia: () => null}));
  expect([...html.matchAll(/data-panel="([^"]+)"/g)].map(m => m[1])).toEqual(['review', 'info', 'effects', 'media']);
});
