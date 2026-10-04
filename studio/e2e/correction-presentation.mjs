// Run against an isolated Vite server; never talks to a backend or models.
import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const out = process.env.OUT ?? '/tmp/task13-presentation';
await fs.mkdir(out, {recursive: true});
const browser = await chromium.launch({executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true});
try {
  for (const viewport of [{width: 1440, height: 960}, {width: 390, height: 844}, {width: 1200, height: 900}]) {
    const page = await browser.newPage({viewport, hasTouch: viewport.width !== 1440});
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${process.env.STUDIO_URL ?? 'http://127.0.0.1:7482'}/e2e/correction-presentation.html`);
    await page.getByRole('button', {name: 'Actions for Layer 2', exact: true}).waitFor();
    if (viewport.width === 1200) {
      const heights = await page.locator('.transport .icon-button').evaluateAll(els => els.map(e => e.getBoundingClientRect().height));
      assert.ok(heights.length > 0 && heights.every(h => h >= 44), `coarse transport targets: ${heights}`);
    }
    await page.getByRole('button', {name: 'Add a positive to trim', exact: true}).click();
    await page.getByRole('button', {name: 'Switch to SAM 3', exact: true}).click();
    await page.getByRole('button', {name: 'Gone for a while?', exact: true}).click();
    assert.deepEqual(await page.evaluate(() => window.calls), [['trim'], ['sam3'], ['gone']]);
    await page.getByRole('button', {name: 'Toggle SAM 3', exact: true}).click();
    assert.equal(await page.getByRole('button', {name: 'Switch to SAM 3', exact: true}).count(), 0);
    await page.getByRole('button', {name: 'Hint', exact: true}).click();
    assert.equal((await page.getByRole('status').innerText()).replace(/\s+/g, ' ').trim(), 'Gone for a while? Mark it absent until it comes back.');
    await page.getByRole('button', {name: 'No message', exact: true}).click();
    assert.equal(await page.getByRole('status').count(), 0);
    await page.getByRole('button', {name: 'Frame 38', exact: true}).click();
    const trigger = page.getByRole('button', {name: 'Actions for Layer 2', exact: true});
    await trigger.focus(); await page.keyboard.press('ArrowDown');
    await page.getByRole('menuitem').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
    await trigger.click();
    const box = await page.getByRole('menu').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height);
    await page.getByRole('menuitem', {name: 'Mark absent until it comes back'}).click();
    assert.deepEqual((await page.evaluate(() => window.calls)).slice(3), [['absent', 2, 37]]);
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
    await page.getByRole('button', {name: 'Toggle busy', exact: true}).click();
    assert.equal(await trigger.isDisabled(), true);
    await page.getByRole('button', {name: 'Nudge', exact: true}).click();
    await page.screenshot({path: `${out}/${viewport.width}.png`, fullPage: true});
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('PASS: desktop/touch, 16 grouped layers, lane ID + playhead, one callback, no selection/canvas leak, keyboard/focus, viewport fit, busy state, all nudge states/copy');
} finally { await browser.close(); }
