// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Effect clips: an effect with its own settings and frame range on one layer
// (or on the background). A layer can hold several; they may overlap, and a
// higher row draws on top. The preview and the export resolve each frame from
// the same EffectDoc (activeClips), so a clip looks the same in both. On a
// frame where a layer has no active clip it is "untouched": the preview shows
// its Overlay tint, and an export draws it as the export dialog says.
//
// Every function here is pure but loadEffectDoc/saveEffectDoc: the session
// keeps the doc in React state and in localStorage (v2 key; the v1
// per-object map is only ever read, once).
import type {EffectParams, EffectParamValue} from '@/common/components/video/effects/Effect';
import {EFFECT_SPECS} from '@/common/components/video/effects/EffectParamSpecs';
import {readJson, writeJson} from '~/lib/storage';

export type EffectTarget = {kind: 'object'; id: number} | {kind: 'background'};
export type EffectClip = {
  id: string;
  target: EffectTarget;
  effect: string;
  params: EffectParams;
  /** First frame, inclusive. */
  start: number;
  /** Last frame, exclusive. */
  end: number;
  /** Order within its target: a higher row draws later (on top). */
  row: number;
  /** Frames of the clip's animation already elapsed at `start`. */
  phase: number;
};
export type EffectDoc = {version: 2; clips: EffectClip[]};

export const EMPTY_DOC: EffectDoc = {version: 2, clips: []};
/** A new clip's length, clamped to the video's end (Nate, Q3). */
export const DEFAULT_CLIP_SECONDS = 3;
export const OVERLAY = 'Overlay';
/** Meta's "Original" highlight: the object as it is in the video. */
export const ORIGINAL = 'Cutout';
/** The background with no clip, or with an effect this build does not know. */
export const BACKGROUND_DEFAULT = 'Original';

/** How an export draws an object on a frame where it has no clip. */
export type UntouchedMode = 'original' | 'shown';

export function sameTarget(a: EffectTarget, b: EffectTarget): boolean {
  return a.kind === b.kind && (a.kind === 'background' || a.id === (b as {id: number}).id);
}

function decimals(step: number): number {
  return (String(step).split('.')[1] ?? '').length;
}

/** '#rgb' / '#rrggbb' as lowercase '#rrggbb'; null if it is neither. */
function parseColor(v: unknown): string | null {
  if (typeof v !== 'string') {
    return null;
  }
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) {
    return s;
  }
  return /^#[0-9a-f]{3}$/.test(s) ? `#${[...s.slice(1)].map(c => c + c).join('')}` : null;
}

/**
 * Settings fit for `effect`: unknown keys dropped, numbers clamped and rounded
 * to their step, colours parsed ('layer' allowed), anything missing or
 * malformed set to its default. An effect this build does not know keeps its
 * plain values as they are, for a newer build to read.
 */
export function normalizeParams(effect: string, raw: unknown): EffectParams {
  const given = raw != null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const spec = EFFECT_SPECS[effect];
  if (spec == null) {
    return Object.fromEntries(
      Object.entries(given).filter((e): e is [string, EffectParamValue] =>
        ['number', 'string', 'boolean'].includes(typeof e[1]),
      ),
    );
  }
  const out: EffectParams = {};
  // a setting the clip lacks comes from its style (a clip saved before the effect had it draws as it did)
  const preset: Record<string, unknown> = typeof given.style === 'string' ? (spec.styles[given.style] ?? {}) : {};
  for (const [key, p] of Object.entries(spec.params)) {
    const v = given[key] ?? preset[key];
    if (p.kind === 'number') {
      if (typeof v === 'number' && Number.isFinite(v)) {
        const stepped = Number((p.min + Math.round((v - p.min) / p.step) * p.step).toFixed(decimals(p.step)));
        out[key] = Math.min(p.max, Math.max(p.min, stepped));
      } else {
        out[key] = p.default;
      }
    } else if (p.kind === 'color') {
      out[key] = v === 'layer' ? 'layer' : (parseColor(v) ?? p.default);
    } else {
      out[key] = typeof v === 'string' && p.options.includes(v) ? v : p.default;
    }
  }
  return out;
}

