// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {DEFAULT_API_ENDPOINT, parseObjectLimit, resolveApiEndpoint} from './config';

describe('resolveApiEndpoint', () => {
  it('uses the page origin for "same-origin" (studio served by the backend)', () => {
    expect(resolveApiEndpoint('same-origin', 'http://127.0.0.1:54321')).toBe('http://127.0.0.1:54321');
  });
  it('uses a given endpoint, without trailing slashes', () => {
    expect(resolveApiEndpoint('http://127.0.0.1:7363//', 'http://x')).toBe('http://127.0.0.1:7363');
  });
  it('falls back to the default when unset', () => {
    expect(resolveApiEndpoint(undefined, 'http://x')).toBe(DEFAULT_API_ENDPOINT);
    expect(resolveApiEndpoint('', 'http://x')).toBe(DEFAULT_API_ENDPOINT);
  });
});

describe('parseObjectLimit', () => {
  it('keeps a positive number and defaults otherwise', () => {
    expect(parseObjectLimit('24')).toBe(24);
    expect(parseObjectLimit('0')).toBe(16);
    expect(parseObjectLimit(undefined)).toBe(16);
  });
});
