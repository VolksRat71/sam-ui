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
import {EMPTY_HISTORY, type SeedHistory, type ServerHistory, normalizeHistory} from './history';
import {EMPTY_LAYOUT, type Layout, type LayoutAction, arrange, layoutReducer, parseLayout} from './layout';
import {type FrameRange, type Mark, normalizeMarks, normalizeRanges, rangesKey, viewMarks} from './ranges';

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
    /** The text prompt that seeded the frame (SAM 3); its mask is the frame's. */
    readonly text?: string | null;
  }>;
  /** One entry per engine; the top-level fields are the default engine's. */
  readonly tracks?: ReadonlyArray<ServerTrack>;
  /**
   * Absent ranges (state/ranges.ts). Studio's queries select this field, so
   * studio needs a backend that has it: the two ship together (desktop), and a
   * backend from before ranges fails the whole query rather than sending none.
   */
  readonly ranges?: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
    readonly state: string;
    /** A candidate's provenance (draft 5); null on confirmed ranges. */
    readonly source?: string | null;
    readonly score?: number | null;
  }> | null;
  /** What the object can undo and redo, and its kept track versions (state/history.ts). */
  readonly history?: ServerHistory | null;
};

export type EngineTrack = {
  state: TrackState;
  /** [first, last] frame of the cached track, when there is one. */
  frames: [number, number] | null;
  nFrames: number;
};

export type StudioObject = {
  id: number;
  /** The user's name for it; null shows the default ("Object N"). */
  name: string | null;
  color: string;
  /** The current engine's track: a view of `engines[engine]`. */
  state: TrackState;
  frames: [number, number] | null;
  nFrames: number;
  /** Every engine's track, by engine name. */
  engines: Record<string, EngineTrack>;
  /** Seed clicks per frame. A frame with no clicks has no key. */
  points: Record<number, NormPoint[]>;
  /**
   * Text prompts per frame (SAM 3): a frame seeded by a phrase, whose best
   * match is its mask. Clicks there refine it and keep the text.
   */
  texts: Record<number, string>;
  /** Frames where the object is marked absent: empty, never tracked or exported. */
  ranges: FrameRange[];
  /**
   * Its present and candidate ranges, as the timeline shows them (never over
   * an absent frame). Annotations: they never touch a mask or a track's state.
   */
  marks: Mark[];
  /** Undo, redo and the kept track versions. */
  history: SeedHistory;
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
  /** Frames streamed so far (a frame may come once per pass). */
  frames: number;
  /**
   * How many frames the job streams in all, when the backend says (a SAM 2
   * job with objects first seeded on different frames runs one pass per
   * first-seed frame: frames x passes). Null: the video's frame count.
   */
  total: number | null;
  canceling: boolean;
  /**
   * The ids the backend re-tracks only around their corrections (a bounded
   * re-track, backend tracks/bounded.py; the Objects-Bounded header).
   */
  bounded: number[];
};

export type StudioState = {
  /** The engine Track runs and the preview shows. */
  engine: string;
  objects: StudioObject[];
  activeId: number | null;
  jobs: Job[];
  /** The last job-level failure, shown until the next job starts. */
  notice: string | null;
  /**
   * The objects' order and groups (state/layout.ts): the list's, the lanes'
   * and the exports' order. `objects` itself stays in id order.
   */
  layout: Layout;
};

export type Action =
  | {type: 'restore'; objects: ReadonlyArray<ServerObject>}
  | {type: 'sync'; objects: ReadonlyArray<ServerObject>}
  | {type: 'setEngine'; engine: string}
  | {type: 'add'; id: number}
  | {type: 'select'; id: number | null}
  | {type: 'setPoints'; id: number; frame: number; points: NormPoint[]}
  /** A text prompt matched: it seeds the frame, replacing its clicks. */
  | {type: 'setText'; id: number; frame: number; text: string}
  /** The object's ranges changed: absent ones, and (when given) its present and candidate ones. */
  | {type: 'setRanges'; id: number; ranges: FrameRange[]; marks?: Mark[]}
  /** The backend's answer to an undo, redo, restore or move: the object as it now is. */
  | {type: 'objectChanged'; object: ServerObject}
  | {type: 'trackStarted'; key: number; ids: number[]; engine?: string}
  | {type: 'trackAttached'; key: number; jobId: string | null; selected: number[]; bounded?: number[]}
  | {type: 'trackProgress'; key: number}
  | {type: 'trackTotal'; key: number; total: number}
  | {type: 'trackCanceling'; key: number}
  | {type: 'trackFinished'; key: number; tracked: number[]; failed: Record<number, string>}
  | {type: 'trackFailed'; key: number; error: string}
  /** engine null: every engine's track was cleared. */
  | {type: 'trackCleared'; id: number; engine?: string | null}
  | {type: 'removed'; id: number}
  | {type: 'rename'; id: number; name: string | null}
  /** Names from the backend (ids it does not name keep theirs). */
  | {type: 'names'; names: Record<number, string>}
  | {type: 'reset'}
  /** The stored layout (the backend's or this browser's), as loaded. */
  | {type: 'setLayout'; layout: unknown}
  /** A reorder or regroup. */
  | {type: 'layout'; action: LayoutAction};

