import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it} from 'vitest';
import {initialState, reducer} from '~/state/objects';
import type {StudioSessionApi} from '~/workspace/useStudioSession';
import ObjectsSection from './ObjectsSection';

it("renames an object from its timeline lane, like a group's", () => {
  const added = reducer(initialState, {type: 'add', id: 0});
  const state = reducer({...added, activeId: null}, {type: 'rename', id: 0, name: 'Dog'});
  const session = {state, disagreement: new Map(), objectColors: {}} as unknown as StudioSessionApi;
  const html = renderToStaticMarkup(createElement(ObjectsSection, {session, renderLane: () => null}));
  const lane = html.slice(html.indexOf('class="layer-summary"'), html.indexOf('</div>', html.indexOf('class="layer-summary"')));
  expect(lane).toContain('title="Double-click to rename">Dog</span>');
  expect(lane).toContain('tabindex="-1" class="icon-button small rename-button" title="Rename" aria-label="Rename Dog"'); // no Tab stop per lane
});
