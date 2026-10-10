// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// What the desktop app's main window exposes (desktop/src/app-preload.js).
// Absent anywhere else (a browser, the dev server), so callers show their
// desktop-only controls only when this returns a bridge.
//
// `ae` reaches After Effects through the desktop app's main process
// (desktop/src/ae-roto.js). The page never talks to After Effects itself: its
// bridge refuses browser origins, so nothing here probes localhost.
import type {VectorJson} from '~/state/contours';

export type AeError = {state: string; message: string; installUrl?: string; problems?: string[]};
export type AeResult<T> = {ok: true; value: T} | {ok: false; error: AeError};
export type AeStatus = {state: 'ready'; aeVersion: string | null} | AeError;

/** A footage item as the bridge's `media` op lists it, marked eligible or not. */
export type AeMediaItem = {
  id: number;
  name: string;
  path: string;
  width: number;
  height: number;
  frameRate: number;
  frames: number;
  duration: number;
  missing: boolean;
  eligible: boolean;
  reason?: string;
};

export type AeMedia = {
  project: {path: string | null; name: string | null; dirty?: boolean} | null;
  items: AeMediaItem[];
  ineligible: Array<{id: number; name: string; reason: string}>;
};

/** Where an After Effects video came from, as the backend keeps it (data/linked.py). */
export type AeSourceRecord = {
  path: string;
  source: {kind: string; aeItemId: number; aeProjectPath: string | null; name: string; path: string; width: number; height: number; frameRate: number; frames: number};
  videoHash: string;
  missing?: boolean;
  changed?: boolean;
};

/** A video opened in place: the backend's listing of it. */
export type AeLinkedVideo = {path: string; posterPath: string | null; width: number; height: number; record: AeSourceRecord};

export type AeExportRequest = {videoPath: string; objects: VectorJson[]; studio: {frames: number; width: number; height: number}};
export type AeExportResult = {compId: number; compName: string; layers: number; masks: number; keys: number};

export type AeBridge = {
  status(): Promise<AeResult<AeStatus>>;
  listMedia(): Promise<AeResult<AeMedia>>;
  open(itemId: number): Promise<AeResult<AeLinkedVideo>>;
  sourceOf(videoPath: string): Promise<AeResult<AeSourceRecord | null>>;
  exportRoto(request: AeExportRequest): Promise<AeResult<AeExportResult>>;
  /** Progress of the running export; returns the unsubscribe. */
  onProgress(cb: (p: {fraction: number; label: string}) => void): () => void;
};

/** A job that ended, as studio tells the desktop app. Main writes the notification's words. */
export type JobDone = {kind: 'track'; ok: boolean; engine: string; objectIds: number[]; name: string};

/**
 * Job notifications (desktop/src/job-notify.js): studio says a job ended and
 * main decides whether to notify (a setting, off by default, and only while the
 * window is not focused). A click comes back through onOpen.
 */
export type JobsBridge = {
  done(job: JobDone): void;
  /** A clicked notification's job; returns the unsubscribe. Not trusted: see asJobOpen. */
  onOpen(cb: (job: unknown) => void): () => void;
};

/**
 * What the person sees, as studio reports it to the desktop app for agents'
 * sam_studio state (desktop/src/mcp-tools.js parseView checks it whole).
 */
export type AgentView =
  | {open: false}
  | {
      open: true;
      video_id: string;
      session_id: string;
      frame: number;
      n_frames: number;
      playing: boolean;
      active_object: number | null;
      engine: string;
      hidden_objects: number[];
      colors: Record<string, string>;
      next_object_id: number;
    };

export const AGENT_KINDS = [
  'points', 'text', 'range', 'undo', 'redo', 'remove', 'track_start', 'track_done', 'track_cancel', 'review', 'export', 'goto',
] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** A change an agent made (desktop/src/mcp-tools.js change()), as studio reads it. */
export type AgentChange = {
  videoId: string;
  kind: AgentKind;
  objectIds: number[];
  /** The frame it touched (a range's first). */
  frame: number | null;
  /** A range's last frame. */
  end: number | null;
  /** range: absent | present | clear; track_done: done | failed; review: reviewed | unreviewed. */
  state: string | null;
  jobId: string | null;
  /** export: the folder name. */
  name: string | null;
  at: number;
};

/**
 * Agents (desktop/src/main.js, issue #73): studio reports the person's view,
 * and hears each change an agent made while agents are allowed.
 */
export type AgentBridge = {
  report(view: AgentView): void;
  /** An agent's change; returns the unsubscribe. Not trusted: see asAgentChange. */
  onChanged(cb: (change: unknown) => void): () => void;
  /** sam_studio goto: cb answers whether studio moved. Not trusted: see asAgentGoto. Absent before #73's goto. */
  onGoto?(cb: (request: unknown) => GotoAnswer): () => void;
  /**
   * sam_track start on the open video: studio runs the job as its own, so it
   * draws on the lanes, and answers through `reply`. Not trusted: see asAgentTrack.
   */
  onTrack?(cb: (request: unknown, reply: (msg: AgentTrackReply) => void) => void): () => void;
};

