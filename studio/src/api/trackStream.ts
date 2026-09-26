// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Reads the backend's track streams (POST /track_objects, POST /track_masks):
// multipart/x-savi-stream parts, split by Meta's MultipartStream parser. Each
// part is JSON: a frame {frame_index, results: [{object_id, mask}]}, or, last
// on /track_objects, a closing part {done: true, job_id, objects, tracked,
// failed} or {done: false, job_id, error, objects}. The closing part also
// carries frame_index -1 and results [], so `done` is checked first.
import multipartStream from '@/common/utils/MultipartStream';
import type {RLEObject} from '@/jscocotools/mask';

export type FramePart = {
  kind: 'frame';
  frameIndex: number;
  results: Array<{objectId: number; mask: RLEObject}>;
};

export type DonePart = {
  kind: 'done';
  jobId: string | null;
  objects: number[];
  tracked: number[];
  failed: Record<number, string>;
};

export type ErrorPart = {
  kind: 'error';
  jobId: string | null;
  error: string;
  objects: number[];
};

export type TrackPart = FramePart | DonePart | ErrorPart;

/** How a track job ended, from its closing part (or its lack of one). */
export type JobOutcome =
  | {ok: true; objects: number[]; tracked: number[]; failed: Record<number, string>}
  | {ok: false; error: string; objects: number[]};

export class TrackStreamError extends Error {}

function ids(value: unknown): number[] {
  return Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : [];
}

export function parseTrackPart(json: unknown): TrackPart {
  if (json == null || typeof json !== 'object') {
    throw new TrackStreamError('track stream part is not a JSON object');
  }
  const body = json as Record<string, unknown>;
  if ('done' in body) {
    const jobId = typeof body.job_id === 'string' ? body.job_id : null;
    if (body.done === true) {
      const failed: Record<number, string> = {};
      const raw = body.failed;
      if (raw != null && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          failed[Number(k)] = String(v);
        }
      }
      return {kind: 'done', jobId, objects: ids(body.objects), tracked: ids(body.tracked), failed};
    }
    return {
      kind: 'error',
      jobId,
      error: typeof body.error === 'string' ? body.error : 'track job failed',
      objects: ids(body.objects),
    };
  }
  if (typeof body.frame_index !== 'number' || !Array.isArray(body.results)) {
    throw new TrackStreamError('track stream part has no frame_index or results');
  }
  return {
    kind: 'frame',
    frameIndex: body.frame_index,
    results: (body.results as Array<{object_id: number; mask: RLEObject}>).map(r => ({
      objectId: Number(r.object_id),
      mask: {size: [r.mask.size[0], r.mask.size[1]], counts: r.mask.counts},
    })),
  };
}

/** The Objects-Tracked header: the ids the job selected, comma-separated. */
export function parseObjectsHeader(value: string | null): number[] {
  if (value == null || value.trim() === '') {
    return [];
  }
  return value
    .split(',')
    .map(s => Number.parseInt(s.trim(), 10))
    .filter(Number.isFinite);
}

export async function* readTrackStream(
  contentType: string | null,
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): AsyncGenerator<TrackPart, void> {
  if (contentType == null || !contentType.startsWith('multipart/x-savi-stream;')) {
    throw new TrackStreamError(`not a track stream (Content-Type ${contentType})`);
  }
  if (body == null) {
    throw new TrackStreamError('track stream has no body');
  }
  const reader = multipartStream(contentType, body).getReader();
  const text = new TextDecoder();
  try {
    while (true) {
      if (signal?.aborted) {
        return;
      }
      const {done, value} = await reader.read();
      if (done) {
        return;
      }
      const type: string = value.headers.get('Content-Type') ?? '';
      if (!type.startsWith('application/json')) {
        continue;
      }
      yield parseTrackPart(JSON.parse(text.decode(value.body)));
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * The outcome of a /track_objects job. Only the closing part says what was
 * cached: a stream that ends without one (a dropped connection, a killed
 * server) is a failure, however many frames it carried.
 */
export function jobOutcome(closing: DonePart | ErrorPart | null): JobOutcome {
  if (closing == null) {
    return {ok: false, error: 'the track stream ended without a closing part', objects: []};
  }
  if (closing.kind === 'error') {
    return {ok: false, error: closing.error, objects: closing.objects};
  }
  return {ok: true, objects: closing.objects, tracked: closing.tracked, failed: closing.failed};
}
