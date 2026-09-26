// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {
  Action,
  ServerObject,
  StudioState,
  canAddObject,
  comparableIds,
  effectFocusId,
  preferredEngine,
  dirtyIds,
  initialState,
  needsPositiveClick,
  nextObjectId,
  reducer,
} from './objects';

function run(actions: Action[], state: StudioState = initialState): StudioState {
  return actions.reduce(reducer, state);
}

function server(
  objectId: number,
  state: string,
  seeds: Array<[frame: number, points: number[][], labels: number[]]> = [[0, [[0.5, 0.5]], [1]]],
): ServerObject {
  return {
    objectId,
    state,
    frames: state === 'untracked' ? null : [0, 23],
    nFrames: state === 'untracked' ? 0 : 24,
    seeds: seeds.map(([frameIndex, points, labels]) => ({frameIndex, points, labels})),
  };
}

const byId = (s: StudioState, id: number) => s.objects.find(o => o.id === id)!;

describe('id allocation', () => {
  it('starts at 0', () => {
    expect(nextObjectId([])).toBe(0);
  });

  it('never collides with a restored object, gaps included', () => {
    const s = run([{type: 'restore', objects: [server(0, 'tracked'), server(5, 'stale')]}]);
    expect(nextObjectId(s.objects)).toBe(6);
    const s2 = run([{type: 'add', id: nextObjectId(s.objects)}], s);
    expect(nextObjectId(s2.objects)).toBe(7);
  });

  it('reuses the top id only once that object is gone (the backend forgot it)', () => {
    const s = run([
      {type: 'restore', objects: [server(0, 'tracked'), server(1, 'tracked')]},
      {type: 'removed', id: 1},
    ]);
    expect(nextObjectId(s.objects)).toBe(1);
  });
});

describe('restore', () => {
  it('brings objects back with their seed points on their frames', () => {
    const s = run([
      {
        type: 'restore',
        objects: [
          server(3, 'tracked', [
            [0, [[0.1, 0.2]], [1]],
            [7, [[0.3, 0.4], [0.5, 0.6]], [1, 0]],
          ]),
          server(1, 'untracked'),
        ],
      },
    ]);
    expect(s.objects.map(o => o.id)).toEqual([1, 3]);
    expect(byId(s, 3).points).toEqual({0: [[0.1, 0.2, 1]], 7: [[0.3, 0.4, 1], [0.5, 0.6, 0]]});
    expect(byId(s, 3).frames).toEqual([0, 23]);
    expect(byId(s, 1).state).toBe('untracked');
    expect(s.activeId).toBeNull();
  });
});

