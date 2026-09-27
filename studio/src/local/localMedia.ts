// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Videos with no backend: files the user opens are copied into this
// browser's OPFS (they never leave it), keyed by their sha256 as the backend
// keys uploads, plus the samples a build bundles (samples/index.json next
// to the page). Each becomes a VideoItem whose url is a blob URL (OPFS) or
// the sample's own URL, and whose key is its sha256.
import {ALL_FORMATS, BlobSource, Input} from 'mediabunny';
import {BASE_URL} from '~/config';
import {rememberUploadName} from '~/lib/uploadNames';
import type {VideoItem} from '~/workspace/useStudioSession';
import {type Kv, readJson, writeJson} from './kv';
import {OfflineService} from './offlineStores';

type Entry = {key: string; name: string; width: number; height: number; added: string};
/** samples/index.json: the files, and their size when the build knows it. */
type Sample = {file: string; width?: number; height?: number};

const INDEX = 'videos/index.json';

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = data instanceof Uint8Array ? data.slice().buffer : data;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function videoSize(blob: Blob): Promise<{width: number; height: number}> {
  const input = new Input({source: new BlobSource(blob), formats: ALL_FORMATS});
  try {
    const track = await input.getPrimaryVideoTrack();
    if (track == null) {
      throw new Error('the file has no video track');
    }
    return {width: track.displayWidth, height: track.displayHeight};
  } finally {
    input.dispose();
  }
}

export class LocalMedia {
  private _urls = new Map<string, string>();
  private _samples: VideoItem[] | null = null;

  constructor(private readonly _kv: Kv) {}

  private async _index(): Promise<Entry[]> {
    return (await readJson<Entry[]>(this._kv, INDEX)) ?? [];
  }

  private async _item(e: Entry): Promise<VideoItem | null> {
    let url = this._urls.get(e.key);
    if (url == null) {
      const blob = await this._kv.blob(`videos/${e.key}.mp4`, 'video/mp4');
      if (blob == null) {
        return null; // the index names a file that is gone
      }
      url = URL.createObjectURL(blob);
      this._urls.set(e.key, url);
    }
    const path = `local/${e.key}.mp4`;
    rememberUploadName(path, e.name);
    return {path, url, width: e.width, height: e.height, posterUrl: null, key: e.key};
  }

  /** The bundled samples (a Pages build ships one or two of Meta's gallery clips). */
  private async _loadSamples(): Promise<VideoItem[]> {
    if (this._samples != null) {
      return this._samples;
    }
    const res = await fetch(`${BASE_URL}samples/index.json`).catch(() => null);
    const list = res?.ok && (res.headers.get('Content-Type') ?? '').includes('json') ? ((await res.json()) as Sample[]) : [];
    const out: VideoItem[] = [];
    for (const s of list) {
      const url = `${BASE_URL}samples/${s.file}`;
      const bytes = await fetch(url)
        .then(r => (r.ok ? r.arrayBuffer() : null))
        .catch(() => null);
      if (bytes == null) {
        continue;
      }
      const size = s.width != null && s.height != null ? {width: s.width, height: s.height} : await videoSize(new Blob([bytes], {type: 'video/mp4'})).catch(() => null);
      if (size == null) {
        continue;
      }
      out.push({path: `samples/${s.file}`, url, width: size.width, height: size.height, posterUrl: null, key: await sha256Hex(bytes)});
    }
    this._samples = out;
    return out;
  }

  /** The samples, then the opened files, newest first. */
  async list(): Promise<VideoItem[]> {
    const opened: VideoItem[] = [];
    for (const e of [...(await this._index())].reverse()) {
      const item = await this._item(e);
      if (item != null) {
        opened.push(item);
      }
    }
    return [...(await this._loadSamples()), ...opened];
  }

  /** Copy a file into this browser; opening the same file again finds the copy. */
  async open(file: File): Promise<VideoItem> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const key = await sha256Hex(bytes);
    const index = await this._index();
    let entry = index.find(e => e.key === key);
    if (entry == null) {
      const {width, height} = await videoSize(file);
      await this._kv.write(`videos/${key}.mp4`, bytes);
      entry = {key, name: file.name, width, height, added: new Date().toISOString()};
      await writeJson(this._kv, INDEX, [...index, entry]);
    }
    const item = await this._item(entry);
    if (item == null) {
      throw new Error('the file could not be stored in this browser');
    }
    return item;
  }

  /** Delete an opened file, and (purge) its objects and tracks. */
  async remove(video: VideoItem, purge: boolean): Promise<void> {
    const key = video.key ?? video.path.replace(/^local\/|\.mp4$/g, '');
    await writeJson(this._kv, INDEX, (await this._index()).filter(e => e.key !== key));
    await this._kv.remove(`videos/${key}.mp4`);
    const url = this._urls.get(key);
    if (url != null) {
      URL.revokeObjectURL(url);
      this._urls.delete(key);
    }
    if (purge) {
      await new OfflineService(this._kv).clearVideo(key);
    }
  }
}
