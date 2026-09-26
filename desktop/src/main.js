// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The desktop app: one window on studio, served by the bundled backend.
//
// Start-up:
//   1. make sure the SAM 2.1 large checkpoint is there (downloaded on first run);
//   2. start the backend (single-process flask) on a free port, data in userData;
//   3. wait for /healthy, then open the window on http://127.0.0.1:<port>/.
// The backend is stopped when the app quits. SAM 3 is bring-your-own: its
// weights (Meta's SAM License) are never shipped; SAM 3 > Choose weights folder.
'use strict';

const {app, BrowserWindow, Menu, dialog, shell} = require('electron');
const {spawn} = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');

const CHECKPOINT_URL = 'https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt';
const CHECKPOINT_NAME = 'sam2.1_hiera_large.pt';
// The checkpoint is a Python pickle: loading a tampered one runs code. Only a
// file with this exact hash (Meta's release, 092824) is ever used.
const CHECKPOINT_SHA256 = '2647878d5dfa5098f2f8649825738a9345572bae2d4350a2468587ece47dd318';
// Every window: no Node in the page, isolated preload world, OS sandbox.
const WEB_PREFERENCES = {contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true};

function isHttps(url) {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', c => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}
const REPO = path.resolve(__dirname, '..', '..'); // dev only

// A separate data folder (tests, a second profile): set before anything reads userData.
if (process.env.SAM_UI_USER_DATA) app.setPath('userData', process.env.SAM_UI_USER_DATA);

let backend = null;
let backendPort = null;
let mainWindow = null;
let quitting = false;

function paths() {
  const res = process.resourcesPath;
  const packaged = app.isPackaged;
  const userData = app.getPath('userData');
  return {
    python: packaged ? path.join(res, 'python', 'bin', 'python3') : process.env.SAM_UI_PYTHON || path.join(REPO, '.venv', 'bin', 'python'),
    serverDir: packaged ? path.join(res, 'backend', 'server') : path.join(REPO, 'demo', 'backend', 'server'),
    studioDist: packaged ? path.join(res, 'studio') : path.join(REPO, 'studio', 'dist'),
    gallery: packaged ? path.join(res, 'gallery') : path.join(REPO, 'demo', 'data', 'gallery'),
    ffmpegDir: path.dirname(require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked')),
    userData,
    dataDir: path.join(userData, 'data'),
    checkpoint: path.join(userData, 'checkpoints', CHECKPOINT_NAME),
    logDir: path.join(userData, 'logs'),
    settings: path.join(userData, 'settings.json'),
  };
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(paths().settings, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  const next = {...readSettings(), ...patch};
  fs.mkdirSync(path.dirname(paths().settings), {recursive: true});
  fs.writeFileSync(paths().settings, JSON.stringify(next, null, 1));
  return next;
}

// -- first run -------------------------------------------------------------

function ensureGallery(p) {
  fs.mkdirSync(p.dataDir, {recursive: true});
  const link = path.join(p.dataDir, 'gallery');
  if (!fs.existsSync(link)) fs.symlinkSync(p.gallery, link, 'dir');
}

function splash() {
  const win = new BrowserWindow({width: 520, height: 220, resizable: false, show: true, title: 'sam-ui', webPreferences: WEB_PREFERENCES});
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#111;color:#eee;
    font:14px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh">
    <div style="width:420px"><div style="font-weight:600;margin-bottom:10px">sam-ui</div>
    <div id="msg">Starting…</div>
    <div style="margin-top:12px;height:6px;background:#333;border-radius:3px">
    <div id="bar" style="height:6px;width:0;background:#6ea8fe;border-radius:3px"></div></div></div></body>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.setMenuBarVisibility(false);
  const say = (msg, frac) =>
    !win.isDestroyed() &&
    win.webContents
      .executeJavaScript(
        `document.getElementById('msg').textContent=${JSON.stringify(msg)};` +
          (frac == null ? '' : `document.getElementById('bar').style.width='${Math.round(frac * 100)}%';`),
      )
      .catch(() => {});
  return {win, say};
}

function download(url, dest, expectedSha256, onProgress) {
  return new Promise((resolve, reject) => {
    const part = dest + '.part';
    const get = u =>
      https
        .get(u, res => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const next = new URL(res.headers.location, u).toString();
            if (!isHttps(next)) return reject(new Error(`refusing a non-https redirect to ${next}`));
            return get(next);
          }
          if (res.statusCode !== 200) return reject(new Error(`download failed: HTTP ${res.statusCode}`));
          const total = Number(res.headers['content-length']) || 0;
          let got = 0;
          const hash = crypto.createHash('sha256');
          const out = fs.createWriteStream(part);
          res.on('data', c => {
            got += c.length;
            hash.update(c);
            onProgress(got, total);
          });
          res.pipe(out);
          out.on('finish', () =>
            out.close(() => {
              if (total && got !== total) return reject(new Error('download incomplete'));
              const digest = hash.digest('hex');
              if (digest !== expectedSha256) {
                fs.rmSync(part, {force: true});
                return reject(new Error(`checksum mismatch (got ${digest}); the download was deleted`));
              }
              resolve();
            }),
          );
          res.on('error', reject);
        })
        .on('error', reject);
    get(url);
  }).then(() => fs.renameSync(dest + '.part', dest));
}

async function ensureCheckpoint(p, say) {
  if (fs.existsSync(p.checkpoint)) return;
  fs.mkdirSync(path.dirname(p.checkpoint), {recursive: true});
  const local = process.env.SAM_UI_CHECKPOINT; // dev: reuse a checkpoint already on disk
  if (local && fs.existsSync(local)) {
    say('Checking the local checkpoint…', null);
    if ((await sha256File(local)) !== CHECKPOINT_SHA256) throw new Error(`SAM_UI_CHECKPOINT ${local} is not Meta's SAM 2.1 large`);
    fs.symlinkSync(local, p.checkpoint);
    return;
  }
  say('Downloading SAM 2.1 large (about 900 MB, once)…', 0);
  await download(CHECKPOINT_URL, p.checkpoint, CHECKPOINT_SHA256, (got, total) =>
    say(`Downloading SAM 2.1 large: ${(got / 2 ** 20).toFixed(0)} of ${(total / 2 ** 20).toFixed(0)} MB`, total ? got / total : null),
  );
}

// -- backend ---------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const {port} = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function startBackend(p, port) {
  fs.mkdirSync(p.logDir, {recursive: true});
  const log = fs.createWriteStream(path.join(p.logDir, 'backend.log'), {flags: 'a'});
  log.write(`\n--- ${new Date().toISOString()} starting on ${port}\n`);
  const settings = readSettings();
  const env = {
    ...process.env,
    PATH: `${p.ffmpegDir}${path.delimiter}${process.env.PATH || ''}`,
    PYTORCH_ENABLE_MPS_FALLBACK: '1',
    APP_ROOT: p.userData, // the backend reads APP_ROOT/checkpoints/<checkpoint>
    MODEL_SIZE: 'large',
    DATA_PATH: p.dataDir,
    API_URL: `http://127.0.0.1:${port}`,
    DEFAULT_VIDEO_PATH: 'gallery/05_default_juggle.mp4',
    SAM_UI_STUDIO_DIST: p.studioDist,
    SAM_UI_EXPORT_ROOT: app.getPath('home'),
    // lock the backend to this app's page: no CORS, only our Host and Origin (local_guard.py)
    SAM_UI_CORS: 'off',
    SAM_UI_ALLOWED_HOST: `127.0.0.1:${port}`,
    ...(settings.sam3Weights ? {SAM_UI_SAM3_WEIGHTS: settings.sam3Weights} : {}),
  };
  const child = spawn(
    p.python,
    ['-m', 'flask', '--app', 'app', 'run', '--host', '127.0.0.1', '--port', String(port), '--with-threads'],
    {cwd: p.serverDir, env},
  );
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.on('exit', code => {
    log.write(`--- backend exited with ${code}\n`);
    if (!quitting) {
      dialog.showErrorBox('sam-ui: the backend stopped', `It exited with code ${code}. The log is at\n${path.join(p.logDir, 'backend.log')}`);
      app.quit();
    }
  });
  return child;
}

