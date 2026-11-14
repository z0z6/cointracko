'use strict';
// Warstwa platformy: ten sam interfejs działa w Electronie (Linux – przez preload/IPC)
// i w aplikacji na Androida (Capacitor – dane w pamięci WebView, powiadomienia lokalne).

(function () {
  const isElectron = !!window.api;
  const cap = window.Capacitor;
  const isNative = !isElectron && !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const plugin = (name) => (cap && cap.Plugins ? cap.Plugins[name] : null);

  if (isElectron) {
    const a = window.api;
    window.platform = {
      kind: 'electron',
      desktop: true,
      info: () => a.info(),
      load: () => a.getState(),
      saveSettings: (patch) => a.setSettings(patch),
      saveData: (data) => a.setData(data),
      notify: (title, body) => a.notify(title, body),
      setTrayInfo: (text) => a.setTrayInfo(text),
      windowControl: (act) => a.windowControl(act),
      openExternal: (url) => a.openExternal(url),
      openDataDir: () => a.openDataDir(),
      saveFile: (name, text) => a.saveFile(name, text),
      setApiKey: (k) => a.setApiKey(k),
      testAi: () => a.testAi(),
      extractHoldings: (image) => a.extractHoldings(image),
      claude: { status: a.claudeStatus, install: a.claudeInstall, login: a.claudeLogin, code: a.claudeCode, cancel: a.claudeCancel, logout: a.claudeLogout, browse: a.browseClaude },
      on: (ch, fn) => a.on(ch, fn)
    };
    return;
  }

  // ───────────── Android / przeglądarka ─────────────
  const KEY = 'cointracko-state-v1';
  const KEY_API = 'cointracko-api-key';
  const listeners = {};
  const emit = (ch, payload) => (listeners[ch] || []).forEach((fn) => { try { fn(payload); } catch (_) { /* ignore */ } });

  function read() {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { raw = {}; }
    const settings = Core.deepMerge(Core.DEFAULT_SETTINGS, raw.settings || {});
    settings.ai.provider = 'api'; // konto Claude (Claude Code) jest dostępne tylko na komputerze
    return { settings, data: Core.sanitizeData(raw.data) };
  }
  function write(state) { localStorage.setItem(KEY, JSON.stringify({ version: 1, settings: state.settings, data: state.data })); }
  const apiKey = () => { try { return localStorage.getItem(KEY_API) || ''; } catch (_) { return ''; } };

  async function claudeRequest({ system, prompt, image, maxTokens = 4000 }) {
    const key = apiKey();
    if (!key) throw new Error('Brak klucza API Claude. Wklej go w Ustawieniach → Claude albo użyj odczytu lokalnego (OCR).');
    const content = [];
    if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType || 'image/jpeg', data: image.data } });
    content.push({ type: 'text', text: prompt });
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: read().settings.ai.apiModel || 'claude-sonnet-5-5', max_tokens: maxTokens, system, messages: [{ role: 'user', content }] })
      });
    } catch (_) { throw new Error('Brak połączenia z serwerem Claude.'); }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = json && json.error && json.error.message ? json.error.message : `błąd ${res.status}`;
      if (res.status === 401) throw new Error('Klucz API Claude jest nieprawidłowy.');
      throw new Error('Claude: ' + String(msg).slice(0, 300));
    }
    return (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }

  let notifyId = Math.floor(Date.now() / 1000) % 100000;
  async function notify(title, body) {
    const LN = plugin('LocalNotifications');
    if (LN) {
      try {
        let perm = await LN.checkPermissions();
        if (perm.display !== 'granted') perm = await LN.requestPermissions();
        if (perm.display !== 'granted') return false;
        await LN.schedule({ notifications: [{ id: ++notifyId, title, body }] });
        return true;
      } catch (_) { return false; }
    }
    if ('Notification' in window) {
      try {
        if (Notification.permission === 'default') await Notification.requestPermission();
        if (Notification.permission === 'granted') { new Notification(title, { body }); return true; }
      } catch (_) { /* brak */ }
    }
    return false;
  }

  window.platform = {
    kind: isNative ? 'android' : 'web',
    desktop: false,
    info: async () => ({
      version: document.documentElement.dataset.version || '',
      platform: isNative ? cap.getPlatform() : 'web',
      dataDir: '',
      hasTray: false,
      mock: /[?&]mock=1/.test(location.search)
    }),
    load: async () => ({ ...read(), hasApiKey: !!apiKey(), claudePath: null }),
    saveSettings: async (patch) => { const s = read(); s.settings = Core.deepMerge(s.settings, patch); write(s); return s.settings; },
    saveData: async (data) => { const s = read(); s.data = Core.sanitizeData(data); write(s); return true; },
    notify,
    requestNotifications: async () => { const LN = plugin('LocalNotifications'); if (LN) { try { await LN.requestPermissions(); } catch (_) { /* brak */ } } },
    setTrayInfo: async () => true,
    windowControl: async () => false,
    openExternal: async (url) => { if (/^https:\/\//.test(url)) window.open(url, '_blank'); return true; },
    openDataDir: async () => true,
    // Android: plik trafia do pamięci podręcznej aplikacji i otwiera się systemowe „Udostępnij”
    // (zapis w Plikach, na Dysku, wysyłka na inne urządzenie). Przeglądarka: zwykłe pobranie pliku.
    saveFile: async (name, text) => {
      const FS = plugin('Filesystem');
      const Share = plugin('Share');
      if (isNative && FS && Share) {
        const res = await FS.writeFile({ path: name, data: text, directory: 'CACHE', encoding: 'utf8' });
        try { await Share.share({ title: 'Portfel CoinTracko', files: [res.uri], dialogTitle: 'Zapisz lub wyślij plik portfela' }); } catch (e) {
          if (/cancel/i.test(String(e && e.message))) return null;
          throw new Error('Nie udało się udostępnić pliku: ' + (e && e.message ? e.message : e));
        }
        return name;
      }
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return name;
    },
    setApiKey: async (k) => { const v = String(k || '').trim(); if (v) localStorage.setItem(KEY_API, v); else localStorage.removeItem(KEY_API); return !!v; },
    testAi: async () => { const t = await claudeRequest({ system: 'Jesteś testem połączenia.', prompt: 'Odpowiedz dokładnie tekstem: {"ok":true}', maxTokens: 50 }); return 'Połączenie działa: ' + t.trim().slice(0, 40); },
    extractHoldings: async (image) => Core.normalizeAiRows(Core.extractJson(await claudeRequest({ system: Core.HOLDINGS_SYSTEM, prompt: Core.HOLDINGS_PROMPT, image }))),
    claude: null,
    on: (ch, fn) => { (listeners[ch] = listeners[ch] || []).push(fn); return () => { listeners[ch] = listeners[ch].filter((f) => f !== fn); }; }
  };

  // Android: przycisk „wstecz” oraz powrót aplikacji na pierwszy plan
  const App = plugin('App');
  if (App && App.addListener) {
    App.addListener('backButton', () => { if (!window.onAppBack || !window.onAppBack()) { if (App.minimizeApp) App.minimizeApp(); } });
    App.addListener('appStateChange', (st) => { if (st && st.isActive) emit('app:shown'); });
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) emit('app:shown'); });
})();