/** `params` with style `style`'s preset applied. */
export function withStyle(effect: string, params: EffectParams, style: string): EffectParams {
  return normalizeParams(effect, {...params, ...(EFFECT_SPECS[effect]?.styles[style] ?? {})});
}

/**
 * Clips in the order they are drawn, last on top: lowest row first, equal rows
 * (a split's parts, a duplicate) in doc order. The one draw order the renderer,
 * the timeline band and the stack operations all use.
 */
function drawOrder(clips: ReadonlyArray<EffectClip>): EffectClip[] {
  return [...clips].sort((a, b) => a.row - b.row);
}

/** The clips drawn on `frame` (start <= frame < end), in draw order. */
export function activeClips(doc: EffectDoc, frame: number): EffectClip[] {
  return drawOrder(doc.clips.filter(c => c.start <= frame && frame < c.end));
}

/** A clip's own clock on `frame`, in seconds of video: it travels with the clip. */
export function clipTime(clip: EffectClip, frame: number, fps: number): number {
  return (frame - clip.start + clip.phase) / (fps > 0 ? fps : 30);
}

/** An id no clip in `doc` has: c1, c2, ... (as layout.ts names groups). */
export function newClipId(doc: EffectDoc): string {
  const n = doc.clips.reduce((m, c) => Math.max(m, /^c(\d+)$/.test(c.id) ? Number(c.id.slice(1)) : 0), 0);
  return `c${n + 1}`;
}

function clipsOf(doc: EffectDoc, target: EffectTarget): EffectClip[] {
  return doc.clips.filter(c => sameTarget(c.target, target));
}

/** The row above every clip `target` has: where a new clip goes. */
function topRow(doc: EffectDoc, target: EffectTarget): number {
  return clipsOf(doc, target).reduce((top, c) => Math.max(top, c.row + 1), 0);
}

/**
 * A new clip of `effect` on `target` at the playhead, DEFAULT_CLIP_SECONDS long
 * but never past the video's end (addClip puts it on top of its target's clips).
 */
export function newClip(
  o: {id: string; target: EffectTarget; effect: string; frame: number; numFrames: number; fps: number; params?: EffectParams},
): EffectClip {
  const last = Math.max(1, o.numFrames);
  const start = Math.min(Math.max(0, Math.round(o.frame)), last - 1);
  const length = Math.max(1, Math.round(DEFAULT_CLIP_SECONDS * (o.fps > 0 ? o.fps : 30)));
  return {
    id: o.id,
    target: o.target,
    effect: o.effect,
    params: normalizeParams(o.effect, o.params ?? {}),
    start,
    end: Math.min(last, start + length),
    row: 0,
    phase: 0,
  };
}

/** Add `clip`, on top of its target's clips. */
export function addClip(doc: EffectDoc, clip: EffectClip): EffectDoc {
  return {...doc, clips: [...doc.clips, {...clip, row: topRow(doc, clip.target)}]};
}

function change(doc: EffectDoc, id: string, fn: (c: EffectClip) => EffectClip): EffectDoc {
  return {...doc, clips: doc.clips.map(c => (c.id === id ? fn(c) : c))};
}

/** Change a clip's effect and/or settings (settings are validated for the effect it ends up with). */
export function updateClip(doc: EffectDoc, id: string, patch: {effect?: string; params?: EffectParams}): EffectDoc {
  return change(doc, id, c => {
    const effect = patch.effect ?? c.effect;
    return {...c, effect, params: normalizeParams(effect, patch.params ?? (effect === c.effect ? c.params : {}))};
  });
}

/** Move a clip to start at `start`, keeping its length (and its animation: phase travels with it). */
export function moveClip(doc: EffectDoc, id: string, start: number, numFrames: number): EffectDoc {
  return change(doc, id, c => {
    const length = c.end - c.start;
    const s = Math.max(0, Math.min(Math.round(start), Math.max(0, numFrames - length)));
    return {...c, start: s, end: s + length};
  });
}

/**
 * Move one edge of a clip to `frame`. Trimming the start later by d frames
 * adds d to the phase (earlier: takes it off), so every frame still in the
 * clip looks exactly as before. A clip keeps at least one frame.
 */
