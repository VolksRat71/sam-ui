// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Main-thread side of studio's video worker. Meta's VideoWorkerBridge already
// speaks the video messages (canvas, source, playback, frames, filmstrip);
// this adds studio's typed RPC calls and events on the same worker.
import VideoWorkerBridge from '@/common/components/video/VideoWorkerBridge';
import type {
  StudioCall,
  StudioEvent,
  StudioEventMessage,
  StudioMethod,
  StudioMethods,
  StudioReply,
} from '~/worker/protocol';

type Pending = {resolve: (value: unknown) => void; reject: (error: Error) => void};

export default class StudioBridge extends VideoWorkerBridge {
  private _nextCall = 1;
  private _pending = new Map<number, Pending>();
  private _studioListeners = new Set<(event: StudioEvent) => void>();

  static createStudio(): StudioBridge {
    return new StudioBridge(
      new Worker(new URL('../worker/studio.worker.ts', import.meta.url), {
        type: 'module',
      }),
    );
  }

  constructor(worker: Worker) {
    super(worker);
    worker.addEventListener(
      'message',
      (event: MessageEvent<StudioReply | StudioEventMessage | {action: string}>) => {
        const data = event.data;
        if (data.action === 'studioReply') {
          const reply = data as StudioReply;
          const pending = this._pending.get(reply.id);
          if (pending == null) {
            return;
          }
          this._pending.delete(reply.id);
          if (reply.ok) {
            pending.resolve(reply.value);
          } else {
            pending.reject(new Error(reply.error));
          }
        } else if (data.action === 'studioEvent') {
          const {event: studioEvent} = data as StudioEventMessage;
          this._studioListeners.forEach(listener => listener(studioEvent));
        }
      },
    );
  }

  call<M extends StudioMethod>(
    method: M,
    args: StudioMethods[M]['args'],
  ): Promise<StudioMethods[M]['result']> {
    const id = this._nextCall++;
    const message: StudioCall<M> = {action: 'studioCall', id, method, args};
    return new Promise((resolve, reject) => {
      this._pending.set(id, {
        resolve: value => resolve(value as StudioMethods[M]['result']),
        reject,
      });
      this.worker.postMessage(message);
    });
  }

  onStudioEvent(listener: (event: StudioEvent) => void): () => void {
    this._studioListeners.add(listener);
    return () => this._studioListeners.delete(listener);
  }

  terminate(): void {
    for (const pending of this._pending.values()) {
      pending.reject(new Error('worker terminated'));
    }
    this._pending.clear();
    this._studioListeners.clear();
    super.terminate();
  }
}
