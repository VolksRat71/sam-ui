import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it} from 'vitest';
import {initialState} from '~/state/objects';
import ObjectsSection from './ObjectsSection';

it("offers Rename in a group's Actions menu (the pencil is hidden on touch widths)", () => {
  const group = {id: 'g1', name: 'Jugglers', color: '#3366ff', members: [], collapsed: false, hidden: false};
  const session = {state: {...initialState, layout: {order: [], groups: [group]}}, canAdd: true, busy: false, status: 'ready'};
  const html = renderToStaticMarkup(createElement(ObjectsSection, {session: session as never}));
  const menu = html.slice(html.indexOf('class="group-options"'));
  expect(menu).toMatch(/<button class="link-button" title="Rename the group">.*Rename<\/button>/);
});