export function trimClip(doc: EffectDoc, id: string, edge: 'start' | 'end', frame: number, numFrames: number): EffectDoc {
  return change(doc, id, c => {
    const f = Math.round(frame);
    if (edge === 'start') {
      const start = Math.max(0, Math.min(f, c.end - 1));
      return {...c, start, phase: c.phase + (start - c.start)};
    }
    return {...c, end: Math.max(c.start + 1, Math.min(f, Math.max(numFrames, c.start + 1)))};
  });
}

export function removeClip(doc: EffectDoc, id: string): EffectDoc {
  return {...doc, clips: doc.clips.filter(c => c.id !== id)};
}

/**
 * Split a clip at `frame` into [start, frame) and [frame, end), the right
 * part as `newId`: both keep the effect, settings and row, and the right
 * part's phase continues the animation, so every frame looks as before.
 * The exception: an animation paced over the clip's length (Text) re-paces
 * the shorter left part. Only strictly inside the clip; anywhere else
 * nothing changes.
 */
export function splitClip(doc: EffectDoc, id: string, frame: number, newId = newClipId(doc)): EffectDoc {
  const f = Math.round(frame);
  const c = doc.clips.find(x => x.id === id);
  if (c == null || f <= c.start || f >= c.end) {
    return doc;
  }
  // the new part goes last, where a redo (editJournal.applyEntry) puts it back
  const right = {...c, id: newId, start: f, phase: c.phase + (f - c.start)};
  return {...doc, clips: [...doc.clips.map(x => (x === c ? {...c, end: f} : x)), right]};
}

/**
 * A copy of a clip as `newId`, its animation from the beginning (phase 0):
 * right after the original on the same row when it fits there (inside the
 * video, over no other clip of that row), else on a new top row at the
 * original's frames.
 */
export function duplicateClip(doc: EffectDoc, id: string, newId: string, numFrames: number): EffectDoc {
  const c = doc.clips.find(x => x.id === id);
  if (c == null) {
    return doc;
  }
  const after = {...c, id: newId, start: c.end, end: 2 * c.end - c.start, phase: 0};
  const fits =
    after.end <= numFrames && !clipsOf(doc, c.target).some(o => o.row === c.row && o.start < after.end && after.start < o.end);
  return fits ? {...doc, clips: [...doc.clips, after]} : addClip(doc, {...c, id: newId, phase: 0});
}

/** A target's clips in draw order. */
function stackOf(doc: EffectDoc, target: EffectTarget): EffectClip[] {
  return drawOrder(clipsOf(doc, target));
}

/**
 * The nearest clip above (up) or below (down) a clip in its target's stack
 * that overlaps it in time: the one a reorder passes. Clips it does not
 * overlap are skipped, since passing them changes nothing drawn.
 */
export function overlapNeighbour(doc: EffectDoc, id: string, direction: 'up' | 'down'): EffectClip | null {
  const c = doc.clips.find(x => x.id === id);
  if (c == null) {
    return null;
  }
  const stack = stackOf(doc, c.target);
  const at = stack.indexOf(c);
  const side = direction === 'up' ? stack.slice(at + 1) : stack.slice(0, at).reverse();
  return side.find(o => o.start < c.end && c.start < o.end) ?? null;
}

/**
 * Move a clip up (drawn later, on top) or down its target's stack, just past
 * overlapNeighbour; every other clip keeps its order, and the target's rows
 * become 0..n-1. With no overlapping clip that way, nothing changes.
 */
export function reorderClip(doc: EffectDoc, id: string, direction: 'up' | 'down'): EffectDoc {
  const past = overlapNeighbour(doc, id, direction);
  if (past == null) {
    return doc;
  }
  const c = doc.clips.find(x => x.id === id)!;
  const stack = stackOf(doc, c.target).filter(x => x !== c);
  stack.splice(stack.indexOf(past) + (direction === 'up' ? 1 : 0), 0, c);
  const rows = new Map(stack.map((x, i) => [x.id, i]));
  return {
    ...doc,
    clips: doc.clips.map(x => {
      const row = rows.get(x.id);
      return row == null || row === x.row ? x : {...x, row};
    }),
  };
}

