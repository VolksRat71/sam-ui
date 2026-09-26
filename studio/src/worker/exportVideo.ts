// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Encodes the rendered frames as an H.264 MP4, in the browser (WebCodecs,
// through mediabunny's muxer). Replaces Meta's encoder for studio's export:
// it gives a constant frame rate with exact timestamps, even dimensions,
// yuv420p and the moov atom at the front, so the file plays in QuickTime and
// in browsers, and it adds no watermark.
import {BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH} from 'mediabunny';
import {CanvasForm} from 'pts';

export type EncodeOptions = {
  width: number;
  height: number;
  fps: number;
  numFrames: number;
  /** Draw frame `index` onto `form` (a canvas the size of the video). */
  draw: (form: CanvasForm, index: number) => Promise<void>;
  onProgress?: (done: number) => void;
};

/** H.264 wants even dimensions: drop the last row or column if odd. */
export function evenSize(n: number): number {
  const r = Math.max(2, Math.floor(n));
  return r % 2 === 0 ? r : r - 1;
}

export async function encodeMp4(o: EncodeOptions): Promise<ArrayBuffer> {
  const width = evenSize(o.width);
  const height = evenSize(o.height);
  const fps = o.fps > 0 ? o.fps : 30;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (ctx == null) {
    throw new Error('no 2D canvas for the export');
  }
  const form = new CanvasForm(ctx);
  const output = new Output({
    format: new Mp4OutputFormat({fastStart: 'in-memory'}),
    target: new BufferTarget(),
  });
  const source = new CanvasSource(canvas, {codec: 'avc', quality: QUALITY_HIGH});
  output.addVideoTrack(source, {frameRate: fps});
  await output.start();
  try {
    for (let i = 0; i < o.numFrames; i++) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      await o.draw(form, i);
      await source.add(i / fps, 1 / fps);
      o.onProgress?.((i + 1) / o.numFrames);
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
  return buffer;
}
