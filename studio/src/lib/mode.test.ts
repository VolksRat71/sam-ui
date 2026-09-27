// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {waitForBackend} from './mode';

describe('waitForBackend', () => {
  it('waits through a slow first answer instead of giving up', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      await new Promise(r => setTimeout(r, 40)); // slower than a short probe would allow
      return new Response('{}');
    }) as typeof fetch;
    await expect(waitForBackend({totalMs: 1000, attemptMs: 500, retryMs: 5, fetchFn})).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  it('retries while the backend is still starting', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      if (calls < 3) {
        throw new TypeError('connection refused');
      }
      return new Response('', {status: 404}); // an older backend without /engines still counts
    }) as typeof fetch;
    await waitForBackend({totalMs: 1000, attemptMs: 100, retryMs: 5, fetchFn});
    expect(calls).toBe(3);
  });

  it('rejects, naming the backend, when it never answers', async () => {
    const fetchFn = (async () => {
      throw new TypeError('connection refused');
    }) as typeof fetch;
    await expect(waitForBackend({totalMs: 60, attemptMs: 20, retryMs: 5, fetchFn})).rejects.toThrow(/did not answer \(connection refused\)/);
  });
});