export const initialState: StudioState = {
  engine: DEFAULT_ENGINE,
  objects: [],
  activeId: null,
  jobs: [],
  notice: null,
  layout: EMPTY_LAYOUT,
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

function seedsToTexts(seeds: ServerObject['seeds']): Record<number, string> {
  const out: Record<number, string> = {};
  for (const s of seeds) {
    if (s.text != null && s.text !== '') {
      out[s.frameIndex] = s.text;
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
      name: null,
      color: colorFor(o.objectId),
      state: 'untracked',
      frames: null,
      nFrames: 0,
      engines,
      points: seedsToPoints(o.seeds),
      texts: seedsToTexts(o.seeds),
      ranges: normalizeRanges(o.ranges),
      marks: viewMarks(normalizeRanges(o.ranges), normalizeMarks(o.ranges)),
      history: normalizeHistory(o.history),
      running: false,
      error: null,
    },
    engine,
  );
}

export function hasSeeds(o: StudioObject): boolean {
  return Object.values(o.points).some(p => p.length > 0) || Object.keys(o.texts).length > 0;
}

/** Frames with clicks or a text prompt: the frames the object is seeded on. */
export function seedFrames(o: StudioObject): number[] {
  const frames = new Set(Object.keys(o.texts).map(Number));
  for (const f of Object.keys(o.points).map(Number)) {
    if (o.points[f].length > 0) {
      frames.add(f);
    }
  }
  return [...frames].sort((a, b) => a - b);
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
 * included, so a new object never lands on a restored object's seeds, and
 * at least `floor` (one past the highest id ever used on this video), so an
 * id, and with it the default name "Object N", is never reused after a delete.
 */
export function nextObjectId(objects: ReadonlyArray<{id: number}>, floor = 0): number {
  return Math.max(objects.reduce((max, o) => Math.max(max, o.id), -1) + 1, floor);
}

export function canAddObject(state: StudioState, limit: number): boolean {
  return state.objects.length < limit;
}

/**
 * True when every click on this frame is negative and the frame has no mask.
 * On a tracked frame the backend's SAM 2 cuts the clicked region from the
 * tracked mask (`masked`: the frame still shows one). With no mask to refine,
 * as in the browser engine, SAM 2 returns an empty mask, and the frame needs
 * one positive click on what to keep.
 */
export function needsPositiveClick(o: StudioObject | undefined, frame: number, masked = false): boolean {
  const pts = o?.points[frame];
  return !masked && pts != null && pts.length > 0 && pts.every(p => p[2] === 0);
}

/** The objects in list order: the layout's, else creation order. */
export function orderedObjects(state: Pick<StudioState, 'objects' | 'layout'>): StudioObject[] {
  const byIdMap = new Map(state.objects.map(o => [o.id, o]));
  return arrange(state.layout, state.objects.map(o => o.id)).order.map(id => byIdMap.get(id)!);
}

/** What a group's Track sends: its members a plain Track would run (dirtyIds), in list order. */
export function groupDirtyIds(state: StudioState, groupId: string): number[] {
  const members = arrange(state.layout, state.objects.map(o => o.id)).groups.find(g => g.id === groupId)?.members ?? [];
  const dirty = new Set(dirtyIds(state));
  return members.filter(id => dirty.has(id));
}

/** Objects whose shown track is stale: the preview draws it faded until the re-track. */
export function staleIds(state: StudioState): number[] {
  return state.objects.filter(o => o.state === 'stale').map(o => o.id);
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
          return {...fromServer(s, state.engine), name: o.name, running: o.running, error: o.error};
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
        name: null,
        color: colorFor(action.id),
        state: 'untracked',
        frames: null,
        nFrames: 0,
        engines: {},
        points: {},
        texts: {},
        ranges: [],
        marks: [],
        history: EMPTY_HISTORY,
        running: false,
        error: null,
      };
      return {
        ...state,
        activeId: action.id,
        objects: [...state.objects, added].sort(byId),
        layout: layoutReducer(state.layout, {type: 'addObject', id: action.id}, state.objects.map(o => o.id)),
      };
    }

    case 'select':
      return {...state, activeId: action.id};

    case 'setPoints':
    case 'setText':
      return update(state, action.id, o => {
        const points = {...o.points};
        const texts = {...o.texts};
        if (action.type === 'setText') {
          texts[action.frame] = action.text; // the backend drops the frame's clicks
          delete points[action.frame];
        } else if (action.points.length > 0) {
          points[action.frame] = action.points;
        } else {
          delete points[action.frame]; // the backend clears the frame, text and all
          delete texts[action.frame];
        }
        const next = {...o, points, texts, error: null};
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

    case 'setRanges':
      return update(state, action.id, o => {
        const ranges = normalizeRanges(action.ranges);
        const marks = viewMarks(ranges, action.marks ?? o.marks);
        if (rangesKey(ranges) === rangesKey(o.ranges)) {
          // present and candidate ranges are annotations: no track goes stale
          return action.marks == null ? o : {...o, marks};
        }
        // ranges join the seeds hash: every engine's track goes stale
        const engines: Record<string, EngineTrack> = {};
        for (const [name, t] of Object.entries(o.engines)) {
          engines[name] = t.state === 'tracked' ? {...t, state: 'stale'} : t;
        }
        return viewed({...o, ranges, marks, engines, error: null}, state.engine);
      });

    case 'objectChanged': {
      const s = action.object;
      if (!state.objects.some(o => o.id === s.objectId)) {
        return {...state, objects: [...state.objects, fromServer(s, state.engine)].sort(byId)};
      }
      return update(state, s.objectId, o => ({...fromServer(s, state.engine), name: o.name, running: o.running}));
    }

    case 'trackStarted': {
      const ids = [...new Set(action.ids)].sort((a, b) => a - b);
      const job: Job = {
        key: action.key,
        jobId: null,
        engine: action.engine ?? state.engine,
        ids,
        frames: 0,
        total: null,
        canceling: false,
        bounded: [],
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
            ? {
                ...j,
                jobId: action.jobId,
                ids: j.ids.filter(id => selected.has(id)),
                bounded: (action.bounded ?? []).filter(id => selected.has(id)),
              }
            : j,
        ),
      );
    }

    case 'trackProgress':
      return updateJob(state, action.key, j => ({...j, frames: j.frames + 1}));

    case 'trackTotal':
      return updateJob(state, action.key, j => ({...j, total: action.total > 0 ? action.total : null}));

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
        layout: layoutReducer(state.layout, {type: 'removeObject', id: action.id}, state.objects.map(o => o.id)),
      };

    case 'rename':
      return update(state, action.id, o => ({...o, name: action.name}));

    case 'names':
      return {
        ...state,
        objects: state.objects.map(o => (action.names[o.id] != null ? {...o, name: action.names[o.id]} : o)),
      };

    case 'reset':
      return {...initialState, engine: state.engine};

    case 'setLayout':
      return {...state, layout: arrange(parseLayout(action.layout), state.objects.map(o => o.id))};

    case 'layout':
      return {...state, layout: layoutReducer(state.layout, action.action, state.objects.map(o => o.id))};
  }
}

/** A job's progress as shown: done of total, never past it; total defaults to the video's frames. */
export function jobProgress(job: Pick<Job, 'frames' | 'total'>, numFrames: number): {done: number; total: number | null; fraction: number} {
  const total = job.total ?? (numFrames > 0 ? numFrames : null);
  const done = total == null ? job.frames : Math.min(job.frames, total);
  return {done, total, fraction: total == null || total === 0 ? 0 : done / total};
}
