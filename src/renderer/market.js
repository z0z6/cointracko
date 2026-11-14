'use strict';
// Klient notowań (CoinGecko, publiczne API – bez klucza; opcjonalny klucz demo zwiększa limity).

(function () {
  const BASE = 'https://api.coingecko.com/api/v3';
  const cache = new Map(); // klucz → { at, data }
  let apiKey = '';
  let transport = null; // podmieniane w trybie testowym

  class MarketError extends Error {
    constructor(message, kind) { super(message); this.kind = kind; }
  }

  async function getJson(path, params = {}, { ttl = 0, timeoutMs = 20000 } = {}) {
    const qs = Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const url = `${BASE}${path}${qs ? '?' + qs : ''}`;
    const hit = cache.get(url);
    if (ttl && hit && Date.now() - hit.at < ttl) return hit.data;
    if (transport) {
      const data = await transport(path, params);
      cache.set(url, { at: Date.now(), data });
      return data;
    }
    const headers = apiKey ? { 'x-cg-demo-api-key': apiKey, accept: 'application/json' } : { accept: 'application/json' };
    const offline = (e) => new MarketError(e && e.name === 'AbortError' ? 'Serwer notowań nie odpowiada (przekroczono czas oczekiwania).' : 'Brak połączenia z internetem lub serwerem notowań.', 'network');
    let status;
    let body;
    if (window.api && window.api.getJson) {
      // komputer: zapytanie wykonuje proces główny aplikacji (bez ograniczeń CORS przeglądarki)
      try { const r = await window.api.getJson(url, apiKey); status = r.status; body = r.data; } catch (e) { throw offline(e); }
    } else {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: ctrl.signal, headers });
        status = res.status;
        body = res.ok ? await res.json() : null;
      } catch (e) { throw offline(e); } finally { clearTimeout(timer); }
    }
    if (status === 429) {
      if (hit) return hit.data; // przy limicie zapytań pokaż ostatnie znane dane
      throw new MarketError('Serwer notowań chwilowo ogranicza liczbę zapytań. Spróbuję ponownie za chwilę.', 'rate');
    }
    if (status === 401 || status === 403) throw new MarketError('Serwer notowań odrzucił zapytanie (sprawdź klucz CoinGecko w Ustawieniach).', 'auth');
    if (status < 200 || status >= 300 || body == null) throw new MarketError(`Serwer notowań zwrócił błąd ${status}.`, 'http');
    const data = body;
    cache.set(url, { at: Date.now(), data });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return data;
  }

  function mapCoin(c) {
    return {
      id: c.id,
      symbol: c.symbol,
      name: c.name,
      image: c.image,
      price: c.current_price,
      change1h: c.price_change_percentage_1h_in_currency,
      change24h: c.price_change_percentage_24h_in_currency != null ? c.price_change_percentage_24h_in_currency : c.price_change_percentage_24h,
      change7d: c.price_change_percentage_7d_in_currency,
      marketCap: c.market_cap,
      rank: c.market_cap_rank,
      volume: c.total_volume,
      high24h: c.high_24h,
      low24h: c.low_24h,
      ath: c.ath,
      athChange: c.ath_change_percentage,
      supply: c.circulating_supply,
      spark: c.sparkline_in_7d && Array.isArray(c.sparkline_in_7d.price) ? c.sparkline_in_7d.price : null,
      updated: c.last_updated
    };
  }

  // Notowania wskazanych monet (do 250 identyfikatorów w jednym zapytaniu).
  async function quotes(ids, cur) {
    if (!ids.length) return [];
    const out = [];
    for (let i = 0; i < ids.length; i += 200) {
      const data = await getJson('/coins/markets', {
        vs_currency: cur, ids: ids.slice(i, i + 200).join(','), order: 'market_cap_desc', per_page: 250, page: 1, sparkline: 'true', price_change_percentage: '1h,24h,7d'
      });
      out.push(...data.map(mapCoin));
    }
    return out;
  }

  // Ranking wg kapitalizacji (strony po 250 pozycji).
  async function top(cur, page = 1, { ttl = 120000 } = {}) {
    const data = await getJson('/coins/markets', {
      vs_currency: cur, order: 'market_cap_desc', per_page: 250, page, sparkline: 'true', price_change_percentage: '1h,24h,7d'
    }, { ttl });
    return data.map(mapCoin);
  }

  async function search(query) {
    const q = String(query || '').trim();
    if (!q) return [];
    const data = await getJson('/search', { query: q }, { ttl: 10 * 60000 });
    return (data.coins || []).slice(0, 25).map((c) => ({ id: c.id, symbol: c.symbol, name: c.name, image: c.large || c.thumb, rank: c.market_cap_rank }));
  }

  // Historia cen: days = 1 | 7 | 30 | 90 | 365 → [[czas_ms, cena], …]
  async function chart(id, cur, days) {
    const ttl = days <= 1 ? 60000 : days <= 7 ? 5 * 60000 : 30 * 60000;
    const data = await getJson(`/coins/${encodeURIComponent(id)}/market_chart`, { vs_currency: cur, days }, { ttl });
    return (data.prices || []).filter((p) => Array.isArray(p) && isFinite(p[1]));
  }

  window.Market = {
    quotes, top, search, chart, MarketError,
    setKey: (k) => { apiKey = String(k || '').trim(); },
    setTransport: (fn) => { transport = fn; cache.clear(); },
    clearCache: () => cache.clear()
  };
})();
