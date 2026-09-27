// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {pageNotice} from './notices';

describe('pageNotice', () => {
  it('in the browser-only build: unsupported without WebGPU, the demo banner with it', () => {
    expect(pageNotice({backend: false, webgpu: false, browserOnly: false})).toBe('unsupported');
    expect(pageNotice({backend: false, webgpu: true, browserOnly: true})).toBe('demo');
  });

  it('with a backend: no notice, whether or not WebGPU works', () => {
    expect(pageNotice({backend: true, webgpu: false, browserOnly: false})).toBeNull();
    expect(pageNotice({backend: true, webgpu: true, browserOnly: false})).toBeNull();
    // a backend whose engines all fail leaves the browser engine: the demo banner
    expect(pageNotice({backend: true, webgpu: true, browserOnly: true})).toBe('demo');
  });

  it('shows nothing until WebGPU has been checked', () => {
    expect(pageNotice({backend: false, webgpu: null, browserOnly: true})).toBeNull();
  });
});
