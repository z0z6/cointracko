'use strict';
// Niezależne źródła cen: trzy oracle (Pyth, RedStone, Chainlink), indeks CryptoCompare, giełdy Coinbase i Binance
// oraz CoinGecko jako agregator. Cena „zaufana” to średnia z źródeł zgodnych ze sobą – wartości odstające od mediany
// (np. błędna wycena jednego serwisu) są odrzucane i pokazywane osobno.
// Część czysta (parsery, konsensus) działa bez sieci i jest testowana w test/run-tests.js.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Oracles = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const SOURCES = {
    pyth: { label: 'Pyth Network', kind: 'oracle', maxAgeMs: 30 * 60000 },
    redstone: { label: 'RedStone', kind: 'oracle', maxAgeMs: 60 * 60000 },
    chainlink: { label: 'Chainlink', kind: 'oracle', maxAgeMs: 26 * 3600000 },
    cryptocompare: { label: 'CryptoCompare (indeks CCCAGG)', kind: 'index', maxAgeMs: 0 },
    coinbase: { label: 'Coinbase', kind: 'exchange', maxAgeMs: 0 },
    binance: { label: 'Binance', kind: 'exchange', maxAgeMs: 0 },
    coingecko: { label: 'CoinGecko', kind: 'aggregator', maxAgeMs: 0 }
  };
  const KIND_LABEL = { oracle: 'oracle', index: 'indeks', exchange: 'giełda', aggregator: 'agregator' };
  const ORACLE_IDS = Object.keys(SOURCES).filter((k) => SOURCES[k].kind === 'oracle');

  // Chainlink: stała lista awaryjna (BTC/USD i ETH/USD, Ethereum mainnet), gdy katalog feedów jest niedostępny.
  const CHAINLINK_STATIC = {
    BTC: { proxy: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c', decimals: 8 },
    ETH: { proxy: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', decimals: 8 }
  };
  const LATEST_ROUND_DATA = '0xfeaf968c'; // selektor latestRoundData()
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : NaN; };
  const normSym = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  // ───────────────────────── parsery odpowiedzi ─────────────────────────

  // Pyth: lista feedów → { SYMBOL: id } (kwotowane w USD)
  function parsePythFeeds(list) {
    const out = {};
    for (const f of Array.isArray(list) ? list : []) {
      const a = (f && f.attributes) || {};
      if (!f || !/^[0-9a-f]{64}$/i.test(String(f.id || ''))) continue;
      if (String(a.quote_currency || '').toUpperCase() !== 'USD') continue;
      if (a.asset_type && String(a.asset_type).toLowerCase() !== 'crypto') continue;
      const base = normSym(a.base);
      if (!base) continue;
      const exact = String(a.symbol || '').toUpperCase() === `CRYPTO.${base}/USD`;
      if (!out[base] || exact) out[base] = String(f.id).toLowerCase().replace(/^0x/, '');
    }
    return out;
  }

  // Pyth: odpowiedź /v2/updates/price/latest → { id: { price, ts } }; odrzuca wyceny z szerokim przedziałem ufności
  function parsePythPrices(json) {
    const out = {};
    for (const p of (json && json.parsed) || []) {
      const pr = p && p.price;
      if (!pr) continue;
      const price = num(pr.price) * Math.pow(10, num(pr.expo));
      const conf = num(pr.conf) * Math.pow(10, num(pr.expo));
      if (!(price > 0)) continue;
      if (conf / price > 0.02) continue; // oracle sam zgłasza niepewność > 2% – nie ufamy
      out[String(p.id).toLowerCase().replace(/^0x/, '')] = { price, ts: num(pr.publish_time) * 1000 };
    }
    return out;
  }

  // RedStone: obiekt { SYM: { value, timestamp } } albo tablica [{ symbol, value, timestamp }]
  function parseRedstone(json) {
    const out = {};
    const add = (sym, it) => {
      const price = num(it && it.value);
      if (price > 0) out[normSym(sym || (it && it.symbol))] = { price, ts: num(it.timestamp) || 0 };
    };
    if (Array.isArray(json)) json.forEach((it) => it && add(it.symbol, it));
    else if (json && typeof json === 'object') for (const [k, it] of Object.entries(json)) if (it && typeof it === 'object') add(k, it);
    return out;
  }

  // CryptoCompare pricemulti → { SYM: cena w USD }
  function parseCryptoCompareMulti(json) {
    const out = {};
    if (!json || json.Response === 'Error') return out;
    for (const [sym, v] of Object.entries(json)) { const p = num(v && v.USD); if (p > 0) out[normSym(sym)] = p; }
    return out;
  }

  // Binance ticker/price (wszystkie pary) → { SYM: cena } dla par z USDT
  function parseBinance(arr) {
    const out = {};
    for (const t of Array.isArray(arr) ? arr : []) {
      const m = /^([A-Z0-9]{2,15})USDT$/.exec(String((t && t.symbol) || ''));
      const p = num(t && t.price);
      if (m && p > 0) out[m[1]] = p;
    }
    return out;
  }

  // Coinbase exchange-rates (base USD): rates = ile jednostek za 1 USD → ceny kryptowalut i kursy walut
  function parseCoinbaseRates(json) {
    const rates = (json && json.data && json.data.rates) || {};
    const crypto = {};
    const fiat = {};
    for (const [sym, v] of Object.entries(rates)) {
      const r = num(v);
      if (!(r > 0)) continue;
      crypto[normSym(sym)] = 1 / r;
      fiat[normSym(sym)] = r;
    }
    return { crypto, fiat };
  }

  // Chainlink: katalog feedów → { SYM: { proxy, decimals } } dla par X / USD
  function parseChainlinkDirectory(json) {
    const out = {};
    for (const f of Array.isArray(json) ? json : []) {
      const m = /^([A-Za-z0-9.]+)\s*\/\s*USD$/.exec(String((f && f.name) || ''));
      const proxy = String((f && (f.proxyAddress || f.contractAddress)) || '');
      if (!m || !/^0x[0-9a-fA-F]{40}$/.test(proxy)) continue;
      const cat = String(f.feedCategory || '').toLowerCase();
      if (cat && !['verified', 'monitored', 'custom', 'low'].includes(cat)) continue;
      const decimals = Number.isInteger(f.decimals) ? f.decimals : 8;
      out[normSym(m[1])] = { proxy, decimals };
    }
    return out;
  }

  // Wynik eth_call latestRoundData() → { price, ts } (answer = słowo 2, updatedAt = słowo 4)
  function decodeRoundData(hex, decimals) {
    const h = String(hex || '').replace(/^0x/, '');
    if (h.length < 64 * 4) return null;
    const word = (i) => h.slice(i * 64, (i + 1) * 64);
    let answer = BigInt('0x' + word(1));
    if (answer >= (1n << 255n)) answer -= 1n << 256n; // int256
    const price = Number(answer) / Math.pow(10, decimals);
    const updated = Number(BigInt('0x' + word(3)));
    return price > 0 ? { price, ts: updated * 1000 } : null;
  }

  // ───────────────────────── konsensus ─────────────────────────

  const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  // entries: [{ source, price, ts? }] → cena zaufana, pewność i lista odrzuconych odchyleń
  function consensus(entries, { tolerancePct = 2, now = Date.now() } = {}) {
    const all = [];
    for (const e of entries || []) {
      const meta = SOURCES[e.source] || { label: e.source, kind: 'exchange', maxAgeMs: 0 };
      if (!(e.price > 0) || !isFinite(e.price)) continue;
      const age = e.ts ? now - e.ts : null;
      const stale = !!(meta.maxAgeMs && age != null && age > meta.maxAgeMs);
      all.push({ ...e, label: meta.label, kind: meta.kind, age, stale });
    }
    const fresh = all.filter((e) => !e.stale);
    if (!fresh.length) return all.length ? { price: null, entries: all, total: all.length, inliers: 0, outliers: [], confidence: 'none', spreadPct: null, oracleCount: 0, conflict: false } : null;
    const med = median(fresh.map((e) => e.price));
    for (const e of all) { e.devPct = (e.price / med - 1) * 100; e.outlier = !e.stale && Math.abs(e.devPct) > tolerancePct; }
    let inl = fresh.filter((e) => !e.outlier);
    let conflict = false;
    if (!inl.length) { inl = fresh; conflict = true; } // np. dwa źródła rozjechane o więcej niż tolerancja
    const price = conflict ? med : inl.reduce((s, e) => s + e.price, 0) / inl.length;
    const prices = inl.map((e) => e.price);
    const oracleCount = inl.filter((e) => e.kind === 'oracle').length;
    const confidence = conflict ? 'low' : inl.length >= 3 && oracleCount >= 2 ? 'high' : inl.length >= 2 ? 'medium' : 'low';
    return {
      price, median: med, total: all.length, inliers: inl.length, oracleCount, confidence, conflict,
      spreadPct: prices.length > 1 ? ((Math.max(...prices) - Math.min(...prices)) / price) * 100 : 0,
      outliers: all.filter((e) => e.outlier).map((e) => e.source),
      stale: all.filter((e) => e.stale).map((e) => e.source),
      entries: all
    };
  }

  // ───────────────────────── pobieranie ─────────────────────────

  const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
  const RPCS = ['https://ethereum-rpc.publicnode.com/', 'https://cloudflare-eth.com/'];

  // deps: { remote: { json(url, opts) }, cache: { get(key, maxAgeMs), set(key, value) } }
  function create(deps) {
    const { remote, cache } = deps;
    const cached = async (key, maxAge, load) => {
      const hit = cache ? await cache.get(key, maxAge).catch(() => null) : null;
      if (hit) return hit;
      const v = await load();
      if (cache) cache.set(key, v).catch(() => {});
      return v;
    };

    const fetchers = {
      async pyth(symbols) {
        const map = await cached('oracle:pyth-feeds', 7 * 24 * 3600000, async () => parsePythFeeds(await remote.json('https://hermes.pyth.network/v2/price_feeds?asset_type=crypto', { ttl: 3600000 })));
        const ids = symbols.filter((s) => map[s]).map((s) => map[s]);
        const prices = {};
        for (const part of chunk([...new Set(ids)], 40)) {
          const qs = part.map((id) => 'ids[]=' + id).join('&');
          Object.assign(prices, parsePythPrices(await remote.json(`https://hermes.pyth.network/v2/updates/price/latest?${qs}&parsed=true&ignore_invalid_price_ids=true`, { ttl: 15000 })));
        }
        const out = {};
        for (const s of symbols) if (map[s] && prices[map[s]]) out[s] = prices[map[s]];
        return out;
      },
      async redstone(symbols) {
        const out = {};
        for (const part of chunk(symbols, 40)) Object.assign(out, parseRedstone(await remote.json(`https://api.redstone.finance/prices?symbols=${part.join(',')}&provider=redstone`, { ttl: 15000 })));
        return out;
      },
      async cryptocompare(symbols) {
        const out = {};
        for (const part of chunk(symbols, 30)) {
          const p = parseCryptoCompareMulti(await remote.json(`https://min-api.cryptocompare.com/data/pricemulti?fsyms=${part.join(',')}&tsyms=USD`, { ttl: 30000 }));
          for (const [k, v] of Object.entries(p)) out[k] = { price: v, ts: 0 };
        }
        return out;
      },
      async binance(symbols) {
        const all = parseBinance(await remote.json('https://data-api.binance.vision/api/v3/ticker/price', { ttl: 45000 }));
        const out = {};
        for (const s of symbols) if (all[s]) out[s] = { price: all[s], ts: 0 };
        return out;
      },
      async chainlink(symbols) {
        let feeds = CHAINLINK_STATIC;
        try { feeds = { ...CHAINLINK_STATIC, ...(await cached('oracle:chainlink-feeds', 24 * 3600000, async () => parseChainlinkDirectory(await remote.json('https://reference-data-directory.vercel.app/feeds-mainnet.json', { ttl: 3600000 })))) }; } catch (_) { /* lista awaryjna */ }
        const want = symbols.filter((s) => feeds[s]);
        if (!want.length) return {};
        const body = want.map((s, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_call', params: [{ to: feeds[s].proxy, data: LATEST_ROUND_DATA }, 'latest'] }));
        let res;
        let lastErr;
        for (const url of RPCS) {
          try { res = await remote.json(url, { method: 'POST', body, ttl: 15000 }); break; } catch (e) { lastErr = e; }
        }
        if (!res) throw lastErr || new Error('Brak połączenia z węzłem Ethereum');
        const out = {};
        for (const r of Array.isArray(res) ? res : []) {
          const s = want[r && r.id];
          const d = s && r.result ? decodeRoundData(r.result, feeds[s].decimals) : null;
          if (d) out[s] = d;
        }
        return out;
      }
    };

    // coins: [{ id, symbol }], currency: 'usd'|'pln'|'eur', enabled: { pyth: true, … }
    // → { byId: { id: [{ source, price, ts }] }, fx, errors: { źródło: komunikat }, ok: [źródła] }
    async function fetchAll(coins, { currency = 'usd', enabled = {}, fxFallback = null } = {}) {
      const symOf = new Map();
      for (const c of coins) { const s = normSym(c.symbol); if (s) symOf.set(c.id, s); }
      const symbols = [...new Set(symOf.values())];
      const on = (k) => enabled[k] !== false;
      const jobs = {};
      for (const k of ['pyth', 'redstone', 'chainlink', 'cryptocompare', 'binance']) if (on(k)) jobs[k] = fetchers[k](symbols);
      // Coinbase: ceny giełdowe oraz kursy walut do przeliczeń (potrzebne także, gdy samo źródło jest wyłączone)
      const needFx = currency !== 'usd';
      if (on('coinbase') || needFx) jobs.coinbase = remote.json('https://api.coinbase.com/v2/exchange-rates?currency=USD', { ttl: 45000 }).then(parseCoinbaseRates);
      const keys = Object.keys(jobs);
      const settled = await Promise.allSettled(keys.map((k) => jobs[k]));
      const per = {};
      const errors = {};
      keys.forEach((k, i) => { if (settled[i].status === 'fulfilled') per[k] = settled[i].value; else errors[k] = (settled[i].reason && settled[i].reason.message) || 'błąd'; });
      let fx = 1;
      if (needFx) {
        const r = per.coinbase && per.coinbase.fiat[normSym(currency)];
        fx = r > 0 ? r : fxFallback > 0 ? fxFallback : null;
      }
      const byId = {};
      if (fx != null) {
        for (const [id, sym] of symOf) {
          const list = [];
          for (const k of Object.keys(per)) {
            if (k === 'coinbase') { if (on('coinbase') && per.coinbase.crypto[sym] > 0) list.push({ source: 'coinbase', price: per.coinbase.crypto[sym] * fx, ts: 0 }); continue; }
            const v = per[k][sym];
            if (v && v.price > 0) list.push({ source: k, price: v.price * fx, ts: v.ts || 0 });
          }
          byId[id] = list;
        }
      } else {
        errors.fx = 'Brak kursu waluty – ceny źródeł pominięto.';
      }
      return { byId, fx, errors, ok: Object.keys(per).filter((k) => k !== 'coinbase' || on('coinbase')), at: Date.now() };
    }

    return { fetchAll };
  }

  return {
    SOURCES, KIND_LABEL, ORACLE_IDS, CHAINLINK_STATIC, normSym,
    parsePythFeeds, parsePythPrices, parseRedstone, parseCryptoCompareMulti, parseBinance, parseCoinbaseRates, parseChainlinkDirectory, decodeRoundData,
    consensus, create
  };
});
