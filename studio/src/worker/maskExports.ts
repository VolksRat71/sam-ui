// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The mask exports studio makes in the browser, each a zip with a README.txt
// that records where the masks came from:
//   - videos:  one grayscale H.264 MP4 per object (255 object, 0 background),
//              at the video's size and fps, padded to even dimensions;
//   - vectors: one Vector JSON per object (state/contours.ts);
//   - folder:  the rotoscoping working folder (tracks/export.py's layout),
//              for when the backend cannot write it (browser tracks).
// Frames inside an object's absent ranges are empty in all three.
// Objects come in the order given (the layout's: state/maskExport.ts
// groupExport); a grouped object's files go in its group's folder, with an
// optional union of the group's masks (opts.union).
import type {QueueEntry} from '~/state/audit';
import {BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH} from 'mediabunny';
import type {RLEObject} from '@/jscocotools/mask';
import {grayPng} from '~/lib/png';
import {zip, type ZipEntry} from '~/lib/zip';
import {rleToMask} from '~/local/sam2/masks';
import {vectorJson} from '~/state/contours';
import {
  type ExportedObject,
  type ExportGroup,
  type ExportKind,
  exportPath,
  matteName,
  type Provenance,
  readme,
  rotoDecisions,
  type Seeds,
  unionMatteName,
  unionPath,
  withoutAbsent,
} from '~/state/maskExport';

export type ExportOptions = {
  /** The groups with an exported member (groupExport); none: no folders. */
  groups?: ReadonlyArray<ExportGroup>;
  /** Also one union mask per group. Off by default. */
  union?: boolean;
  /** The audit queue's stops: data/review.json in the roto folder. */
  review?: ReadonlyArray<QueueEntry>;
};

export type MaskSource = {
  /** Object `id`'s mask on frame i, or null where its track has none. */
  maskAt(id: number, frame: number): RLEObject | null;
  seedsOf(id: number): Seeds;
};

/** A frame's mask as a row-major 0/1 plane of the video's size (zeros when there is none). */
function plane(rle: RLEObject | null, w: number, h: number): Uint8Array | null {
  if (rle == null) {
    return null;
  }
  const m = rleToMask(rle);
  if (m.width !== w || m.height !== h) {
    throw new Error(`a mask is ${m.width}x${m.height}, the video ${w}x${h}`);
  }
  return m.mask;
}

/** The OR of several objects' masks, as one more mask source id (a group's union). */
function unionSource(src: MaskSource, members: ReadonlyArray<number>, p: Provenance): (frame: number) => Uint8Array | null {
  return frame => {
    let acc: Uint8Array | null = null;
    for (const id of members) {
      const m = plane(src.maskAt(id, frame), p.width, p.height);
      if (m != null) {
        acc = acc == null ? m.slice() : acc.map((v, k) => v | m[k]);
      }
    }
    return acc;
  };
}

async function maskVideo(p: Provenance, id: number, src: MaskSource, onFrame: () => void): Promise<Uint8Array> {
  return maskVideoOf(p, frame => plane(src.maskAt(id, frame), p.width, p.height), onFrame);
}

async function maskVideoOf(p: Provenance, maskOf: (frame: number) => Uint8Array | null, onFrame: () => void): Promise<Uint8Array> {
  // H.264 needs even dimensions: pad with a black row or column
  const w = p.width + (p.width % 2);
  const h = p.height + (p.height % 2);
  const fps = p.fps > 0 ? p.fps : 30;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (ctx == null) {
    throw new Error('no 2D canvas for the export');
  }
  const output = new Output({format: new Mp4OutputFormat({fastStart: 'in-memory'}), target: new BufferTarget()});
  const source = new CanvasSource(canvas, {codec: 'avc', quality: QUALITY_HIGH});
  output.addVideoTrack(source, {frameRate: fps});
  await output.start();
  const image = ctx.createImageData(p.width, p.height);
  const px = new Uint32Array(image.data.buffer);
  try {
    for (let i = 0; i < p.frames; i++) {
      const m = maskOf(i);
      for (let k = 0; k < px.length; k++) {
        px[k] = m != null && m[k] ? 0xffffffff : 0xff000000;
      }
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      ctx.putImageData(image, 0, 0);
      await source.add(i / fps, 1 / fps);
      onFrame();
    }
    await output.finalize();
  } catch (error) {
    await output.cancel();
    throw error;
  }
  const buffer = (output.target as BufferTarget).buffer;
  if (buffer == null) {
    throw new Error('the export produced no file');
  }
  return new Uint8Array(buffer);
}

