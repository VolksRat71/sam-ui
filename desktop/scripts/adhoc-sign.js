// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// electron-builder afterPack hook: ad-hoc sign the whole app.
//
// Without it, the app keeps Electron's own small ad-hoc signature while
// packaging adds the Python runtime, backend and studio around it, so the
// signature no longer matches the bundle. A downloaded (quarantined) copy then
// opens as "sam-ui is damaged and can't be opened", with no way past it. A valid
// ad-hoc signature is still not Apple-notarised, but macOS then offers the
// ordinary Open Anyway (System Settings -> Privacy & Security). Real signing
// needs a Developer ID; this runs when the build has none (identity null).
'use strict';

const {execFileSync} = require('node:child_process');
const path = require('node:path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('xattr', ['-cr', app]); // Finder info and similar detritus make codesign refuse
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], {stdio: 'inherit'});
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], {stdio: 'inherit'});
  console.log(`  • ad-hoc signed and verified  ${path.basename(app)}`);
};
