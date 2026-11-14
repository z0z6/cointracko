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

  const DEFAULT_SETTINGS = {
    ui: { theme: 'system' }, // 'system' | 'light' | 'dark'
    market: { currency: 'usd', refreshSec: 60, cgKey: '' },
    window: { closeAction: 'tray' }, // 'tray' – chowaj do zasobnika, 'minimize' – minimalizuj na pasek zadań, 'quit' – zakończ
    alerts: { notifications: true },
    import: { method: 'auto' }, // 'auto' | 'claude' | 'ocr'
    ai: {
      provider: 'claude-code', // 'claude-code' (konto Claude, tylko komputer) | 'api' (klucz API)
      model: 'sonnet',
      apiModel: 'claude-sonnet-5-5',
      claudePath: ''
    }
  };

  const DEFAULT_DATA = {
    watch: [], // [{ id, symbol, name, image }]
    holdings: {}, // { id: ilość }
    alerts: [], // [{ id, coinId, type, value, currency, repeat, active, armed, lastTriggered }]
    alertLog: [], // [{ at, coinId, title, body }]
    hints: {}
  };

  const STARTER_WATCH = [
    { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', image: '' },
    { id: 'ethereum', symbol: 'eth', name: 'Ethereum', image: '' },
    { id: 'solana', symbol: 'sol', name: 'Solana', image: '' },
    { id: 'binancecoin', symbol: 'bnb', name: 'BNB', image: '' },
    { id: 'ripple', symbol: 'xrp', name: 'XRP', image: '' }
  ];

  function deepMerge(base, extra) {
    if (Array.isArray(base)) return Array.isArray(extra) ? extra : base;
    if (base && typeof base === 'object') {
      const out = { ...base };
      if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
        for (const k of Object.keys(extra)) out[k] = k in base ? deepMerge(base[k], extra[k]) : extra[k];
      }
      return out;
    }
    return extra === undefined ? base : extra;
  }

  // Porządkuje dane użytkownika wczytane z dysku (odporność na uszkodzony lub stary plik).
  function sanitizeData(raw) {
    const d = raw && typeof raw === 'object' ? raw : {};
    const watch = (Array.isArray(d.watch) ? d.watch : []).filter((w) => w && typeof w.id === 'string' && w.id)
      .map((w) => ({ id: w.id, symbol: String(w.symbol || ''), name: String(w.name || w.id), image: String(w.image || '') }));
    const seen = new Set();
    const uniq = watch.filter((w) => (seen.has(w.id) ? false : seen.add(w.id)));
    const holdings = {};
    for (const [id, v] of Object.entries(d.holdings && typeof d.holdings === 'object' ? d.holdings : {})) {
      const n = Number(v);
      if (isFinite(n) && n > 0) holdings[id] = n;
    }
    const alerts = (Array.isArray(d.alerts) ? d.alerts : []).filter((a) => a && a.coinId && ALERT_TYPES[a.type] && isFinite(Number(a.value)))
      .map((a) => ({ ...a, value: Number(a.value), active: a.active !== false, repeat: !!a.repeat }));
    return {
      watch: uniq,
      holdings,
      alerts,
      alertLog: (Array.isArray(d.alertLog) ? d.alertLog : []).slice(0, 100),
      hints: d.hints && typeof d.hints === 'object' ? d.hints : {}
    };
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

  // rows: [{ id, amount }], mode: 'replace' (ustaw ilość) | 'add' (dodaj do posiadanych)
  function mergeHoldings(holdings, rows, mode = 'replace') {
    const out = { ...(holdings || {}) };
    for (const r of rows || []) {
      if (!r || !r.id || !(r.amount > 0)) continue;
      out[r.id] = mode === 'add' ? (out[r.id] || 0) + r.amount : r.amount;
    }
    return out;
  }

  // ───────────────────────── alerty ─────────────────────────

  const ALERT_TYPES = {
    above: { label: 'Cena wzrośnie powyżej', unit: 'price' },
    below: { label: 'Cena spadnie poniżej', unit: 'price' },
    changeUp: { label: 'Wzrost w 24 h o co najmniej', unit: 'pct' },
    changeDown: { label: 'Spadek w 24 h o co najmniej', unit: 'pct' }
  };

  function alertCondition(alert, m) {
    if (!m || !isFinite(m.price)) return null;
    const v = Number(alert.value);
    if (!isFinite(v)) return null;
    switch (alert.type) {
      case 'above': return m.price >= v;
      case 'below': return m.price <= v;
      case 'changeUp': return isFinite(m.change24h) ? m.change24h >= Math.abs(v) : null;
      case 'changeDown': return isFinite(m.change24h) ? m.change24h <= -Math.abs(v) : null;
      default: return null;
    }
  }

  // Sprawdza alerty na aktualnych notowaniach. Zwraca nową listę alertów i te, które właśnie się uruchomiły.
  // Alert jednorazowy po uruchomieniu wyłącza się; powtarzalny uzbraja się ponownie, gdy warunek przestanie być spełniony.
  // Alert cenowy dotyczy waluty, w której został ustawiony – przy innej walucie notowań jest pomijany.
  function evaluateAlerts(alerts, market, cur, now = Date.now()) {
    const fired = [];
    let changed = false;
    const next = (alerts || []).map((a) => {
      if (!a.active) return a;
      const unit = (ALERT_TYPES[a.type] || {}).unit;
      if (unit === 'price' && a.currency && a.currency !== cur) return a;
      const m = (market || {})[a.coinId];
      const cond = alertCondition(a, m);
      if (cond == null) return a;
      const armed = a.armed !== false;
      if (cond && armed) {
        const upd = { ...a, lastTriggered: now, lastPrice: m.price, armed: false };
        if (!a.repeat) upd.active = false;
        fired.push({ alert: upd, price: m.price, change24h: m.change24h });
        changed = true;
        return upd;
      }
      if (!cond && !armed) { changed = true; return { ...a, armed: true }; }
      return a;
    });
    return { alerts: next, fired, changed };
  }

  function alertSummary(alert, cur) {
    const t = ALERT_TYPES[alert.type];
    if (!t) return '';
    const v = t.unit === 'price' ? fmtMoney(Number(alert.value), alert.currency || cur) : fmtPct(Math.abs(Number(alert.value)), 1).replace(/^[+−]/, '');
    return `${t.label} ${v}`;
  }

  function alertMessage(fire, coin, cur) {
    const a = fire.alert;
    const name = coin ? `${coin.name} (${String(coin.symbol || '').toUpperCase()})` : a.coinId;
    const price = fmtMoney(fire.price, cur);
    const title = {
      above: `${name} powyżej ${fmtMoney(Number(a.value), a.currency || cur)}`,
      below: `${name} poniżej ${fmtMoney(Number(a.value), a.currency || cur)}`,
      changeUp: `${name}: ${fmtPct(fire.change24h)} w 24 h`,
      changeDown: `${name}: ${fmtPct(fire.change24h)} w 24 h`
    }[a.type] || name;
    return { title, body: `Aktualna cena: ${price}` + (isFinite(fire.change24h) ? ` (${fmtPct(fire.change24h)} w 24 h)` : '') };
  }

  // ───────────────────────── import ze zrzutu ekranu ─────────────────────────

  const HOLDINGS_SYSTEM = `Jesteś asystentem, który dokładnie odczytuje zrzuty ekranu z giełd i portfeli kryptowalut (Binance, Coinbase, Kraken, Bybit, MetaMask, Trust Wallet, Ledger Live, Revolut, Zonda itp.).
Twoje zadanie: wypisać każdy widoczny token wraz z POSIADANĄ ILOŚCIĄ (liczbą jednostek tokena).
Zasady:
- Ilość to liczba tokenów, a NIE wartość w walucie (USD/PLN/EUR/USDT). Jeśli w wierszu są obie liczby, wybierz liczbę jednostek tokena (zwykle stoi przy symbolu albo bez znaku waluty).
- Zachowaj pełną precyzję liczby. Zwracaj liczbę JSON z kropką dziesiętną, bez separatorów tysięcy (np. 1234.5678).
- Symbol podawaj wielkimi literami (np. BTC, ETH, SOL). Jeśli widać pełną nazwę, podaj ją w polu "name".
- Nie zgaduj: gdy ilości nie da się odczytać, ustaw "amount": null i opisz problem w "note".
- Pomiń pozycje z zerową ilością, waluty tradycyjne (USD, EUR, PLN) i elementy interfejsu.`;

  const HOLDINGS_PROMPT = `Odczytaj z tego zrzutu ekranu listę posiadanych kryptowalut.
Zwróć WYŁĄCZNIE obiekt JSON w bloku \`\`\`json o strukturze:
{
  "holdings": [
    { "symbol": "BTC", "name": "Bitcoin", "amount": 0.1234, "valueShown": "7 512,40 USD lub null", "note": "" }
  ],
  "warnings": ["krótkie uwagi o jakości zrzutu lub wątpliwościach"]
}`;

  // Porządkuje odpowiedź modelu (nie ufamy formatowi).
  function normalizeAiRows(json) {
    const list = Array.isArray(json) ? json : json && Array.isArray(json.holdings) ? json.holdings : [];
    const rows = [];
    for (const r of list) {
      if (!r || typeof r !== 'object') continue;
      const symbol = String(r.symbol || r.ticker || '').trim().toUpperCase().replace(/[^A-Z0-9.$]/g, '').slice(0, 12);
      const name = String(r.name || '').trim().slice(0, 60);
      if (!symbol && !name) continue;
      const amount = parseAmount(r.amount);
      rows.push({ symbol, name, amount: isFinite(amount) && amount > 0 ? amount : null, note: String(r.note || '').slice(0, 140) });
    }
    const warnings = json && Array.isArray(json.warnings) ? json.warnings.map((w) => String(w).slice(0, 200)).slice(0, 5) : [];
    return { rows: dedupeRows(rows), warnings };
  }

  function dedupeRows(rows) {
    const seen = new Map();
    for (const r of rows) {
      const key = r.symbol || r.name.toLowerCase();
      if (!seen.has(key)) seen.set(key, r);
      else if (seen.get(key).amount == null && r.amount != null) seen.set(key, r);
    }
    return [...seen.values()];
  }

  // Słowa wyglądające jak symbole, które nie są tokenami w kontekście zrzutu z portfela.
  const STOP = new Set(['USD', 'EUR', 'PLN', 'GBP', 'CHF', 'JPY', 'APR', 'APY', 'PNL', 'ROI', 'ALL', 'BUY', 'SELL', 'SEND', 'SWAP', 'EARN', 'SPOT', 'COIN', 'COINS', 'TOTAL', 'ASSET', 'ASSETS',
    'TOKEN', 'TOKENS', 'NFT', 'NFTS', 'MAX', 'MIN', 'NEW', 'HOT', 'TOP', 'PRO', 'VIP', 'FAQ', 'KYC', 'OTC', 'P2P', 'API', 'APP', 'WEB', 'THE', 'AND', 'FOR', 'YOU', 'YOUR', 'NOW', 'DAY', 'PM', 'AM',
    'ID', 'OK', 'ON', 'OFF', 'IN', 'OUT', 'UP', 'TO', 'OF', 'AT', 'BY', 'IS', 'IT', 'GO', 'ME', 'MY', 'NO', 'PAY', 'CARD', 'CASH', 'BANK', 'FIAT', 'HOME', 'MORE', 'DEFI', 'WEB3', 'GAS', 'FEE', 'FEES',
    'LTE', 'WIFI', 'GSM', 'H', 'D', 'W', 'M', 'Y', 'K', 'B', 'T', 'X', 'USDⓈ']);

  const NUM_RE = /(?<![A-Za-z0-9])([$€£]?)\s?(\d{1,3}(?:[  .,']\d{3})+(?:[.,]\d+)?(?!\d)|\d+(?:[.,]\d+)?)\s?(%|k\b|K\b|M\b|mln\b)?(?:\s?(zł|PLN|USDT|USDC|USD|EUR|[$€](?!\s?\d)))?/g;

  function lineNumbers(line) {
    const out = [];
    let m;
    NUM_RE.lastIndex = 0;
    while ((m = NUM_RE.exec(line))) {
      const [raw, pre, digits, suffix, post] = m;
      const fiat = !!pre || !!post;
      const value = parseAmount(digits + (suffix && suffix !== '%' ? suffix : ''));
      if (!isFinite(value)) continue;
      out.push({ value, fiat, pct: suffix === '%', index: m.index, end: m.index + raw.length, raw, post: post || '' });
    }
    return out;
  }

  // Buduje indeks symboli/nazw z listy monet (kolejność = ranking kapitalizacji; pierwszy wygrywa).
  function coinIndex(coins) {
    const bySymbol = new Map();
    const byName = new Map();
    for (const c of coins || []) {
      const s = String(c.symbol || '').toUpperCase();
      if (s && !bySymbol.has(s)) bySymbol.set(s, c);
      const n = String(c.name || '').toLowerCase();
      if (n && !byName.has(n)) byName.set(n, c);
    }
    return { bySymbol, byName };
  }

  // Heurystyczne czytanie tekstu z OCR: w każdym wierszu szukamy symbolu/nazwy tokena i liczby jednostek.
  function parseOcrText(text, coins) {
    const idx = coinIndex(coins);
    const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/[|¦]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const found = [];
    const names = [...idx.byName.keys()].filter((n) => n.length >= 4).sort((a, b) => b.length - a.length);

    const findCoin = (line) => {
      // 1) symbol wielkimi literami (np. BTC, 1INCH, USDT)
      const tokens = line.match(/[A-Z0-9$]{2,10}/g) || [];
      for (const t of tokens) {
        const sym = t.replace(/^\$/, '');
        if (!/[A-Z]/.test(sym) || STOP.has(sym)) continue;
        const pos = line.indexOf(t);
        const before = line[pos - 1];
        const after = line[pos + t.length];
        if ((before && /[A-Za-z0-9]/.test(before)) || (after && /[a-z]/.test(after))) continue;
        if (idx.bySymbol.has(sym)) return { coin: idx.bySymbol.get(sym), symbol: sym, pos, len: t.length, bySymbol: true };
      }
      // 2) pełna nazwa (np. Bitcoin, Ethereum)
      const low = line.toLowerCase();
      for (const n of names) {
        const p = low.indexOf(n);
        if (p < 0) continue;
        const b = low[p - 1];
        const a = low[p + n.length];
        if ((b && /[a-z0-9]/.test(b)) || (a && /[a-z0-9]/.test(a))) continue;
        const c = idx.byName.get(n);
        return { coin: c, symbol: String(c.symbol || '').toUpperCase(), pos: p, len: n.length, bySymbol: false };
      }
      return null;
    };

    const pickAmount = (nums, hit) => {
      const usable = nums.filter((n) => !n.pct && !n.fiat && n.value > 0);
      if (!usable.length) return null;
      if (hit) {
        // liczba tuż przed symbolem („0.5 BTC”) albo tuż po nim („BTC 0.5”)
        const adjacentBefore = usable.find((n) => hit.pos - n.end >= 0 && hit.pos - n.end <= 2);
        if (adjacentBefore) return adjacentBefore.value;
      }
      return usable[0].value;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const hit = findCoin(line);
      if (!hit) continue;
      // usuń sam symbol z wiersza, żeby cyfry w symbolu (np. 1INCH) nie były liczbą
      const rest = line.slice(0, hit.pos) + ' '.repeat(hit.len) + line.slice(hit.pos + hit.len);
      let amount = pickAmount(lineNumbers(rest), hit);
      if (amount == null && i + 1 < lines.length && !findCoin(lines[i + 1])) amount = pickAmount(lineNumbers(lines[i + 1]), null);
      // układ dwuwierszowy („SYMBOL ilość” nad „Nazwa wartość”), gdy symbolu w wierszu wyżej nie udało się odczytać
      if (amount == null && !hit.bySymbol && i > 0 && !findCoin(lines[i - 1])) amount = pickAmount(lineNumbers(lines[i - 1]), null);
      found.push({ symbol: hit.symbol, name: hit.coin.name || '', amount, note: '', coin: hit.coin, line });
    }
    return dedupeRows(found);
  }

  // Dopasowuje odczytane wiersze do monet z listy (symbol → najwyższa kapitalizacja, potem nazwa).
  function matchRows(rows, coins) {
    const idx = coinIndex(coins);
    return (rows || []).map((r) => {
      let coin = r.coin || null;
      const byName = r.name ? idx.byName.get(r.name.toLowerCase()) : null;
      const bySym = r.symbol ? idx.bySymbol.get(r.symbol.toUpperCase()) : null;
      if (!coin) {
        // nazwa i symbol zgodne → pewne; sama nazwa jest pewniejsza niż sam symbol (symbole się powtarzają)
        if (byName && (!r.symbol || String(byName.symbol).toUpperCase() === r.symbol.toUpperCase())) coin = byName;
        else coin = bySym || byName || null;
      }
      return { symbol: r.symbol, name: r.name, amount: r.amount, note: r.note || '', coin: coin ? pickCoin(coin) : null };
    });
  }

  function pickCoin(c) {
    return { id: c.id, symbol: String(c.symbol || '').toLowerCase(), name: c.name || c.id, image: c.image || c.large || c.thumb || '' };
  }

  // Wyciąga JSON z odpowiedzi modelu (blok ```json lub pierwszy obiekt w tekście).
  function extractJson(text) {
    if (!text) throw new Error('Pusta odpowiedź modelu.');
    const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
    for (const t of [...blocks.reverse(), text]) {
      try { return JSON.parse(t.trim()); } catch (_) { /* dalej */ }
      const starts = [t.indexOf('{'), t.indexOf('[')].filter((x) => x >= 0);
      if (!starts.length) continue;
      const s = Math.min(...starts);
      const e = t.lastIndexOf(t[s] === '{' ? '}' : ']');
      if (e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch (_) { /* dalej */ } }
    }
    throw new Error('Nie udało się odczytać odpowiedzi modelu jako JSON.');
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
    CURRENCIES, ALERT_TYPES, HOLDINGS_SYSTEM, HOLDINGS_PROMPT, DEFAULT_SETTINGS, DEFAULT_DATA, STARTER_WATCH,
    deepMerge, sanitizeData,
    fmtMoney, fmtAmount, fmtPct, parseAmount,
    portfolio, mergeHoldings,
    alertCondition, evaluateAlerts, alertSummary, alertMessage,
    normalizeAiRows, parseOcrText, matchRows, pickCoin, extractJson, lineNumbers,
    downsample, niceTicks
  };
});
