// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The host side of model.worker.ts: typed calls, events, and the frames the
// worker asks for. A host is studio's video worker (it already decodes the
// video) or the parity page.
import type {FromWorker, ModelEvent, ModelMethod, ModelMethods, ToWorker} from './modelProtocol';

/** A frame at the model's input size (size x size); ownership passes to the client. */
export type FrameProvider = (frame: number, size: number) => Promise<ImageBitmap>;

export function spawnModelWorker(): Worker {
  return new Worker(new URL('./model.worker.ts', import.meta.url), {type: 'module', name: 'sam2-model'});
}

export class ModelClient {
  private _next = 1;
  private _waits = new Map<number, {resolve: (v: unknown) => void; reject: (e: Error) => void}>();
  private _listeners = new Set<(e: ModelEvent) => void>();
  private _dead: Error | null = null;

  constructor(
    private readonly _worker: Worker,
    private readonly _frames: FrameProvider,
  ) {
    _worker.addEventListener('message', (e: MessageEvent<FromWorker>) => this._onMessage(e.data));
    _worker.addEventListener('error', e => this._fail(new Error(`model worker: ${e.message || 'failed to start'}`)));
  }

  private _fail(error: Error): void {
    this._dead = error;
    for (const w of this._waits.values()) {
      w.reject(error);
    }
    this._waits.clear();
  }

  private _post(m: ToWorker, transfer: Transferable[] = []): void {
    this._worker.postMessage(m, transfer);
  }

  private async _serveFrame(req: number, frame: number, size: number): Promise<void> {
    try {
      const bitmap = await this._frames(frame, size);
      this._post({type: 'frame', req, bitmap}, [bitmap]);
    } catch (error) {
      this._post({type: 'frame', req, bitmap: null, error: error instanceof Error ? error.message : String(error)});
    }
  }

  private _onMessage(m: FromWorker): void {
    if (m.type === 'needFrame') {
      void this._serveFrame(m.req, m.frame, m.size);
    } else if (m.type === 'event') {
      this._listeners.forEach(l => l(m.event));
    } else if (m.type === 'reply') {
      const w = this._waits.get(m.id);
      this._waits.delete(m.id);
      if (m.ok) {
        w?.resolve(m.value);
      } else {
        w?.reject(new Error(m.error));
      }
    }
  }

  call<M extends ModelMethod>(method: M, args: ModelMethods[M]['args']): Promise<ModelMethods[M]['result']> {
    if (this._dead != null) {
      return Promise.reject(this._dead);
    }
    const id = this._next++;
    return new Promise((resolve, reject) => {
      this._waits.set(id, {resolve: resolve as (v: unknown) => void, reject});
      this._post({type: 'call', id, method, args});
    });
  }

  /** Listen to worker events; returns the unsubscribe. */
  on(listener: (e: ModelEvent) => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  terminate(): void {
    this._worker.terminate();
    this._fail(new Error('model worker terminated'));
  }
}
