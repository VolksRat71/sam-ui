// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The object layout (issue #21) as pure functions: the order of a video's
// objects and their groups, as the backend's tracks/layout.py stores it in
// tracks/<video>/layout.json (OPFS, seeds/<video>/layout.json, in the build
// with no backend):
//
//   {order: [objectId, ...], groups: [{id, name, color, members, collapsed, hidden}]}
//
// The order is the Objects list's, the timeline lanes' and every export's. An
// object is in at most one group. A group's members always sit together in
// the order, at the place of its first member; a group with no members is
// listed last. "collapsed" folds the group in the list, "hidden" keeps its
// masks off the preview (never off an export).
//
// The layout is metadata: no reorder or regroup changes a seeds key, makes a
// track stale or goes on an object's undo history. A video with no layout keeps
// creation order (id order: ids are never reused) and has no groups.
//
// Every reducer action works on the layout arranged against the objects that
// exist (arrange), and answers an arranged layout.

export type ObjectGroup = {
  id: string;
  name: string;
  /** #rrggbb, lower case. */
  color: string;
  /** Object ids, in list order. */
  members: number[];
  collapsed: boolean;
  hidden: boolean;
};

export type Layout = {order: number[]; groups: ObjectGroup[]};

export const EMPTY_LAYOUT: Layout = {order: [], groups: []};

export const GROUP_NAME_MAX = 64;
/** The backend's limits (tracks/layout.py): it refuses a layout past them, and a read drops the excess. */
export const MAX_GROUPS = 64;
/** Per list: the order, and each group's members. */
export const MAX_IDS = 4096;
export const MAX_ID = 1_000_000;
export const DEFAULT_GROUP_NAME = 'Group';
const GROUP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
/** Group colours: the backend export's palette (tracks/export.py). */
export const GROUP_PALETTE = ['#b4ff00', '#ff4fa3', '#3fd0ff', '#ffb020', '#9b6bff', '#2fe38a', '#ff5a36', '#f2f25a'];

export type ListItem = {kind: 'object'; id: number} | {kind: 'group'; group: ObjectGroup};

/** Where an object is dropped: before or after another object (joining its group), onto a group, or past the end. */
export type DropTarget = {before: number} | {after: number} | {group: string} | {end: true};

export type GroupPatch = Partial<Pick<ObjectGroup, 'name' | 'color' | 'collapsed' | 'hidden'>>;

export type LayoutAction =
  | {type: 'addObject'; id: number}
  | {type: 'removeObject'; id: number}
  | {type: 'moveObject'; id: number; to: DropTarget}
  /** Keyboard reorder: one place up (-1) or down (1), into and out of open groups. */
  | {type: 'stepObject'; id: number; dir: -1 | 1}
  | {type: 'stepGroup'; groupId: string; dir: -1 | 1}
  /** Put a group before an object (or that object's group), or last (null). */
  | {type: 'moveGroup'; groupId: string; before: {object: number} | {group: string} | null}
  /** Into a group as its last member, or (null) out of its group, just after it. */
  | {type: 'setGroup'; id: number; groupId: string | null}
  /** A new group; with members, it sits where the first of them is. */
  | {type: 'addGroup'; id: string; name: string; color: string; members?: number[]}
  /** Its members stay where they are, ungrouped. */
  | {type: 'removeGroup'; groupId: string}
  | {type: 'updateGroup'; groupId: string; patch: GroupPatch};

export function cleanGroupName(raw: unknown): string {
  const name = (typeof raw === 'string' ? raw : '').trim().slice(0, GROUP_NAME_MAX).trim();
  return name === '' ? DEFAULT_GROUP_NAME : name;
}

function ids(raw: unknown): number[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const valid = raw.filter((x): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= MAX_ID);
  return [...new Set(valid)].slice(0, MAX_IDS);
}

