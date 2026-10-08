import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it} from 'vitest';
import {initialState, reducer} from '~/state/objects';
import type {StudioSessionApi} from '~/workspace/useStudioSession';
import Timeline from './Timeline';

it('gives the Layers list one Tab stop: lanes and their Actions are reached from the layer', () => {
  const state = [0, 1, 2].reduce((s, id) => reducer(s, {type: 'add', id}), initialState);
  const session = {
    state,
    meta: {numFrames: 10, fps: 30, decoded: false},
    frame: 0,
    tracklets: new Map(),
    ordered: state.objects,
    disagreement: new Map(),
    flags: {},
    objectColors: {},
    status: 'ready',
  } as unknown as StudioSessionApi;
  const html = renderToStaticMarkup(createElement(Timeline, {session}));
  const lanes = [...html.matchAll(/<div[^>]*class="swimlane( [^"]*)?"[^>]*>/g)].map(m => m[0]);
  const actions = [...html.matchAll(/<button[^>]*aria-label="Actions for [^"]*"[^>]*>/g)].map(m => m[0]);
  const options = [...html.matchAll(/<div[^>]*role="option"[^>]*>/g)].map(m => m[0]);
  expect(lanes).toHaveLength(3);
  expect(actions).toHaveLength(3);
  expect(lanes.every(l => l.includes('tabindex="-1"'))).toBe(true);
  expect(actions.every(a => a.includes('tabindex="-1"'))).toBe(true);
  expect(options.filter(o => o.includes('tabindex="0"'))).toHaveLength(1); // the selected layer's, roving
  expect(options.every(o => o.includes('aria-keyshortcuts="Shift+F10"'))).toBe(true); // the way to its Actions
});
