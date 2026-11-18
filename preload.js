const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getRoots: () => ipcRenderer.invoke('get-roots'),
  listDir: (dir, opts) => ipcRenderer.invoke('list-dir', dir, opts),
  listRecursive: (dir) => ipcRenderer.invoke('list-recursive', dir),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  parentDir: (p) => ipcRenderer.invoke('parent-dir', p),
  saveFile: (data, name, filterName, ext) => ipcRenderer.invoke('save-file', data, name, filterName, ext),
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  printHtml: (html, opts) => ipcRenderer.invoke('print-html', html, opts),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return null; } },
  platform: process.platform
});
