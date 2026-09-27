// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {probeWebGpu} from './webgpu';

describe('probeWebGpu', () => {
  it('needs a non-null adapter', async () => {
    expect(await probeWebGpu({requestAdapter: async () => ({name: 'gpu'})})).toBe(true);
    expect(await probeWebGpu({requestAdapter: async () => null})).toBe(false);
  });

  it('is false when requestAdapter throws, or there is no API', async () => {
    expect(
      await probeWebGpu({
        requestAdapter: async () => {
          throw new Error('no');
        },
      }),
    ).toBe(false);
    expect(await probeWebGpu(undefined)).toBe(false);
    expect(await probeWebGpu(null)).toBe(false);
  });

  it('is false when the adapter never comes', async () => {
    const t0 = Date.now();
    expect(await probeWebGpu({requestAdapter: () => new Promise(() => {})}, 50)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
