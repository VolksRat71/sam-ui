// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {
  TrackPart,
  jobOutcome,
  parseObjectsHeader,
  parseTrackPart,
  readTrackStream,
} from './trackStream';

const CONTENT_TYPE = 'multipart/x-savi-stream; boundary=frame';
const encoder = new TextEncoder();

/** One part as demo/backend/server/inference/multipart.py builds it. */
function part(body: unknown): string {
  const json = JSON.stringify(body);
  return (
    '--frame\r\n' +
    'Content-Type: application/json; charset=utf-8\r\n' +
    'Frame-Current: -1\r\nFrame-Total: -1\r\nMask-Type: RLE[]\r\n' +
    `Content-Length: ${encoder.encode(json).length}\r\n\r\n` +
    json
  );
}

/** A body that arrives in `chunk`-byte pieces, split anywhere. */
function body(text: string, chunk = 7): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(text);
  let pos = 0;
  return new ReadableStream({
    pull(controller) {
      if (pos >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(pos, pos + chunk));
      pos += chunk;
    },
  });
}

async function collect(text: string, chunk?: number): Promise<TrackPart[]> {
  const out: TrackPart[] = [];
  for await (const p of readTrackStream(CONTENT_TYPE, body(text, chunk))) {
    out.push(p);
  }
  return out;
}

const mask = {size: [240, 320], counts: 'abc'};

describe('readTrackStream', () => {
  it('reads frames, then the closing part of a finished job', async () => {
    const text =
      part({frame_index: 0, results: [{object_id: 2, mask}]}) +
      part({frame_index: 1, results: [{object_id: 2, mask}, {object_id: 3, mask}]}) +
      part({frame_index: -1, results: [], done: true, job_id: 'j1', objects: [2, 3], tracked: [2], failed: {'3': 'OSError: disk full'}});
    for (const chunk of [1, 5, 64, 10_000]) {
      const parts = await collect(text, chunk);
      expect(parts.map(p => p.kind)).toEqual(['frame', 'frame', 'done']);
      expect(parts[1]).toEqual({
        kind: 'frame',
        frameIndex: 1,
        results: [
          {objectId: 2, mask: {size: [240, 320], counts: 'abc'}},
          {objectId: 3, mask: {size: [240, 320], counts: 'abc'}},
        ],
      });
      expect(parts[2]).toEqual({
        kind: 'done',
        jobId: 'j1',
        objects: [2, 3],
        tracked: [2],
        failed: {3: 'OSError: disk full'},
      });
    }
  });

  it('reads an error part (a cancel or an engine failure)', async () => {
    const parts = await collect(
      part({frame_index: 0, results: [{object_id: 0, mask}]}) +
        part({frame_index: -1, results: [], done: false, job_id: 'j2', error: 'canceled', objects: [0]}),
    );
    expect(parts[1]).toEqual({kind: 'error', jobId: 'j2', error: 'canceled', objects: [0]});
    expect(jobOutcome(parts[1] as never)).toEqual({ok: false, error: 'canceled', objects: [0]});
  });

  it('never reads the closing part as a frame, even with frame_index and results', () => {
    const p = parseTrackPart({frame_index: -1, results: [], done: true, objects: [], tracked: [], failed: {}});
    expect(p.kind).toBe('done');
  });

  it('reads a cached-track stream, which has no closing part', async () => {
    const parts = await collect(part({frame_index: 4, results: [{object_id: 1, mask}]}));
    expect(parts).toHaveLength(1);
    expect(parts[0].kind).toBe('frame');
  });

  it('fails on a stream cut mid-part', async () => {
    const text = part({frame_index: 0, results: []});
    await expect(collect(text.slice(0, text.length - 3))).rejects.toThrow(/mid-part/);
  });

  it('refuses a response that is not a track stream', async () => {
    const gen = readTrackStream('application/json', body('{}'));
    await expect(gen.next()).rejects.toThrow(/not a track stream/);
  });
});

describe('jobOutcome', () => {
  it('treats a missing closing part as a failure', () => {
    expect(jobOutcome(null)).toMatchObject({ok: false});
  });

  it('passes a finished job through', () => {
    expect(jobOutcome({kind: 'done', jobId: null, objects: [1], tracked: [1], failed: {}})).toEqual({
      ok: true,
      objects: [1],
      tracked: [1],
      failed: {},
    });
  });
});

describe('parseObjectsHeader', () => {
  it('reads the Objects-Tracked header', () => {
    expect(parseObjectsHeader('0,1, 4')).toEqual([0, 1, 4]);
    expect(parseObjectsHeader('')).toEqual([]);
    expect(parseObjectsHeader(null)).toEqual([]);
  });
});
