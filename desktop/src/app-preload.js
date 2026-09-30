// sam-ui (Apache-2.0). New file, not from SAM 2.
// The main window's only bridge to the app: studio's engine picker can open
// the SAM 3 setup window (the same one as Help → Set up SAM 3…), and studio
// can reach After Effects through the main process (main.js, ae-roto.js):
// list its footage, open an item in place, and export masks to a new comp.
// Each ae call resolves to {ok: true, value} or {ok: false, error}.
'use strict';

const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('samUiDesktop', {
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
