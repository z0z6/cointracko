'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Tray, Menu, nativeImage, nativeTheme, net } = require('electron');
const path = require('path');
const fs = require('fs');

const { Store } = require('./store');
const { BrowserServer } = require('./web-server');
const autostart = require('./autostart');
const { Remote } = require('./remote');
const { pickSettingsPatch } = require('../renderer/core');

const APP_NAME = 'CoinTracko';
app.setName(APP_NAME);
app.commandLine.appendSwitch('lang', 'pl');
// (okno ma sandbox: true w webPreferences; app.enableSandbox() nie łączy się z --no-sandbox z wrappera AppImage i zawiesza usługę sieci)
app.commandLine.appendSwitch('disable-features', 'MediaRouter,Translate,OptimizationHints'); // mniej zbędnych usług w tle
app.disableHardwareAcceleration(); // bez procesu GPU: mniej pamięci i prądu (interfejs jest lekki)
// Funkcje deweloperskie (zrzuty ekranu, dane przykładowe) działają tylko w wersji niespakowanej.
const DEV = !app.isPackaged;
if (process.platform === 'win32') app.setAppUserModelId('pl.z0z6.cointracko');

const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
const dataDir = process.env.COINTRACKO_DATA_DIR || (portableDir ? path.join(portableDir, 'CoinTracko - dane') : path.join(app.getPath('userData'), 'dane'));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win = null;
let tray = null;
let quitting = false;
let store, server, remote;

function emit(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Do przeglądarki systemowej trafiają wyłącznie poprawne adresy https (bez danych logowania w adresie).
function openExternalSafe(raw) {
  try {
    const u = new URL(String(raw));
    if (u.protocol !== 'https:' || u.username || u.password || String(raw).length > 2000) return false;
    shell.openExternal(u.toString());
    return true;
  } catch (_) { return false; }
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
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: DEV,
      backgroundThrottling: false // notowania i alerty działają także, gdy okno jest schowane
    }
  });
  win.setMenuBarVisibility(false);
  if (DEV && process.env.COINTRACKO_SIZE) { const [w, hh] = process.env.COINTRACKO_SIZE.split('x').map(Number); win.setSize(w, hh); }
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) { win.show(); return; }
    // start z systemem: okno zostaje schowane w zasobniku; bez zasobnika minimalizujemy je na pasek zadań
    if (!tray) { win.showInactive(); win.minimize(); }
  });
  if (DEV && process.env.COINTRACKO_SHOTS) {
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
  win.webContents.setWindowOpenHandler(({ url }) => { openExternalSafe(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-redirect', (e) => e.preventDefault());
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

// Polecenia przyjmujemy tylko od okna aplikacji (jego główna ramka, wczytana z pliku interfejsu).
function trusted(e) {
  try {
    return !!win && !win.isDestroyed() && e.sender === win.webContents && e.senderFrame === win.webContents.mainFrame && /^file:\/\//.test(e.senderFrame.url);
  } catch (_) { return false; }
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!trusted(e)) return { ok: false, error: 'Niedozwolone źródło polecenia.' };
    try { return { ok: true, data: await fn(...args) }; } catch (err) { return { ok: false, error: err.message || String(err) }; }
  });
}

function registerIpc() {
  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    dataDir,
    hasTray: !!tray,
    mock: DEV && !!process.env.COINTRACKO_MOCK
  }));

  handle('window:control', (action) => {
    if (!['close', 'minimize', 'maximize', 'state'].includes(action)) return false;
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

  handle('state:get', () => ({ settings: store.settings, data: store.data }));
  handle('settings:set', (raw) => {
    const patch = pickSettingsPatch(raw, ['ui', 'market', 'window', 'alerts', 'intel', 'browser']); // tylko znane sekcje i pola
    const s = store.updateSettings(patch);
    if (patch.ui && patch.ui.theme) nativeTheme.themeSource = s.ui.theme;
    if (patch.browser) server.apply(s.browser);
    if (patch.window && ('autostart' in patch.window || 'startHidden' in patch.window)) autostart.apply(app, s.window);
    return s;
  });
  handle('data:set', (data) => store.setData(data));
  // Zapytania zdalne wykonuje proces główny (bez ograniczeń CORS) – wyłącznie do adresów z listy dozwolonych.
  handle('net:fetch', (req) => remote.request(req || {}));
  handle('notify', (title, body) => notify(String(title || APP_NAME).slice(0, 120), String(body || '').slice(0, 300)));
  handle('tray:info', (text) => { if (tray) tray.setToolTip(String(text || APP_NAME).slice(0, 120)); return true; });

  handle('browser:status', () => server.status());
  handle('browser:open', () => { const st = server.status(); if (!st.running) throw new Error('Podgląd w przeglądarce jest wyłączony.'); shell.openExternal(st.url); return true; });

  handle('file:save', async (name, text) => {
    if (typeof text !== 'string' || text.length > 8 * 1024 * 1024) throw new Error('Plik jest zbyt duży.');
    const safe = String(name || 'cointracko.json').replace(/[\\/:*?"<>|]/g, '-').slice(0, 120);
    const r = await dialog.showSaveDialog(win, { title: 'Zapisz plik portfela', defaultPath: path.join(app.getPath('documents'), safe), filters: [{ name: 'Plik CoinTracko (JSON)', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, String(text), 'utf8');
    return r.filePath;
  });
  handle('shell:openExternal', (url) => openExternalSafe(url));
  handle('shell:openDataDir', () => shell.openPath(dataDir));
}

app.on('second-instance', () => showWindow());

// Dodatkowe zabezpieczenia wszystkich okien: brak <webview>, nawigacji i uprawnień (kamera, lokalizacja itp.).
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
  contents.on('will-navigate', (ev) => ev.preventDefault());
});

app.whenReady().then(() => {
  if (!gotLock) return;
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  store = new Store(dataDir);
  nativeTheme.themeSource = (DEV && process.env.COINTRACKO_THEME) || store.settings.ui.theme || 'system';
  try { fs.unlinkSync(path.join(dataDir, 'klucz.bin')); } catch (_) { /* brak – dawny, zapisany klucz API */ }
  remote = new Remote((url, init) => net.fetch(url, init));
  server = new BrowserServer({
    getState: () => ({ settings: store.settings, data: store.data, rev: store.rev }),
    setData: (data) => { store.setData(data); emit('data:external', store.data); },
    setSettings: (patch) => { const st = store.updateSettings(patch); if (patch && patch.ui) nativeTheme.themeSource = st.ui.theme; emit('settings:external', st); return st; },
    remote,
    root: path.join(__dirname, '..', 'renderer'),
    iconFile: iconPath(),
    version: app.getVersion()
  });
  server.apply(store.settings.browser);
  // wpis autostartu odświeżamy przy każdym starcie (np. po przeniesieniu pliku AppImage w inne miejsce)
  try { if (store.settings.window.autostart) autostart.apply(app, store.settings.window); } catch (_) { /* tryb deweloperski */ }
  createTray();
  registerIpc();
  createWindow();
  app.on('activate', showWindow);
});

app.on('before-quit', () => { quitting = true; if (server) server.stop(); });
app.on('window-all-closed', () => app.quit());