/** A stored or received layout, tolerating anything malformed (a damaged file reads as no layout). */
export function parseLayout(raw: unknown): Layout {
  if (raw == null || typeof raw !== 'object') {
    return EMPTY_LAYOUT;
  }
  const r = raw as {order?: unknown; groups?: unknown};
  const taken = new Set<number>();
  const seen = new Set<string>();
  const groups: ObjectGroup[] = [];
  for (const x of Array.isArray(r.groups) ? r.groups.slice(0, MAX_GROUPS) : []) {
    const gr = (x ?? {}) as Record<string, unknown>;
    if (typeof gr.id !== 'string' || !GROUP_ID.test(gr.id) || seen.has(gr.id)) {
      continue;
    }
    seen.add(gr.id);
    const members = ids(gr.members).filter(m => !taken.has(m));
    members.forEach(m => taken.add(m));
    groups.push({
      id: gr.id,
      name: cleanGroupName(gr.name),
      color: typeof gr.color === 'string' && COLOR.test(gr.color) ? gr.color.toLowerCase() : GROUP_PALETTE[groups.length % GROUP_PALETTE.length],
      members,
      collapsed: gr.collapsed === true,
      hidden: gr.hidden === true,
    });
  }
  return {order: ids(r.order), groups};
}

/**
 * The layout against the objects that exist: ids that are gone dropped,
 * objects it does not name appended in creation order, and each group's
 * members together where its first member is.
 */
export function arrange(layout: Layout, objectIds: ReadonlyArray<number>): Layout {
  const known = [...new Set(objectIds)].sort((a, b) => a - b);
  const have = new Set(known);
  const order = layout.order.filter(o => have.has(o));
  const listed = new Set(order);
  order.push(...known.filter(o => !listed.has(o)));
  const rank = new Map(order.map((o, i) => [o, i]));
  const groups = layout.groups.map(gr => ({
    ...gr,
    members: gr.members.filter(m => have.has(m)).sort((a, b) => rank.get(a)! - rank.get(b)!),
  }));
  const groupOfId = new Map(groups.flatMap(gr => gr.members.map(m => [m, gr] as const)));
  const flat: number[] = [];
  const placed = new Set<string>();
  for (const o of order) {
    const gr = groupOfId.get(o);
    if (gr == null) {
      flat.push(o);
    } else if (!placed.has(gr.id)) {
      placed.add(gr.id);
      flat.push(...gr.members);
    }
  }
  return {order: flat, groups};
}

/** The Objects list's rows: ungrouped objects and groups, in order; groups with no members last. */
export function listItems(layout: Layout): ListItem[] {
  const groupOfId = new Map(layout.groups.flatMap(gr => gr.members.map(m => [m, gr] as const)));
  const out: ListItem[] = [];
  const placed = new Set<string>();
  for (const o of layout.order) {
    const gr = groupOfId.get(o);
    if (gr == null) {
      out.push({kind: 'object', id: o});
    } else if (!placed.has(gr.id)) {
      placed.add(gr.id);
      out.push({kind: 'group', group: gr});
    }
  }
  for (const gr of layout.groups) {
    if (!placed.has(gr.id)) {
      out.push({kind: 'group', group: gr});
    }
  }
  return out;
}

export function groupOf(layout: Layout, id: number): ObjectGroup | null {
  return layout.groups.find(gr => gr.members.includes(id)) ?? null;
}

/** The members of hidden groups: kept off the preview. */
export function hiddenIds(layout: Layout): number[] {
  return layout.groups.filter(gr => gr.hidden).flatMap(gr => gr.members);
}

/** "g<n>", one past the highest such id. */
export function newGroupId(layout: Layout): string {
  const n = layout.groups.reduce((m, gr) => Math.max(m, /^g(\d+)$/.test(gr.id) ? Number(gr.id.slice(1)) : 0), 0);
  return `g${n + 1}`;
}

export function nextGroupColor(layout: Layout): string {
  return GROUP_PALETTE[layout.groups.length % GROUP_PALETTE.length];
}

// -- the list as a tree: top-level items, and each group's members ---------------

type Top = {kind: 'object'; id: number} | {kind: 'group'; id: string};
type Tree = {top: Top[]; members: Map<string, number[]>; groups: ObjectGroup[]};

