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
  setApiKey: (k) => call('apikey:set', k),
  testAi: () => call('ai:test'),
  extractHoldings: (image) => call('ai:extractHoldings', image),
  claudeStatus: () => call('claude:status'),
  claudeInstall: () => call('claude:install'),
  claudeLogin: () => call('claude:login'),
  claudeCode: (code) => call('claude:code', code),
  claudeCancel: () => call('claude:cancel'),
  claudeLogout: () => call('claude:logout'),
  browseClaude: () => call('ai:browseClaude'),
  openExternal: (u) => call('shell:openExternal', u),
  openDataDir: () => call('shell:openDataDir'),
  on: (channel, fn) => {
    const allowed = ['window:state', 'claude:log', 'claude:login', 'app:refresh', 'app:shown'];
    if (!allowed.includes(channel)) return () => {};
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  }
});
