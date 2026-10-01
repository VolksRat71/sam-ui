// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Messages between the studio UI and its video worker, on top of Meta's video
// messages (setCanvas, setSource, play, frameUpdate, ...), which pass through
// unchanged. Studio calls are request/response RPCs; the worker also pushes
// events (tracklet summaries, track progress).
import type {JobOutcome} from '~/api/trackStream';
import type {LocalModelStatus, LocalOptions} from '~/local/LocalEngine';
import type {Layout} from '~/state/layout';
import type {ExportedObject, ExportGroup, ExportKind} from '~/state/maskExport';
import type {NormPoint, ServerObject} from '~/state/objects';
import type {RangeState} from '~/state/ranges';

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

/** GET /engines, one entry. */
export type EngineInfo = {
  name: string;
  model: string;
  default: boolean;
  available: boolean;
  reason: string | null;
  loaded: boolean;
  /** Set by the UI while a first job on it loads the model. */
  loading?: boolean;
  /** Runs in this browser (studio/src/local), not on the backend. */
  local?: boolean;
  /** For a disabled engine: where to get it (shown with the reason). */
  href?: string;
  /** A short note beside the engine's name in the picker. */
  hint?: string;
  /** The picker's name for it, when not engineLabel(name). */
  label?: string;
};

/** POST /track_disagreement's answer. */
export type Disagreement = {
  engines: [string, string];
  threshold: number;
  objects: Record<string, {flagged: number[]; iou: Record<string, number>; mean_iou: number | null}>;
  skipped: Record<string, Record<string, string | null>>;
};

/** POST /export's body, less the session. */
export type ExportRequest = {
  engine: string;
  out_dir: string;
  objects: Record<string, {id: string; prompt: string; color: string}>;
  include_stale: boolean;
  frames: boolean;
  force: boolean;
  /** One union matte per group (issue #21); an older backend ignores it. */
  union?: boolean;
};

/** POST /export's manifest (tracks/export.py). */
export type ExportManifest = {
  out_dir: string;
  exported: string;
  products: Record<string, {object_id: number; state: string; n_frames: number; frames: number[] | null}>;
  skipped: Record<string, string>;
  n_frames: number;
  frames_extracted: boolean;
  frames_on_disk?: number;
  warning?: string;
};

