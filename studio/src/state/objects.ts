// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The Objects list as a pure reducer: which objects exist, their seed clicks,
// their track state per engine, and the track jobs this page is running
// (several may run at once, each on its own objects and engine). The worker
// owns the masks; this owns everything the UI decides with.
//
// Track state mirrors the backend (tracks/store.py, tracks/jobs.py), once per
// engine: untracked (no track), stale (a track, but the seeds changed since),
// tracked, and tracking (a running job on that engine holds the object, maybe
// another tab's). `engine` is the one the UI tracks with and shows; each
// object's state / frames / nFrames are that engine's. The backend stays the
// authority: after each call the UI syncs from objectTracks, and the reducer's
// own transitions only keep the list right in between.
import {THEME_COLORS} from '@/theme/colors';

export type TrackState = 'untracked' | 'stale' | 'tracked' | 'tracking';
export type Label = 0 | 1;
/** A click, normalised to 0-1 (x / width, y / height), as the backend stores it. */
export type NormPoint = [x: number, y: number, label: Label];

export const DEFAULT_ENGINE = 'sam2';

type ServerTrack = {
  readonly engine: string;
  readonly state: string;
  readonly frames?: ReadonlyArray<number> | null;
  readonly nFrames: number;
};

/** The GraphQL ObjectTrack, as startSession and objectTracks return it. */
export type ServerObject = {
  readonly objectId: number;
  readonly state: string;
  readonly frames?: ReadonlyArray<number> | null;
  readonly nFrames: number;
  readonly seeds: ReadonlyArray<{
    readonly frameIndex: number;
    readonly points: ReadonlyArray<ReadonlyArray<number>>;
    readonly labels: ReadonlyArray<number>;
    readonly mask?: {readonly size: ReadonlyArray<number>; readonly counts: string} | null;
  }>;
  /** One entry per engine; the top-level fields are the default engine's. */
  readonly tracks?: ReadonlyArray<ServerTrack>;
};

export type EngineTrack = {
  state: TrackState;
  /** [first, last] frame of the cached track, when there is one. */
  frames: [number, number] | null;
  nFrames: number;
};

export type StudioObject = {
  id: number;
  color: string;
  /** The current engine's track: a view of `engines[engine]`. */
  state: TrackState;
  frames: [number, number] | null;
  nFrames: number;
  /** Every engine's track, by engine name. */
  engines: Record<string, EngineTrack>;
  /** Seed clicks per frame. A frame with no clicks has no key. */
  points: Record<number, NormPoint[]>;
  /** Held by one of this page's running jobs on the current engine. */
  running: boolean;
  /** Why this object's last track failed. */
  error: string | null;
};

export type Job = {
  /** Client key, known before the backend answers. */
  key: number;
  /** The backend's Job-Id, once the stream has started. */
  jobId: string | null;
  engine: string;
  ids: number[];
  /** Frames streamed so far. */
  frames: number;
  canceling: boolean;
};

export type StudioState = {
  /** The engine Track runs and the preview shows. */
  engine: string;
  objects: StudioObject[];
  activeId: number | null;
  jobs: Job[];
  /** The last job-level failure, shown until the next job starts. */
  notice: string | null;
};

export type Action =
  | {type: 'restore'; objects: ReadonlyArray<ServerObject>}
  | {type: 'sync'; objects: ReadonlyArray<ServerObject>}
  | {type: 'setEngine'; engine: string}
  | {type: 'add'; id: number}
  | {type: 'select'; id: number | null}
  | {type: 'setPoints'; id: number; frame: number; points: NormPoint[]}
  | {type: 'trackStarted'; key: number; ids: number[]; engine?: string}
  | {type: 'trackAttached'; key: number; jobId: string | null; selected: number[]}
  | {type: 'trackProgress'; key: number}
  | {type: 'trackCanceling'; key: number}
  | {type: 'trackFinished'; key: number; tracked: number[]; failed: Record<number, string>}
  | {type: 'trackFailed'; key: number; error: string}
  /** engine null: every engine's track was cleared. */
  | {type: 'trackCleared'; id: number; engine?: string | null}
  | {type: 'removed'; id: number}
  | {type: 'reset'};

