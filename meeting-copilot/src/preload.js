'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => {
  const h = (_e, p) => cb(p);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  enableLoopbackAudio: () => ipcRenderer.invoke('enable-loopback-audio'),
  disableLoopbackAudio: () => ipcRenderer.invoke('disable-loopback-audio'),
  geminiStatus: () => ipcRenderer.invoke('gemini:status'),
  geminiAsk: (id, question) => ipcRenderer.invoke('gemini:ask', { id, question }),
  geminiReset: () => ipcRenderer.invoke('gemini:reset'),
  geminiCancel: () => ipcRenderer.invoke('gemini:cancel'),
  hide: () => ipcRenderer.invoke('win:hide'),
  quit: () => ipcRenderer.invoke('win:quit'),
  onGeminiUpdate: (cb) => on('gemini:update', cb),
  onAskLast: (cb) => on('ui:ask-last', cb),
  onToggleListen: (cb) => on('ui:toggle-listen', cb),
  onClickThrough: (cb) => on('ui:clickthrough', cb),
});