/** Drop the clips of objects that no longer exist (background clips stay). */
export function pruneClips(doc: EffectDoc, objectIds: ReadonlyArray<number>): EffectDoc {
  const keep = new Set(objectIds);
  const clips = doc.clips.filter(c => c.target.kind === 'background' || keep.has(c.target.id));
  return clips.length === doc.clips.length ? doc : {...doc, clips};
}

/**
 * The clip an effect pick on `target` edits: the selected clip if it is
 * `target`'s, else its top clip on the playhead; never a clip off the
 * playhead the person cannot see being changed.
 */
export function clipToEdit(doc: EffectDoc, target: EffectTarget, frame: number, selectedId: string | null): EffectClip | null {
  const mine = clipsOf(doc, target);
  return mine.find(c => c.id === selectedId) ?? drawOrder(mine.filter(c => c.start <= frame && frame < c.end)).at(-1) ?? null;
}

/** What picking `effect` gives a clip: the effect it has again moves to its next style; another starts at its defaults. */
export function pickedParams(clip: Pick<EffectClip, 'effect' | 'params'> | null, effect: string): EffectParams {
  const style = EFFECT_SPECS[effect]?.params.style;
  if (clip == null || clip.effect !== effect || style?.kind !== 'choice') {
    return normalizeParams(effect, {});
  }
  const at = style.options.indexOf(String(clip.params.style));
  return withStyle(effect, clip.params, style.options[(at + 1) % style.options.length]);
}

/**
 * Today's one-click effect buttons on top of clips: picking `effect` on
 * `target` edits the clip clipToEdit finds (the same effect again: its next
 * style). With none, it adds a clip over the whole video when the target has
 * no clips yet, else a new clip at the playhead (as Add effect does).
 */
export function pickOnTarget(
  doc: EffectDoc,
  o: {target: EffectTarget; effect: string; frame: number; numFrames: number; fps?: number; selectedId: string | null; newId: string; params?: EffectParams},
): {doc: EffectDoc; clipId: string} {
  const clip = clipToEdit(doc, o.target, o.frame, o.selectedId);
  const params = o.params ?? pickedParams(clip, o.effect);
  if (clip != null) {
    return {doc: updateClip(doc, clip.id, {effect: o.effect, params}), clipId: clip.id};
  }
  if (clipsOf(doc, o.target).length > 0) {
    const added = newClip({id: o.newId, target: o.target, effect: o.effect, frame: o.frame, numFrames: o.numFrames, fps: o.fps ?? 30, params});
    return {doc: addClip(doc, added), clipId: o.newId};
  }
  const full: EffectClip = {
    id: o.newId,
    target: o.target,
    effect: o.effect,
    params: normalizeParams(o.effect, params),
    start: 0,
    end: Math.max(1, o.numFrames),
    row: 0,
    phase: 0,
  };
  return {doc: addClip(doc, full), clipId: o.newId};
}

/**
 * A group's effect pick, the same for every member and the same rule as a
 * one-layer pick (pickOnTarget, selection plays no part): edit its top clip on
 * the playhead, else add one there, or over the whole video if it has none. Every member gets
 * the first member's picked settings (the same effect again: its next style).
 */
export function pickOnGroup(
  doc: EffectDoc,
  o: {members: number[]; effect: string; frame: number; numFrames: number; fps: number},
): {doc: EffectDoc; changed: number; added: number} {
  let params: EffectParams | undefined;
  let changed = 0;
  for (const id of o.members) {
    const target: EffectTarget = {kind: 'object', id};
    const clip = clipToEdit(doc, target, o.frame, null);
    params ??= pickedParams(clip, o.effect);
    if (clip != null) {
      changed++;
    }
    // the single-layer rule (pickOnTarget), so a member with no clips yet gets the whole video like a one-layer pick
    doc = pickOnTarget(doc, {target, effect: o.effect, frame: o.frame, numFrames: o.numFrames, fps: o.fps, selectedId: null, newId: newClipId(doc), params}).doc;
  }
  return {doc, changed, added: o.members.length - changed};
}

