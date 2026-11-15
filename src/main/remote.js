'use strict';
// Bezpieczny klient zapytań zdalnych (proces główny): lista dozwolonych adresów, limit czasu i rozmiaru odpowiedzi,
// kontrola adresu końcowego po przekierowaniach, wspólna krótka pamięć podręczna i łączenie identycznych zapytań.
const { isAllowed } = require('../renderer/allowlist');

const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 20000;
const DEFAULT_TTL = 25 * 1000;
const MAX_TTL = 24 * 3600 * 1000;
const KEY_HOST = 'api.coingecko.com'; // klucz CoinGecko wolno wysłać tylko do CoinGecko
const MAX_CACHE_BYTES = 24 * 1024 * 1024; // łączny limit pamięci podręcznej
const MAX_PARALLEL = 6; // naraz tyle zapytań sieciowych (reszta czeka w kolejce)
const MAX_REDIRECTS = 3;

class Remote {
  // fetchImpl(url, init) → Response (w Electronie: net.fetch)
  constructor(fetchImpl, { allowed = isAllowed, now = Date.now } = {}) {
    this.fetch = fetchImpl;
    this.allowed = allowed;
    this.now = now;
    this.cache = new Map();
    this.cacheBytes = 0;
    this.inflight = new Map();
    this.active = 0;
    this.waiting = [];
  }

  async _slot() {
    if (this.active >= MAX_PARALLEL) await new Promise((r) => this.waiting.push(r));
    this.active++;
  }

  _release() {
    this.active--;
    const next = this.waiting.shift();
    if (next) next();
  }

  _store(id, value, ttl) {
    const size = (value.text ? value.text.length : 0) + (value.data !== undefined ? JSON.stringify(value.data).length : 0) + 200;
    const old = this.cache.get(id);
    if (old) { this.cacheBytes -= old.size; this.cache.delete(id); }
    this.cache.set(id, { at: this.now(), ttl, value, size });
    this.cacheBytes += size;
    while ((this.cacheBytes > MAX_CACHE_BYTES || this.cache.size > 300) && this.cache.size) {
      const k = this.cache.keys().next().value;
      this.cacheBytes -= this.cache.get(k).size; this.cache.delete(k);
    }
  }

  // req: { url, method?, body?, as?: 'json'|'text', ttl?: ms, fresh?: bool, key?: klucz CoinGecko }
  async request(req) {
    const method = String(req.method || 'GET').toUpperCase();
    const body = req.body == null ? undefined : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    if (!this.allowed(req.url, method, body)) throw new Error('Niedozwolony adres.');
    const as = req.as === 'text' ? 'text' : 'json';
    const ttl = Math.min(MAX_TTL, Math.max(0, req.ttl == null ? DEFAULT_TTL : Number(req.ttl) || 0));
    const id = `${method} ${req.url} ${body || ''} ${as}`;
    const hit = this.cache.get(id);
    if (!req.fresh && hit && this.now() - hit.at < hit.ttl) return hit.value; // fresh: pomiń pamięć podręczną (wymuszona aktualizacja)
    if (this.inflight.has(id)) return this.inflight.get(id);
    const p = this._do(req, method, body, as).then((value) => {
      if (value.status === 200 && ttl > 0) this._store(id, value, ttl);
      return value;
    }).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  async _do(req, method, body, as) {
    await this._slot();
    try {
      let url = req.url;
      let m = method;
      let payload = body;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const headers = { accept: as === 'json' ? 'application/json' : 'application/rss+xml, application/xml, text/xml, */*;q=0.5' };
        if (payload !== undefined) headers['content-type'] = 'application/json';
        if (req.key && new URL(url).hostname === KEY_HOST) headers['x-cg-demo-api-key'] = String(req.key).slice(0, 200); // klucz wyłącznie do CoinGecko
        // przekierowania obsługujemy sami, żeby każdy kolejny adres przeszedł przez listę dozwolonych, zanim wyślemy zapytanie
        const res = await this.fetch(url, { method: m, headers, body: payload, redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers && res.headers.get && res.headers.get('location');
          await discard(res);
          if (!loc) throw new Error('Serwer przekierował bez adresu.');
          const next = new URL(loc, url).toString();
          if (m !== 'GET' && res.status !== 307 && res.status !== 308) { m = 'GET'; payload = undefined; }
          if (!this.allowed(next, m, payload)) throw new Error('Serwer przekierował na niedozwolony adres.');
          url = next;
          continue;
        }
        if (res.type === 'opaqueredirect') throw new Error('Serwer przekierował na niedozwolony adres.');
        if (!res.ok) { await discard(res); return { status: res.status }; }
        const text = await readLimited(res, MAX_BYTES);
        if (as === 'text') return { status: res.status, text };
        try { return { status: res.status, data: JSON.parse(text) }; } catch (_) { throw new Error('Serwer zwrócił niepoprawną odpowiedź.'); }
      }
      throw new Error('Zbyt wiele przekierowań.');
    } finally { this._release(); }
  }
}

async function discard(res) { try { if (res.body && res.body.cancel) await res.body.cancel(); } catch (_) { /* ignore */ } }

// Czyta treść odpowiedzi, przerywając po przekroczeniu limitu.
async function readLimited(res, max) {
  const len = Number(res.headers && res.headers.get && res.headers.get('content-length'));
  if (len > max) throw new Error('Odpowiedź serwera jest zbyt duża.');
  if (!res.body || !res.body.getReader) {
    const t = await res.text();
    if (t.length > max) throw new Error('Odpowiedź serwera jest zbyt duża.');
    return t;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { try { await reader.cancel(); } catch (_) { /* ignore */ } throw new Error('Odpowiedź serwera jest zbyt duża.'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

module.exports = { Remote, readLimited, MAX_BYTES };