export const initialState: StudioState = {
  engine: DEFAULT_ENGINE,
  objects: [],
  activeId: null,
  jobs: [],
  notice: null,
};

const NO_TRACK: EngineTrack = {state: 'untracked', frames: null, nFrames: 0};

export function colorFor(id: number): string {
  return THEME_COLORS[id % THEME_COLORS.length];
}

export function toTrackState(state: string | undefined): TrackState {
  return state === 'tracked' || state === 'stale' || state === 'tracking' ? state : 'untracked';
}

function seedsToPoints(seeds: ServerObject['seeds']): Record<number, NormPoint[]> {
  const out: Record<number, NormPoint[]> = {};
  for (const s of seeds) {
    const pts = s.points.map(
      (p, i): NormPoint => [p[0], p[1], s.labels[i] === 0 ? 0 : 1],
    );
    if (pts.length > 0) {
      out[s.frameIndex] = pts;
    }
  }
  return out;
}

function trackFrames(frames: ServerTrack['frames']): [number, number] | null {
  return frames != null && frames.length >= 2 ? [frames[0], frames[1]] : null;
}

function toEngineTrack(t: {state: string; frames?: ReadonlyArray<number> | null; nFrames: number}): EngineTrack {
  return {state: toTrackState(t.state), frames: trackFrames(t.frames), nFrames: t.nFrames};
}

/** Point an object's top-level state at one engine. */
function viewed(o: StudioObject, engine: string): StudioObject {
  const t = o.engines[engine] ?? NO_TRACK;
  return {...o, state: t.state, frames: t.frames, nFrames: t.nFrames};
}

export function fromServer(o: ServerObject, engine: string = DEFAULT_ENGINE): StudioObject {
  const engines: Record<string, EngineTrack> = {};
  if (o.tracks != null && o.tracks.length > 0) {
    for (const t of o.tracks) {
      engines[t.engine] = toEngineTrack(t);
    }
  } else {
    engines[DEFAULT_ENGINE] = toEngineTrack(o);
  }
  return viewed(
    {
      id: o.objectId,
      color: colorFor(o.objectId),
      state: 'untracked',
      frames: null,
      nFrames: 0,
      engines,
      points: seedsToPoints(o.seeds),
      running: false,
      error: null,
    },
    engine,
  );
}

export function hasSeeds(o: StudioObject): boolean {
  return Object.values(o.points).some(p => p.length > 0);
}

export function seedFrames(o: StudioObject): number[] {
  return Object.keys(o.points)
    .map(Number)
    .filter(f => o.points[f].length > 0)
    .sort((a, b) => a - b);
}

/** Held by a running job on the current engine, this page's or another's. */
export function isTracking(o: StudioObject): boolean {
  return o.running || o.state === 'tracking';
}

/**
 * The objects a Track press sends: the ones with clicks whose track on the
 * current engine is missing or stale, and that no running job on it holds.
 * Tracked objects are never re-run, and their masks stay on screen. A press
 * while a job runs starts a second job for the rest.
 */
export function dirtyIds(state: StudioState): number[] {
  return state.objects
    .filter(o => hasSeeds(o) && o.state !== 'tracked' && !isTracking(o))
    .map(o => o.id)
    .sort((a, b) => a - b);
}

/**
 * The engine to show after a restore: the current one if any object has a
 * track on it, else an available engine that does (the one with the most
 * tracked objects), else the current one. A video tracked only with SAM 3
 * then opens on SAM 3 instead of showing nothing.
 */
export function preferredEngine(
  objects: ReadonlyArray<ServerObject>,
  current: string,
  available: ReadonlyArray<string>,
): string {
  const tracks = (o: ServerObject, e: string) =>
    toTrackState(o.tracks?.find(t => t.engine === e)?.state ?? (e === DEFAULT_ENGINE ? o.state : undefined));
  const count = (e: string) => objects.filter(o => tracks(o, e) !== 'untracked').length;
  if (count(current) > 0) {
    return current;
  }
  const best = [...available].sort((a, b) => count(b) - count(a))[0];
  return best != null && count(best) > 0 ? best : current;
}

