import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const out = '/tmp/refine-detail-presentation'; await fs.mkdir(out, {recursive: true});
const browser = await chromium.launch({executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true});
try {
 for (const width of [1440,390]) {
  const page = await browser.newPage({viewport: {width,height:900},hasTouch:width===390}); const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:7482/e2e/detail-presentation.html');
  await page.getByText('Experimental',{exact:true}).click();
  await page.getByRole('button',{name:'Refine Detail',exact:true}).click();
  await page.getByRole('img',{name:'Crop points.',exact:false}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Refine',exact:true}).isDisabled(),true);
  const canvas=page.locator('.detail-crop');await canvas.focus();await page.keyboard.press('ArrowRight');await page.keyboard.press('Enter');
  assert.equal((await page.evaluate(()=>window.calls)).filter(c=>c[0]==='preview_detail_crop').length,0);
  await page.getByRole('button',{name:'Refine',exact:true}).click();
  await page.getByText('7 added pixels. This frame only.').waitFor();
  const calls=await page.evaluate(()=>window.calls);const request=calls.find(c=>c[0]==='preview_detail_crop')[1];
  assert.equal(request.object_id,1);assert.equal(request.frame_index,0);assert.equal(request.crop_points.length,1);
  await page.screenshot({path:`${out}/${width}.png`,fullPage:true});
  await page.getByRole('button',{name:'Apply detail',exact:true}).click();
  await page.getByRole('button',{name:'Refine Detail',exact:true}).waitFor();
  assert.equal((await page.evaluate(()=>window.calls)).filter(c=>c[0]==='apply_detail_crop').length,1);
  await page.getByRole('button',{name:'Refine Detail',exact:true}).click();await canvas.waitFor();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('button',{name:'Empty result',exact:true}).click();
  await page.getByRole('button',{name:'Refine Detail',exact:true}).click();await canvas.waitFor();await canvas.click();
  await page.getByRole('button',{name:'Refine',exact:true}).click();await page.getByText('No new detail found.',{exact:false}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Apply detail',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Next frame',exact:true}).click();
  await page.getByRole('region',{name:'Refine Detail'}).waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Unavailable base',exact:true}).click();
  await page.getByRole('button',{name:'Refine Detail',exact:true}).click();
  await page.getByText('The base is unavailable on this frame.',{exact:false}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Refine',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Remove detail 1',exact:true}).click();
  const remove=(await page.evaluate(()=>window.calls)).find(c=>c[0]==='remove_detail_crop')[1];
  assert.equal(remove.expected_correction_revision,'snapshot1');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('button',{name:'Browser engine',exact:true}).click();
  await page.getByText('Experimental',{exact:true}).waitFor({state:'hidden'});
  assert.deepEqual(errors,[]); await page.close();
 }
 console.log('PASS detail desktop/phone: explicit inference, keyboard crop point, apply once, cancel, empty result, frame invalidation, browser engine hidden');
} finally {await browser.close();}
