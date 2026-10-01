// sam-ui (Apache-2.0). New file, not from SAM 2.
// The pure object layout (issue #21), with the backend's tests/test_layout.py rules.
import {describe, expect, it} from 'vitest';
import {
  EMPTY_LAYOUT,
  type Layout,
  type LayoutAction,
  type ObjectGroup,
  arrange,
  groupOf,
  hiddenIds,
  layoutReducer,
  listItems,
  newGroupId,
  parseLayout,
} from './layout';

const g = (id: string, members: number[], over: Partial<ObjectGroup> = {}): ObjectGroup => ({
  id,
  name: id === 'cast' ? 'Cast' : 'Props',
  color: '#ff4fa3',
  members,
  collapsed: false,
  hidden: false,
  ...over,
});

function run(layout: Layout, ids: number[], ...actions: LayoutAction[]): Layout {
  return actions.reduce((l, a) => layoutReducer(l, a, ids), layout);
}

describe('arrange', () => {
  it('keeps creation order and no groups for a video with no layout', () => {
    expect(arrange(EMPTY_LAYOUT, [3, 1, 2])).toEqual({order: [1, 2, 3], groups: []});
  });

  it('drops ids that are gone and appends objects it does not name', () => {
    expect(arrange({order: [4, 9], groups: [g('cast', [9, 1])]}, [1, 2, 4])).toEqual({
      order: [4, 1, 2],
      groups: [g('cast', [1])],
    });
  });

  it('puts a group together where its first member is', () => {
    expect(arrange({order: [1, 3, 2], groups: [g('cast', [2, 1])]}, [1, 2, 3])).toEqual({
      order: [1, 2, 3],
      groups: [g('cast', [1, 2])],
    });
  });
});

