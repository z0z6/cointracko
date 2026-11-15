'use strict';
// Jeden sposób wykonywania zapytań zdalnych w całej aplikacji. Komputer i przeglądarka-podgląd korzystają z procesu
// głównego (lista dozwolonych adresów, limity, wspólna pamięć podręczna); Android łączy się bezpośrednio (natywny HTTP).

(function () {
  let override = null; // tryb deweloperski (dane przykładowe)
  const local = new Map(); // pamięć podręczna dla połączeń bezpośrednich
  const TIMEOUT_MS = 20000;

  async function direct(req) {
    const method = String(req.method || 'GET').toUpperCase();
    const body = req.body == null ? undefined : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    const as = req.as === 'text' ? 'text' : 'json';
    if (!Allowlist.isAllowed(req.url, method, body)) throw new Error('Niedozwolony adres.'); // także przy połączeniach bezpośrednich (Android)
    const ttl = req.ttl == null ? 25000 : req.ttl;
    const id = `${method} ${req.url} ${body || ''} ${as}`;
    const hit = local.get(id);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const headers = { accept: as === 'json' ? 'application/json' : '*/*' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (req.key && /^https:\/\/api\.coingecko\.com\//.test(req.url)) headers['x-cg-demo-api-key'] = String(req.key);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(req.url, { method, headers, body, signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      let value;
      if (!res.ok) value = { status: res.status };
      else if (as === 'text') value = { status: res.status, text: await res.text() };
      else value = { status: res.status, data: await res.json() };
      if (res.ok && ttl > 0) { local.set(id, { at: Date.now(), value }); if (local.size > 200) local.delete(local.keys().next().value); }
      return value;
    } finally { clearTimeout(timer); }
  }

  // → { status, data | text }; rzuca błąd tylko przy braku połączenia
  function request(req) {
    if (override) return override(req);
    if (window.api && window.api.fetchRemote) return window.api.fetchRemote(req);
    if (window.platform && window.platform.fetchRemote) return window.platform.fetchRemote(req);
    return direct(req);
  }

  // wygodnie: zwraca dane albo rzuca błąd z kodem statusu
  async function json(url, opts = {}) {
    const r = await request({ url, as: 'json', ...opts });
    if (r.status !== 200) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
    return r.data;
  }
  async function text(url, opts = {}) {
    const r = await request({ url, as: 'text', ...opts });
    if (r.status !== 200) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
    return r.text;
  }

  window.Remote = { request, json, text, setTransport: (fn) => { override = fn; local.clear(); } };
})();
