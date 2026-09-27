// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The pure parts of studio's in-browser mask exports: the provenance every export carries (so a SAM 2.1 tiny export can never pass
// for a SAM 2 large one), and the rotoscoping working folder's decision
// files, laid out as demo/backend/server/tracks/export.py writes them.

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
};

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

/** README.txt of an export zip. */
export function readme(kind: ExportKind, p: Provenance, objects: ReadonlyArray<ExportedObject>): string {
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
    ...objects.map(
      o =>
        `  ${o.name}: object id ${o.objectId}, named "${o.label}", ${o.state}${o.model != null && o.model !== p.model ? `, model ${o.model}` : ''}`,
    ),
    '',
  ];
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

/**
 * The folder's JSON files: products.json, anchors.json (seed clicks in
 * full-res pixels, frames 1-based), shots.json, data/review.json and
 * notes/sam-ui-export.json.
 */
export function rotoDecisions(
  p: Provenance,
  objects: ReadonlyArray<ExportedObject>,
  seedsOf: (objectId: number) => Seeds,
  framesOf: (objectId: number) => number,
): Record<string, string> {
  const products = objects.map(o => ({
    id: o.name,
    shots: [1],
    prompt: o.prompt,
    color: o.color,
    status: 'confirmed',
    meta: {sam_ui_object: o.objectId, name: o.label},
  }));
  const anchors: Record<string, {points: Record<string, number[][]>}> = {};
  for (const o of objects) {
    const points: Record<string, number[][]> = {};
    for (const [frame, pts] of [...seedsOf(o.objectId)].sort((a, b) => a[0] - b[0])) {
      if (pts.length > 0) {
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
        {object_id: o.objectId, state: o.state, engine: p.engine, model: o.model ?? p.model, frames: [0, p.frames - 1], n_frames: framesOf(o.objectId)},
      ]),
    ),
    skipped: {},
    n_frames: p.frames,
    frames_extracted: false,
  };
  const json = (v: unknown) => JSON.stringify(v, null, 1);
  return {
    'products.json': json({products}),
    'anchors.json': json(anchors),
    'shots.json': json({cuts: [1], unsure: []}),
    'data/review.json': '{}',
    'notes/sam-ui-export.json': json(manifest),
  };
}

/** The matte's file name for 0-based frame i: clip frames are 1-based, 5 digits. */
export function matteName(name: string, frame: number): string {
  return `data/mattes_tracked/${name}/${String(frame + 1).padStart(5, '0')}.png`;
}