/**
 * What an object's Clear track button clears: the track on the engine on
 * screen if there is one, else the track another engine holds (a video
 * tracked with SAM 3 while SAM 2 is on screen), else, with several, all of
 * them. Null when there is nothing to clear, or a job holds the object.
 */
export function clearTarget(o: StudioObject, engine: string): {engine: string | null; others: boolean} | null {
  if (isTracking(o)) {
    return null;
  }
  const has = (e: string) => {
    const s = o.engines[e]?.state;
    return s === 'tracked' || s === 'stale';
  };
  const others = Object.keys(o.engines).filter(e => e !== engine && has(e));
  if (has(engine)) {
    return {engine, others: others.length > 0};
  }
  if (others.length === 1) {
    return {engine: others[0], others: false};
  }
  return others.length > 1 ? {engine: null, others: false} : null;
}

/** Objects both engines track with their current clicks: the ones worth comparing. */
export function comparableIds(state: StudioState, a: string, b: string): number[] {
  return state.objects
    .filter(o => o.engines[a]?.state === 'tracked' && o.engines[b]?.state === 'tracked')
    .map(o => o.id);
}

/**
 * The id for a new object: one past the highest id known, restored ones
 * included, so a new object never lands on a restored object's seeds.
 */
export function nextObjectId(objects: ReadonlyArray<{id: number}>): number {
  return objects.reduce((max, o) => Math.max(max, o.id), -1) + 1;
}

export function canAddObject(state: StudioState, limit: number): boolean {
  return state.objects.length < limit;
}

/**
 * True when every click on this frame is negative. SAM 2 then returns an
 * empty mask: a correction frame needs one positive click on what to keep.
 */
export function needsPositiveClick(o: StudioObject | undefined, frame: number): boolean {
  const pts = o?.points[frame];
  return pts != null && pts.length > 0 && pts.every(p => p[2] === 0);
}

function update(
  state: StudioState,
  id: number,
  fn: (o: StudioObject) => StudioObject,
): StudioState {
  return {...state, objects: state.objects.map(o => (o.id === id ? fn(o) : o))};
}

function byId(a: StudioObject, b: StudioObject) {
  return a.id - b.id;
}

/** Recompute every object's running flag from the jobs on the current engine. */
function withJobs(state: StudioState, jobs: Job[]): StudioState {
  const held = new Set(jobs.filter(j => j.engine === state.engine).flatMap(j => j.ids));
  return {
    ...state,
    jobs,
    objects: state.objects.map(o => (o.running === held.has(o.id) ? o : {...o, running: held.has(o.id)})),
  };
}

function updateJob(state: StudioState, key: number, fn: (j: Job) => Job): StudioState {
  return {...state, jobs: state.jobs.map(j => (j.key === key ? fn(j) : j))};
}

function setTrack(o: StudioObject, engine: string, t: EngineTrack, current: string): StudioObject {
  return viewed({...o, engines: {...o.engines, [engine]: t}}, current);
}

