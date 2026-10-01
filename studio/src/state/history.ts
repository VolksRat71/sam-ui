// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// An object's seed history (issue #18), as the UI decides with it: whether it
// can undo or redo, its kept track versions (the backend's tracks/versions.py,
// or the browser's own with no backend), the Cmd-Z / Shift-Cmd-Z shortcuts,
// and where a frame's clicks can be moved. The backend is the authority:
// every undo, redo, restore or move answers with the object as it now is.
import {engineLabel} from './engines';
import {absentAt} from './ranges';
import type {StudioObject, StudioState} from './objects';

/** One kept track of an object's seeds: when it was tracked, by which engine, from how many clicks. */
export type TrackVersion = {
  /** The seeds hash it was made from (the browser engine's own key with no backend). */
  key: string;
  engine: string;
  model: string;
  /** When it was tracked (the backend's "%Y-%m-%dT%H:%M:%S%z"), if known. */
  created: string | null;
  elapsedS: number | null;
  nFrames: number | null;
  clicks: number;
  seedFrames: number;
  /** Bounded passes made part of it (backend tracks/bounded.py). */
  bounded: boolean;
  /** Made from the object's current seeds. */
  current: boolean;
};

export type SeedHistory = {canUndo: boolean; canRedo: boolean; versions: TrackVersion[]};

export const EMPTY_HISTORY: SeedHistory = {canUndo: false, canRedo: false, versions: []};

type RawVersion = {readonly [K in keyof TrackVersion]?: TrackVersion[K] | null};
export type ServerHistory = {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly versions: ReadonlyArray<RawVersion>;
};

export function normalizeHistory(h: ServerHistory | null | undefined): SeedHistory {
  if (h == null) {
    return EMPTY_HISTORY;
  }
  return {
    canUndo: Boolean(h.canUndo),
    canRedo: Boolean(h.canRedo),
    versions: (h.versions ?? []).map(v => ({
      key: String(v.key ?? ''),
      engine: String(v.engine ?? ''),
      model: String(v.model ?? ''),
      created: v.created ?? null,
      elapsedS: v.elapsedS ?? null,
      nFrames: v.nFrames ?? null,
      clicks: v.clicks ?? 0,
      seedFrames: v.seedFrames ?? 0,
      bounded: Boolean(v.bounded),
      current: Boolean(v.current),
    })),
  };
}

// -- keyboard ------------------------------------------------------------------

type KeyLike = {key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; target: unknown};

/** Whether a key event's target takes typing (a field), where Cmd-Z is the field's own. */
export function isTypingTarget(target: unknown): boolean {
  if (target == null || typeof target !== 'object') {
    return false;
  }
  const t = target as {tagName?: unknown; isContentEditable?: unknown};
  const tag = typeof t.tagName === 'string' ? t.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
}

/** Cmd-Z (or Ctrl-Z) undoes, Shift-Cmd-Z (or Ctrl-Y) redoes; never while typing in a field. */
export function historyShortcut(e: KeyLike): 'undo' | 'redo' | null {
  if (!(e.metaKey || e.ctrlKey) || isTypingTarget(e.target)) {
    return null;
  }
  const k = e.key.toLowerCase();
  if (k === 'z') {
    return e.shiftKey ? 'redo' : 'undo';
  }
  return k === 'y' && e.ctrlKey && !e.metaKey ? 'redo' : null;
}

// -- the version list -----------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The backend's time ("...-0500"), which not every Date parser takes without the colon. */
export function parseCreated(created: string | null): Date | null {
  if (created == null) {
    return null;
  }
  const d = new Date(created.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? null : d;
}

function clock(d: Date): string {
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "21:04 · SAM 2 · 3 clicks" (with the date on another day than `now`). */
export function versionLabel(v: TrackVersion, now: Date = new Date()): string {
  const d = parseCreated(v.created);
  const parts: string[] = [];
  if (d != null) {
    const sameDay = d.toDateString() === now.toDateString();
    parts.push(sameDay ? clock(d) : `${MONTHS[d.getMonth()]} ${d.getDate()} ${clock(d)}`);
  }
  parts.push(engineLabel(v.engine), `${v.clicks} ${v.clicks === 1 ? 'click' : 'clicks'}`);
  return parts.join(' · ');
}

// -- what is allowed -----------------------------------------------------------

const tracking = (o: Pick<StudioObject, 'running' | 'state'>) => o.running || o.state === 'tracking';

/** Why undo (or redo) cannot run on this object now, or null when it can. */
export function undoBlock(o: StudioObject | undefined, which: 'undo' | 'redo'): string | null {
  if (o == null) {
    return 'Select an object to undo its clicks';
  }
  if (tracking(o)) {
    return 'This object is being tracked: wait for its job, or cancel it, to undo';
  }
  const can = which === 'undo' ? o.history.canUndo : o.history.canRedo;
  return can ? null : `Nothing to ${which} for this object`;
}

export type MoveTarget = {id: number; blocked: string | null};

/**
 * Where the clicks object `fromId` has on `frame` can go: every other object,
 * each with why it cannot take them (marked absent there, or being tracked),
 * or none at all when there are no clicks to move or the object is tracking.
 */
export function moveTargets(state: StudioState, fromId: number, frame: number): MoveTarget[] {
  const from = state.objects.find(o => o.id === fromId);
  if (from == null || (from.points[frame]?.length ?? 0) === 0 || tracking(from)) {
    return [];
  }
  return state.objects
    .filter(o => o.id !== fromId)
    .map(o => ({
      id: o.id,
      blocked: absentAt(o.ranges, frame)
        ? `marked absent on frame ${frame + 1}`
        : tracking(o)
          ? 'being tracked'
          : null,
    }));
}
