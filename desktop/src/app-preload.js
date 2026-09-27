// sam-ui (Apache-2.0). New file, not from SAM 2.
// The main window's only bridge to the app: studio's engine picker can open
// the SAM 3 setup window (the same one as Help → Set up SAM 3…).
'use strict';

const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('samUiDesktop', {
  setupSam3: () => ipcRenderer.send('app:setup-sam3'),
});