export function reducer(state: StudioState, action: Action): StudioState {
  switch (action.type) {
    case 'restore':
      return {
        ...initialState,
        engine: state.engine,
        objects: action.objects.map(o => fromServer(o, state.engine)).sort(byId),
      };

    case 'sync': {
      // The server knows every object that has clicks. A local object it does
      // not know is kept only while it has none (just added, not clicked yet).
      const server = new Map(action.objects.map(o => [o.objectId, o]));
      const kept = state.objects
        .filter(o => server.has(o.id) || !hasSeeds(o))
        .map(o => {
          const s = server.get(o.id);
          if (s == null) {
            return o;
          }
          server.delete(o.id);
          return {...fromServer(s, state.engine), running: o.running, error: o.error};
        });
      const added = [...server.values()].map(o => fromServer(o, state.engine));
      const objects = [...kept, ...added].sort(byId);
      const activeId = objects.some(o => o.id === state.activeId)
        ? state.activeId
        : null;
      return {...state, objects, activeId};
    }

    case 'setEngine': {
      const next = {...state, engine: action.engine, objects: state.objects.map(o => viewed(o, action.engine))};
      return withJobs(next, state.jobs);
    }

    case 'add': {
      if (state.objects.some(o => o.id === action.id)) {
        return {...state, activeId: action.id};
      }
      const added: StudioObject = {
        id: action.id,
        color: colorFor(action.id),
        state: 'untracked',
        frames: null,
        nFrames: 0,
        engines: {},
        points: {},
        running: false,
        error: null,
      };
      return {...state, activeId: action.id, objects: [...state.objects, added].sort(byId)};
    }

    case 'select':
      return {...state, activeId: action.id};

    case 'setPoints':
      return update(state, action.id, o => {
        const points = {...o.points};
        if (action.points.length > 0) {
          points[action.frame] = action.points;
        } else {
          delete points[action.frame];
        }
        const next = {...o, points, error: null};
        const engines: Record<string, EngineTrack> = {};
        for (const [name, t] of Object.entries(o.engines)) {
          // the backend drops a track with no seeds left behind it; any other
          // change of clicks leaves every engine's track stale
          engines[name] = !hasSeeds(next)
            ? NO_TRACK
            : t.state === 'tracked'
              ? {...t, state: 'stale'}
              : t;
        }
        return viewed({...next, engines}, state.engine);
      });

    case 'trackStarted': {
      const ids = [...new Set(action.ids)].sort((a, b) => a - b);
      const job: Job = {
        key: action.key,
        jobId: null,
        engine: action.engine ?? state.engine,
        ids,
        frames: 0,
        canceling: false,
      };
      const next = withJobs({...state, notice: null}, [...state.jobs, job]);
      return {
        ...next,
        objects: next.objects.map(o => (ids.includes(o.id) ? {...o, error: null} : o)),
      };
    }

    case 'trackAttached': {
      // the backend claims only what no other job holds: the rest never ran
      const selected = new Set(action.selected);
      return withJobs(
        state,
        state.jobs.map(j =>
          j.key === action.key
            ? {...j, jobId: action.jobId, ids: j.ids.filter(id => selected.has(id))}
            : j,
        ),
      );
    }

    case 'trackProgress':
      return updateJob(state, action.key, j => ({...j, frames: j.frames + 1}));

    case 'trackCanceling':
      return updateJob(state, action.key, j => ({...j, canceling: true}));

    case 'trackFinished': {
      const job = state.jobs.find(j => j.key === action.key);
      const engine = job?.engine ?? state.engine;
      const tracked = new Set(action.tracked);
      const next = withJobs(state, state.jobs.filter(j => j.key !== action.key));
      return {
        ...next,
        objects: next.objects.map(o => {
          if (tracked.has(o.id)) {
            const prev = o.engines[engine] ?? NO_TRACK;
            return {...setTrack(o, engine, {...prev, state: 'tracked'}, state.engine), error: null};
          }
          const err = action.failed[o.id];
          return err != null ? {...o, error: err} : o;
        }),
      };
    }

    case 'trackFailed':
      return {
        ...withJobs(state, state.jobs.filter(j => j.key !== action.key)),
        notice: action.error,
      };

    case 'trackCleared':
      return update(state, action.id, o => {
        const names = action.engine == null ? Object.keys(o.engines) : [action.engine];
        let next: StudioObject = {...o, error: null};
        for (const name of names) {
          next = setTrack(next, name, NO_TRACK, state.engine);
        }
        return viewed(next, state.engine);
      });

    case 'removed':
      return {
        ...state,
        objects: state.objects.filter(o => o.id !== action.id),
        activeId: state.activeId === action.id ? null : state.activeId,
      };

    case 'reset':
      return {...initialState, engine: state.engine};
  }
}
