// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The headed browser the browser-engine runs (smoke-local, memory) drive.
// BROWSER picks it:
//   chrome (default): Chrome, CHROME its binary;
//   firefox: the installed Firefox over WebDriver BiDi, FIREFOX its binary
//     (default /Applications/Firefox.app);
//   webkit: Playwright's WebKit build. It is the engine behind Safari, not
//     Safari itself, so a pass here says nothing certain about Safari. Its
//     ephemeral contexts have no OPFS (getDirectory() fails), so it runs in
//     a persistent context on a fresh profile folder, which launch() returns
//     in place of a browser (both have newPage(), addInitScript() and close()).
import {chromium, firefox, webkit} from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BROWSER = process.env.BROWSER ?? 'chrome';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export function launch(chromeArgs = []) {
  if (BROWSER === 'firefox') {
    // studio asks for persistent storage; Firefox asks the user, and these
    // test-profile prefs answer Allow so an unattended run is not left with a prompt
    const firefoxUserPrefs = {'dom.storageManager.prompt.testing': true, 'dom.storageManager.prompt.testing.allow': true};
    return firefox.launch({channel: 'moz-firefox', executablePath: process.env.FIREFOX, headless: false, firefoxUserPrefs});
  }
  if (BROWSER === 'webkit') {
    // ponytail: the profile folder is left in the temp dir
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sam-ui-webkit-'));
    return webkit.launchPersistentContext(profile, {headless: false, acceptDownloads: true});
  }
  return chromium.launch({executablePath: CHROME, headless: false, args: ['--enable-unsafe-webgpu', ...chromeArgs]});
}

/**
 * A page in a fresh context, with the dock's Media section open: since the
 * Compositing Suite layout (#42) it starts collapsed, which hides the
 * dropzone and the delete buttons the runs click.
 */
export async function newPage(browser, viewport) {
  const context = BROWSER === 'webkit' ? browser : await browser.newContext({viewport, acceptDownloads: true});
  await context.addInitScript(() => {
    try {
      const key = 'sam-ui-suite:sections-open';
      localStorage.setItem(key, JSON.stringify({...JSON.parse(localStorage.getItem(key) ?? '{}'), media: true}));
    } catch {
      // no storage on this page (about:blank)
    }
  });
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  return page;
}
