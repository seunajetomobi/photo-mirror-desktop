/* Photo Mirror desktop app (Windows, macOS, Linux).
   Runs the same local server as `node server/server.js`, inside the app, and shows the viewer in a window. */
'use strict';
const { app, BrowserWindow, Menu, ipcMain, shell, session } = require('electron');
const path = require('path');
const { create } = require('../server/server.js');

let win = null, srv = null, closing = false, origin = '';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(start).catch(e => { console.error(e); app.exit(1); });
}

async function start() {
  srv = await create({
    dataDir: path.join(app.getPath('userData'), 'data'),
    appDir: path.join(__dirname, '..', 'app'),
    allowShutdown: false                                   // the power button quits the app itself
  }).start();
  origin = 'http://127.0.0.1:' + srv.ports.http;

  /* only what the viewer needs: copy to clipboard, notifications, fullscreen */
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(['clipboard-sanitized-write', 'notifications', 'fullscreen'].includes(perm)));

  ipcMain.on('pm:quit', () => app.quit());
  ipcMain.handle('pm:fullscreen', () => { if (win) win.setFullScreen(!win.isFullScreen()); return win ? win.isFullScreen() : false; });
  ipcMain.on('pm:isfs', e => { e.returnValue = win ? win.isFullScreen() : false; });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [{ role: process.platform === 'darwin' ? 'close' : 'quit', label: process.platform === 'darwin' ? 'Close window' : 'Quit Photo Mirror' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    { label: 'Help', submenu: [{ label: 'Photo Mirror website', click: () => shell.openExternal('https://www.helekt.net') }] }
  ]));
  openWindow();
  app.on('activate', () => { if (!win) openWindow(); });
}

function openWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 720, minHeight: 560, backgroundColor: '#161b22', title: 'Photo Mirror', show: false,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false }
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL(origin + '/');
  /* stay inside the app; send real web links to the normal browser */
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url) && !url.startsWith(origin)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', e => {                                   // stop the server cleanly, then really exit
  if (closing) return;
  closing = true; e.preventDefault();
  Promise.resolve(srv && srv.close()).catch(() => {}).finally(() => app.exit(0));
});
