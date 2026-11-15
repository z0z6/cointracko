'use strict';
// Wspólna logika CoinTracko (bez dostępu do DOM-u i sieci) – działa w oknie aplikacji,
// w procesie głównym Electrona oraz w testach (node test/run-tests.js).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const CURRENCIES = {
    usd: { label: 'USD – dolar amerykański', code: 'USD' },
    pln: { label: 'PLN – polski złoty', code: 'PLN' },
    eur: { label: 'EUR – euro', code: 'EUR' }
  };

  // Motywy kolorystyczne (style w styles.css: html[data-palette])
  const PALETTES = [
    { id: 'ocean', label: 'Ocean', color: '#007aff' },
    { id: 'violet', label: 'Fiolet', color: '#6f42f0' },
    { id: 'emerald', label: 'Szmaragd', color: '#0b8f5a' },
    { id: 'amber', label: 'Bursztyn', color: '#d95f00' },
    { id: 'rose', label: 'Róża', color: '#d81b60' },
    { id: 'graphite', label: 'Grafit', color: '#475467' },
    { id: 'teal', label: 'Turkus', color: '#00838f' }
  ];

  const DEFAULT_SETTINGS = {
    ui: { theme: 'system', palette: 'ocean' }, // theme: 'system' | 'light' | 'dark'; palette: jeden z 7 motywów kolorystycznych (PALETTES)
    market: {
      currency: 'usd', refreshSec: 60, cgKey: '',
      useConsensus: true, // wyceniaj według średniej ze zgodnych źródeł (oracle + giełdy + CoinGecko)
      tolerancePct: 2, // źródło odbiegające od mediany o więcej niż tyle % jest odrzucane
      sources: { pyth: true, redstone: true, chainlink: true, cryptocompare: true, coinbase: true, binance: true, coingecko: true }
    },
    window: { closeAction: 'tray', autostart: true, startHidden: true }, // closeAction: 'tray' – chowaj do zasobnika, 'minimize' – minimalizuj na pasek zadań, 'quit' – zakończ; autostart: uruchamiaj z systemem (okno schowane, gdy startHidden)
    intel: { enabled: true, notify: true, minSeverity: 4 }, // wiadomości i wykrywanie anomalii
    browser: { enabled: false, port: 47820 } // podgląd w przeglądarce (tylko komputer): http://127.0.0.1:port
  };

  const DEFAULT_DATA = {
    watch: [], // [{ id, symbol, name, image }]
    holdings: {}, // { id: ilość } – wyliczane z wpisów (suma kupna − sprzedaży); nie edytuje się go bezpośrednio
    lots: {}, // { id: [{ id, type: 'buy'|'sell', date: 'RRRR-MM-DD' lub '', amount, price, currency }] } – wpisy (jedyne źródło ilości)
    hints: {}
  };

  const STARTER_WATCH = [
    { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', image: '' },
    { id: 'ethereum', symbol: 'eth', name: 'Ethereum', image: '' },
    { id: 'solana', symbol: 'sol', name: 'Solana', image: '' },
    { id: 'binancecoin', symbol: 'bnb', name: 'BNB', image: '' },
    { id: 'ripple', symbol: 'xrp', name: 'XRP', image: '' }
  ];

  const EPS = 1e-12;
  const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));

  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  function deepMerge(base, extra) {
    if (Array.isArray(base)) return Array.isArray(extra) ? extra : base;
    if (base && typeof base === 'object') {
      const out = { ...base };
      if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
        for (const k of Object.keys(extra)) {
          if (UNSAFE_KEYS.has(k)) continue; // ochrona przed zatruciem prototypu
          out[k] = hasOwn(base, k) ? deepMerge(base[k], extra[k]) : extra[k];
        }
      }
      return out;
    }
    return extra === undefined ? base : extra;
  }

  // ───────────────────────── ustawienia: walidacja ─────────────────────────
  const clampInt = (v, min, max, def) => { const n = Math.round(Number(v)); return isFinite(n) && n >= min && n <= max ? n : def; };
  const asBool = (v, def) => (typeof v === 'boolean' ? v : def);
  const oneOf = (v, list, def) => (list.includes(v) ? v : def);

  // Zwraca kompletne, poprawne ustawienia: nieznane klucze są odrzucane, a wartości sprowadzane do dozwolonych zakresów.
  function sanitizeSettings(raw) {
    const d = DEFAULT_SETTINGS;
    const r = deepMerge(d, raw && typeof raw === 'object' ? raw : {});
    const src = {};
    for (const k of Object.keys(d.market.sources)) src[k] = asBool(r.market.sources && r.market.sources[k], true);
    const tol = Number(r.market.tolerancePct);
    return {
      ui: { theme: oneOf(r.ui.theme, ['system', 'light', 'dark'], 'system'), palette: oneOf(r.ui.palette, PALETTES.map((x) => x.id), 'ocean') },
      market: {
        currency: hasOwn(CURRENCIES, r.market.currency) ? r.market.currency : 'usd',
        refreshSec: clampInt(r.market.refreshSec, 15, 3600, 60),
        cgKey: typeof r.market.cgKey === 'string' && /^[A-Za-z0-9_.\-]{0,200}$/.test(r.market.cgKey) ? r.market.cgKey : '',
        useConsensus: asBool(r.market.useConsensus, true),
        tolerancePct: isFinite(tol) && tol >= 0.5 && tol <= 20 ? tol : 2,
        sources: src
      },
      window: { closeAction: oneOf(r.window.closeAction, ['tray', 'minimize', 'quit'], 'tray'), autostart: asBool(r.window.autostart, true), startHidden: asBool(r.window.startHidden, true) },
      intel: { enabled: asBool(r.intel.enabled, true), notify: asBool(r.intel.notify, true), minSeverity: clampInt(r.intel.minSeverity, 1, 5, 4) },
      browser: { enabled: asBool(r.browser.enabled, false), port: clampInt(r.browser.port, 1024, 65535, 47820) }
    };
  }

  // Zmiana ustawień od strony przeglądarki lub okna: tylko wskazane sekcje, tylko znane pola.
  function pickSettingsPatch(patch, sections) {
    const out = {};
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out;
    for (const sec of sections) {
      if (patch[sec] && typeof patch[sec] === 'object' && !Array.isArray(patch[sec]) && hasOwn(DEFAULT_SETTINGS, sec)) {
        const o = {};
        for (const k of Object.keys(patch[sec])) if (hasOwn(DEFAULT_SETTINGS[sec], k)) o[k] = patch[sec][k];
        out[sec] = o;
      }
    }
    return out;
  }

  // Porządkuje dane użytkownika wczytane z dysku (odporność na uszkodzony lub stary plik).
  const COIN_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;
  const okId = (id) => typeof id === 'string' && COIN_ID.test(id) && !UNSAFE_KEYS.has(id);
  const SAFE_IMAGE = /^(https:\/\/(coin-images|assets)\.coingecko\.com\/[\w\-./%?=&]{1,300}|data:image\/(png|jpeg|webp|svg\+xml)[;,][^"'\s]{0,3000})$/;
  const MAX_WATCH = 500; const MAX_LOTS = 5000;
  const str = (v, n) => String(v == null ? '' : v).slice(0, n);

  // Porządkuje dane użytkownika wczytane z dysku, z pliku lub od przeglądarki (odporność na uszkodzony, stary lub złośliwy plik).
  function sanitizeData(raw) {
    const d = raw && typeof raw === 'object' ? raw : {};
    const watch = (Array.isArray(d.watch) ? d.watch : []).filter((w) => w && okId(w.id))
      .map((w) => ({ id: w.id, symbol: str(w.symbol, 24), name: str(w.name || w.id, 80), image: typeof w.image === 'string' && SAFE_IMAGE.test(w.image) ? w.image : '' }));
    const seen = new Set();
    const uniq = watch.filter((w) => (seen.has(w.id) ? false : seen.add(w.id))).slice(0, MAX_WATCH);
    const lots = {};
    for (const [id, list] of Object.entries(d.lots && typeof d.lots === 'object' && !Array.isArray(d.lots) ? d.lots : {})) {
      if (!okId(id)) continue;
      const clean = (Array.isArray(list) ? list : []).slice(0, MAX_LOTS).map(sanitizeLot).filter(Boolean);
      if (clean.length) lots[id] = sortLots(clean);
    }
    // Migracja ze starego formatu: ilość zapisana „na sztywno” (bez wpisów) staje się zwykłym, edytowalnym wpisem.
    for (const [id, v] of Object.entries(d.holdings && typeof d.holdings === 'object' && !Array.isArray(d.holdings) ? d.holdings : {})) {
      const n = Number(v);
      if (!okId(id) || !isFinite(n) || n <= 0) continue;
      const missing = n - lotsNet(lots[id]);
      if (missing > EPS) lots[id] = sortLots([...(lots[id] || []), { id: 'start-' + id, type: 'buy', date: '', amount: missing, price: null, currency: 'usd' }]);
    }
    const holdings = holdingsFromLots(lots);
    const hints = {};
    const dh = d.hints && typeof d.hints === 'object' && !Array.isArray(d.hints) ? d.hints : {};
    for (const k of ['seeded', 'trayHint']) if (dh[k] === true) hints[k] = true;
    return { watch: uniq, holdings, lots, hints };
  }

  // ───────────────────────── formatowanie ─────────────────────────

  function fmtMoney(value, cur = 'usd', opts = {}) {
    if (value == null || !isFinite(value)) return '—';
    const code = (CURRENCIES[cur] || CURRENCIES.usd).code;
    const abs = Math.abs(value);
    let max = 2;
    let min = 2;
    if (opts.compact && abs >= 1e6) {
      return new Intl.NumberFormat('pl-PL', { style: 'currency', currency: code, notation: 'compact', maximumFractionDigits: 2 }).format(value);
    }
    if (abs > 0 && abs < 1) {
      // małe ceny: 4 cyfry znaczące (np. 0,00001234)
      max = Math.min(12, Math.max(4, 3 - Math.floor(Math.log10(abs))));
      min = 2;
    }
    return new Intl.NumberFormat('pl-PL', { style: 'currency', currency: code, minimumFractionDigits: min, maximumFractionDigits: max, useGrouping: 'always' }).format(value);
  }

  function fmtAmount(n) {
    if (n == null || !isFinite(n)) return '—';
    const abs = Math.abs(n);
    const max = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8;
    return new Intl.NumberFormat('pl-PL', { maximumFractionDigits: max, useGrouping: 'always' }).format(n);
  }

  function fmtPct(n, digits = 2) {
    if (n == null || !isFinite(n)) return '—';
    const s = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Math.abs(n));
    return (n > 0 ? '+' : n < 0 ? '−' : '') + s + '%';
  }

  // Liczba wpisana przez człowieka lub odczytana ze zrzutu: „1 234,56”, „1,234.56”, „0.5”, „12k”, „1,2 mln”.
  function parseAmount(input) {
    if (typeof input === 'number') return isFinite(input) ? input : NaN;
    if (input == null) return NaN;
    let s = String(input).trim().replace(/[\s  ']/g, '');
    if (!s) return NaN;
    let mult = 1;
    const suf = s.match(/(k|tys\.?|m|mln|b|mld)$/i);
    if (suf) {
      const t = suf[1].toLowerCase().replace('.', '');
      mult = t === 'k' || t === 'tys' ? 1e3 : t === 'm' || t === 'mln' ? 1e6 : 1e9;
      s = s.slice(0, -suf[1].length);
    }
    s = s.replace(/[^0-9.,-]/g, '');
    if (!/[0-9]/.test(s)) return NaN;
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    if (lastDot >= 0 && lastComma >= 0) {
      // ostatni separator jest dziesiętny, pozostałe to separatory tysięcy
      const dec = lastDot > lastComma ? '.' : ',';
      const tho = dec === '.' ? ',' : '.';
      s = s.split(tho).join('').replace(dec, '.');
    } else if (lastComma >= 0) {
      const parts = s.split(',');
      // „1,234,567” lub „12,345” (dokładnie 3 cyfry po przecinku i więcej niż jeden przecinek) → tysiące
      if (parts.length > 2 && parts.slice(1).every((p) => p.length === 3)) s = parts.join('');
      else s = parts.slice(0, -1).join('') + '.' + parts[parts.length - 1];
    } else if (lastDot >= 0) {
      const parts = s.split('.');
      if (parts.length > 2) {
        if (parts.slice(1).every((p) => p.length === 3)) s = parts.join('');
        else s = parts.slice(0, -1).join('') + '.' + parts[parts.length - 1];
      }
    }
    const n = Number(s);
    return isFinite(n) ? n * mult : NaN;
  }

  // ───────────────────────── portfel ─────────────────────────

  // holdings: { id: ilość }, market: { id: { price, change24h, ... } }
  function portfolio(holdings, market) {
    const items = [];
    let total = 0;
    let prevTotal = 0;
    let unpriced = 0;
    for (const [id, amount] of Object.entries(holdings || {})) {
      if (!(amount > 0)) continue;
      const m = (market || {})[id];
      if (!m || !isFinite(m.price)) { unpriced++; items.push({ id, amount, value: null, change24h: null }); continue; }
      const value = amount * m.price;
      const ch = isFinite(m.change24h) ? m.change24h : 0;
      const prev = value / (1 + ch / 100);
      total += value;
      prevTotal += isFinite(prev) ? prev : value;
      items.push({ id, amount, value, change24h: ch, pnl24h: value - prev });
    }
    items.sort((a, b) => (b.value || 0) - (a.value || 0));
    for (const it of items) it.share = total > 0 && it.value != null ? it.value / total : 0;
    const change = total - prevTotal;
    return { total, change24hValue: change, change24hPct: prevTotal > 0 ? (change / prevTotal) * 100 : 0, items, unpriced };
  }

  // ───────────────────────── partie zakupu ─────────────────────────

  function sanitizeLot(l) {
    if (!l || typeof l !== 'object') return null;
    const amount = Number(l.amount);
    if (!isFinite(amount) || amount <= 0) return null;
    const price = l.price == null || l.price === '' ? null : Number(l.price);
    return {
      id: String(l.id || Math.random().toString(36).slice(2, 10)),
      type: l.type === 'sell' ? 'sell' : 'buy',
      date: isDate(l.date) ? l.date : '',
      amount,
      price: price != null && isFinite(price) && price >= 0 ? price : null,
      currency: CURRENCIES[l.currency] ? l.currency : 'usd'
    };
  }

  // chronologicznie; partie bez daty na początku (traktowane jak najstarsze)
  function sortLots(list) {
    return [...list].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  }

  // ilość wynikająca z partii: kupno − sprzedaż
  function lotsNet(list) {
    let n = 0;
    for (const l of list || []) n += l.type === 'sell' ? -l.amount : l.amount;
    return n > EPS ? n : 0;
  }

  // saldo wpisów (kupno − sprzedaż) bez przycinania do zera – służy do wykrywania sprzedaży większej niż posiadanie
  function lotsBalance(list) {
    let n = 0;
    for (const l of list || []) n += l.type === 'sell' ? -l.amount : l.amount;
    return n;
  }

  // Ilości posiadane = suma wpisów każdej monety (kupno − sprzedaż); pozycje o zerowej ilości znikają.
  function holdingsFromLots(lots) {
    const out = {};
    for (const [id, list] of Object.entries(lots || {})) {
      const n = lotsNet(list);
      if (n > EPS) out[id] = n;
    }
    return out;
  }

  // przelicza kwotę między walutami wg bieżących kursów (rates: { usd: 1, pln: 4.05, eur: 0.93 })
  function convert(value, from, to, rates) {
    if (value == null || from === to) return value;
    const a = rates && rates[from];
    const b = rates && rates[to];
    return a > 0 && b > 0 ? (value / a) * b : null;
  }

  // Wynik pozycji metodą średniej ceny zakupu.
  // Ilość pozycji to suma wpisów; wpisy bez ceny zakupu nie wchodzą do kosztu i zysku. price – bieżąca cena w walucie cur.
  function positionStats(list, price, cur, rates) {
    let qty = 0; // ilość z partii
    let knownQty = 0; // ilość, dla której znamy koszt
    let cost = 0; // koszt tej ilości
    let realized = 0;
    let bought = 0;
    let sold = 0;
    let first = '';
    for (const l of sortLots(list || [])) {
      const p = l.price == null ? null : convert(l.price, l.currency, cur, rates);
      if (l.date && (!first || l.date < first)) first = l.date;
      if (l.type !== 'sell') {
        qty += l.amount;
        bought += l.amount;
        if (p != null) { knownQty += l.amount; cost += l.amount * p; }
        continue;
      }
      sold += l.amount;
      const take = Math.min(l.amount, qty);
      if (take <= EPS) continue;
      const share = take / qty;
      const soldKnown = knownQty * share;
      const soldCost = cost * share;
      if (p != null && soldKnown > EPS) realized += soldKnown * p - soldCost;
      knownQty -= soldKnown;
      cost -= soldCost;
      qty -= take;
    }
    if (qty < EPS) { qty = 0; knownQty = 0; cost = 0; }
    const totalQty = qty;
    const hasPrice = price != null && isFinite(price);
    const value = hasPrice ? totalQty * price : null;
    const knownValue = hasPrice ? knownQty * price : null;
    const pnl = knownQty > EPS && knownValue != null ? knownValue - cost : null;
    return {
      total: totalQty,
      lotQty: qty,
      knownQty,
      cost: knownQty > EPS ? cost : 0,
      avgPrice: knownQty > EPS ? cost / knownQty : null,
      value,
      pnl,
      pnlPct: pnl != null && cost > 0 ? (pnl / cost) * 100 : null,
      realized,
      bought,
      sold,
      firstDate: first,
      count: (list || []).length
    };
  }

  // Wynik pojedynczej partii kupna przy bieżącej cenie.
  function lotResult(l, price, cur, rates) {
    const p = l.price == null ? null : convert(l.price, l.currency, cur, rates);
    const cost = p != null ? p * l.amount : null;
    const value = price != null && isFinite(price) ? price * l.amount : null;
    if (l.type === 'sell') return { unitPrice: p, cost: null, value: cost, pnl: null, pnlPct: null };
    const pnl = cost != null && value != null ? value - cost : null;
    return { unitPrice: p, cost, value, pnl, pnlPct: pnl != null && cost > 0 ? (pnl / cost) * 100 : null };
  }

  // Zapisuje nową listę wpisów monety i przelicza z niej łączną ilość (jedyne źródło ilości).
  function applyLots(data, id, newLots) {
    const clean = sortLots((newLots || []).map(sanitizeLot).filter(Boolean));
    const lots = { ...(data.lots || {}) };
    if (clean.length) lots[id] = clean; else delete lots[id];
    return { ...data, lots, holdings: holdingsFromLots(lots) };
  }

  // Nowy, pusty wpis (do formularza) – domyślnie kupno z dzisiejszą datą.
  function newLot(partial = {}) {
    return sanitizeLot({ type: 'buy', date: '', amount: 1, price: null, currency: 'usd', ...partial });
  }

  // ───────────────────────── statystyki ─────────────────────────

  const STABLES = new Set(['usdt', 'usdc', 'dai', 'busd', 'tusd', 'fdusd', 'usde', 'usds', 'pyusd', 'usdd', 'eurc', 'eurs', 'gusd', 'frax', 'usdp', 'usd1']);

  // Zbiorcze statystyki portfela. market: { id: notowanie }, coins: (id) → { symbol, name }
  function portfolioStats(data, market, cur, rates, coinOf) {
    const p = portfolio(data.holdings, market);
    const rows = [];
    let cost = 0; let knownValue = 0; let pnl = 0; let realized = 0; let lotsCount = 0; let first = '';
    let prev1h = 0; let prev7d = 0; let have1h = 0; let have7d = 0; let stable = 0; let hhi = 0;
    const ids = new Set([...Object.keys(data.holdings), ...Object.keys(data.lots || {})]);
    for (const id of ids) {
      const m = (market || {})[id] || {};
      const st = positionStats((data.lots || {})[id], m.price, cur, rates);
      const item = p.items.find((i) => i.id === id);
      const share = item ? item.share : 0;
      const c = coinOf ? coinOf(id) : { symbol: id, name: id };
      realized += st.realized;
      lotsCount += st.count;
      if (st.firstDate && (!first || st.firstDate < first)) first = st.firstDate;
      if (!(st.total > 0)) { if (st.count) rows.push({ id, coin: c, closed: true, ...st, share: 0 }); continue; }
      if (st.pnl != null) { cost += st.cost; knownValue += st.knownQty * m.price; pnl += st.pnl; }
      if (st.value != null) {
        if (isFinite(m.change1h)) { prev1h += st.value / (1 + m.change1h / 100); have1h += st.value; }
        if (isFinite(m.change7d)) { prev7d += st.value / (1 + m.change7d / 100); have7d += st.value; }
        if (STABLES.has(String(c.symbol || '').toLowerCase())) stable += share;
        hhi += share * share;
      }
      rows.push({ id, coin: c, closed: false, ...st, share, price: m.price, change24h: m.change24h, change7d: m.change7d, athChange: m.athChange });
    }
    rows.sort((a, b) => (b.value || 0) - (a.value || 0));
    const open = rows.filter((r) => !r.closed && r.value != null);
    const by = (key, dir) => { const l = open.filter((r) => r[key] != null && isFinite(r[key])); return l.length ? l.reduce((a, b) => (dir * (b[key] - a[key]) > 0 ? b : a)) : null; };
    return {
      total: p.total,
      change24hValue: p.change24hValue,
      change24hPct: p.change24hPct,
      change1hPct: prev1h > 0 ? (have1h / prev1h - 1) * 100 : null,
      change7dPct: prev7d > 0 ? (have7d / prev7d - 1) * 100 : null,
      change7dValue: prev7d > 0 ? have7d - prev7d : null,
      cost,
      pnl: cost > 0 ? pnl : null,
      pnlPct: cost > 0 ? (pnl / cost) * 100 : null,
      costCoverage: p.total > 0 ? knownValue / p.total : 0, // jaka część portfela ma znaną cenę zakupu
      realized,
      lotsCount,
      firstDate: first,
      assets: open.length,
      largest: open[0] || null,
      stableShare: stable,
      effectiveAssets: hhi > 0 ? 1 / hhi : 0, // „efektywna liczba aktywów” (odwrotność indeksu koncentracji)
      best24h: by('change24h', 1), worst24h: by('change24h', -1),
      best7d: by('change7d', 1), worst7d: by('change7d', -1),
      bestPnl: by('pnlPct', 1), worstPnl: by('pnlPct', -1),
      rows
    };
  }

  // Segmenty wykresu kołowego: największe pozycje + „Inne”.
  function allocation(items, labelOf, max = 6) {
    const priced = (items || []).filter((i) => i.value != null && i.value > 0);
    const top = priced.slice(0, max).map((i) => ({ id: i.id, label: labelOf(i.id), value: i.value, share: i.share }));
    const rest = priced.slice(max);
    if (rest.length) top.push({ id: null, label: 'Inne', value: rest.reduce((s, i) => s + i.value, 0), share: rest.reduce((s, i) => s + i.share, 0) });
    return top;
  }

  // Wartość portfela w czasie przy obecnych ilościach. series: [{ amount, points: [[t, cena]] }]
  function combineHistory(series, n = 120) {
    const usable = (series || []).filter((s) => s.amount > 0 && s.points && s.points.length > 1);
    if (!usable.length) return [];
    const start = Math.max(...usable.map((s) => s.points[0][0]));
    const end = Math.min(...usable.map((s) => s.points[s.points.length - 1][0]));
    if (!(end > start)) return [];
    const out = [];
    const idx = usable.map(() => 0);
    for (let k = 0; k < n; k++) {
      const t = start + ((end - start) * k) / (n - 1);
      let v = 0;
      usable.forEach((s, j) => {
        const pts = s.points;
        while (idx[j] < pts.length - 2 && pts[idx[j] + 1][0] <= t) idx[j]++;
        const a = pts[idx[j]]; const b = pts[idx[j] + 1];
        const f = b[0] === a[0] ? 0 : Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0])));
        v += s.amount * (a[1] + (b[1] - a[1]) * f);
      });
      out.push([t, v]);
    }
    return out;
  }

  // Zmiana, skrajne wartości i największe obsunięcie (spadek od szczytu) w serii [[t, wartość]].
  function seriesStats(points) {
    if (!points || points.length < 2) return null;
    let min = points[0]; let max = points[0]; let peak = points[0][1]; let dd = 0;
    for (const p of points) {
      if (p[1] < min[1]) min = p;
      if (p[1] > max[1]) max = p;
      if (p[1] > peak) peak = p[1];
      if (peak > 0) dd = Math.min(dd, (p[1] / peak - 1) * 100);
    }
    const first = points[0][1]; const last = points[points.length - 1][1];
    return { changePct: first > 0 ? (last / first - 1) * 100 : null, changeValue: last - first, min, max, maxDrawdownPct: dd };
  }

  // ───────────────────────── eksport / import pliku ─────────────────────────

  const FILE_FORMAT = 2; // 2: ilość wynika z wpisów („lots”); pliki formatu 1 (z ilością „na sztywno”) nadal się importuje

  function buildExport(data, settings, now = new Date()) {
    return {
      app: 'CoinTracko',
      format: FILE_FORMAT,
      exportedAt: now.toISOString(),
      currency: settings && settings.market ? settings.market.currency : 'usd',
      watch: data.watch,
      holdings: data.holdings,
      lots: data.lots || {}
    };
  }

  function exportFileName(now = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `cointracko-portfel-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.json`;
  }

  // Czyta plik eksportu; rzuca zrozumiały błąd, gdy to nie jest plik CoinTracko.
  function parseImport(text) {
    let raw;
    try { raw = JSON.parse(String(text || '').replace(/^﻿/, '')); } catch (_) { throw new Error('To nie jest plik CoinTracko (nie udało się go odczytać jako JSON).'); }
    if (!raw || typeof raw !== 'object' || raw.app !== 'CoinTracko') throw new Error('To nie jest plik wyeksportowany z CoinTracko.');
    if (Number(raw.format) > FILE_FORMAT) throw new Error('Ten plik pochodzi z nowszej wersji CoinTracko – zaktualizuj aplikację.');
    const data = sanitizeData({ watch: raw.watch, holdings: raw.holdings, lots: raw.lots }); // alerty ręczne z dawnych plików są pomijane
    // każda posiadana moneta musi być na liście obserwowanych
    for (const id of Object.keys(data.holdings)) if (!data.watch.some((w) => w.id === id)) data.watch.push({ id, symbol: '', name: id, image: '' });
    return {
      data,
      exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
      currency: CURRENCIES[raw.currency] ? raw.currency : null,
      counts: { holdings: Object.keys(data.holdings).length, lots: Object.values(data.lots).reduce((n, l) => n + l.length, 0), watch: data.watch.length }
    };
  }

  // mode 'replace' – dane z pliku zastępują portfel; 'merge' – są dołączane (dla tych samych monet wpisy z pliku zastępują obecne)
  function mergeImport(current, incoming, mode) {
    if (mode === 'replace') return { ...current, watch: incoming.watch, holdings: holdingsFromLots(incoming.lots), lots: incoming.lots };
    const watch = [...current.watch];
    for (const w of incoming.watch) if (!watch.some((x) => x.id === w.id)) watch.push(w);
    const lots = { ...(current.lots || {}) };
    for (const [id, list] of Object.entries(incoming.lots)) lots[id] = list; // dla tych samych monet wpisy z pliku zastępują obecne
    return sanitizeData({ ...current, watch, holdings: {}, lots });
  }

  // ───────────────────────── kalkulator ─────────────────────────

  // Przelicza ilość między dwiema jednostkami o znanych cenach w tej samej walucie bazowej.
  // unitFrom / unitTo = cena 1 jednostki (np. 1 XRP = 2,3 PLN → 2,3; 1 PLN w PLN → 1).
  function convertAmount(amount, unitFrom, unitTo, reverse = false) {
    const a = Number(amount), f = Number(unitFrom), t = Number(unitTo);
    if (![a, f, t].every(isFinite) || f <= 0 || t <= 0) return NaN;
    return reverse ? (a * t) / f : (a * f) / t;
  }

  // Data „N lat temu” z tym samym dniem i miesiącem (29 lutego → 28 lutego w latach niewysokosnych), jako RRRR-MM-DD.
  function sameDayYearsAgo(years, now = new Date()) {
    const y = now.getFullYear() - years, m = now.getMonth(), d = now.getDate();
    const last = new Date(y, m + 1, 0).getDate();
    return `${y}-${String(m + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
  }

  function pickCoin(c) {
    return { id: c.id, symbol: String(c.symbol || '').toLowerCase(), name: c.name || c.id, image: c.image || c.large || c.thumb || '' };
  }

  // ───────────────────────── wykresy ─────────────────────────

  // Zmniejsza serię do maks. n punktów (zachowując pierwszy i ostatni).
  function downsample(points, n) {
    if (!points || points.length <= n) return points || [];
    const out = [];
    const step = (points.length - 1) / (n - 1);
    for (let i = 0; i < n; i++) out.push(points[Math.round(i * step)]);
    return out;
  }

  // „Ładne” podziałki osi (ok. count wartości między min a max).
  function niceTicks(min, max, count = 4) {
    if (!isFinite(min) || !isFinite(max)) return [];
    if (min === max) return [min];
    const span = max - min;
    const raw = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
    return ticks;
  }

  return {
    PALETTES, convertAmount, sameDayYearsAgo,
    isStable: (sym) => STABLES.has(String(sym || '').toLowerCase()),
    CURRENCIES, DEFAULT_SETTINGS, DEFAULT_DATA, STARTER_WATCH,
    deepMerge, sanitizeData, sanitizeSettings, pickSettingsPatch,
    fmtMoney, fmtAmount, fmtPct, parseAmount,
    portfolio,
    sanitizeLot, sortLots, lotsNet, lotsBalance, holdingsFromLots, convert, positionStats, lotResult, applyLots, newLot,
    portfolioStats, allocation, combineHistory, seriesStats,
    buildExport, exportFileName, parseImport, mergeImport,
    pickCoin,
    downsample, niceTicks
  };
});
