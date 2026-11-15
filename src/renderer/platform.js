'use strict';
// Warstwa platformy: ten sam interfejs działa w Electronie (Linux – przez preload/IPC)
// w aplikacji na Androida (Capacitor – dane w pamięci WebView, powiadomienia lokalne)
// oraz w przeglądarce otwartej na stronie serwowanej przez aplikację desktopową (dane i notowania przez lokalne API).

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
      browserStatus: () => a.browserStatus(),
      browserOpen: () => a.browserOpen(),
      on: (ch, fn) => a.on(ch, fn)
    };
    return;
  }

  // ───────────── przeglądarka otwarta z aplikacji desktopowej (podgląd) ─────────────
  if (!isNative && document.querySelector('meta[name="cointracko-host"]')) {
    const lst = {};
    const fire = (ch, payload) => (lst[ch] || []).forEach((fn) => { try { fn(payload); } catch (_) { /* ignore */ } });
    let rev = 0;
    const call = async (path, body) => {
      let res;
      try {
        res = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json', 'x-cointracko': '1' }, body: JSON.stringify(body) });
      } catch (_) { throw new Error('Aplikacja CoinTracko na komputerze nie odpowiada – sprawdź, czy jest uruchomiona.'); }
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || json.ok === false) throw new Error((json && json.error) || `Błąd serwera ${res.status}`);
      return json;
    };
    // zmiany zrobione w oknie aplikacji (lub w innej karcie) trafiają tu po chwili
    setInterval(async () => {
      if (document.hidden) return;
      try {
        const r = await call('/api/rev');
        if (r.rev === rev) return;
        const st = await call('/api/state');
        rev = st.rev;
        fire('state:external', { settings: st.settings, data: st.data });
      } catch (_) { /* aplikacja chwilowo niedostępna */ }
    }, 4000);
    window.platform = {
      kind: 'browser',
      desktop: false,
      hosted: true,
      info: async () => ({ version: document.documentElement.dataset.version || '', platform: 'web', dataDir: '', hasTray: false, mock: /[?&]mock=1/.test(location.search) }),
      load: async () => { const st = await call('/api/state'); rev = st.rev; return { settings: st.settings, data: st.data }; },
      saveSettings: async (patch) => { const r = await call('/api/settings', patch); return r.settings; },
      saveData: async (data) => { const r = await call('/api/data', data); rev = r.rev; return true; },
      fetchRemote: async (req) => { const r = await call('/api/fetch', req); return { status: r.status, data: r.data, text: r.text }; },
      notify: async () => false, // alerty i powiadomienia obsługuje okno aplikacji
      setTrayInfo: async () => true,
      windowControl: async () => false,
      openExternal: async (url) => { if (/^https:\/\//.test(url)) window.open(url, '_blank', 'noopener'); return true; },
      openDataDir: async () => true,
      saveFile: async (name, text) => {
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        return name;
      },
      on: (ch, fn) => { (lst[ch] = lst[ch] || []).push(fn); return () => { lst[ch] = lst[ch].filter((f) => f !== fn); }; }
    };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) fire('app:shown'); });
    return;
  }

  // ───────────── Android / przeglądarka (samodzielnie) ─────────────
  const KEY = 'cointracko-state-v1';
  const listeners = {};
  const emit = (ch, payload) => (listeners[ch] || []).forEach((fn) => { try { fn(payload); } catch (_) { /* ignore */ } });

  function read() {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { raw = {}; }
    const settings = Core.deepMerge(Core.DEFAULT_SETTINGS, raw.settings || {});
    delete settings.ai; delete settings.import; // dawne ustawienia importu ze zrzutu i Claude
    return { settings, data: Core.sanitizeData(raw.data) };
  }
  function write(state) { localStorage.setItem(KEY, JSON.stringify({ version: 1, settings: state.settings, data: state.data })); }

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
    load: async () => read(),
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
