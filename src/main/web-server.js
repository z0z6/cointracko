'use strict';
// Podgląd w przeglądarce: lokalny serwer (tylko 127.0.0.1) udostępnia ten sam interfejs, co okno aplikacji,
// oraz niewielkie API do odczytu i zapisu danych. Dzięki temu CoinTracko można otworzyć w Vivaldim,
// Chrome czy Edge (także jako panel boczny Vivaldiego), a zmiany widać w obu miejscach.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { pickSettingsPatch } = require('../renderer/core');

const MAX_BODY = 4 * 1024 * 1024;
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'geolocation=(), camera=(), microphone=(), payment=(), usb=(), serial=()',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://coin-images.coingecko.com https://assets.coingecko.com; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon'
};

class BrowserServer {
  // hooks: { getState() → { settings, data, rev }, setData(data), setSettings(patch), remote (klient zapytań zdalnych), root, iconFile, version }
  constructor(hooks) {
    this.hooks = hooks;
    this.server = null;
    this.port = 0;
    this.error = '';
  }

  status() {
    const running = !!(this.server && this.server.listening);
    return { running, port: this.port, url: running ? `http://127.0.0.1:${this.port}/` : '', error: this.error };
  }

  // Włącza, wyłącza lub restartuje serwer zgodnie z ustawieniami { enabled, port }.
  apply(cfg) {
    const enabled = !!(cfg && cfg.enabled);
    const port = Number(cfg && cfg.port) || 47820;
    if (!enabled) { this.stop(); this.error = ''; return; }
    if (this.server && this.port === port) return;
    this.stop();
    this.start(port);
  }

  start(port) {
    this.error = '';
    this.port = port;
    const server = http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 30000, headersTimeout: 10000, keepAliveTimeout: 5000 }, (req, res) => this.handle(req, res));
    server.maxConnections = 64;
    server.on('error', (e) => {
      this.error = e && e.code === 'EADDRINUSE' ? `Port ${port} jest zajęty przez inny program – wybierz inny.` : `Nie udało się uruchomić podglądu: ${e && e.message}`;
      if (this.server === server) this.server = null;
    });
    server.listen(port, '127.0.0.1');
    this.server = server;
  }

  stop() {
    if (!this.server) return;
    try { this.server.close(); if (this.server.closeAllConnections) this.server.closeAllConnections(); } catch (_) { /* ignore */ }
    this.server = null;
  }

  // Ochrona przed zapytaniami z cudzych stron (CSRF) i przed DNS rebinding: akceptujemy tylko własny adres.
  allowed(req) {
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return false;
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return false;
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return false; // zapytanie zainicjowane przez inną stronę
    if (req.method === 'POST' && req.headers['x-cointracko'] !== '1') return false;
    return true;
  }

  json(res, code, body) {
    const text = JSON.stringify(body);
    res.writeHead(code, { ...SECURITY_HEADERS, 'content-type': MIME['.json'], 'cache-control': 'no-store' });
    res.end(text);
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('Zbyt duże dane.')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch (_) { reject(new Error('Niepoprawny JSON.')); } });
      req.on('error', reject);
    });
  }

  async handle(req, res) {
    try {
      if (!this.allowed(req)) { res.writeHead(403, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' }); res.end('Brak dostępu'); return; }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) return await this.api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, SECURITY_HEADERS); res.end(); return; }
      return this.serveFile(req, res, url.pathname);
    } catch (e) {
      this.json(res, 500, { ok: false, error: e && e.message ? e.message : String(e) });
    }
  }

  async api(req, res, url) {
    const h = this.hooks;
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/state') {
      const st = h.getState();
      return this.json(res, 200, { ok: true, settings: st.settings, data: st.data, rev: st.rev, version: h.version });
    }
    if (route === 'GET /api/rev') return this.json(res, 200, { ok: true, rev: h.getState().rev });
    if (route === 'POST /api/fetch') {
      // zapytania zdalne przeglądarki idą przez ten sam bezpieczny klient (lista adresów, limity, wspólna pamięć podręczna)
      const r = await this.readBody(req);
      if (!r || typeof r !== 'object') throw new Error('Brak zapytania.');
      return this.json(res, 200, { ok: true, ...(await h.remote.request({ url: r.url, method: r.method, body: r.body, as: r.as, ttl: r.ttl, key: r.key })) });
    }
    if (route === 'POST /api/data') {
      const body = await this.readBody(req);
      if (!body || typeof body !== 'object') throw new Error('Brak danych.');
      h.setData(body);
      return this.json(res, 200, { ok: true, rev: h.getState().rev });
    }
    if (route === 'POST /api/settings') {
      const patch = await this.readBody(req);
      if (!patch || typeof patch !== 'object') throw new Error('Brak ustawień.');
      // przeglądarka może zmieniać tylko wygląd, notowania, alerty i wiadomości – serwerem i oknem steruje się z aplikacji
      return this.json(res, 200, { ok: true, settings: h.setSettings(pickSettingsPatch(patch, ['ui', 'market', 'alerts', 'intel'])) });
    }
    return this.json(res, 404, { ok: false, error: 'Nie ma takiego adresu.' });
  }

  serveFile(req, res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch (_) { res.writeHead(400, SECURITY_HEADERS); res.end(); return; }
    if (rel.includes('\0')) { res.writeHead(400, SECURITY_HEADERS); res.end(); return; }
    if (rel === '/' || rel === '') rel = '/index.html';
    if (rel === '/icon.png' || rel === '/favicon.ico') {
      return fs.readFile(this.hooks.iconFile, (err, buf) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': MIME['.png'], 'cache-control': 'max-age=3600' });
        res.end(buf);
      });
    }
    const root = path.resolve(this.hooks.root);
    const file = path.resolve(root, '.' + path.normalize('/' + rel));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' }); res.end('Nie znaleziono'); return; }
      const ext = path.extname(file).toLowerCase();
      let body = buf;
      if (path.basename(file) === 'index.html') {
        // znacznik mówi stronie, że działa w przeglądarce obok aplikacji (dane i notowania idą przez serwer)
        body = Buffer.from(buf.toString('utf8').replace('<head>', `<head>\n  <meta name="cointracko-host" content="1">`).replace('<html lang="pl">', `<html lang="pl" data-version="${this.hooks.version}">`));
      }
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': MIME[ext] || 'application/octet-stream',
        'cache-control': ext === '.woff2' ? 'max-age=86400' : 'no-cache'
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    });
  }
}

module.exports = { BrowserServer };
