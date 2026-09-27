// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Which notice sits under the top bar:
//   - unsupported: the browser-only build in a browser without working
//     WebGPU; it cannot track, and says so, with no dismiss;
//   - demo: the browser engine is all there is and works (the dismissible
//     "this is a demo" banner);
//   - none: a build with a backend (a missing WebGPU only disables the
//     browser engine's entry, with its tooltip).
export type PageNotice = 'unsupported' | 'demo' | null;

export function pageNotice(o: {backend: boolean; webgpu: boolean | null; browserOnly: boolean}): PageNotice {
  if (o.webgpu == null) {
    return null; // not known yet
  }
  if (!o.backend && !o.webgpu) {
    return 'unsupported';
  }
  return o.browserOnly && o.webgpu ? 'demo' : null;
}