export type AgentTrack = {videoId: string; objectIds: number[] | null; engine: string | null};
export type AgentTrackReply =
  | {stage: 'started'; job_id: string | null; objects: number[]; bounded: number[]}
  | {stage: 'refused'; error: string}
  | {stage: 'done'; result: {done: boolean; tracked: number[]; failed: Record<string, string>; error?: string}};

export type GotoAnswer = {moved: true} | {moved: false; reason: string};
export type AgentGoto = {videoId: string; frame: number | null; objectId: number | null};

export type DesktopBridge = {setupSam3(): void; ae?: AeBridge; jobs?: JobsBridge; agent?: AgentBridge};

export function desktopBridge(): DesktopBridge | null {
  const b = (globalThis as {samUiDesktop?: Partial<DesktopBridge>}).samUiDesktop;
  return typeof b?.setupSam3 === 'function' ? (b as DesktopBridge) : null;
}

/** The After Effects half of the desktop bridge, or null (a browser, or an older desktop app). */
export function aeBridge(): AeBridge | null {
  const ae = desktopBridge()?.ae;
  return ae != null && typeof ae.listMedia === 'function' ? ae : null;
}

/** The job-notification half of the desktop bridge, or null (a browser, or an older desktop app). */
export function jobsBridge(): JobsBridge | null {
  const jobs = desktopBridge()?.jobs;
  return jobs != null && typeof jobs.done === 'function' && typeof jobs.onOpen === 'function' ? jobs : null;
}

/** The agents half of the desktop bridge, or null (a browser, or an older desktop app). */
export function agentBridge(): AgentBridge | null {
  const agent = desktopBridge()?.agent;
  return agent != null && typeof agent.report === 'function' && typeof agent.onChanged === 'function' ? agent : null;
}

const STATES = new Set(['absent', 'present', 'clear', 'done', 'failed', 'reviewed', 'unreviewed']);
const isNat = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const optNat = (v: unknown) => (v == null ? null : isNat(v) ? v : undefined);

/** An agent's change as main sends it, or null for anything malformed. */
export function asAgentChange(x: unknown): AgentChange | null {
  if (x == null || typeof x !== 'object' || Array.isArray(x)) {
    return null;
  }
  const c = x as Record<string, unknown>;
  const {video_id: videoId, kind, object_ids: objectIds, job_id: jobId, state, name, at} = c;
  const frame = optNat(c.frame);
  const end = optNat(c.end);
  const ok =
    typeof videoId === 'string' && videoId.length > 0 && videoId.length <= 512 &&
    (AGENT_KINDS as readonly unknown[]).includes(kind) &&
    Array.isArray(objectIds) && objectIds.length <= 1000 && objectIds.every(isNat) &&
    frame !== undefined && end !== undefined &&
    (state == null || (typeof state === 'string' && STATES.has(state))) &&
    (jobId == null || (typeof jobId === 'string' && /^[\w-]{1,128}$/.test(jobId))) &&
    (name == null || (typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name))) &&
    typeof at === 'number' && Number.isFinite(at);
  if (!ok) {
    return null;
  }
  return {
    videoId,
    kind: kind as AgentKind,
    objectIds: [...objectIds],
    frame,
    end,
    state: (state as string | undefined) ?? null,
    jobId: (jobId as string | undefined) ?? null,
    name: (name as string | undefined) ?? null,
    at,
  };
}

/** A sam_studio goto as main sends it ({video_id, frame, object_id}), or null for anything malformed. */
export function asAgentGoto(x: unknown): AgentGoto | null {
  if (x == null || typeof x !== 'object' || Array.isArray(x)) {
    return null;
  }
  const {video_id: videoId, frame: rawFrame, object_id: rawObject} = x as Record<string, unknown>;
  const frame = optNat(rawFrame);
  const objectId = optNat(rawObject);
  const ok = typeof videoId === 'string' && videoId.length > 0 && frame !== undefined && objectId !== undefined && (frame != null || objectId != null);
  return ok ? {videoId, frame, objectId} : null;
}

/** A track request as main sends it ({video_id, object_ids, engine}), or null for anything malformed. */
export function asAgentTrack(x: unknown): AgentTrack | null {
  if (x == null || typeof x !== 'object' || Array.isArray(x)) {
    return null;
  }
  const {video_id: videoId, object_ids: ids, engine} = x as Record<string, unknown>;
  const ok =
    typeof videoId === 'string' && videoId.length > 0 &&
    (ids == null || (Array.isArray(ids) && ids.length <= 1000 && ids.every(isNat))) &&
    (engine == null || (typeof engine === 'string' && /^[a-z0-9_-]{1,32}$/.test(engine)));
  return ok ? {videoId, objectIds: ids == null ? null : [...(ids as number[])], engine: (engine as string | null | undefined) ?? null} : null;
}

/** A clicked notification's engine and object ids, or null for anything else. */
export function asJobOpen(x: unknown): {engine: string; objectIds: number[]} | null {
  const {engine, objectIds} = (x ?? {}) as {engine?: unknown; objectIds?: unknown};
  const idsOk = Array.isArray(objectIds) && objectIds.length > 0 && objectIds.every(id => Number.isSafeInteger(id) && id >= 0);
  return idsOk && typeof engine === 'string' ? {engine, objectIds} : null;
}