describe('track selection', () => {
  it('sends only objects with clicks that are untracked or stale', () => {
    const s = run([
      {type: 'restore', objects: [server(0, 'tracked'), server(1, 'stale'), server(2, 'untracked')]},
      {type: 'add', id: 3}, // no clicks yet
    ]);
    expect(dirtyIds(s)).toEqual([1, 2]);
  });

  it('a new object added after a track is the only one sent next', () => {
    let s = run([
      {type: 'add', id: 0},
      {type: 'setPoints', id: 0, frame: 0, points: [[0.2, 0.2, 1]]},
      {type: 'add', id: 1},
      {type: 'setPoints', id: 1, frame: 0, points: [[0.7, 0.7, 1]]},
    ]);
    expect(dirtyIds(s)).toEqual([0, 1]);
    s = run(
      [
        {type: 'trackStarted', key: 1, ids: [0, 1]},
        {type: 'trackFinished', key: 1, tracked: [0, 1], failed: {}},
      ],
      s,
    );
    expect(dirtyIds(s)).toEqual([]);
    s = run([{type: 'add', id: 2}, {type: 'setPoints', id: 2, frame: 5, points: [[0.5, 0.5, 1]]}], s);
    expect(dirtyIds(s)).toEqual([2]);
  });

  it('running objects are not sent again: a second press runs only the rest', () => {
    let s = run([
      {type: 'restore', objects: [server(0, 'untracked'), server(1, 'untracked')]},
      {type: 'trackStarted', key: 1, ids: [0]},
    ]);
    expect(dirtyIds(s)).toEqual([1]);
    s = run([{type: 'trackStarted', key: 2, ids: [1]}], s);
    expect(s.jobs.map(j => j.ids)).toEqual([[0], [1]]);
    expect(dirtyIds(s)).toEqual([]);
    // the first job ends; the second still holds object 1
    s = run([{type: 'trackFinished', key: 1, tracked: [0], failed: {}}], s);
    expect(s.objects.map(o => [o.id, o.state, o.running])).toEqual([
      [0, 'tracked', false],
      [1, 'untracked', true],
    ]);
  });

  it('objects another tab is tracking are not sent', () => {
    const s = run([{type: 'restore', objects: [server(0, 'tracking'), server(1, 'stale')]}]);
    expect(dirtyIds(s)).toEqual([1]);
  });

  it('an object the backend would not claim is released when the job attaches', () => {
    const s = run([
      {type: 'restore', objects: [server(0, 'untracked'), server(1, 'untracked')]},
      {type: 'trackStarted', key: 7, ids: [0, 1]},
      {type: 'trackAttached', key: 7, jobId: 'abc', selected: [1]},
    ]);
    expect(s.jobs).toEqual([{key: 7, jobId: 'abc', engine: 'sam2', ids: [1], frames: 0, canceling: false}]);
    expect(dirtyIds(s)).toEqual([0]);
  });
});

describe('state transitions', () => {
  it('a click on a tracked object makes it stale', () => {
    const s = run([
      {type: 'restore', objects: [server(0, 'tracked')]},
      {type: 'setPoints', id: 0, frame: 9, points: [[0.4, 0.4, 0]]},
    ]);
    expect(byId(s, 0).state).toBe('stale');
  });

  it('removing its last click makes an object untracked (the backend drops its track)', () => {
    const s = run([
      {type: 'restore', objects: [server(0, 'tracked')]},
      {type: 'setPoints', id: 0, frame: 0, points: []},
    ]);
    expect(byId(s, 0)).toMatchObject({state: 'untracked', frames: null, nFrames: 0, points: {}});
  });

  it('a finished job marks what it tracked and records what failed', () => {
    const s = run([
      {type: 'restore', objects: [server(0, 'untracked'), server(1, 'stale'), server(2, 'tracked')]},
      {type: 'trackStarted', key: 3, ids: [0, 1]},
      {type: 'trackProgress', key: 3},
      {type: 'trackProgress', key: 3},
    ]);
    expect(s.jobs).toEqual([{key: 3, jobId: null, engine: 'sam2', ids: [0, 1], frames: 2, canceling: false}]);
    expect(byId(s, 0).running).toBe(true);
    expect(byId(s, 2).running).toBe(false);
    const done = reducer(s, {type: 'trackFinished', key: 3, tracked: [0], failed: {1: 'OSError'}});
    expect(done.jobs).toEqual([]);
    expect(byId(done, 0)).toMatchObject({state: 'tracked', running: false});
    expect(byId(done, 1)).toMatchObject({state: 'stale', running: false, error: 'OSError'});
    expect(byId(done, 2).state).toBe('tracked');
  });

  it('a failed or cancelled job changes no state', () => {
    const s = run([
      {type: 'restore', objects: [server(0, 'untracked'), server(1, 'stale')]},
      {type: 'trackStarted', key: 4, ids: [0, 1]},
      {type: 'trackCanceling', key: 4},
    ]);
    expect(s.jobs[0].canceling).toBe(true);
    const failed = reducer(s, {type: 'trackFailed', key: 4, error: 'canceled'});
    expect(failed.jobs).toEqual([]);
    expect(failed.notice).toBe('canceled');
    expect(failed.objects.map(o => [o.state, o.running])).toEqual([
      ['untracked', false],
      ['stale', false],
    ]);
    expect(dirtyIds(failed)).toEqual([0, 1]);
  });

  it('clearing a track makes the object untracked and keeps its clicks', () => {
    const s = run([
      {type: 'restore', objects: [server(0, 'tracked')]},
      {type: 'trackCleared', id: 0},
    ]);
    expect(byId(s, 0)).toMatchObject({state: 'untracked', frames: null, nFrames: 0});
    expect(byId(s, 0).points[0]).toHaveLength(1);
    expect(dirtyIds(s)).toEqual([0]);
  });

  it('sync takes the server state but keeps an unclicked new object and the running flags', () => {
    const s = run([
      {type: 'restore', objects: [server(0, 'untracked'), server(1, 'untracked')]},
      {type: 'trackStarted', key: 1, ids: [0]},
      {type: 'add', id: 2},
      {type: 'sync', objects: [server(0, 'untracked'), server(3, 'tracked')]},
    ]);
    // 1 has clicks but the server forgot it: gone. 2 has none yet: kept.
    expect(s.objects.map(o => o.id)).toEqual([0, 2, 3]);
    expect(byId(s, 0).running).toBe(true);
    expect(byId(s, 3).state).toBe('tracked');
    expect(s.activeId).toBe(2);
  });

  it('start over empties the list', () => {
    const s = run([{type: 'restore', objects: [server(0, 'tracked')]}, {type: 'reset'}]);
    expect(s).toEqual(initialState);
  });
});

