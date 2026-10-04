// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// "Looks right" marks on the audit queue (state/audit.ts) for the tracks this
// browser holds, the twin of the backend's tracks/review.py:
//   seeds/<video>/<obj>/review.json  {"marks": [ReviewMark]}
// beside the object's seeds, so removing the object removes them, and never
// in its seeds key or seed record (a mark makes no track stale and is not a
// seed change to undo). With no backend it lives in OPFS; for the browser
// engine beside a backend, in memory, as that engine's tracks are.
import {type ReviewMark, covers, parseMarks} from '~/state/audit';
import {type Kv, readJson, writeJson} from './kv';

/** Marks kept per object, oldest dropped first (invalid ones stay, so an undo can bring them back). */
export const REVIEW_KEEP = 500;

export class KvReviewStore {
  constructor(private readonly _kv: Kv) {}

  private _path(video: string, obj: number): string {
    return `seeds/${video}/${Math.trunc(obj)}/review.json`;
  }

  async marks(video: string, obj: number): Promise<ReviewMark[]> {
    return parseMarks(await readJson<unknown>(this._kv, this._path(video, obj)));
  }

  private async _write(video: string, obj: number, marks: ReviewMark[]): Promise<void> {
    if (marks.length === 0) {
      await this._kv.remove(this._path(video, obj));
    } else {
      await writeJson(this._kv, this._path(video, obj), {marks: marks.slice(-REVIEW_KEEP)});
    }
  }

  /** Mark a frame reviewed, replacing any mark on it from the same engine. */
  async mark(video: string, obj: number, m: ReviewMark): Promise<void> {
    const rest = (await this.marks(video, obj)).filter(x => !(x.engine === m.engine && x.frame === m.frame));
    await this._write(video, obj, [...rest, m]);
  }

  /** Drop `engine`'s marks reviewing anything in frames start-end. */
  async unmark(video: string, obj: number, engine: string, start: number, end: number): Promise<void> {
    const marks = await this.marks(video, obj);
    await this._write(video, obj, marks.filter(m => !(m.engine === engine && covers(m, start, end))));
  }
}
