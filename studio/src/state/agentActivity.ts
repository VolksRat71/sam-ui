// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// What agents did on the open video (issue #73), for the topbar's Agent chip
// and its list: the desktop app tells studio each change (lib/desktop.ts
// AgentChange), and this keeps the last few and says them in studio's words
// (layers, keyframe clicks, 1-based frames). In memory only, per video.
import type {AgentChange, AgentTrack, AgentView} from '~/lib/desktop';
import {BROWSER_ENGINE, engineLabel} from '~/state/engines';
import {DEFAULT_ENGINE} from '~/state/objects';

export const ACTIVITY_LIMIT = 20;

export type AgentEntry = {
  /** Unique within the list: React's key. */
  id: number;
  change: AgentChange;
  /** The person had one of its layers selected when it happened. */
  onSelected: boolean;
};

/**
 * The list with `change` on top, newest first, at most ACTIVITY_LIMIT. Clicks
 * set again on the same layer and frame replace the row before them, so an
 * agent refining one frame leaves one row, not five.
 */
export function appendActivity(list: ReadonlyArray<AgentEntry>, change: AgentChange, activeId: number | null): AgentEntry[] {
  const top = list[0];
  const same =
    top != null &&
    ['points', 'text'].includes(change.kind) &&
    top.change.kind === change.kind &&
    top.change.frame === change.frame &&
    top.change.objectIds.join(',') === change.objectIds.join(',');
  const entry = {
    id: (top?.id ?? 0) + 1,
    change,
    onSelected: activeId != null && change.objectIds.includes(activeId),
  };
  return [entry, ...(same ? list.slice(1) : list)].slice(0, ACTIVITY_LIMIT);
}

function layers(ids: ReadonlyArray<number>, nameOf: (id: number) => string): string {
  if (ids.length === 0) {
    return 'every tracked layer';
  }
  const named = ids.slice(0, 3).map(nameOf).join(', ');
  return ids.length > 3 ? `${named} and ${ids.length - 3} more` : named;
}

/** The change in words, as the chip and the list say it: "set clicks on Blocks 2, frame 121". */
export function describeChange(c: AgentChange, nameOf: (id: number) => string): string {
  const who = layers(c.objectIds, nameOf);
  const frame = c.frame != null ? `frame ${c.frame + 1}` : null;
  const span = c.frame != null && c.end != null && c.end !== c.frame ? `frames ${c.frame + 1}–${c.end + 1}` : frame;
  switch (c.kind) {
    case 'points':
      return `set clicks on ${who}, ${frame}`;
    case 'text':
      return `set ${who} from a phrase, ${frame}`;
    case 'range':
      return c.state === 'clear'
        ? `cleared the marks on ${who}, ${span}`
        : `marked ${who} ${c.state === 'present' ? 'present' : 'absent'}, ${span}`;
    case 'undo':
      return `undid the last change on ${who}`;
    case 'redo':
      return `redid the last change on ${who}`;
    case 'remove':
      return `removed ${who}`;
    case 'track_start':
      return `started tracking ${who}`;
    case 'track_done':
      return c.state === 'failed' ? `could not finish tracking ${who}` : `tracked ${who}`;
    case 'track_cancel':
      return `cancelled tracking ${who}`;
    case 'review':
      return c.state === 'unreviewed' ? `unmarked ${frame} of ${who} as reviewed` : `marked ${frame} of ${who} reviewed`;
    case 'export':
      return `exported ${who} to ${c.name ?? 'a folder'}`;
    case 'goto':
      return c.objectIds.length === 0 ? `moved you to ${frame}` : `moved you to ${who}${frame != null ? `, ${frame}` : ''}`;
  }
}

/** The entry's words with the selection called out: the person's own layer. */
export function describeEntry(e: AgentEntry, nameOf: (id: number) => string): string {
  return e.onSelected ? `${describeChange(e.change, nameOf)} (your selected layer)` : describeChange(e.change, nameOf);
}

/**
 * How studio runs an agent's track (sam_track start on its video): refused,
 * or on `engine` (the agent's, else the backend's default, never the one the
 * person shows) for `ids`, or (null) for what is dirty on that engine, which
 * the caller reads fresh from the backend (state/objects.ts dirtyOn).
 */
export function planAgentTrack(
  r: AgentTrack | null,
  at: {videoPath: string; ready: boolean},
): {refuse: string} | {engine: string; ids: number[] | null} {
  if (r == null || r.videoId !== at.videoPath || !at.ready) {
    return {refuse: 'studio is not on that video'};
  }
  if (r.engine === BROWSER_ENGINE) {
    return {refuse: `${engineLabel(BROWSER_ENGINE)} runs in the person's browser only`};
  }
  return {engine: r.engine ?? DEFAULT_ENGINE, ids: r.objectIds};
}

/** "now", "40 s", "3 min", "2 h": a change's age, in the list's tabular column. */
export function ageLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h`;
}

/**
 * What studio reports to the desktop app as the person's view: closed until
 * the session and the video's length are known, the frame kept in the clip,
 * and only the colours the person picked (the rest are the theme's, which the
 * backend draws too).
 */
export function viewReport(v: {
  videoId: string;
  sessionId: string | null;
  frame: number;
  numFrames: number;
  playing: boolean;
  activeId: number | null;
  engine: string;
  hiddenIds: ReadonlyArray<number>;
  colors: Readonly<Record<number, string>>;
  nextObjectId: number;
}): AgentView {
  if (v.sessionId == null || v.numFrames <= 0) {
    return {open: false};
  }
  return {
    open: true,
    video_id: v.videoId,
    session_id: v.sessionId,
    frame: Math.max(0, Math.min(v.numFrames - 1, v.frame)),
    n_frames: v.numFrames,
    playing: v.playing,
    active_object: v.activeId,
    engine: v.engine,
    hidden_objects: [...new Set(v.hiddenIds)].sort((a, b) => a - b),
    colors: Object.fromEntries(Object.entries(v.colors).map(([id, c]) => [String(id), c])),
    next_object_id: v.nextObjectId,
  };
}
