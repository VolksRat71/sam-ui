// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The pure parts of studio's in-browser mask exports: the provenance every export carries (so a SAM 2.1 tiny export can never pass
// for a SAM 2 large one), and the rotoscoping working folder's decision
// files, laid out as demo/backend/server/tracks/export.py writes them.
// Frames inside an object's absent ranges export empty (a black matte, a null
// outline), and its clicks there stay out of anchors.json, as the backend does.
// Present and candidate ranges never change a mask: README.txt and the roto
// folder's JSON record every range with its state (a candidate's source and
// score too), as tracks/export.py's manifest does.
//
// Exports follow the object layout (state/layout.ts): objects in list order,
// and a folder per group. In the zips (videos, vectors) a grouped object's
// file is in "<group>/", with an optional union of the group's masks there
// too; in the roto folder the mattes stay in data/mattes_tracked/<pid>/ (the
// pipeline reads them there) and each group gets data/groups/<folder>/, as
// tracks/export.py writes it. README.txt and the JSON record each object's group.
//
// The roto folder's data/review.json carries the audit queue (state/audit.ts)
// as tracks/export.py writes it: "<pid>:<1-based frame>": ["sam-ui review
// (score s): why"], marked reviewed where a person said it looks right, and
// the manifest holds each product's queue as data.
import type {QueueEntry} from './audit';
import {safeFileName} from './fileNames';
import {arrange, type Layout} from './layout';
import {type FrameRange, type Mark, type TimelineRange, absentAt, provenanceLabel, timelineView} from './ranges';

export type ExportKind = 'videos' | 'vectors' | 'folder';

export type ExportedObject = {
  objectId: number;
  /** The object's own name, as shown in studio. */
  label: string;
  /** Its file (or, in the roto folder, product id) name: safe and unique. */
  name: string;
  state: string;
  prompt: string;
  color: string;
  /** The model this object's track was made with, when it differs per object. */
  model?: string;
  /** Frames the object is marked absent on: exported empty. */
  ranges?: ReadonlyArray<FrameRange>;
  /** Its present and candidate ranges: recorded, never applied to a mask. */
  marks?: ReadonlyArray<Mark>;
  /** Its group, if it has one (set by groupExport). */
  group?: {id: string; name: string} | null;
};

/** A group as exported: only groups with an exported member get one. */
export type ExportGroup = {
  id: string;
  name: string;
  color: string;
  /** Its folder: in the zip (videos, vectors), or under data/groups/ (folder). */
  folder: string;
  /** Object ids, in export order. */
  members: number[];
};

/** The roto folder's group folder for a name: as tracks/export.py's _folder. */
function rotoFolder(name: string, id: string): string {
  const slug = name
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .toLowerCase()
    .slice(0, 64);
  return slug === '' ? id.toLowerCase() : slug;
}

/**
 * The objects of an export in the layout's order, each with its group, and
 * the groups that have an exported member, each with a unique folder.
 */
export function groupExport(
  kind: ExportKind,
  objects: ReadonlyArray<ExportedObject>,
  layout: Layout,
): {objects: ExportedObject[]; groups: ExportGroup[]} {
  const arranged = arrange(layout, objects.map(o => o.objectId));
  const byObject = new Map(objects.map(o => [o.objectId, o]));
  const groupOfId = new Map(arranged.groups.flatMap(g => g.members.map(m => [m, g] as const)));
  const ordered = arranged.order.map(id => {
    const g = groupOfId.get(id);
    return {...byObject.get(id)!, group: g != null ? {id: g.id, name: g.name} : null};
  });
  const used = new Set<string>();
  const groups: ExportGroup[] = [];
  for (const g of arranged.groups) {
    if (g.members.length === 0) {
      continue;
    }
    const base = kind === 'folder' ? rotoFolder(g.name, g.id) : safeFileName(g.name, 'Group');
    let folder = base;
    for (let k = 2; used.has(folder.toLowerCase()); k++) {
      folder = kind === 'folder' ? `${base}_${k}` : `${base} (${k})`;
    }
    used.add(folder.toLowerCase());
    groups.push({id: g.id, name: g.name, color: g.color, folder, members: g.members});
  }
  return {objects: ordered, groups};
}

