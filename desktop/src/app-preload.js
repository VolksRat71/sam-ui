// sam-ui (Apache-2.0). New file, not from SAM 2.
// The main window's only bridge to the app: studio's engine picker can open
// the SAM 3 setup window (the same one as Help → Set up SAM 3…).
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
  setupSam3: () => ipcRenderer.send('app:setup-sam3'),
});