/** Each studio call: its arguments and what it resolves to. */
export type StudioMethods = {
  /** `offline`: no backend; seeds, names and tracks live in this browser (OPFS). */
  init: {args: {endpoint: string; offline?: boolean}; result: void};
  /** `key`: the video's sha256, which keys its data with no backend. */
  startSession: {args: {path: string; key?: string}; result: SessionInfo};
  closeSession: {args: Record<string, never>; result: void};
  /** Replace one object's clicks on one frame (none: clear the frame). */
  setPoints: {
    args: {objectId: number; frameIndex: number; points: NormPoint[]};
    result: void;
  };
  removeObject: {args: {objectId: number}; result: void};
  clearTrack: {args: {objectId: number; engine: string | null}; result: ServerObject};
  /**
   * Set frames start-end of an object to a range state (state/ranges.ts), or
   * clear them (state null: every state, or those in `clear`). A candidate
   * takes its `source` and optional `score`. Only absent ranges change a track.
   */
  setRange: {
    args: {objectId: number; start: number; end: number; state: RangeState | null; source?: string; score?: number; clear?: RangeState[]};
    result: ServerObject;
  };
  /** Write candidate ranges in bulk (a discovery job's results); `replace` drops the old ones. */
  writeCandidates: {
    args: {objectId: number; candidates: Array<{start: number; end: number; source: string; score?: number | null}>; replace?: boolean};
    result: ServerObject;
  };
  objectTracks: {args: Record<string, never>; result: ServerObject[]};
  /** Undo or redo one object's last seed change; a kept track of the restored clicks comes back with no job. */
  undo: {args: {objectId: number}; result: ServerObject};
  redo: {args: {objectId: number}; result: ServerObject};
  /** Go back to one of the object's kept versions (the list's key, and the engine that made it). */
  restoreVersion: {args: {objectId: number; key: string; engine: string}; result: ServerObject};
  /** Move one object's clicks on a frame to another object; answers both objects. */
  moveClicks: {args: {frameIndex: number; fromId: number; toId: number}; result: ServerObject[]};
  /**
   * Run a track job for these ids (the backend skips any another job holds);
   * resolves when its stream closes. `key` names the job in events.
   */
  track: {args: {objectIds: number[]; key: number; engine: string}; result: TrackResult};
  /** Cancel one job, or with jobId null every job of the session. */
  cancelTrack: {args: {jobId: string | null}; result: boolean};
  trackJobs: {args: Record<string, never>; result: RunningJob[]};
  /** Stream cached tracks back into the preview (after a restore). */
  repaint: {args: {objectIds?: number[]}; result: void};
  startOver: {args: Record<string, never>; result: void};
  /** Write tracked objects as a rotoscoping working folder; a refusal rejects with its reason. */
  export: {args: ExportRequest; result: ExportManifest};
  setActiveObject: {args: {objectId: number | null}; result: void};
  /** Objects whose shown track is stale: drawn faded, except on frames with clicks. */
  setStaleObjects: {args: {objectIds: number[]}; result: void};
  /** The engine the preview shows; its cached tracks are repainted. */
  setEngine: {args: {engine: string}; result: void};
  engines: {args: Record<string, never>; result: EngineInfo[]};
  disagreement: {args: {a: string; b: string; objectIds?: number[]}; result: Disagreement};
  /** Every object's own selected-object effect (objects not listed: Overlay). */
  setObjectEffects: {args: {effects: Record<number, {name: string; variant: number}>}; result: void};
  /** How many variants each highlight effect has. */
  effectVariants: {args: {names: string[]}; result: Record<string, number>};
  /** Render the video with these per-object effects as an MP4 (no editing aids). */
  exportVideo: {args: {effects: Record<number, {name: string; variant: number}>}; result: ArrayBuffer};
  /**
   * Name an object (null: back to its default). `saved` is false when the
   * backend predates names (it keeps the name for this session only).
   */
  renameObject: {args: {objectId: number; name: string | null}; result: {saved: boolean}};
  /** The backend's object names; `supported` is false on a backend without names. */
  objectNames: {args: Record<string, never>; result: {names: Record<number, string>; supported: boolean}};
  /**
   * Build a mask export in the browser, as a zip: mask videos, Vector JSON,
   * or the roto working folder. The objects' masks are the engine's on screen.
   */
  exportMasks: {
    args: {
      kind: ExportKind;
      /** In export (layout) order. */
      objects: ExportedObject[];
      engine: string;
      engineLabel: string;
      model: string;
      /** The groups with an exported member: a folder each (state/maskExport.ts groupExport). */
      groups?: ExportGroup[];
      /** Also one union mask per group. */
      union?: boolean;
    };
    result: ArrayBuffer;
  };
  /**
   * The objects' order and groups (state/layout.ts). `supported` is false on
   * a backend from before layouts (creation order, no groups).
   */
  objectLayout: {args: Record<string, never>; result: {layout: Layout; supported: boolean}};
  /** Store the layout. Metadata only: no track goes stale. `saved` false: an older backend. */
  setObjectLayout: {args: {layout: Layout}; result: {saved: boolean}};
  /** Members of hidden groups: kept off the preview (never off an export). */
  setHiddenObjects: {args: {objectIds: number[]}; result: void};
  /** The browser engine's model size and hole fill (tracks made otherwise go stale). */
  setLocalOptions: {args: LocalOptions; result: void};
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
  /** bounded: the selected ids re-tracked only around their corrections (Objects-Bounded). */
  | {type: 'jobStarted'; key: number; jobId: string | null; selected: number[]; bounded?: number[]}
  | {type: 'trackFrame'; key: number; frameIndex: number}
  | {type: 'repaint'; active: boolean}
  | {type: 'exportProgress'; done: number}
  | {type: 'localModel'; model: LocalModelStatus}
  | {type: 'warning'; message: string};

export type StudioEventMessage = {action: 'studioEvent'; event: StudioEvent};