function parseTarget(raw: unknown): EffectTarget | null {
  const t = raw as {kind?: unknown; id?: unknown} | null;
  if (t?.kind === 'background') {
    return {kind: 'background'};
  }
  return t?.kind === 'object' && Number.isInteger(t.id) ? {kind: 'object', id: t.id as number} : null;
}

/** Read a stored v2 doc, dropping malformed clips and validating every clip's settings (it comes from localStorage). */
export function parseEffectDoc(raw: unknown): EffectDoc {
  const list = (raw as {version?: unknown; clips?: unknown} | null)?.clips;
  if ((raw as {version?: unknown} | null)?.version !== 2 || !Array.isArray(list)) {
    return EMPTY_DOC;
  }
  const seen = new Set<string>();
  const clips: EffectClip[] = [];
  for (const r of list as Array<Record<string, unknown> | null>) {
    const target = parseTarget(r?.target);
    const {id, effect, start, end, row, phase} = r ?? {};
    if (
      target == null ||
      typeof id !== 'string' ||
      id === '' ||
      seen.has(id) ||
      typeof effect !== 'string' ||
      effect === '' ||
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      (start as number) < 0 ||
      (end as number) <= (start as number)
    ) {
      continue;
    }
    seen.add(id);
    clips.push({
      id,
      target,
      effect,
      params: normalizeParams(effect, r?.params),
      start: start as number,
      end: end as number,
      row: Number.isInteger(row) ? (row as number) : 0,
      phase: typeof phase === 'number' && Number.isFinite(phase) ? phase : 0,
    });
  }
  return {version: 2, clips};
}

/**
 * The v1 store (`{objectId: {name, variant}}`, one effect per object for the
 * whole video) as clips: one full-range clip per object, its style the one
 * matching the old variant. Malformed entries are skipped.
 */
export function migrateV1(map: unknown, numFrames: number): EffectDoc {
  if (map == null || typeof map !== 'object') {
    return EMPTY_DOC;
  }
  const clips: EffectClip[] = [];
  for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
    const id = Number(k);
    const e = v as {name?: unknown; variant?: unknown} | null;
    if (!Number.isInteger(id) || e == null || typeof e.name !== 'string' || e.name === '') {
      continue;
    }
    const style = EFFECT_SPECS[e.name]?.params.style;
    const variant = Number.isInteger(e.variant) ? (e.variant as number) : 0;
    const params =
      style?.kind === 'choice' ? {style: style.options[variant % style.options.length] ?? style.default} : {variant};
    clips.push({
      id: `v1-${id}`,
      target: {kind: 'object', id},
      effect: e.name,
      params: normalizeParams(e.name, params),
      start: 0,
      end: Math.max(1, numFrames),
      row: 0,
      phase: 0,
    });
  }
  return {version: 2, clips};
}

const storeKey = (path: string) => `sam-ui-studio:effects:v2:${path}`;

/** The video's stored doc, else its v1 map (`sam-ui-studio:effects:<path>`, never written) migrated. */
export function loadEffectDoc(path: string, numFrames: number): EffectDoc {
  const stored = readJson<unknown>(storeKey(path), null);
  return stored != null
    ? parseEffectDoc(stored)
    : migrateV1(readJson<unknown>(`sam-ui-studio:effects:${path}`, null), numFrames);
}

export function saveEffectDoc(path: string, doc: EffectDoc): void {
  writeJson(storeKey(path), doc);
}

/**
 * Where a target's clips (in doc order) sit on its timeline band: line 0 at
 * the top. A clip goes one line below every clip drawn over it that it
 * overlaps, so of two overlapping clips the one drawn on top is always shown
 * higher; clips that do not overlap share a line, keeping the band as short
 * as it can be.
 */
export function clipLines(clips: ReadonlyArray<EffectClip>): {line: Map<string, number>; count: number} {
  const line = new Map<string, number>();
  const placed: EffectClip[] = [];
  let count = 0;
  for (const c of drawOrder(clips).reverse()) {
    const below = placed.filter(p => p.start < c.end && c.start < p.end).reduce((m, p) => Math.max(m, line.get(p.id)! + 1), 0);
    line.set(c.id, below);
    placed.push(c);
    count = Math.max(count, below + 1);
  }
  return {line, count};
}
