// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Firefox resolves a GPUBuffer.mapAsync only when its GPU process next polls
// the device: a 100 ms timer (POLL_TIME_MS in WebGPUParent.cpp), or a queue
// submit, which runs wgpu's device maintenance, even with no command buffers.
// ONNX Runtime reads back 15 small tensors a tracked frame, one after
// another, so in Firefox 157 each waited about 100 ms and a frame took 1.6 s
// against Chrome's 0.055 s. While a read is pending, this submits an empty
// batch every few milliseconds, so the map resolves soon after the GPU is
// done (about 0.13 s a frame). Chrome resolves maps at once and sees a few
// extra empty submits, at no measurable cost.
// ponytail: remove once Firefox resolves maps without a poll (check by
// deleting this and timing the juggle sample in Firefox).

type Queue = {submit(buffers: unknown[]): void};
type Device = {queue: Queue; createBuffer(desc: {usage: number}): object};
type Buffer = {mapAsync(...args: unknown[]): Promise<void>};
type Scope = {GPUDevice?: {prototype: Device}; GPUBuffer?: {prototype: Buffer}};

const MAP_READ = 0x1;

/** Keeps every pending read-back map in this worker polled. Call before ONNX Runtime makes its device. */
export function installMapNudge(scope: Scope = globalThis as never, everyMs = 2): void {
  const device = scope.GPUDevice?.prototype;
  const buffer = scope.GPUBuffer?.prototype;
  if (device == null || buffer == null) {
    return;
  }
  const owners = new WeakMap<object, Device>();
  const createBuffer = device.createBuffer;
  device.createBuffer = function (desc) {
    const b = createBuffer.call(this, desc);
    if ((desc.usage & MAP_READ) !== 0) {
      owners.set(b, this);
    }
    return b;
  };
  const mapAsync = buffer.mapAsync;
  buffer.mapAsync = function (...args) {
    const mapped = mapAsync.apply(this, args);
    const owner = owners.get(this);
    if (owner != null) {
      let pending = true;
      const done = () => {
        pending = false;
      };
      mapped.then(done, done);
      const poke = () => {
        if (pending) {
          owner.queue.submit([]);
          setTimeout(poke, everyMs);
        }
      };
      setTimeout(poke, everyMs);
    }
    return mapped;
  };
}