/** A zip entry's path for an object's file: in its group's folder, if it has one. */
export function exportPath(o: ExportedObject, groups: ReadonlyArray<ExportGroup>, ext: string): string {
  const g = groups.find(x => x.id === o.group?.id);
  return g != null ? `${g.folder}/${o.name}${ext}` : `${o.name}${ext}`;
}

/** The union file of a group in a zip: "<folder>/<folder> union<ext>", moved aside if a member has that name. */
export function unionPath(g: ExportGroup, objects: ReadonlyArray<ExportedObject>, ext: string): string {
  const taken = new Set(objects.filter(o => o.group?.id === g.id).map(o => o.name.toLowerCase()));
  let name = `${g.folder} union`;
  for (let k = 2; taken.has(name.toLowerCase()); k++) {
    name = `${g.folder} union (${k})`;
  }
  return `${g.folder}/${name}${ext}`;
}

/** The roto folder's union matte of a group for 0-based frame i. */
export function unionMatteName(g: ExportGroup, frame: number): string {
  return `data/groups/${g.folder}/union/${String(frame + 1).padStart(5, '0')}.png`;
}

/** `maskAt` with every absent frame empty (null), even from a track made before the range. */
export function withoutAbsent<T>(
  maskAt: (id: number, frame: number) => T | null,
  objects: ReadonlyArray<Pick<ExportedObject, 'objectId' | 'ranges'>>,
): (id: number, frame: number) => T | null {
  const ranges = new Map(objects.map(o => [o.objectId, o.ranges ?? []]));
  return (id, frame) => (absentAt(ranges.get(id), frame) ? null : maskAt(id, frame));
}

export type Provenance = {
  engine: string;
  engineLabel: string;
  model: string;
  video: string;
  frames: number;
  fps: number;
  width: number;
  height: number;
  /** ISO time. */
  exported: string;
};

const KIND_TITLE: Record<ExportKind, string> = {
  videos: 'Mask videos: one grayscale H.264 MP4 per object, 255 = object, 0 = background.',
  vectors: "Vector outlines: one JSON per object, in the rotoscoping skill's contours.py format.",
  folder: 'A rotoscoping working folder (PNG mattes), as the rotoscoping-video-subjects pipeline reads it.',
};

/** Every range of an object's timeline, one state a frame. */
function rangesOf(o: Pick<ExportedObject, 'ranges' | 'marks'>) {
  return timelineView(o.ranges ?? [], o.marks ?? []);
}

function rangeNote(r: TimelineRange): string {
  return r.state === 'absent'
    ? 'absent (empty mattes)'
    : r.state === 'present'
      ? 'present'
      : `candidate, ${provenanceLabel(r)} (unconfirmed; masks unchanged)`;
}

/** README.txt of an export zip. */
export function readme(
  kind: ExportKind,
  p: Provenance,
  objects: ReadonlyArray<ExportedObject>,
  groups: ReadonlyArray<ExportGroup> = [],
  union = false,
): string {
  const lines = [
    'sam-ui export',
    '',
    KIND_TITLE[kind],
    '',
    `Engine:     ${p.engineLabel} (${p.engine})`,
    `Model:      ${p.model}`,
    `Video:      ${p.video}`,
    `Size:       ${p.width} x ${p.height}`,
    `Frames:     ${p.frames}`,
    `FPS:        ${p.fps}`,
    `Exported:   ${p.exported}`,
    '',
    'Objects:',
    ...objects.flatMap(o => [
      `  ${o.name}: object id ${o.objectId}, named "${o.label}", ${o.state}${o.model != null && o.model !== p.model ? `, model ${o.model}` : ''}${o.group != null ? `, group "${o.group.name}"` : ''}`,
      ...rangesOf(o).map(r => `    frames ${r.start + 1}-${r.end + 1}: ${rangeNote(r)}`),
    ]),
    '',
  ];
  if (groups.length > 0) {
    lines.push(
      'Groups (each in its own folder):',
      ...groups.map(
        g =>
          `  ${g.name}: folder "${kind === 'folder' ? `data/groups/${g.folder}` : g.folder}", ${g.members.length} ${g.members.length === 1 ? 'object' : 'objects'}${union ? ', with a union mask' : ''}`,
      ),
      '',
    );
  }
  if (kind === 'videos') {
    lines.push(
      'The videos are the size of the source (padded by one black row or column where',
      'H.264 needs even dimensions) at its frame rate. Frame 1 of a video is frame 1 of the clip.',
      '',
    );
  }
  return lines.join('\n');
}