/**
 * `src` with every absent frame empty. The original maskAt is read once, up
 * front: a closure over `src` itself would call the wrapper again once `src`
 * is rebound, recursing until the stack overflows.
 */
export function sourceWithoutAbsent(src: MaskSource, objects: ReadonlyArray<ExportedObject>): MaskSource {
  const inner = src.maskAt.bind(src);
  return {...src, maskAt: withoutAbsent(inner, objects)};
}

/** Build one export as a zip. `onProgress` gets 0-1. */
export async function buildExport(
  kind: ExportKind,
  p: Provenance,
  objects: ReadonlyArray<ExportedObject>,
  src: MaskSource,
  onProgress: (done: number) => void,
  opts: ExportOptions = {},
): Promise<Uint8Array> {
  // absent frames are empty in every kind of export
  src = sourceWithoutAbsent(src, objects);
  const groups = opts.groups ?? [];
  const union = opts.union === true && groups.length > 0;
  const entries: ZipEntry[] = [{name: 'README.txt', data: readme(kind, p, objects, groups, union)}];
  const total = Math.max(1, (objects.length + (union ? groups.length : 0)) * p.frames);
  let done = 0;
  const tick = () => {
    done++;
    if (done % 8 === 0 || done === total) {
      onProgress(done / total);
    }
  };
  for (const o of objects) {
    if (kind === 'videos') {
      entries.push({name: exportPath(o, groups, '.mp4'), data: await maskVideo(p, o.objectId, src, tick)});
    } else if (kind === 'vectors') {
      const v = vectorJson(
        {
          engine: p.engine,
          model: o.model ?? p.model,
          object: {id: o.objectId, name: o.label},
          ...(o.group != null ? {group: o.group} : {}),
          fps: p.fps,
          w: p.width,
          h: p.height,
          frames: p.frames,
        },
        i => {
          tick();
          return plane(src.maskAt(o.objectId, i), p.width, p.height);
        },
      );
      entries.push({name: exportPath(o, groups, '.json'), data: JSON.stringify(v)});
    } else {
      const zeros = new Uint8Array(p.width * p.height);
      for (let i = 0; i < p.frames; i++) {
        const m = plane(src.maskAt(o.objectId, i), p.width, p.height);
        const gray = m == null ? zeros : m.map(v => (v ? 255 : 0));
        entries.push({name: matteName(o.name, i), data: await grayPng(gray, p.width, p.height)});
        tick();
      }
    }
    // let the worker answer the UI between objects
    await new Promise(r => setTimeout(r, 0));
  }
  for (const g of union ? groups : []) {
    const maskOf = unionSource(src, g.members, p);
    if (kind === 'videos') {
      entries.push({name: unionPath(g, objects, '.mp4'), data: await maskVideoOf(p, maskOf, tick)});
    } else if (kind === 'vectors') {
      const v = vectorJson(
        {engine: p.engine, model: p.model, group: {id: g.id, name: g.name}, fps: p.fps, w: p.width, h: p.height, frames: p.frames},
        i => {
          tick();
          return maskOf(i);
        },
      );
      entries.push({name: unionPath(g, objects, '.json'), data: JSON.stringify(v)});
    } else {
      const zeros = new Uint8Array(p.width * p.height);
      for (let i = 0; i < p.frames; i++) {
        const m = maskOf(i);
        entries.push({name: unionMatteName(g, i), data: await grayPng(m == null ? zeros : m.map(v => (v ? 255 : 0)), p.width, p.height)});
        tick();
      }
    }
    await new Promise(r => setTimeout(r, 0));
  }
  if (kind === 'folder') {
    const files = rotoDecisions(p, objects, id => src.seedsOf(id), () => p.frames, groups, union, opts.review ?? []);
    for (const [name, data] of Object.entries(files)) {
      entries.push({name, data});
    }
  }
  onProgress(1);
  return zip(entries);
}
