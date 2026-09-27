// sam-ui (Apache-2.0). New file, not from SAM 2.
import type {EngineInfo} from '~/worker/protocol';

/** The in-browser SAM 2.1 tiny engine (studio/src/local). */
export const BROWSER_ENGINE = 'browser-sam2';

/** Where a build without SAM 3 (GitHub Pages) sends people who want it. */
export const RELEASES_URL = 'https://github.com/VolksRat71/sam-ui/releases/latest';

/** "sam2" -> "SAM 2", "sam3" -> "SAM 3", the browser engine by its name; others as they are. */
export function engineLabel(name: string): string {
  if (name === BROWSER_ENGINE) {
    return 'Browser · SAM 2.1 tiny';
  }
  const m = /^sam(\d+(?:\.\d+)?)$/i.exec(name);
  return m == null ? name : `SAM ${m[1]}`;
}

export type PickerOptions = {
  /** navigator.gpu exists (the browser engine needs WebGPU). */
  webgpu: boolean;
  /**
   * A build with no backend (GitHub Pages): SAM 3 is listed, disabled, and
   * links to the desktop app's release.
   */
  pages?: boolean;
};

/**
 * The engine picker's entries: the backend's engines (GET /engines), then the
 * browser engine. A disabled entry says why; one with `href` also links
 * somewhere to get it.
 */
export function pickerEngines(server: ReadonlyArray<EngineInfo>, opts: PickerOptions): EngineInfo[] {
  const out = server.filter(e => e.name !== BROWSER_ENGINE);
  if (opts.pages && !out.some(e => e.name === 'sam3')) {
    out.push({
      name: 'sam3',
      model: 'SAM 3',
      default: false,
      available: false,
      reason: 'SAM 3 runs in the sam-ui desktop app',
      loaded: false,
      href: RELEASES_URL,
    });
  }
  out.push({
    name: BROWSER_ENGINE,
    model: 'sam2.1_hiera_tiny (ONNX, WebGPU)',
    default: server.length === 0,
    available: opts.webgpu,
    reason: opts.webgpu ? null : 'this browser has no WebGPU',
    loaded: false,
    local: true,
  });
  return out;
}
