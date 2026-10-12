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

it('labels the whole-clip lined ruler in displayed frames with both endpoints and minor ticks', () => {
  const session = {
    state: initialState,
    meta: {numFrames: 247, fps: 24, decoded: false},
    frame: 216,
    tracklets: new Map(),
    ordered: [],
    disagreement: new Map(),
    flags: {},
    objectColors: {},
    status: 'ready',
  } as unknown as StudioSessionApi;
  const html = renderToStaticMarkup(createElement(Timeline, {session, presentation: 'lined'}));
  const frames = [...html.matchAll(/id="ruler-label-(\d+)"/g)].map(match => Number(match[1]));
  expect(frames).toEqual([1, 25, 50, 75, 100, 125, 150, 175, 200, 225, 247]);
  expect([...html.matchAll(/class="lined-minor-tick"/g)]).toHaveLength(40);
  for (const numFrames of [1, 2, 8]) {
    const shortHtml = renderToStaticMarkup(createElement(Timeline, {session: {...session, meta: {...session.meta, numFrames}}, presentation: 'lined'}));
    const shortFrames = [...shortHtml.matchAll(/id="ruler-label-(\d+)"/g)].map(match => Number(match[1]));
    expect(shortFrames[0]).toBe(1);
    expect(shortFrames.at(-1)).toBe(numFrames);
    expect(new Set(shortFrames).size).toBe(shortFrames.length);
    expect(shortFrames.every(frame => frame >= 1 && frame <= numFrames)).toBe(true);
  }
});
