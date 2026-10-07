// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The headed browser the browser-engine runs (smoke-local, memory) drive.
// BROWSER picks it:
//   chrome (default): Chrome, CHROME its binary;
//   firefox: the installed Firefox over WebDriver BiDi, FIREFOX its binary
//     (default /Applications/Firefox.app);
//   webkit: Playwright's WebKit build. It is the engine behind Safari, not
//     Safari itself, so a pass here says nothing certain about Safari.
import {chromium, firefox, webkit} from 'playwright-core';

export const BROWSER = process.env.BROWSER ?? 'chrome';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export function launch(chromeArgs = []) {
  if (BROWSER === 'firefox') {
    return firefox.launch({channel: 'moz-firefox', executablePath: process.env.FIREFOX, headless: false});
  }
  if (BROWSER === 'webkit') {
    return webkit.launch({headless: false});
  }
  return chromium.launch({executablePath: CHROME, headless: false, args: ['--enable-unsafe-webgpu', ...chromeArgs]});
}

