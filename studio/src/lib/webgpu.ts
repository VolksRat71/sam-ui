// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Whether this browser can run the browser engine: WebGPU with a working
// adapter. navigator.gpu alone is not enough (a browser may expose the API
// with no usable GPU behind it), so ask for an adapter, with a time limit.
// The answer is cached per page or worker, and every place that decides the
// browser engine's availability asks here.

type GpuLike = {requestAdapter(): Promise<unknown>} | undefined | null;

/** True only when requestAdapter() gives a non-null adapter within `timeoutMs`. */
export async function probeWebGpu(gpu: GpuLike, timeoutMs = 3000): Promise<boolean> {
  if (gpu == null || typeof gpu.requestAdapter !== 'function') {
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const adapter = await Promise.race([gpu.requestAdapter(), timeout]);
    return adapter != null;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

let cached: Promise<boolean> | null = null;

/** This page's (or worker's) answer, asked once. */
export function webGpuAvailable(): Promise<boolean> {
  cached ??= probeWebGpu(typeof navigator === 'undefined' ? undefined : (navigator as {gpu?: GpuLike}).gpu);
  return cached;
}

/** What the browser engine's disabled entry says without WebGPU. */
export const NEEDS_WEBGPU = 'Needs WebGPU (Chrome or Edge on desktop)';
