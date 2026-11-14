'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Tray, Menu, nativeImage, nativeTheme, safeStorage, net } = require('electron');
const path = require('path');
const fs = require('fs');

const { Store } = require('./store');
const { ClaudeAccount } = require('./claude-account');
const { ClaudeCodeProvider, ApiProvider, findClaude } = require('./ai/providers');
const Core = require('../renderer/core');

const APP_NAME = 'CoinTracko';
app.setName(APP_NAME);
app.commandLine.appendSwitch('lang', 'pl');
if (process.platform === 'win32') app.setAppUserModelId('pl.z0z6.cointracko');

const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
const dataDir = process.env.COINTRACKO_DATA_DIR || (portableDir ? path.join(portableDir, 'CoinTracko - dane') : path.join(app.getPath('userData'), 'dane'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let tray = null;
let quitting = false;
let store, account;

const secretsFile = () => path.join(dataDir, 'klucz.bin');

function getApiKey() {
  try {
    const raw = fs.readFileSync(secretsFile());
    if (raw.slice(0, 4).toString() === 'b64:') return Buffer.from(raw.slice(4).toString(), 'base64').toString('utf8');
    return safeStorage.decryptString(raw);
  } catch (_) { return null; }
}

function setApiKey(key) {
  if (!key) { try { fs.unlinkSync(secretsFile()); } catch (_) { /* brak */ } return; }
  if (safeStorage.isEncryptionAvailable()) fs.writeFileSync(secretsFile(), safeStorage.encryptString(key));
  else fs.writeFileSync(secretsFile(), 'b64:' + Buffer.from(key, 'utf8').toString('base64'));
}

function getProvider() {
  const s = store.settings;
  return s.ai.provider === 'api' ? new ApiProvider(s, getApiKey) : new ClaudeCodeProvider(s);
}

function emit(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function iconPath() { return path.join(__dirname, '..', 'assets', 'icon.png'); }

function notify(title, body) {
  if (!Notification.isSupported()) return false;
  const n = new Notification({ title, body, icon: iconPath() });
  n.on('click', () => showWindow());
  n.show();
  return true;
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 400,
    minHeight: 560,
    show: false,
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : undefined,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#f5f5f7',
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false // notowania i alerty działają także, gdy okno jest schowane
    }
  });
  win.setMenuBarVisibility(false);
  if (process.env.COINTRACKO_SIZE) { const [w, hh] = process.env.COINTRACKO_SIZE.split('x').map(Number); win.setSize(w, hh); }
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });
  if (process.env.COINTRACKO_SHOTS) {
    win.webContents.on('console-message', (...a) => { const e = a[0]; console.log('[renderer]', e && e.message ? e.message : a.slice(1).join(' ')); });
    win.webContents.once('did-finish-load', () => devScreenshots(process.env.COINTRACKO_SHOTS));
  }
  win.on('close', (e) => {
    if (quitting) return;
    const action = store.settings.window.closeAction;
    if (action === 'quit') return;
    e.preventDefault();
    if (action === 'tray' && tray) {
      win.hide();
      if (!store.data.hints.trayHint) {
        store.data.hints.trayHint = true; store.save();
        notify('CoinTracko działa w tle', 'Notowania i alerty są nadal aktualizowane. Okno otworzysz ikoną w zasobniku, a aplikację zakończysz z jej menu.');
      }
    } else {
      win.minimize();
    }
  });
  win.on('show', () => emit('app:shown'));
  win.on('restore', () => emit('app:shown'));
  win.on('maximize', () => emit('window:state', { maximized: true }));
  win.on('unmaximize', () => emit('window:state', { maximized: false }));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// Tryb deweloperski: zrzuty ekranu widoków (COINTRACKO_SHOTS=katalog, COINTRACKO_STEPS="nazwa=<JS>,…")
async function devScreenshots(dir) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  fs.mkdirSync(dir, { recursive: true });
  const steps = (process.env.COINTRACKO_STEPS || 'dashboard').split(',');
  await wait(2000);
  for (const step of steps) {
    const [name, js] = step.split('=');
    if (js) await win.webContents.executeJavaScript(decodeURIComponent(js)).catch((e) => console.error(e));
    await wait(Number(process.env.COINTRACKO_WAIT) || 1100);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG());
  }
  quitting = true;
  app.quit();
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quitApp() { quitting = true; app.quit(); }

