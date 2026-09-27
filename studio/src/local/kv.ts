// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Files by path, for the no-server stores: the browser's Origin Private
// File System (OPFS) in the app, memory in tests. Paths are "a/b/c.json";
// directories are made as needed. Every write replaces the whole file.

export interface Kv {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, data: Uint8Array | string): Promise<void>;
  /** A file, or a directory with everything under it; missing is fine. */
  remove(path: string): Promise<void>;
  /** The names directly under a directory ([] when it does not exist). */
  list(dir: string): Promise<string[]>;
  /** A file as a Blob (OPFS hands out the file itself: no copy). */
  blob(path: string, type?: string): Promise<Blob | null>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function readJson<T>(kv: Kv, path: string): Promise<T | null> {
  const bytes = await kv.read(path);
  if (bytes == null) {
    return null;
  }
  try {
    return JSON.parse(dec.decode(bytes)) as T;
  } catch {
    return null; // a damaged file reads as missing
  }
}

export function writeJson(kv: Kv, path: string, value: unknown): Promise<void> {
  return kv.write(path, JSON.stringify(value));
}

function split(path: string): string[] {
  return path.split('/').filter(p => p !== '' && p !== '.' && p !== '..');
}

export class MemoryKv implements Kv {
  readonly files = new Map<string, Uint8Array>();

  async read(path: string): Promise<Uint8Array | null> {
    return this.files.get(split(path).join('/')) ?? null;
  }

  async write(path: string, data: Uint8Array | string): Promise<void> {
    this.files.set(split(path).join('/'), typeof data === 'string' ? enc.encode(data) : data.slice());
  }

  async remove(path: string): Promise<void> {
    const p = split(path).join('/');
    for (const k of [...this.files.keys()]) {
      if (k === p || k.startsWith(`${p}/`)) {
        this.files.delete(k);
      }
    }
  }

  async list(dir: string): Promise<string[]> {
    const p = split(dir).join('/');
    const prefix = p === '' ? '' : `${p}/`;
    const names = new Set<string>();
    for (const k of this.files.keys()) {
      if (k.startsWith(prefix)) {
        names.add(k.slice(prefix.length).split('/')[0]);
      }
    }
    return [...names].sort();
  }

  async blob(path: string, type = ''): Promise<Blob | null> {
    const b = await this.read(path);
    return b == null ? null : new Blob([b], {type});
  }
}

/** OPFS, under one root directory. Writes are queued so one file never gets two writers. */
export class OpfsKv implements Kv {
  private _queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly _root = 'sam-ui') {}

  static available(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
  }

  private async _dir(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
    let d = await (await navigator.storage.getDirectory()).getDirectoryHandle(this._root, {create: true});
    for (const p of parts) {
      try {
        d = await d.getDirectoryHandle(p, {create});
      } catch {
        return null;
      }
    }
    return d;
  }

  private _serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this._queue.then(fn, fn);
    this._queue = next.catch(() => {});
    return next;
  }

  private async _file(path: string): Promise<File | null> {
    const parts = split(path);
    const dir = await this._dir(parts.slice(0, -1), false);
    try {
      return (await dir?.getFileHandle(parts[parts.length - 1]))?.getFile() ?? null;
    } catch {
      return null;
    }
  }

  async read(path: string): Promise<Uint8Array | null> {
    const f = await this._file(path);
    return f == null ? null : new Uint8Array(await f.arrayBuffer());
  }

  async blob(path: string, type = ''): Promise<Blob | null> {
    const f = await this._file(path);
    return f == null ? null : type === '' || f.type === type ? f : new Blob([f], {type});
  }

  write(path: string, data: Uint8Array | string): Promise<void> {
    return this._serial(async () => {
      const parts = split(path);
      const dir = await this._dir(parts.slice(0, -1), true);
      const handle = await dir!.getFileHandle(parts[parts.length - 1], {create: true});
      const w = await handle.createWritable();
      await w.write(typeof data === 'string' ? data : new Blob([data]));
      await w.close();
    });
  }

  remove(path: string): Promise<void> {
    return this._serial(async () => {
      const parts = split(path);
      const dir = await this._dir(parts.slice(0, -1), false);
      await dir?.removeEntry(parts[parts.length - 1], {recursive: true}).catch(() => {});
    });
  }

  async list(dir: string): Promise<string[]> {
    const d = await this._dir(split(dir), false);
    if (d == null) {
      return [];
    }
    const names: string[] = [];
    for await (const name of (d as unknown as {keys(): AsyncIterable<string>}).keys()) {
      names.push(name);
    }
    return names.sort();
  }
}
