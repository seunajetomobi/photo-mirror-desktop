'use strict';
const { contextBridge, ipcRenderer } = require('electron');
/* the viewer page uses these when it runs inside the desktop app */
contextBridge.exposeInMainWorld('pmDesktop', {
  platform: process.platform,
  quit: () => ipcRenderer.send('pm:quit'),
  toggleFullscreen: () => ipcRenderer.invoke('pm:fullscreen'),
  isFullscreen: () => ipcRenderer.sendSync('pm:isfs')
});