function createTray() {
  try {
    const img = nativeImage.createFromPath(iconPath()).resize({ width: 22, height: 22 });
    tray = new Tray(img);
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Otwórz CoinTracko', click: showWindow },
      { label: 'Odśwież notowania', click: () => emit('app:refresh') },
      { type: 'separator' },
      { label: 'Zakończ', click: quitApp }
    ]));
    tray.on('click', showWindow);
  } catch (_) { tray = null; }
}

// ─────────────────────────── IPC ───────────────────────────

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; } catch (err) { return { ok: false, error: err.message || String(err) }; }
  });
}

function registerIpc() {
  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    dataDir,
    hasTray: !!tray,
    mock: !!process.env.COINTRACKO_MOCK
  }));

  handle('window:control', (action) => {
    if (!win) return false;
    if (action === 'close') { win.close(); return false; }
    if (action === 'minimize') { win.minimize(); return win.isMaximized(); }
    if (action === 'maximize') {
      // na Linuksie (re)maksymalizacja jest asynchroniczna – zwracamy stan docelowy
      const target = !win.isMaximized();
      if (target) win.maximize(); else win.unmaximize();
      return target;
    }
    return win.isMaximized();
  });

  handle('state:get', () => ({ settings: store.settings, data: store.data, hasApiKey: !!getApiKey(), claudePath: findClaude(store.settings.ai.claudePath) }));
  handle('settings:set', (patch) => {
    const s = store.updateSettings(patch);
    if (patch && patch.ui && patch.ui.theme) nativeTheme.themeSource = patch.ui.theme;
    return s;
  });
  handle('data:set', (data) => store.setData(data));
  // Notowania pobiera proces główny (okno nie potrzebuje wtedy zgody CORS serwera) – wyłącznie z API CoinGecko.
  handle('net:getJson', async (url, key) => {
    if (typeof url !== 'string' || !url.startsWith('https://api.coingecko.com/api/v3/')) throw new Error('Niedozwolony adres.');
    const headers = { accept: 'application/json' };
    if (key) headers['x-cg-demo-api-key'] = String(key);
    const res = await net.fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    let data = null;
    if (res.ok) data = await res.json();
    return { status: res.status, data };
  });
  handle('notify', (title, body) => notify(String(title || APP_NAME).slice(0, 120), String(body || '').slice(0, 300)));
  handle('tray:info', (text) => { if (tray) tray.setToolTip(String(text || APP_NAME).slice(0, 120)); return true; });

  handle('apikey:set', (key) => { setApiKey((key || '').trim()); return !!getApiKey(); });
  handle('ai:test', async () => getProvider().test());
  handle('ai:extractHoldings', async (image) => {
    if (!image || !image.data) throw new Error('Nie wybrano zrzutu ekranu.');
    const res = await getProvider().run({ system: Core.HOLDINGS_SYSTEM, prompt: Core.HOLDINGS_PROMPT, images: [image], webSearch: false, maxTokens: 4000 });
    return Core.normalizeAiRows(Core.extractJson(res.text));
  });
  handle('claude:status', () => account.status());
  handle('claude:install', () => account.install());
  handle('claude:login', () => { store.updateSettings({ ai: { provider: 'claude-code' } }); return account.startLogin(); });
  handle('claude:code', (code) => account.submitCode(code));
  handle('claude:cancel', () => { account.cancelLogin(); return true; });
  handle('claude:logout', () => account.logout());
  handle('ai:browseClaude', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Wskaż program Claude Code', properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    store.updateSettings({ ai: { claudePath: r.filePaths[0] } });
    return r.filePaths[0];
  });

  handle('shell:openExternal', (url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return true; });
  handle('shell:openDataDir', () => shell.openPath(dataDir));
}

app.on('second-instance', () => showWindow());

app.whenReady().then(() => {
  store = new Store(dataDir);
  nativeTheme.themeSource = process.env.COINTRACKO_THEME || store.settings.ui.theme || 'system';
  account = new ClaudeAccount({ getSettings: () => store.settings, emit });
  createTray();
  registerIpc();
  createWindow();
  app.on('activate', showWindow);
});

app.on('before-quit', () => { quitting = true; if (account) account.cancelLogin(); });
app.on('window-all-closed', () => app.quit());
