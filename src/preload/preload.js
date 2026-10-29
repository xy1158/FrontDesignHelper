'use strict';
// 渲染进程唯一入口：不暴露 Node，只暴露白名单方法。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fdh', {
  api: (op, args) => ipcRenderer.invoke('fdh:api', { op: op, args: args || {} }),
  openDataDir: () => ipcRenderer.invoke('fdh:openDataDir'),
  copyText: (text) => ipcRenderer.invoke('fdh:copyText', text),
  bridgeInfo: () => ipcRenderer.invoke('fdh:bridgeInfo'),
  openExternal: (url) => ipcRenderer.invoke('fdh:openExternal', url),
  onEvent: (cb) => {
    const handler = (event, payload) => { try { cb(payload); } catch (e) { /* ignore */ } };
    ipcRenderer.on('fdh:event', handler);
    return () => ipcRenderer.removeListener('fdh:event', handler);
  },
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }
});