describe('parseLayout', () => {
  it('reads a stored layout and drops what is malformed', () => {
    expect(parseLayout(null)).toEqual(EMPTY_LAYOUT);
    expect(parseLayout({order: 'x', groups: 5})).toEqual(EMPTY_LAYOUT);
    const raw = {
      order: [2, 2, 1, 'x'],
      groups: [g('cast', [1]), {id: 'bad id', name: 'x', color: '#000000', members: []}, g('props', [1, 2], {color: 'red'})],
    };
    const parsed = parseLayout(raw);
    expect(parsed.order).toEqual([2, 1]);
    // an object is in at most one group; a bad colour falls back to a palette one
    expect(parsed.groups.map(x => [x.id, x.members])).toEqual([
      ['cast', [1]],
      ['props', [2]],
    ]);
    expect(parsed.groups[1].color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('trims and caps names, with a default', () => {
    const parsed = parseLayout({order: [], groups: [g('cast', [], {name: '  ' + 'x'.repeat(80)}), g('props', [], {name: ' '})]});
    expect(parsed.groups.map(x => x.name)).toEqual(['x'.repeat(64), 'Group']);
  });
});

describe('listItems', () => {
  it('lists ungrouped objects and groups in order, empty groups last', () => {
    const l = {order: [1, 2, 3, 4], groups: [g('props', []), g('cast', [2, 3])]};
    expect(listItems(l)).toEqual([
      {kind: 'object', id: 1},
      {kind: 'group', group: g('cast', [2, 3])},
      {kind: 'object', id: 4},
      {kind: 'group', group: g('props', [])},
    ]);
  });
});

describe('reordering', () => {
  const ids = [1, 2, 3, 4];

  it('drops an object before or after another, joining that object’s group', () => {
    const l = {order: [1, 2, 3, 4], groups: [g('cast', [2, 3])]};
    expect(run(l, ids, {type: 'moveObject', id: 4, to: {before: 1}})).toEqual({order: [4, 1, 2, 3], groups: [g('cast', [2, 3])]});
    expect(run(l, ids, {type: 'moveObject', id: 1, to: {after: 2}})).toEqual({order: [2, 1, 3, 4], groups: [g('cast', [2, 1, 3])]});
    expect(run(l, ids, {type: 'moveObject', id: 3, to: {after: 4}})).toEqual({order: [1, 2, 4, 3], groups: [g('cast', [2])]});
  });

  it('drops an object onto a group header (its last member) or past the end (ungrouped)', () => {
    const l = {order: [1, 2, 3, 4], groups: [g('cast', [2, 3])]};
    expect(run(l, ids, {type: 'moveObject', id: 1, to: {group: 'cast'}})).toEqual({order: [2, 3, 1, 4], groups: [g('cast', [2, 3, 1])]});
    expect(run(l, ids, {type: 'moveObject', id: 2, to: {end: true}})).toEqual({order: [1, 3, 4, 2], groups: [g('cast', [3])]});
  });

  it('dropping an object on itself changes nothing', () => {
    const l = {order: [1, 2, 3, 4], groups: [g('cast', [2, 3])]};
    expect(run(l, ids, {type: 'moveObject', id: 2, to: {before: 2}})).toEqual(l);
  });

  it('steps an object up and down by keyboard, into and out of open groups', () => {
    const l = {order: [1, 2, 3, 4], groups: [g('cast', [2, 3])]};
    const up = (id: number) => ({type: 'stepObject' as const, id, dir: -1 as const});
    const down = (id: number) => ({type: 'stepObject' as const, id, dir: 1 as const});
    // inside a group: swap with a neighbour; past its ends: out of it
    expect(run(l, ids, down(2))).toEqual({order: [1, 3, 2, 4], groups: [g('cast', [3, 2])]});
    expect(run(l, ids, up(2))).toEqual({order: [1, 2, 3, 4], groups: [g('cast', [3])]});
    expect(run(l, ids, down(3))).toEqual({order: [1, 2, 3, 4], groups: [g('cast', [2])]});
    // an ungrouped object next to an open group steps into it
    expect(run(l, ids, down(1))).toEqual({order: [1, 2, 3, 4], groups: [g('cast', [1, 2, 3])]});
    expect(run(l, ids, up(4))).toEqual({order: [1, 2, 3, 4], groups: [g('cast', [2, 3, 4])]});
    // the first object cannot go up, the last cannot go down
    expect(run(l, ids, up(1))).toEqual(l);
    expect(run({order: [1, 2], groups: []}, [1, 2], down(2))).toEqual({order: [1, 2], groups: []});
  });

  it('steps an object over a collapsed group without joining it', () => {
    const l = {order: [1, 2, 3, 4], groups: [g('cast', [2, 3], {collapsed: true})]};
    expect(run(l, ids, {type: 'stepObject', id: 1, dir: 1})).toEqual({order: [2, 3, 1, 4], groups: [g('cast', [2, 3], {collapsed: true})]});
    expect(run(l, ids, {type: 'stepObject', id: 4, dir: -1})).toEqual({order: [1, 4, 2, 3], groups: [g('cast', [2, 3], {collapsed: true})]});
  });

  it('steps and drags a whole group past its neighbours', () => {
    const l = {order: [1, 2, 3, 4], groups: [g('cast', [2, 3])]};
    expect(run(l, ids, {type: 'stepGroup', groupId: 'cast', dir: -1})).toEqual({order: [2, 3, 1, 4], groups: [g('cast', [2, 3])]});
    expect(run(l, ids, {type: 'stepGroup', groupId: 'cast', dir: 1})).toEqual({order: [1, 4, 2, 3], groups: [g('cast', [2, 3])]});
    expect(run(l, ids, {type: 'moveGroup', groupId: 'cast', before: {object: 1}})).toEqual({order: [2, 3, 1, 4], groups: [g('cast', [2, 3])]});
    expect(run(l, ids, {type: 'moveGroup', groupId: 'cast', before: null})).toEqual({order: [1, 4, 2, 3], groups: [g('cast', [2, 3])]});
  });
});

describe('grouping', () => {
  const ids = [1, 2, 3];

  it('makes a group, with a member where that member was, or empty at the end', () => {
    const made = run(EMPTY_LAYOUT, ids, {type: 'addGroup', id: 'cast', name: 'Cast', color: '#ff4fa3', members: [2]});
    expect(made).toEqual({order: [1, 2, 3], groups: [g('cast', [2])]});
    const empty = run(EMPTY_LAYOUT, ids, {type: 'addGroup', id: 'props', name: 'Props', color: '#ff4fa3'});
    expect(listItems(empty).at(-1)).toEqual({kind: 'group', group: g('props', [])});
  });

  it('keeps an object in one group at a time', () => {
    const l = {order: [1, 2, 3], groups: [g('cast', [1]), g('props', [3])]};
    const moved = run(l, ids, {type: 'setGroup', id: 1, groupId: 'props'});
    expect(moved.groups).toEqual([g('cast', []), g('props', [3, 1])]);
    expect(groupOf(moved, 1)?.id).toBe('props');
  });

  it('takes an object out of its group, just after the group', () => {
    const l = {order: [1, 2, 3], groups: [g('cast', [1, 2])]};
    expect(run(l, ids, {type: 'setGroup', id: 1, groupId: null})).toEqual({order: [2, 1, 3], groups: [g('cast', [2])]});
  });

  it('deleting a group keeps its members, ungrouped, in place', () => {
    const l = {order: [3, 1, 2], groups: [g('cast', [1, 2]), g('props', [3])]};
    expect(run(l, ids, {type: 'removeGroup', groupId: 'cast'})).toEqual({order: [3, 1, 2], groups: [g('props', [3])]});
  });

  it('deleting an object takes it out of the order and its group', () => {
    const l = {order: [3, 1, 2], groups: [g('cast', [1, 2])]};
    expect(run(l, ids, {type: 'removeObject', id: 1})).toEqual({order: [3, 2], groups: [g('cast', [2])]});
  });

  it('a new object goes last, ungrouped', () => {
    const l = {order: [3, 1, 2], groups: [g('cast', [1, 2])]};
    expect(run(l, [1, 2, 3, 4], {type: 'addObject', id: 4})).toEqual({order: [3, 1, 2, 4], groups: [g('cast', [1, 2])]});
  });

  it('renames, recolours, collapses and hides a group', () => {
    const l = {order: [1, 2], groups: [g('cast', [1, 2])]};
    const next = run(
      l,
      [1, 2],
      {type: 'updateGroup', groupId: 'cast', patch: {name: '  Leads  ', color: '#00FF00'}},
      {type: 'updateGroup', groupId: 'cast', patch: {collapsed: true, hidden: true}},
    );
    expect(next.groups[0]).toEqual(g('cast', [1, 2], {name: 'Leads', color: '#00ff00', collapsed: true, hidden: true}));
    expect(hiddenIds(next)).toEqual([1, 2]);
    // a bad colour is ignored, an empty name is the default
    const bad = run(next, [1, 2], {type: 'updateGroup', groupId: 'cast', patch: {color: 'red', name: ' '}});
    expect([bad.groups[0].color, bad.groups[0].name]).toEqual(['#00ff00', 'Group']);
  });

  it('gives new groups ids that are not taken', () => {
    expect(newGroupId(EMPTY_LAYOUT)).toBe('g1');
    expect(newGroupId({order: [], groups: [g('g1', []), g('g7', []), g('cast', [])]})).toBe('g8');
  });
});
