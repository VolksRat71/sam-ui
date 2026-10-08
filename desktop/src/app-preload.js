// sam-ui (Apache-2.0). New file, not from SAM 2.
// The main window's only bridge to the app: studio's engine picker can open
// the SAM 3 setup window (the same one as Help → Set up SAM 3…), and studio
// can reach After Effects through the main process (main.js, ae-roto.js):
// list its footage, open an item in place, and export masks to a new comp.
// Each ae call resolves to {ok: true, value} or {ok: false, error}.
'use strict';

const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('samUiDesktop', {
  // the update banner (main.js, update-check.js): what the last check found
  // ({version, name, url, current} or null), a newly found one, and its close
  // and link, which main opens (only a sam-ui release page)
  updates: {
    pending: () => ipcRenderer.invoke('updates:pending'),
    onAvailable: cb => {
      const listener = (_e, release) => cb(release);
      ipcRenderer.on('updates:available', listener);
      return () => ipcRenderer.removeListener('updates:available', listener);
    },
    dismiss: version => ipcRenderer.send('updates:dismiss', version),
    openRelease: () => ipcRenderer.send('updates:open'),
  },
  // job notifications (main.js, job-notify.js): studio says a job ended
  // ({kind, ok, engine, objectIds, name}) and main decides whether to notify; a click
  // on one comes back as {engine, objectIds} for studio to jump to
  jobs: {
    done: job => ipcRenderer.send('jobs:done', job),
    onOpen: cb => {
      const listener = (_e, job) => cb(job);
      ipcRenderer.on('jobs:open', listener);
      return () => ipcRenderer.removeListener('jobs:open', listener);
    },
  },
  setupSam3: () => ipcRenderer.send('app:setup-sam3'),
  ae: {
    status: () => ipcRenderer.invoke('ae:status'),
    listMedia: () => ipcRenderer.invoke('ae:media'),
    open: itemId => ipcRenderer.invoke('ae:open', itemId),
    sourceOf: videoPath => ipcRenderer.invoke('ae:source', videoPath),
    exportRoto: request => ipcRenderer.invoke('ae:export', request),
    onProgress: cb => {
      const listener = (_e, p) => cb(p);
      ipcRenderer.on('ae:progress', listener);
      return () => ipcRenderer.removeListener('ae:progress', listener);
    },
  },
});
