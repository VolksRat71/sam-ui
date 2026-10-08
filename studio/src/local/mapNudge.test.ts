import {expect, it, vi} from 'vitest';
import {installMapNudge} from './mapNudge';

it('submits while a read-back map is pending, and stops once it resolves', async () => {
  vi.useFakeTimers();
  try {
    const submits: unknown[][] = [];
    let resolve = () => {};
    class GPUBuffer {
      constructor(readonly usage: number) {}
      mapAsync(): Promise<void> {
        return new Promise(r => (resolve = r));
      }
    }
    class GPUDevice {
      queue = {submit: (b: unknown[]) => submits.push(b)};
      createBuffer(desc: {usage: number}) {
        return new GPUBuffer(desc.usage);
      }
    }
    installMapNudge({GPUDevice, GPUBuffer}, 2);
    const device = new GPUDevice();

    void (device.createBuffer({usage: 0x80}) as GPUBuffer).mapAsync(); // not MAP_READ: no nudge
    await vi.advanceTimersByTimeAsync(10);
    expect(submits).toHaveLength(0);

    const mapped = (device.createBuffer({usage: 0x1 | 0x8}) as GPUBuffer).mapAsync();
    await vi.advanceTimersByTimeAsync(10);
    expect(submits.length).toBeGreaterThanOrEqual(4);
    expect(submits.every(b => b.length === 0)).toBe(true);

    resolve();
    await mapped;
    const n = submits.length;
    await vi.advanceTimersByTimeAsync(20);
    expect(submits.length).toBeLessThanOrEqual(n + 1);
  } finally {
    vi.useRealTimers();
  }
});