export type Seeds = ReadonlyMap<number, ReadonlyArray<readonly [number, number, number]>>;

/** One stop's note in data/review.json, word for word as tracks/export.py's _note. */
export function reviewNote(e: Pick<QueueEntry, 'score' | 'reviewed' | 'reasons'>): string {
  const done = e.reviewed ? ', reviewed in sam-ui: looks right' : '';
  return `sam-ui review (score ${e.score.toFixed(2)}${done}): ${e.reasons.map(r => r.detail).join('; ')}`;
}

/**
 * The folder's JSON files: products.json, anchors.json (seed clicks in
 * full-res pixels, frames 1-based), shots.json, data/review.json (the audit
 * queue's stops, `review`) and notes/sam-ui-export.json.
 */
export function rotoDecisions(
  p: Provenance,
  objects: ReadonlyArray<ExportedObject>,
  seedsOf: (objectId: number) => Seeds,
  framesOf: (objectId: number) => number,
  groups: ReadonlyArray<ExportGroup> = [],
  union = false,
  review: ReadonlyArray<QueueEntry> = [],
): Record<string, string> {
  const stopsOf = (id: number) => review.filter(e => e.objectId === id).sort((a, b) => a.frame - b.frame);
  const products = objects.map(o => ({
    id: o.name,
    shots: [1],
    prompt: o.prompt,
    color: o.color,
    status: 'confirmed',
    meta: {sam_ui_object: o.objectId, name: o.label, ...(o.group != null ? {group: o.group} : {})},
  }));
  const pid = new Map(objects.map(o => [o.objectId, o.name]));
  const groupEntries = groups.map(g => ({
    id: g.id,
    name: g.name,
    color: g.color,
    folder: g.folder,
    members: g.members.map(m => pid.get(m)!).filter(x => x != null),
    union,
  }));
  const anchors: Record<string, {points: Record<string, number[][]>}> = {};
  for (const o of objects) {
    const points: Record<string, number[][]> = {};
    for (const [frame, pts] of [...seedsOf(o.objectId)].sort((a, b) => a[0] - b[0])) {
      if (pts.length > 0 && !absentAt(o.ranges, frame)) {
        points[String(frame + 1)] = pts.map(q => [Math.round(q[0] * p.width), Math.round(q[1] * p.height), q[2] === 0 ? 0 : 1]);
      }
    }
    if (Object.keys(points).length > 0) {
      anchors[o.name] = {points};
    }
  }
  const manifest = {
    exported: p.exported,
    video: p.video,
    video_path: null,
    engine: p.engine,
    model: p.model,
    products: Object.fromEntries(
      objects.map(o => [
        o.name,
        {
          object_id: o.objectId,
          state: o.state,
          engine: p.engine,
          model: o.model ?? p.model,
          frames: [0, p.frames - 1],
          n_frames: framesOf(o.objectId),
          // 0-based, as tracks/export.py records them
          ranges: rangesOf(o),
          group: o.group ?? null,
          // as the backend's manifest: 0-based frames
          review: {
            n_frames: p.frames,
            unreviewed: stopsOf(o.objectId).filter(e => !e.reviewed).length,
            locations: stopsOf(o.objectId).map(({objectId: _id, reviewedAt, ...e}) => ({...e, reviewed_at: reviewedAt})),
          },
        },
      ]),
    ),
    skipped: {},
    n_frames: p.frames,
    groups: groupEntries,
    frames_extracted: false,
  };
  const json = (v: unknown) => JSON.stringify(v, null, 1);
  const files: Record<string, string> = {
    'products.json': json({products}),
    'anchors.json': json(anchors),
    'shots.json': json({cuts: [1], unsure: []}),
    'data/review.json': json(
      Object.fromEntries(objects.flatMap(o => stopsOf(o.objectId).map(e => [`${o.name}:${e.frame + 1}`, [reviewNote(e)]]))),
    ),
    'notes/sam-ui-export.json': json(manifest),
  };
  for (const {folder, ...g} of groupEntries) {
    files[`data/groups/${folder}/group.json`] = json(g);
  }
  return files;
}

/** The matte's file name for 0-based frame i: clip frames are 1-based, 5 digits. */
export function matteName(name: string, frame: number): string {
  return `data/mattes_tracked/${name}/${String(frame + 1).padStart(5, '0')}.png`;
}
