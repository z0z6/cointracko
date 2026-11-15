'use strict';
// Historia cen w rozdzielczości dziennej (do 6 lat wstecz) i wartość portfela dzień po dniu.
// Źródła: CryptoCompare (indeks CCCAGG, do 2000 dni na zapytanie) → Binance (świece dzienne) jako zapas.
// Część czysta (parsery, łączenie, wartość portfela) jest testowana bez sieci.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PriceHistory = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DAY = 86400000;
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : NaN; };
  const dayOf = (ts) => Math.floor(ts / DAY);

  // CryptoCompare histoday → [[ts_ms, close]]; pomija dni sprzed notowania (cena 0)
  function parseCryptoCompareDaily(json) {
    if (!json || json.Response === 'Error') return [];
    const arr = (json.Data && json.Data.Data) || json.Data || [];
    const out = [];
    for (const d of Array.isArray(arr) ? arr : []) {
      const t = num(d && d.time) * 1000; const c = num(d && d.close);
      if (t > 0 && c > 0) out.push([dayOf(t) * DAY, c]);
    }
    return out;
  }

  // Binance klines (1d) → [[ts_ms, close]]
  function parseBinanceKlines(arr) {
    const out = [];
    for (const k of Array.isArray(arr) ? arr : []) {
      const t = num(k && k[0]); const c = num(k && k[4]);
      if (t > 0 && c > 0) out.push([dayOf(t) * DAY, c]);
    }
    return out;
  }

  // scala dwie serie dzienne (nowsze dane nadpisują starsze), sortuje i usuwa duplikaty dni
  function mergeDaily(a, b) {
    const m = new Map();
    for (const p of a || []) m.set(p[0], p[1]);
    for (const p of b || []) m.set(p[0], p[1]);
    return [...m.entries()].sort((x, y) => x[0] - y[0]);
  }

  // Odrzuca pojedyncze błędne punkty (np. wartość 0,001 × sąsiedzi) – skok > 20× względem obu sąsiadów w górę/dół.
  function cleanSpikes(points, factor = 20) {
    if (points.length < 3) return points;
    const out = [points[0]];
    for (let i = 1; i < points.length - 1; i++) {
      const prev = out[out.length - 1][1]; const cur = points[i][1]; const next = points[i + 1][1];
      const spikeUp = cur > prev * factor && cur > next * factor;
      const spikeDown = cur < prev / factor && cur < next / factor;
      if (!spikeUp && !spikeDown) out.push(points[i]);
    }
    out.push(points[points.length - 1]);
    return out;
  }

  // cena z ostatniego dnia ≤ dzień; przed początkiem serii → null
  function priceOnOrBefore(points, ts) {
    let lo = 0; let hi = points.length - 1; let ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (points[mid][0] <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans < 0 ? null : points[ans][1];
  }

  // Wartość portfela dzień po dniu.
  //   mode 'lots'    – ilość z wpisów kupna/sprzedaży obowiązująca danego dnia (wpisy bez daty liczone od początku zakresu)
  //   mode 'current' – dzisiejsze ilości przy dawnych cenach
  // args: { lots: {id:[lot]}, amounts: {id:ilość}, histories: {id:[[ts,cena]]}, mode, fromTs, toTs }
  // → { points: [[ts, wartość]], missing: [id], used: [id] }
  function portfolioDaily({ lots = {}, amounts = {}, histories = {}, mode = 'lots', fromTs, toTs }) {
    const ids = Object.keys(mode === 'lots' ? lots : amounts).filter((id) => (mode === 'lots' ? (lots[id] || []).length : amounts[id] > 0));
    const used = []; const missing = [];
    const coins = [];
    for (const id of ids) {
      const pts = histories[id];
      if (!pts || !pts.length) { missing.push(id); continue; }
      used.push(id);
      let events = null; let flat = 0;
      if (mode === 'lots') {
        events = (lots[id] || []).map((l) => ({ ts: l.date ? Date.parse(l.date) : -Infinity, d: (l.type === 'sell' ? -1 : 1) * l.amount })).sort((a, b) => a.ts - b.ts);
      } else flat = amounts[id];
      coins.push({ id, pts, events, flat, ei: 0, amount: mode === 'lots' ? 0 : flat, pi: -1 });
    }
    if (!coins.length) return { points: [], missing, used };
    // początek: pierwszy wpis z datą; jeśli któryś wpis nie ma daty, liczy się go od początku dostępnych cen
    const allTs = mode === 'lots' ? coins.flatMap((c) => c.events.map((e) => e.ts)) : [];
    const firstLot = mode === 'lots' && allTs.length && !allTs.includes(-Infinity) ? Math.min(...allTs) : -Infinity;
    const firstPrice = Math.min(...coins.map((c) => c.pts[0][0]));
    let start = Math.max(firstLot, firstPrice);
    if (fromTs != null) start = Math.max(start, fromTs);
    const end = toTs != null ? toTs : Math.max(...coins.map((c) => c.pts[c.pts.length - 1][0]));
    start = dayOf(start) * DAY;
    const points = [];
    for (let t = start; t <= end; t += DAY) {
      let v = 0;
      for (const c of coins) {
        if (c.events) {
          while (c.ei < c.events.length && c.events[c.ei].ts <= t) { c.amount += c.events[c.ei].d; c.ei++; }
        }
        if (c.amount <= 1e-12) continue;
        while (c.pi + 1 < c.pts.length && c.pts[c.pi + 1][0] <= t) c.pi++;
        if (c.pi < 0) continue; // brak ceny w tym dniu
        v += c.amount * c.pts[c.pi][1];
      }
      points.push([t, v]);
    }
    return { points, missing, used };
  }

  // ───────────────────────── pobieranie ─────────────────────────

  function create({ remote, cache }) {
    const inflight = new Map();

    async function fromCryptoCompare(sym, cur, days, toTs) {
      const qs = `fsym=${encodeURIComponent(sym)}&tsym=${encodeURIComponent(cur.toUpperCase())}&limit=${Math.min(2000, Math.max(1, days))}${toTs ? '&toTs=' + Math.floor(toTs / 1000) : ''}`;
      const json = await remote.json(`https://min-api.cryptocompare.com/data/v2/histoday?${qs}`, { ttl: 3600000 });
      if (json && json.Response === 'Error') throw new Error(json.Message || 'CryptoCompare: błąd');
      return parseCryptoCompareDaily(json);
    }

    async function fromBinance(sym, days, startTs) {
      const out = [];
      let from = startTs;
      for (let guard = 0; guard < 4; guard++) {
        const arr = await remote.json(`https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(sym)}USDT&interval=1d&limit=1000&startTime=${from}`, { ttl: 3600000 });
        const part = parseBinanceKlines(arr);
        if (!part.length) break;
        out.push(...part);
        from = part[part.length - 1][0] + DAY;
        if (part.length < 1000 || from > Date.now()) break;
      }
      return out;
    }

    // → { points: [[ts, cena]], source, approx } dla ostatnich `years` lat
    async function daily(coin, currency, years = 6) {
      const sym = String(coin.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!sym) throw new Error('Brak symbolu monety');
      const cur = String(currency || 'usd').toUpperCase();
      const key = `hist:${sym}:${cur}`;
      if (inflight.has(key)) return inflight.get(key);
      const p = (async () => {
        const today = dayOf(Date.now()) * DAY;
        const wantFrom = today - Math.round(years * 365.25) * DAY;
        let rec = cache ? await cache.get(key).catch(() => null) : null;
        let points = rec && Array.isArray(rec.points) ? rec.points : [];
        const covers = points.length && points[0][0] <= wantFrom + 7 * DAY;
        const fresh = points.length && points[points.length - 1][0] >= today - DAY;
        if (covers && fresh) return { points: trim(points, wantFrom), source: rec.source, approx: !!rec.approx };
        let source = (rec && rec.source) || 'cryptocompare'; let approx = !!(rec && rec.approx);
        try {
          if (!covers) {
            // pełne pobranie: dwa zapytania (do 2000 dni każde)
            let all = await fromCryptoCompare(sym, cur, 2000, today + DAY);
            if (all.length && all[0][0] > wantFrom + 30 * DAY && (all[0][0] - wantFrom) / DAY > 5) {
              const more = await fromCryptoCompare(sym, cur, Math.min(2000, Math.round((all[0][0] - wantFrom) / DAY) + 2), all[0][0] - DAY);
              all = mergeDaily(more, all);
            }
            if (!all.length) throw new Error('Brak danych');
            points = all; source = 'cryptocompare'; approx = false;
          } else {
            const need = Math.round((today - points[points.length - 1][0]) / DAY) + 2;
            points = mergeDaily(points, await fromCryptoCompare(sym, cur, need, today + DAY));
          }
        } catch (e) {
          // zapas: Binance (pary z USDT; w innych walutach przybliżenie wg dzisiejszego kursu)
          const part = await fromBinance(sym, 2200, covers ? points[points.length - 1][0] : wantFrom);
          if (!part.length) throw e;
          points = mergeDaily(points, part); source = 'binance'; approx = cur !== 'USD';
        }
        points = cleanSpikes(points);
        if (cache) cache.set(key, { points, source, approx }).catch(() => {});
        return { points: trim(points, wantFrom), source, approx };
      })().finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    }
    // Cena zamknięcia dnia (UTC) z konkretnej daty 'RRRR-MM-DD' – także sprzed wielu lat.
    // Najpierw z 6-letniej historii (zapisywanej lokalnie), a dla starszych dat – pojedynczym zapytaniem o ten dzień.
    async function priceOn(coin, currency, iso) {
      const ts = Date.parse(String(iso));
      const today = dayOf(Date.now()) * DAY;
      if (!isFinite(ts) || !/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) throw new Error('Niepoprawna data.');
      if (ts > today) throw new Error('Data nie może być z przyszłości.');
      const sym = String(coin.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!sym) throw new Error('Brak symbolu monety.');
      const cur = String(currency || 'usd').toUpperCase();
      let first = null;
      try {
        const r = await daily(coin, currency, 6);
        first = r.points[0] ? r.points[0][0] : null;
        const hit = exactOrPrev(r.points, ts, 3);
        if (hit) return { price: hit[1], date: hit[0], source: r.source, approx: !!r.approx };
      } catch (_) { /* spróbujemy zapytania o pojedynczy dzień */ }
      if (first != null && ts >= first) throw new Error('Brak notowań z tego dnia (kryptowaluta mogła jeszcze nie istnieć).');
      const pts = await fromCryptoCompare(sym, cur, 3, ts + DAY / 2);
      const hit = exactOrPrev(pts, ts, 3);
      if (!hit) throw new Error('Brak notowań z tego dnia (kryptowaluta mogła jeszcze nie istnieć).');
      return { price: hit[1], date: hit[0], source: 'cryptocompare', approx: false };
    }
    return { daily, priceOn };
  }

  // punkt z dokładnie tego dnia albo z ostatnich `gap` dni wcześniej (luki w danych)
  function exactOrPrev(points, ts, gap) {
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i][0] === ts) return points[i];
      if (points[i][0] < ts) return ts - points[i][0] <= gap * DAY ? points[i] : null;
    }
    return null;
  }

  const trim = (points, from) => (points[0] && points[0][0] < from ? points.filter((p) => p[0] >= from) : points);

  return { DAY, parseCryptoCompareDaily, parseBinanceKlines, mergeDaily, cleanSpikes, priceOnOrBefore, exactOrPrev, portfolioDaily, create };
});
