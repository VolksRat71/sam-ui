// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Messages between the studio UI and its video worker, on top of Meta's video
// messages (setCanvas, setSource, play, frameUpdate, ...), which pass through
// unchanged. Studio calls are request/response RPCs; the worker also pushes
// events (tracklet summaries, track progress).
import type {JobOutcome} from '~/api/trackStream';
import type {LocalModelStatus, LocalOptions} from '~/local/LocalEngine';
import type {QueueEntry, ReasonKind, ReviewQueue} from '~/state/audit';
import type {Layout} from '~/state/layout';
import type {ExportedObject, ExportGroup, ExportKind} from '~/state/maskExport';
import type {NormPoint, ServerObject} from '~/state/objects';
import type {Mark, RangeState} from '~/state/ranges';

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
  /** It reads text prompts here (SAM 3's detector). A backend from before them sends none. */
  text?: boolean;
  /** Why it cannot read text here, when it cannot. */
  textReason?: string | null;
};

/** POST /text_prompt's answer: the best instance of `text` on one frame. */
export type TextPromptResult = {
  objectId: number;
  frameIndex: number;
  text: string;
  engine: string;
  /** False: nothing on the frame matched, and nothing was stored. */
  matched: boolean;
  score: number;
  /** How many instances matched; the best one is the frame's mask. */
  instances: number;
};

/** One appearance POST /discover_text found: frames start-end (from 0), now a candidate range. */
export type DiscoveredInterval = {
  start: number;
  end: number;
  /** The mean detector score of its hits. */
  score: number;
  hits: number;
  /** Its best hit: a suggested seed frame (not stored). */
  best: {frame: number; score: number; box: number[] | null};
};

/** POST /discover_text's answer (EXPERIMENTAL): where in the clip `text` is, written as candidates. */
export type DiscoverTextResult = {
  objectId: number;
  text: string;
  engine: string;
  source: string;
  intervals: DiscoveredInterval[];
  /** Detector calls the scan made, and how long it took. */
  calls: number;
  seconds: number;
  /** Canceled: nothing was written. */
  canceled: boolean;
  /** The object as it is now, its new candidates in its ranges (null when canceled). */
  object: ServerObject | null;
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
  /** The review flags, by object id: they join data/review.json's audit queue. */
  flags?: Record<string, number[]>;
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
  detailRequest: {args: {operation: import('~/state/detail').DetailOperation; args?: Record<string, unknown>}; result: unknown};
  /** `offline`: no backend; seeds, names and tracks live in this browser (OPFS). */
  init: {args: {endpoint: string; offline?: boolean}; result: void};
  /** `key`: the video's sha256, which keys its data with no backend. */
  startSession: {args: {path: string; key?: string}; result: SessionInfo};
  closeSession: {args: Record<string, never>; result: void};
  /**
   * Replace one object's clicks on one frame (none: clear the frame).
   * `engine`: the one on screen; the backend refuses negatives alone on any
   * engine but SAM 3 (`needs_positive:`), and a missing one counts as SAM 2.
   */
  setPoints: {
    args: {objectId: number; frameIndex: number; points: NormPoint[]; engine?: string};
    result: void;
  };
  /** Seed one frame of an object from a phrase (SAM 3); its best match becomes the frame's mask. */
  textPrompt: {args: {objectId: number; frameIndex: number; text: string; engine: string | null}; result: TextPromptResult};
  /** EXPERIMENTAL: look for a phrase across the whole clip (SAM 3) and write each appearance as a candidate range. */
  discoverText: {args: {objectId: number; text: string; engine: string}; result: DiscoverTextResult};
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
  /** Show objects changed elsewhere (an agent): clicks, seed masks and cached track; answers every object. */
  refreshObjects: {args: {objectIds: number[]}; result: ServerObject[]};
  /** Undo or redo one object's last seed change; a kept track of the restored clicks comes back with no job. */
  undo: {args: {objectId: number}; result: ServerObject};
  redo: {args: {objectId: number}; result: ServerObject};
  /** Go back to one of the object's kept versions (the list's key, and the engine that made it). */
  restoreVersion: {args: {objectId: number; key: string; engine: string}; result: ServerObject};
  /**
   * Move one object's clicks on a frame to another object; answers both objects.
   * `engine`: the one on screen, as for setPoints (a missing one counts as SAM 2).
   */
  moveClicks: {args: {frameIndex: number; fromId: number; toId: number; engine?: string}; result: ServerObject[]};
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
  /**
   * The audit queue (state/audit.ts) of `engine`'s tracks: the backend's for
   * its engines, built here for the browser engine. `flags` are the review
   * flags, and `candidates` each object's candidate ranges (the browser's queue reads them).
   */
  reviewQueue: {args: {engine: string; flags: Record<number, number[]>; candidates: Record<number, Mark[]>}; result: ReviewQueue};
  /** Mark a queue stop reviewed ("looks right"), or unmark the stops over `span`. */
  setReviewed: {
    args: {objectId: number; frame: number; engine: string; reviewed: boolean; span: [number, number]; reasons: ReasonKind[]};
    result: void;
  };
  /** Every object's own selected-object effect (objects not listed: Overlay). */
  setObjectEffects: {args: {effects: Record<number, {name: string; variant: number}>}; result: void};
  /** Browser-local display colors only; no annotation or tracking writes. */
  setObjectColors: {args: {colors: Record<number, string>}; result: void};
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
      /** The audit queue's stops, for the roto folder's data/review.json. */
      review?: QueueEntry[];
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