describe('limits and hints', () => {
  it('caps the number of objects, and allows adding while a job runs', () => {
    let s = run([{type: 'add', id: 0}, {type: 'add', id: 1}]);
    expect(canAddObject(s, 2)).toBe(false);
    expect(canAddObject(s, 3)).toBe(true);
    s = run([{type: 'trackStarted', key: 1, ids: [0]}], s);
    expect(canAddObject(s, 3)).toBe(true);
  });

  it('asks for a positive click when a frame has only negative ones', () => {
    const s = run([
      {type: 'add', id: 0},
      {type: 'setPoints', id: 0, frame: 2, points: [[0.1, 0.1, 0], [0.2, 0.2, 0]]},
      {type: 'setPoints', id: 0, frame: 3, points: [[0.1, 0.1, 0], [0.2, 0.2, 1]]},
    ]);
    expect(needsPositiveClick(byId(s, 0), 2)).toBe(true);
    expect(needsPositiveClick(byId(s, 0), 3)).toBe(false);
    expect(needsPositiveClick(byId(s, 0), 4)).toBe(false);
    expect(needsPositiveClick(undefined, 2)).toBe(false);
  });
});

describe('engines', () => {
  /** An object with a track per engine, as objectTracks sends it. */
  function twoEngines(objectId: number, sam2: string, sam3: string): ServerObject {
    const t = (engine: string, state: string) => ({
      engine,
      state,
      frames: state === 'untracked' ? null : [0, 23],
      nFrames: state === 'untracked' ? 0 : 24,
    });
    return {...server(objectId, sam2), tracks: [t('sam2', sam2), t('sam3', sam3)]};
  }

  it('shows and selects by the current engine', () => {
    let s = run([{type: 'restore', objects: [twoEngines(0, 'tracked', 'untracked'), twoEngines(1, 'stale', 'tracked')]}]);
    expect(s.objects.map(o => o.state)).toEqual(['tracked', 'stale']);
    expect(dirtyIds(s)).toEqual([1]);
    s = reducer(s, {type: 'setEngine', engine: 'sam3'});
    expect(s.objects.map(o => o.state)).toEqual(['untracked', 'tracked']);
    expect(dirtyIds(s)).toEqual([0]);
  });

  it('a job on one engine neither blocks nor marks the other', () => {
    let s = run([
      {type: 'restore', objects: [twoEngines(0, 'untracked', 'untracked')]},
      {type: 'trackStarted', key: 1, ids: [0], engine: 'sam3'},
    ]);
    expect(s.objects[0].running).toBe(false); // viewing sam2; the sam3 job holds it there only
    expect(dirtyIds(s)).toEqual([0]);
    s = run([{type: 'trackFinished', key: 1, tracked: [0], failed: {}}], s);
    expect(s.objects[0].state).toBe('untracked');
    expect(s.objects[0].engines.sam3.state).toBe('tracked');
  });

  it('a click makes every engine stale; clearing one engine keeps the other', () => {
    let s = run([
      {type: 'restore', objects: [twoEngines(0, 'tracked', 'tracked')]},
      {type: 'setPoints', id: 0, frame: 5, points: [[0.1, 0.1, 1]]},
    ]);
    expect([s.objects[0].engines.sam2.state, s.objects[0].engines.sam3.state]).toEqual(['stale', 'stale']);
    s = run([{type: 'restore', objects: [twoEngines(0, 'tracked', 'tracked')]}, {type: 'trackCleared', id: 0, engine: 'sam3'}]);
    expect([s.objects[0].engines.sam2.state, s.objects[0].engines.sam3.state]).toEqual(['tracked', 'untracked']);
    s = reducer(s, {type: 'trackCleared', id: 0, engine: null});
    expect(s.objects[0].engines.sam2.state).toBe('untracked');
  });

  it('focuses effects by the engine on screen, for a restore with SAM 3 tracks only', () => {
    // the upload Nate reported: three objects, SAM 3 tracks only (one stale)
    const restored = [
      twoEngines(0, 'untracked', 'tracked'),
      twoEngines(1, 'untracked', 'tracked'),
      twoEngines(2, 'untracked', 'stale'),
    ];
    let s = run([{type: 'restore', objects: restored}, {type: 'select', id: 0}]);
    expect(effectFocusId(s)).toBeNull(); // on SAM 2 there is no track to draw an effect on
    s = reducer(s, {type: 'setEngine', engine: 'sam3'});
    expect(effectFocusId(s)).toBe(0);
    s = reducer(s, {type: 'select', id: 1});
    expect(effectFocusId(s)).toBe(1);
    s = reducer(s, {type: 'select', id: 2});
    expect(effectFocusId(s)).toBeNull(); // stale: its masks are not its clicks' any more
    // the ids, colours and states stay with their own objects through the restore
    expect(s.objects.map(o => [o.id, o.color, o.engines.sam3.state])).toEqual([
      [0, '#3880F3', 'tracked'],
      [1, '#F0AA19', 'tracked'],
      [2, '#00D2BE', 'stale'],
    ]);
  });

  it('opens a SAM 3-only video on SAM 3, and keeps an engine that has tracks', () => {
    const restored = [twoEngines(0, 'untracked', 'tracked'), twoEngines(1, 'untracked', 'stale')];
    expect(preferredEngine(restored, 'sam2', ['sam2', 'sam3'])).toBe('sam3');
    expect(preferredEngine(restored, 'sam2', ['sam2'])).toBe('sam2'); // SAM 3 unavailable
    expect(preferredEngine([twoEngines(0, 'tracked', 'tracked')], 'sam2', ['sam2', 'sam3'])).toBe('sam2');
    expect(preferredEngine([], 'sam3', ['sam2', 'sam3'])).toBe('sam3');
  });

  it('keeps the chosen engine through a restore', () => {
    const s = run([
      {type: 'setEngine', engine: 'sam3'},
      {type: 'restore', objects: [twoEngines(0, 'untracked', 'tracked')]},
    ]);
    expect(s.engine).toBe('sam3');
    expect(s.objects[0].state).toBe('tracked');
  });

  it('compares only objects both engines track', () => {
    const s = run([
      {type: 'restore', objects: [twoEngines(0, 'tracked', 'tracked'), twoEngines(1, 'tracked', 'stale')]},
    ]);
    expect(comparableIds(s, 'sam2', 'sam3')).toEqual([0]);
  });
});