function toTree(layout: Layout): Tree {
  return {
    top: listItems(layout).map(it => (it.kind === 'object' ? it : {kind: 'group', id: it.group.id})),
    members: new Map(layout.groups.map(gr => [gr.id, [...gr.members]])),
    groups: layout.groups,
  };
}

function fromTree(t: Tree): Layout {
  const order = t.top.flatMap(it => (it.kind === 'object' ? [it.id] : (t.members.get(it.id) ?? [])));
  return {order, groups: t.groups.map(gr => ({...gr, members: t.members.get(gr.id) ?? []}))};
}

const isObj = (id: number) => (it: Top) => it.kind === 'object' && it.id === id;
const isGroup = (id: string) => (it: Top) => it.kind === 'group' && it.id === id;

/** Take object `id` out of wherever it is. */
function detach(t: Tree, id: number): void {
  const i = t.top.findIndex(isObj(id));
  if (i >= 0) {
    t.top.splice(i, 1);
  }
  for (const [gid, m] of t.members) {
    if (m.includes(id)) {
      t.members.set(gid, m.filter(x => x !== id));
    }
  }
}

function containerOf(t: Tree, id: number): string | null {
  for (const [gid, m] of t.members) {
    if (m.includes(id)) {
      return gid;
    }
  }
  return null;
}

function collapsed(t: Tree, gid: string): boolean {
  return t.groups.find(gr => gr.id === gid)?.collapsed === true;
}

function swap<T>(xs: T[], i: number, j: number): void {
  [xs[i], xs[j]] = [xs[j], xs[i]];
}

function moveObject(t: Tree, id: number, to: DropTarget): void {
  if (('before' in to && to.before === id) || ('after' in to && to.after === id)) {
    return;
  }
  if ('group' in to && !t.members.has(to.group)) {
    return;
  }
  detach(t, id);
  if ('end' in to) {
    t.top.push({kind: 'object', id});
  } else if ('group' in to) {
    t.members.get(to.group)!.push(id);
  } else {
    const target = 'before' in to ? to.before : to.after;
    const offset = 'before' in to ? 0 : 1;
    const gid = containerOf(t, target);
    if (gid != null) {
      const m = t.members.get(gid)!;
      m.splice(m.indexOf(target) + offset, 0, id);
    } else {
      const i = t.top.findIndex(isObj(target));
      t.top.splice(i < 0 ? t.top.length : i + offset, 0, {kind: 'object', id});
    }
  }
}

function stepObject(t: Tree, id: number, dir: -1 | 1): void {
  const gid = containerOf(t, id);
  if (gid != null) {
    const m = t.members.get(gid)!;
    const k = m.indexOf(id);
    if (k + dir >= 0 && k + dir < m.length) {
      swap(m, k, k + dir);
      return;
    }
    // past the group's end: out of it, beside it
    m.splice(k, 1);
    const at = t.top.findIndex(isGroup(gid));
    t.top.splice(dir < 0 ? at : at + 1, 0, {kind: 'object', id});
    return;
  }
  const i = t.top.findIndex(isObj(id));
  const j = i + dir;
  if (i < 0 || j < 0 || j >= t.top.length) {
    return;
  }
  const next = t.top[j];
  if (next.kind === 'group' && !collapsed(t, next.id)) {
    // into the open group beside it, at its near end
    t.top.splice(i, 1);
    const m = t.members.get(next.id)!;
    if (dir < 0) {
      m.push(id);
    } else {
      m.unshift(id);
    }
    return;
  }
  swap(t.top, i, j);
}

function stepGroup(t: Tree, gid: string, dir: -1 | 1): void {
  const i = t.top.findIndex(isGroup(gid));
  const j = i + dir;
  if (i >= 0 && j >= 0 && j < t.top.length) {
    swap(t.top, i, j);
  }
}

