// sam-ui (Apache-2.0). New file, not from SAM 2.
import type {EngineInfo} from '~/worker/protocol';

/** The in-browser SAM 2.1 tiny engine (studio/src/local). */
export const BROWSER_ENGINE = 'browser-sam2';

/** Where the browser-only build sends people for the desktop app (SAM 2.1 large, SAM 3). */
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
   * A backend answered GET /engines. Without one (the browser-only build)
   * the desktop app's engines are still listed, disabled, linking to it.
   */
  backend: boolean;
};

const SAM3_SETUP = 'Set it up from Help → Set up SAM 3… in the desktop app.';

/** What a disabled backend engine's tooltip says. */
export function unavailableReason(e: Pick<EngineInfo, 'name' | 'reason'>): string {
  const reason = e.reason?.trim() || 'unavailable';
  const text = `Model not available: ${reason}${/[.!?]$/.test(reason) ? '' : '.'}`;
  return e.name === 'sam3' && /weights/i.test(reason) ? `${text} ${SAM3_SETUP}` : text;
}

/**
 * The engine picker's entries, every model listed whether or not it can run
 * here: the backend's engines (GET /engines; a disabled one says what is
 * missing), then the browser engine. With no backend, SAM 2.1 large and
 * SAM 3 are listed disabled, linking to the desktop app, and the browser
 * engine is the only one enabled.
 */
export function pickerEngines(server: ReadonlyArray<EngineInfo>, opts: PickerOptions): EngineInfo[] {
  const out: EngineInfo[] = opts.backend
    ? server
        .filter(e => e.name !== BROWSER_ENGINE)
        .map(e => (e.available ? e : {...e, reason: unavailableReason(e)}))
    : [
        {name: 'sam2', label: 'SAM 2.1 large', model: 'sam2.1_hiera_large', default: false, available: false, reason: 'Requires the desktop app.', loaded: false, href: RELEASES_URL},
        {name: 'sam3', model: 'SAM 3', default: false, available: false, reason: 'Requires the desktop app.', loaded: false, href: RELEASES_URL},
      ];
  out.push({
    name: BROWSER_ENGINE,
    model: 'sam2.1_hiera_tiny (ONNX, WebGPU)',
    default: !opts.backend,
    available: opts.webgpu,
    reason: opts.webgpu ? null : 'This browser has no WebGPU, which the browser engine needs.',
    loaded: false,
    local: true,
    hint: opts.backend ? 'Lower quality, for quick previews' : undefined,
  });
  return out;
}

/**
 * How the picker lays out: a menu when there is a choice, else (a Pages
 * build) a label for the one engine, with the ones that cannot run beside it.
 */
export function pickerLayout(engines: ReadonlyArray<EngineInfo>): {
  available: EngineInfo[];
  disabled: EngineInfo[];
  single: boolean;
} {
  const available = engines.filter(e => e.available);
  const disabled = engines.filter(e => !e.available);
  return {available, disabled, single: available.length <= 1};
}
