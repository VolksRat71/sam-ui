// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Messages between the studio UI and its video worker, on top of Meta's video
// messages (setCanvas, setSource, play, frameUpdate, ...), which pass through
// unchanged. Studio calls are request/response RPCs; the worker also pushes
// events (tracklet summaries, track progress).
import type {JobOutcome} from '~/api/trackStream';
import type {NormPoint, ServerObject} from '~/state/objects';

export type SessionInfo = {
  sessionId: string;
  objects: ServerObject[];
};

export type TrackResult = {
  /** The ids the backend claimed for this job (Objects-Tracked header). */
  selected: number[];
  jobId: string | null;
  outcome: JobOutcome;
};

/** A running job on this video, from POST /track_jobs (any session's). */
export type RunningJob = {
  jobId: string;
  objects: number[];
  framesDone: number;
  nFrames: number | null;
  elapsedS: number;
};

/** Each studio call: its arguments and what it resolves to. */
export type StudioMethods = {
  init: {args: {endpoint: string}; result: void};
  startSession: {args: {path: string}; result: SessionInfo};
  closeSession: {args: Record<string, never>; result: void};
  /** Replace one object's clicks on one frame (none: clear the frame). */
  setPoints: {
    args: {objectId: number; frameIndex: number; points: NormPoint[]};
    result: void;
  };
  removeObject: {args: {objectId: number}; result: void};
  clearTrack: {args: {objectId: number}; result: ServerObject};
  objectTracks: {args: Record<string, never>; result: ServerObject[]};
  /**
   * Run a track job for these ids (the backend skips any another job holds);
   * resolves when its stream closes. `key` names the job in events.
   */
  track: {args: {objectIds: number[]; key: number}; result: TrackResult};
  /** Cancel one job, or with jobId null every job of the session. */
  cancelTrack: {args: {jobId: string | null}; result: boolean};
  trackJobs: {args: Record<string, never>; result: RunningJob[]};
  /** Stream cached tracks back into the preview (after a restore). */
  repaint: {args: {objectIds?: number[]}; result: void};
  startOver: {args: Record<string, never>; result: void};
  setActiveObject: {args: {objectId: number | null}; result: void};
};

export type StudioMethod = keyof StudioMethods;

export type StudioCall<M extends StudioMethod = StudioMethod> = {
  action: 'studioCall';
  id: number;
  method: M;
  args: StudioMethods[M]['args'];
};

export type StudioReply =
  | {action: 'studioReply'; id: number; ok: true; value: unknown}
  | {action: 'studioReply'; id: number; ok: false; error: string};

/** What the UI needs of an object's masks: the thumbnail and where it has one. */
export type TrackletSummary = {
  id: number;
  color: string;
  thumbnail: string | null;
  /** [first, last] frame runs with a non-empty mask, for the timeline. */
  segments: Array<[number, number]>;
};

export type StudioEvent =
  | {type: 'tracklets'; tracklets: TrackletSummary[]}
  | {type: 'jobStarted'; key: number; jobId: string | null; selected: number[]}
  | {type: 'trackFrame'; key: number; frameIndex: number}
  | {type: 'repaint'; active: boolean}
  | {type: 'warning'; message: string};

export type StudioEventMessage = {action: 'studioEvent'; event: StudioEvent};
