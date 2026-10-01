// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {
  EMPTY_HISTORY,
  historyShortcut,
  isTypingTarget,
  moveTargets,
  normalizeHistory,
  undoBlock,
  versionLabel,
  type TrackVersion,
} from './history';
import {type Action, type ServerObject, type StudioState, initialState, reducer} from './objects';

function run(actions: Action[], state: StudioState = initialState): StudioState {
  return actions.reduce(reducer, state);
}

const v = (over: Partial<TrackVersion> = {}): TrackVersion => ({
  key: 'k',
  engine: 'sam2',
  model: 'large',
  created: '2026-09-30T21:04:09-0500',
  elapsedS: 3.2,
  nFrames: 24,
  clicks: 3,
  seedFrames: 2,
  bounded: false,
  current: false,
  ...over,
});

function server(objectId: number, over: Partial<ServerObject> = {}): ServerObject {
  return {
    objectId,
    state: 'tracked',
    frames: [0, 23],
    nFrames: 24,
    seeds: [{frameIndex: 0, points: [[0.5, 0.5]], labels: [1]}],
    ...over,
  };
}

const key = (over: Partial<{key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; target: unknown}>) => ({
  key: 'z',
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  target: null,
  ...over,
});

describe('keyboard shortcuts', () => {
  it('Cmd-Z undoes and Shift-Cmd-Z redoes; Ctrl works too, and Ctrl-Y redoes', () => {
    expect(historyShortcut(key({metaKey: true}))).toBe('undo');
    expect(historyShortcut(key({metaKey: true, shiftKey: true, key: 'Z'}))).toBe('redo');
    expect(historyShortcut(key({ctrlKey: true}))).toBe('undo');
    expect(historyShortcut(key({ctrlKey: true, key: 'y'}))).toBe('redo');
  });

  it('a plain Z, or another key, is not a shortcut', () => {
    expect(historyShortcut(key({}))).toBeNull();
    expect(historyShortcut(key({metaKey: true, key: 'x'}))).toBeNull();
  });

  it('never fires while typing in a field', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(historyShortcut(key({metaKey: true, target: {tagName}}))).toBeNull();
    }
    expect(historyShortcut(key({metaKey: true, target: {tagName: 'DIV', isContentEditable: true}}))).toBeNull();
    expect(historyShortcut(key({metaKey: true, target: {tagName: 'BUTTON'}}))).toBe('undo');
  });

  it('knows a typing target from anything else', () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({tagName: 'input'})).toBe(true);
    expect(isTypingTarget({tagName: 'CANVAS'})).toBe(false);
  });
});

describe('the version list', () => {
  it('labels a version with its time, engine and clicks', () => {
    const now = new Date('2026-09-30T23:00:00-0500');
    expect(versionLabel(v(), now)).toMatch(/^\d{1,2}:04 · SAM 2 · 3 clicks$/);
    expect(versionLabel(v({clicks: 1, engine: 'sam3'}), now)).toMatch(/SAM 3 · 1 click$/);
  });

  it('dates a version from another day', () => {
    const label = versionLabel(v({created: '2026-09-28T09:05:00-0500'}), new Date('2026-09-30T23:00:00-0500'));
    expect(label).toMatch(/^Sep 2[78] \d{1,2}:05 · SAM 2/);
  });

  it('reads a time with no zone colon, as the backend writes it', () => {
    expect(versionLabel(v({created: 'not a date'}))).toBe('SAM 2 · 3 clicks');
  });

  it('normalizes what the backend sends, and none as empty', () => {
    expect(normalizeHistory(undefined)).toEqual(EMPTY_HISTORY);
    const h = normalizeHistory({canUndo: true, canRedo: false, versions: [v({key: 'a'})]});
    expect(h.canUndo).toBe(true);
    expect(h.versions.map(x => x.key)).toEqual(['a']);
  });
});

describe('objects carry their history', () => {
  it('from a restore and every sync', () => {
    const history = {canUndo: true, canRedo: false, versions: [v({current: true})]};
    let s = run([{type: 'restore', objects: [server(1, {history})]}]);
    expect(s.objects[0].history.canUndo).toBe(true);
    expect(s.objects[0].history.versions[0].current).toBe(true);
    s = run([{type: 'sync', objects: [server(1, {history: {...history, canRedo: true}})]}], s);
    expect(s.objects[0].history.canRedo).toBe(true);
  });

  it('a new object, or a backend without history, has an empty one', () => {
    const s = run([{type: 'restore', objects: [server(1)]}, {type: 'add', id: 2}]);
    expect(s.objects.map(o => o.history)).toEqual([EMPTY_HISTORY, EMPTY_HISTORY]);
  });

  it('an undo answer replaces the object from the backend at once', () => {
    let s = run([{type: 'restore', objects: [server(1, {state: 'stale'})]}]);
    s = run([{type: 'objectChanged', object: server(1, {state: 'tracked', history: {canUndo: false, canRedo: true, versions: []}})}], s);
    expect(s.objects[0].state).toBe('tracked');
    expect(s.objects[0].history.canRedo).toBe(true);
  });
});

describe('undo and redo are refused', () => {
  it('while a job holds the object, or with nothing to undo', () => {
    const s = run([{type: 'restore', objects: [server(1, {history: {canUndo: true, canRedo: false, versions: []}})]}]);
    const o = s.objects[0];
    expect(undoBlock(o, 'undo')).toBeNull();
    expect(undoBlock(o, 'redo')).toMatch(/nothing to redo/i);
    expect(undoBlock({...o, running: true}, 'undo')).toMatch(/being tracked/);
    expect(undoBlock(undefined, 'undo')).toMatch(/select an object/i);
  });
});

describe('moving clicks to another object', () => {
  const s = run([
    {
      type: 'restore',
      objects: [
        server(1, {seeds: [{frameIndex: 4, points: [[0.5, 0.5]], labels: [1]}]}),
        server(2, {ranges: [{start: 3, end: 6, state: 'absent'}]}),
        server(3),
        server(4, {state: 'tracking'}),
      ],
    },
  ]);

  it('offers every other object, and says why one cannot take them', () => {
    const targets = moveTargets(s, 1, 4);
    expect(targets.map(t => t.id)).toEqual([2, 3, 4]);
    expect(targets.find(t => t.id === 2)!.blocked).toMatch(/absent/);
    expect(targets.find(t => t.id === 3)!.blocked).toBeNull();
    expect(targets.find(t => t.id === 4)!.blocked).toMatch(/being tracked/);
  });

  it('offers nothing for a frame the object has no clicks on, or while it is tracking', () => {
    expect(moveTargets(s, 1, 5)).toEqual([]);
    expect(moveTargets(s, 4, 0)).toEqual([]);
  });
});
