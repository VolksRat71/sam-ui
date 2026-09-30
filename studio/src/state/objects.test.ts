// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {
  Action,
  ServerObject,
  StudioState,
  canAddObject,
  clearTarget,
  comparableIds,
  preferredEngine,
  dirtyIds,
  initialState,
  needsPositiveClick,
  jobProgress,
  nextObjectId,
  reducer,
  staleIds,
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

  it('never reuses a deleted id when given the highest id ever used', () => {
    const s = run([
      {type: 'restore', objects: [server(0, 'tracked'), server(1, 'tracked')]},
      {type: 'removed', id: 1},
    ]);
    expect(nextObjectId(s.objects)).toBe(1); // what the objects alone allow
    expect(nextObjectId(s.objects, 2)).toBe(2);
  });
});

describe('names', () => {
  it('start empty, take renames and backend names, and survive a sync', () => {
    let s = run([{type: 'restore', objects: [server(0, 'tracked'), server(1, 'tracked')]}]);
    expect(s.objects.map(o => o.name)).toEqual([null, null]);
    s = run([{type: 'names', names: {1: 'cup', 9: 'gone'}}, {type: 'rename', id: 0, name: 'plate'}], s);
    expect(s.objects.map(o => o.name)).toEqual(['plate', 'cup']);
    s = run([{type: 'sync', objects: [server(0, 'tracked'), server(1, 'stale')]}], s);
    expect(s.objects.map(o => o.name)).toEqual(['plate', 'cup']);
    // a rename is metadata: the track state stays
    expect(run([{type: 'rename', id: 0, name: 'bowl'}], s).objects[0].state).toBe('tracked');
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
    expect(s.jobs).toEqual([{key: 7, jobId: 'abc', engine: 'sam2', ids: [1], frames: 0, total: null, canceling: false}]);
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
    expect(s.jobs).toEqual([{key: 3, jobId: null, engine: 'sam2', ids: [0, 1], frames: 2, total: null, canceling: false}]);
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

  it('asks for a positive click when a frame has only negative ones and no mask', () => {
    const s = run([
      {type: 'add', id: 0},
      {type: 'setPoints', id: 0, frame: 2, points: [[0.1, 0.1, 0], [0.2, 0.2, 0]]},
      {type: 'setPoints', id: 0, frame: 3, points: [[0.1, 0.1, 0], [0.2, 0.2, 1]]},
    ]);
    expect(needsPositiveClick(byId(s, 0), 2)).toBe(true);
    expect(needsPositiveClick(byId(s, 0), 3)).toBe(false);
    expect(needsPositiveClick(byId(s, 0), 4)).toBe(false);
    expect(needsPositiveClick(undefined, 2)).toBe(false);
    // a lone negative on a tracked frame cuts the tracked mask: the frame keeps one, no hint
    expect(needsPositiveClick(byId(s, 0), 2, true)).toBe(false);
  });

  it('lists the objects whose shown track is stale', () => {
    const s = run([
      {type: 'restore', objects: [server(0, 'tracked'), server(1, 'stale'), server(2, 'untracked')]},
      {type: 'setPoints', id: 0, frame: 4, points: [[0.1, 0.1, 0]]},
    ]);
    expect(staleIds(s)).toEqual([0, 1]);
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

  it('Clear track clears the engine on screen, or the engine that has the track', () => {
    const s = run([
      {
        type: 'restore',
        objects: [
          twoEngines(0, 'tracked', 'untracked'),
          twoEngines(1, 'untracked', 'tracked'), // SAM 3 only, SAM 2 on screen
          twoEngines(2, 'untracked', 'untracked'),
          twoEngines(3, 'tracked', 'stale'),
        ],
      },
    ]);
    const [a, b, c, d] = s.objects;
    expect(clearTarget(a, 'sam2')).toEqual({engine: 'sam2', others: false});
    expect(clearTarget(b, 'sam2')).toEqual({engine: 'sam3', others: false}); // was disabled
    expect(clearTarget(c, 'sam2')).toBeNull();
    expect(clearTarget(d, 'sam2')).toEqual({engine: 'sam2', others: true});
    const held = run([{type: 'trackStarted', key: 1, ids: [0]}], s).objects[0];
    expect(clearTarget(held, 'sam2')).toBeNull();
  });

  it('compares only objects both engines track', () => {
    const s = run([
      {type: 'restore', objects: [twoEngines(0, 'tracked', 'tracked'), twoEngines(1, 'tracked', 'stale')]},
    ]);
    expect(comparableIds(s, 'sam2', 'sam3')).toEqual([0]);
  });
});

describe('job progress', () => {
  it('counts against the backend total when a job runs several passes', () => {
    let s = run([{type: 'restore', objects: [server(1, 'untracked'), server(2, 'untracked')]}, {type: 'trackStarted', key: 1, ids: [1, 2]}]);
    for (let i = 0; i < 90; i++) {
      s = run([{type: 'trackProgress', key: 1}], s);
    }
    const job = s.jobs[0];
    expect(jobProgress(job, 60)).toEqual({done: 60, total: 60, fraction: 1}); // no total yet: never past the video
    s = run([{type: 'trackTotal', key: 1, total: 120}], s); // two passes
    expect(jobProgress(s.jobs[0], 60)).toEqual({done: 90, total: 120, fraction: 0.75});
    expect(jobProgress({frames: 5, total: null}, 0)).toEqual({done: 5, total: null, fraction: 0});
  });
});

describe('absent ranges', () => {
  it('come from the backend, and marking one makes the track stale', () => {
    const tracked = {...server(1, 'tracked'), ranges: [{start: 4, end: 6, state: 'absent'}]};
    let s = run([{type: 'restore', objects: [tracked, server(2, 'tracked')]}]);
    expect(byId(s, 1).ranges).toEqual([{start: 4, end: 6, state: 'absent'}]);
    expect(byId(s, 2).ranges).toEqual([]); // an older backend sends none
    s = run([{type: 'setRanges', id: 2, ranges: [{start: 1, end: 2, state: 'absent'}]}], s);
    expect(byId(s, 2).state).toBe('stale');
    expect(dirtyIds(s)).toEqual([2]);
    expect(byId(s, 1).state).toBe('tracked');
  });

  it('leaves the track alone when the ranges did not change', () => {
    const tracked = {...server(1, 'tracked'), ranges: [{start: 4, end: 6, state: 'absent'}]};
    let s = run([{type: 'restore', objects: [tracked]}]);
    s = run([{type: 'setRanges', id: 1, ranges: [{start: 4, end: 5, state: 'absent'}, {start: 6, end: 6, state: 'absent'}]}], s);
    expect(byId(s, 1).state).toBe('tracked');
  });
});
