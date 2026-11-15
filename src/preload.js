'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

contextBridge.exposeInMainWorld('api', {
  info: () => call('app:info'),
  windowControl: (a) => call('window:control', a),
  getState: () => call('state:get'),
  setSettings: (patch) => call('settings:set', patch),
  setData: (data) => call('data:set', data),
  getJson: (url, key) => call('net:getJson', url, key),
  notify: (title, body) => call('notify', title, body),
  setTrayInfo: (text) => call('tray:info', text),
  browserStatus: () => call('browser:status'),
  browserOpen: () => call('browser:open'),
  saveFile: (name, text) => call('file:save', name, text),
  openExternal: (u) => call('shell:openExternal', u),
  openDataDir: () => call('shell:openDataDir'),
  on: (channel, fn) => {
    const allowed = ['window:state', 'app:refresh', 'app:shown', 'data:external', 'settings:external'];
    if (!allowed.includes(channel)) return () => {};
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  }
});
