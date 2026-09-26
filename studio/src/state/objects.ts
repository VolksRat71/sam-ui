// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The Objects list as a pure reducer: which objects exist, their seed clicks,
// their track state, and the track jobs this page is running (several may run
// at once, each on its own objects). The worker owns the masks; this owns
// everything the UI decides with.
//
// Track state mirrors the backend (tracks/store.py, tracks/jobs.py): untracked
// (no track), stale (a track, but the seeds changed since), tracked, and
// tracking (a running job holds the object, maybe another tab's). The backend
// stays the authority: after each call the UI syncs from objectTracks, and the
// reducer's own transitions only keep the list right in between.
import {THEME_COLORS} from '@/theme/colors';

export type TrackState = 'untracked' | 'stale' | 'tracked' | 'tracking';
export type Label = 0 | 1;
/** A click, normalised to 0-1 (x / width, y / height), as the backend stores it. */
export type NormPoint = [x: number, y: number, label: Label];

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
  }>;
};

export type StudioObject = {
  id: number;
  color: string;
  state: TrackState;
  /** Seed clicks per frame. A frame with no clicks has no key. */
  points: Record<number, NormPoint[]>;
  /** [first, last] frame of the cached track, when there is one. */
  frames: [number, number] | null;
  nFrames: number;
  /** Held by one of this page's running jobs. */
  running: boolean;
  /** Why this object's last track failed. */
  error: string | null;
};

export type Job = {
  /** Client key, known before the backend answers. */
  key: number;
  /** The backend's Job-Id, once the stream has started. */
  jobId: string | null;
  ids: number[];
  /** Frames streamed so far. */
  frames: number;
  canceling: boolean;
};

export type StudioState = {
  objects: StudioObject[];
  activeId: number | null;
  jobs: Job[];
  /** The last job-level failure, shown until the next job starts. */
  notice: string | null;
};

export type Action =
  | {type: 'restore'; objects: ReadonlyArray<ServerObject>}
  | {type: 'sync'; objects: ReadonlyArray<ServerObject>}
  | {type: 'add'; id: number}
  | {type: 'select'; id: number | null}
  | {type: 'setPoints'; id: number; frame: number; points: NormPoint[]}
  | {type: 'trackStarted'; key: number; ids: number[]}
  | {type: 'trackAttached'; key: number; jobId: string | null; selected: number[]}
  | {type: 'trackProgress'; key: number}
  | {type: 'trackCanceling'; key: number}
  | {type: 'trackFinished'; key: number; tracked: number[]; failed: Record<number, string>}
  | {type: 'trackFailed'; key: number; error: string}
  | {type: 'trackCleared'; id: number}
  | {type: 'removed'; id: number}
  | {type: 'reset'};

export const initialState: StudioState = {
  objects: [],
  activeId: null,
  jobs: [],
  notice: null,
};

export function colorFor(id: number): string {
  return THEME_COLORS[id % THEME_COLORS.length];
}

export function toTrackState(state: string): TrackState {
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

function trackFrames(frames: ServerObject['frames']): [number, number] | null {
  return frames != null && frames.length >= 2 ? [frames[0], frames[1]] : null;
}

export function fromServer(o: ServerObject): StudioObject {
  return {
    id: o.objectId,
    color: colorFor(o.objectId),
    state: toTrackState(o.state),
    points: seedsToPoints(o.seeds),
    frames: trackFrames(o.frames),
    nFrames: o.nFrames,
    running: false,
    error: null,
  };
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

/** Held by a running job, this page's or another's. */
export function isTracking(o: StudioObject): boolean {
  return o.running || o.state === 'tracking';
}

/**
 * The objects a Track press sends: the ones with clicks whose track is missing
 * or stale, and that no running job holds. Tracked objects are never re-run,
 * and their masks stay on screen. A press while a job runs starts a second
 * job for the rest.
 */
export function dirtyIds(state: StudioState): number[] {
  return state.objects
    .filter(o => hasSeeds(o) && o.state !== 'tracked' && !isTracking(o))
    .map(o => o.id)
    .sort((a, b) => a - b);
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

/** Recompute every object's running flag from the jobs left. */
function withJobs(state: StudioState, jobs: Job[]): StudioState {
  const held = new Set(jobs.flatMap(j => j.ids));
  return {
    ...state,
    jobs,
    objects: state.objects.map(o => (o.running === held.has(o.id) ? o : {...o, running: held.has(o.id)})),
  };
}

function updateJob(state: StudioState, key: number, fn: (j: Job) => Job): StudioState {
  return {...state, jobs: state.jobs.map(j => (j.key === key ? fn(j) : j))};
}

export function reducer(state: StudioState, action: Action): StudioState {
  switch (action.type) {
    case 'restore':
      return {
        ...initialState,
        objects: action.objects.map(fromServer).sort(byId),
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
          const fresh = fromServer(s);
          return {...fresh, running: o.running, error: o.error};
        });
      const added = [...server.values()].map(fromServer);
      const objects = [...kept, ...added].sort(byId);
      const activeId = objects.some(o => o.id === state.activeId)
        ? state.activeId
        : null;
      return {...state, objects, activeId};
    }

    case 'add': {
      if (state.objects.some(o => o.id === action.id)) {
        return {...state, activeId: action.id};
      }
      const added: StudioObject = {
        id: action.id,
        color: colorFor(action.id),
        state: 'untracked',
        points: {},
        frames: null,
        nFrames: 0,
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
        if (!hasSeeds(next)) {
          // the backend drops a track with no seeds left behind it
          return {...next, state: 'untracked', frames: null, nFrames: 0};
        }
        return o.state === 'tracked' ? {...next, state: 'stale'} : next;
      });

    case 'trackStarted': {
      const ids = [...new Set(action.ids)].sort((a, b) => a - b);
      const job: Job = {key: action.key, jobId: null, ids, frames: 0, canceling: false};
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
      const tracked = new Set(action.tracked);
      const next = withJobs(state, state.jobs.filter(j => j.key !== action.key));
      return {
        ...next,
        objects: next.objects.map(o => {
          if (tracked.has(o.id)) {
            return {...o, state: 'tracked', error: null};
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
      return update(state, action.id, o => ({
        ...o,
        state: 'untracked',
        frames: null,
        nFrames: 0,
        error: null,
      }));

    case 'removed':
      return {
        ...state,
        objects: state.objects.filter(o => o.id !== action.id),
        activeId: state.activeId === action.id ? null : state.activeId,
      };

    case 'reset':
      return {...initialState};
  }
}