function moveGroup(t: Tree, gid: string, before: {object: number} | {group: string} | null): void {
  const i = t.top.findIndex(isGroup(gid));
  if (i < 0) {
    return;
  }
  let target: Top | null = null;
  if (before != null && 'object' in before) {
    const host = containerOf(t, before.object);
    if (host === gid) {
      return; // onto one of its own members
    }
    target = t.top.find(host != null ? isGroup(host) : isObj(before.object)) ?? null;
  } else if (before != null) {
    if (before.group === gid) {
      return;
    }
    target = t.top.find(isGroup(before.group)) ?? null;
  }
  const [item] = t.top.splice(i, 1);
  const at = target == null ? t.top.length : t.top.indexOf(target);
  t.top.splice(at, 0, item);
}

function setGroup(t: Tree, id: number, gid: string | null): void {
  if (gid != null) {
    moveObject(t, id, {group: gid});
    return;
  }
  const host = containerOf(t, id);
  if (host == null) {
    return;
  }
  detach(t, id);
  t.top.splice(t.top.findIndex(isGroup(host)) + 1, 0, {kind: 'object', id});
}

function patchGroup(gr: ObjectGroup, patch: GroupPatch): ObjectGroup {
  return {
    ...gr,
    ...(patch.name !== undefined ? {name: cleanGroupName(patch.name)} : {}),
    ...(patch.color !== undefined && COLOR.test(patch.color) ? {color: patch.color.toLowerCase()} : {}),
    ...(patch.collapsed !== undefined ? {collapsed: patch.collapsed} : {}),
    ...(patch.hidden !== undefined ? {hidden: patch.hidden} : {}),
  };
}

/** `objectIds`: the objects that exist, after the action (a new object's id included). */
export function layoutReducer(layout: Layout, action: LayoutAction, objectIds: ReadonlyArray<number>): Layout {
  const known =
    action.type === 'addObject'
      ? [...objectIds, action.id]
      : action.type === 'removeObject'
        ? objectIds.filter(o => o !== action.id)
        : objectIds;
  const base = arrange(layout, known);
  const t = toTree(base);
  switch (action.type) {
    case 'addObject':
      return base; // arrange appends it, ungrouped
    case 'removeObject':
      detach(t, action.id);
      break;
    case 'moveObject':
      moveObject(t, action.id, action.to);
      break;
    case 'stepObject':
      stepObject(t, action.id, action.dir);
      break;
    case 'stepGroup':
      stepGroup(t, action.groupId, action.dir);
      break;
    case 'moveGroup':
      moveGroup(t, action.groupId, action.before);
      break;
    case 'setGroup':
      setGroup(t, action.id, action.groupId);
      break;
    case 'addGroup': {
      if (!GROUP_ID.test(action.id) || t.members.has(action.id) || t.groups.length >= MAX_GROUPS) {
        return base;
      }
      const members = (action.members ?? []).filter(m => base.order.includes(m));
      const first = base.order.find(o => members.includes(o));
      const firstAt = first == null ? -1 : t.top.findIndex(it => (it.kind === 'object' ? it.id === first : t.members.get(it.id)?.includes(first)));
      members.forEach(m => detach(t, m));
      const group = patchGroup(
        {id: action.id, name: DEFAULT_GROUP_NAME, color: GROUP_PALETTE[0], members: [], collapsed: false, hidden: false},
        {name: action.name, color: action.color},
      );
      t.groups = [...t.groups, group];
      t.members.set(action.id, members);
      if (members.length > 0) {
        t.top.splice(Math.min(firstAt, t.top.length), 0, {kind: 'group', id: action.id});
      }
      break;
    }
    case 'removeGroup': {
      const at = t.top.findIndex(isGroup(action.groupId));
      const members = t.members.get(action.groupId) ?? [];
      if (at >= 0) {
        t.top.splice(at, 1, ...members.map(id => ({kind: 'object' as const, id})));
      }
      t.members.delete(action.groupId);
      t.groups = t.groups.filter(gr => gr.id !== action.groupId);
      break;
    }
    case 'updateGroup':
      t.groups = t.groups.map(gr => (gr.id === action.groupId ? patchGroup(gr, action.patch) : gr));
      break;
  }
  return arrange(fromTree(t), known);
}