async function waitHealthy(port, ms = 240000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthy`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    if (backend && backend.exitCode !== null) throw new Error('the backend exited while starting');
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('the backend did not come up in time');
}

function stopBackend() {
  if (backend && backend.exitCode === null) backend.kill('SIGTERM');
}

// -- app -------------------------------------------------------------------

function menu(p) {
  const template = [
    {role: 'appMenu'},
    {role: 'editMenu'},
    {role: 'viewMenu'},
    {
      label: 'SAM 3',
      submenu: [
        {
          label: 'Choose SAM 3 weights folder…',
          click: async () => {
            const r = await dialog.showOpenDialog(mainWindow, {
              title: 'SAM 3 weights (facebook/sam3, under Meta\'s SAM License)',
              properties: ['openDirectory'],
            });
            if (r.canceled || !r.filePaths[0]) return;
            if (!fs.existsSync(path.join(r.filePaths[0], 'model.safetensors'))) {
              dialog.showErrorBox('Not SAM 3 weights', 'That folder has no model.safetensors.');
              return;
            }
            writeSettings({sam3Weights: r.filePaths[0]});
            app.relaunch();
            app.quit(); // the backend reads the setting when it starts
          },
        },
        {label: 'Get SAM 3 weights (Hugging Face)', click: () => shell.openExternal('https://huggingface.co/facebook/sam3')},
      ],
    },
    {role: 'windowMenu'},
    {
      label: 'Help',
      submenu: [
        {label: 'Open backend log', click: () => shell.openPath(path.join(p.logDir, 'backend.log'))},
        {label: 'Show data folder', click: () => shell.openPath(p.userData)},
        {label: 'sam-ui on GitHub', click: () => shell.openExternal('https://github.com/VolksRat71/sam-ui')},
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function main() {
  const p = paths();
  menu(p);
  const {win: splashWin, say} = splash();
  try {
    if (!fs.existsSync(path.join(p.studioDist, 'index.html'))) {
      throw new Error(`studio is not built (${p.studioDist}); run npm run build:studio`);
    }
    ensureGallery(p);
    await ensureCheckpoint(p, say);
    say('Starting the models…', null);
    backendPort = await freePort();
    backend = startBackend(p, backendPort);
    await waitHealthy(backendPort);
  } catch (err) {
    dialog.showErrorBox('sam-ui could not start', `${err.message}\n\nThe log is at ${path.join(p.logDir, 'backend.log')}`);
    quitting = true;
    stopBackend();
    app.quit();
    return;
  }
  const appOrigin = `http://127.0.0.1:${backendPort}`;
  mainWindow = new BrowserWindow({
    width: 1600, height: 1000, show: false, title: 'sam-ui', backgroundColor: '#000000', webPreferences: WEB_PREFERENCES,
  });
  // the window only ever shows the app; links go to the browser, https only
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== appOrigin) {
      event.preventDefault();
      if (isHttps(url)) shell.openExternal(url);
    }
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (!splashWin.isDestroyed()) splashWin.close();
  });
  mainWindow.webContents.setWindowOpenHandler(({url}) => {
    if (isHttps(url)) shell.openExternal(url);
    return {action: 'deny'};
  });
  await mainWindow.loadURL(`${appOrigin}/`);
}

app.on('before-quit', () => {
  quitting = true;
  stopBackend();
});
app.on('window-all-closed', () => app.quit());
app.whenReady().then(main);
