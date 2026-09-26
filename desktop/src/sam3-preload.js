// sam-ui (Apache-2.0). New file, not from SAM 2.
// The SAM 3 download window's only bridge to the app: start a download with a
// token, hear its progress, and open the two Hugging Face pages it links to.
'use strict';

const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('sam3', {
  download: token => ipcRenderer.invoke('sam3:download', token),
  restart: () => ipcRenderer.send('sam3:restart'),
  openModelPage: () => ipcRenderer.send('sam3:open', 'model'),
  openTokenPage: () => ipcRenderer.send('sam3:open', 'tokens'),
  onProgress: cb => ipcRenderer.on('sam3:progress', (_e, p) => cb(p)),
});
