'use strict';
/* global UI, Core, Market, Charts, platform, icon, Remote, KVCache, Oracles, PriceHistory, Intel */
// Warstwa interfejsu dla: cen z wielu źródeł (oracle), długiej historii dziennej, wiadomości i anomalii.
// Ładowany przed app.js; korzysta z jego zmiennych globalnych (state, money, go, render…) dopiero w czasie działania.

const Svc = (() => {
  const remote = { json: (u, o) => Remote.json(u, o), text: (u, o) => Remote.text(u, o) };
  const cache = KVCache.default;
  return { cache, oracles: Oracles.create({ remote, cache }), history: PriceHistory.create({ remote, cache }), intel: Intel.create({ remote, cache }) };
})();

const DAY_MS = 86400000;
const ago = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return 'przed chwilą';
  if (s < 3600) return `${Math.round(s / 60)} min temu`;
  if (s < 86400) return `${Math.round(s / 3600)} godz. temu`;
  return `${Math.round(s / 86400)} dn. temu`;
};

// ───────────────────────── ceny z wielu źródeł ─────────────────────────

function oracleTargets(ids) {
  const out = [];
  for (const id of ids) {
    const c = coinInfo(id);
    if (c.symbol) out.push({ id, symbol: c.symbol });
    if (out.length >= 60) break;
  }
  return out;
}

// Zwraca obietnicę (nigdy nie odrzuconą) – awaria źródeł nie może blokować notowań.
function startOracles(ids) {
  const m = state.settings.market;
  const src = m.sources || {};
  if (!Object.keys(src).some((k) => k !== 'coingecko' && src[k] !== false)) return Promise.resolve(null);
  const fx = state.rates && state.rates[cur()];
  return Svc.oracles.fetchAll(oracleTargets(ids), { currency: cur(), enabled: src, fxFallback: fx || state.priceSrc.fx }).catch((e) => ({ byId: {}, errors: { all: e.message }, ok: [], fx: null, at: Date.now() }));
}

// Ustawia cenę konsensusową (jeśli zgodne są co najmniej dwa źródła) na świeżo pobranych notowaniach.
function applyOracles(res, ids) {
  const m = state.settings.market;
  if (res) state.priceSrc = { at: res.at, errors: res.errors || {}, ok: res.ok || [], fx: res.fx || state.priceSrc.fx };
  for (const id of ids) {
    const q = state.market[id];
    if (!q) continue;
    q.cgPrice = q.price;
    if (!res) continue; // bez świeżego porównania zostaje cena CoinGecko
    const entries = (res.byId[id] || []).slice();
    if (m.sources.coingecko !== false && q.price > 0) entries.push({ source: 'coingecko', price: q.price, ts: 0 });
    const cons = Oracles.consensus(entries, { tolerancePct: m.tolerancePct || 2 });
    state.consensus[id] = cons;
    if (m.useConsensus !== false && cons && cons.price > 0 && cons.inliers >= 2 && !cons.conflict) {
      q.price = cons.price;
      q.priceSource = 'consensus';
    }
  }
}

const CONF_LABEL = { high: 'wysoka zgodność', medium: 'średnia zgodność', low: 'niska zgodność', none: 'brak aktualnych danych' };
const CONF_CLASS = { high: 'green', medium: 'blue', low: 'orange', none: 'red' };

function priceSourcesCard(id) {
  const cons = state.consensus[id];
  const m = state.settings.market;
  const head = h('div', { class: 'card-title' }, iconEl('shield', 16), 'Źródła cen');
  const card = h('div', { class: 'card card-pad', style: { marginTop: '16px' } }, head);
  if (!cons) {
    const errs = Object.entries(state.priceSrc.errors || {});
    card.append(h('div', { class: 'muted' }, state.priceSrc.at ? 'Żadne ze źródeł nie podało ceny tej kryptowaluty.' : 'Porównuję ceny z oracle i giełd… (pierwsze porównanie pojawi się po najbliższym odświeżeniu).'),
      errs.length ? h('div', { class: 'group-footer' }, 'Niedostępne: ' + errs.map(([k, v]) => `${(Oracles.SOURCES[k] || { label: k }).label} (${v})`).join('; ')) : null);
    return card;
  }
  head.append(h('div', { class: 'spacer' }), h('span', { class: 'chip ' + CONF_CLASS[cons.confidence] }, CONF_LABEL[cons.confidence]));
  const rows = [...cons.entries].sort((a, b) => (a.kind === 'oracle' ? 0 : 1) - (b.kind === 'oracle' ? 0 : 1) || a.label.localeCompare(b.label));
  card.append(h('div', { style: { overflowX: 'auto' } }, h('table', { class: 'tbl src-tbl' },
    h('thead', null, h('tr', null, ['Źródło', 'Typ', 'Cena', 'Odchylenie', 'Aktualność', 'Status'].map((t, k) => h('th', { class: k > 1 ? 'r' : '' }, t)))),
    h('tbody', null, rows.map((e) => h('tr', { class: e.outlier || e.stale ? 'off' : '' },
      h('td', null, e.label), h('td', null, Oracles.KIND_LABEL[e.kind] || e.kind),
      h('td', { class: 'r num' }, money(e.price)),
      h('td', { class: 'r num ' + (e.outlier ? 'down' : '') }, e.devPct == null ? '—' : Core.fmtPct(e.devPct, 2)),
      h('td', { class: 'r' }, e.age == null ? 'na żywo' : e.age < 90000 ? 'przed chwilą' : ago(Date.now() - e.age)),
      h('td', { class: 'r' }, e.stale ? h('span', { class: 'chip orange' }, 'nieaktualne') : e.outlier ? h('span', { class: 'chip red' }, 'odrzucone') : h('span', { class: 'chip green' }, 'zgodne'))))))));
  const used = cons.price != null ? `Cena w aplikacji: ${money(cons.price)} — ${m.useConsensus !== false && cons.inliers >= 2 && !cons.conflict ? `średnia z ${cons.inliers} zgodnych źródeł` : 'za mało zgodnych źródeł, pokazuję cenę CoinGecko'}` : 'Brak aktualnej ceny ze źródeł.';
  const spread = cons.spreadPct != null && cons.inliers > 1 ? ` · rozrzut zgodnych źródeł ${cons.spreadPct.toFixed(2)}%` : '';
  card.append(h('p', { class: 'group-footer' }, used + spread + `. Źródło odbiegające od mediany o więcej niż ${m.tolerancePct || 2}% jest odrzucane, a oracle starsze niż jego okno aktualności pomijane.`));
  return card;
}

// ───────────────────────── historia dzienna ─────────────────────────

const HIST_RANGES = [{ value: 7, label: '7 dni' }, { value: 30, label: '30 dni' }, { value: 90, label: '90 dni' }, { value: 365, label: '1 rok' }, { value: 730, label: '2 lata' }, { value: 1095, label: '3 lata' }, { value: 1825, label: '5 lat' }, { value: 2200, label: '6 lat' }];

// punkty wykresu monety: do roku z CoinGecko (gęste), dłuższe z historii dziennej
async function coinChartPoints(id, days) {
  if (days <= 365) return Market.chart(id, cur(), days);
  const c = coinInfo(id);
  const r = await Svc.history.daily({ id, symbol: c.symbol }, cur(), 6);
  const from = Date.now() - days * DAY_MS;
  const pts = r.points.filter((p) => p[0] >= from);
  const q = state.market[id];
  if (q && q.price > 0) pts.push([Date.now(), q.price]);
  return pts;
}

function portfolioHistoryCard(p) {
  const box = h('div', { class: 'chart-box' });
  const readout = h('div', { class: 'chart-readout' });
  const facts = h('div', { class: 'kv-grid', style: { marginTop: '8px' } });
  const note = h('p', { class: 'group-footer' });
  let token = 0;
  const loaded = {}; // id → { points, source, approx }

  const draw = async () => {
    const my = ++token;
    const days = state.statsDays;
    const mode = state.histMode;
    if (chartHandle) { chartHandle.destroy(); chartHandle = null; }
    readout.textContent = ''; facts.replaceChildren();
    const ids = mode === 'lots' ? Object.keys(state.data.lots).filter((id) => (state.data.lots[id] || []).length) : p.items.filter((i) => i.amount > 0).map((i) => i.id);
    const todo = ids.filter((id) => !loaded[id]);
    let done = 0;
    const progress = () => box.replaceChildren(h('div', { class: 'center' }, spinner(18), todo.length ? `Pobieram dzienną historię cen… ${done}/${todo.length}` : 'Liczę wartość portfela…'));
    progress();
    const failed = [];
    const queue = [...todo];
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        try { loaded[id] = await Svc.history.daily({ id, symbol: coinInfo(id).symbol }, cur(), 6); } catch (_) { failed.push(id); }
        done++;
        if (my !== token || state.view !== 'stats') return;
        progress();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (my !== token || state.view !== 'stats') return;

    const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    const hist = {};
    for (const id of ids) if (loaded[id]) hist[id] = loaded[id].points;
    const res = PriceHistory.portfolioDaily({ lots: state.data.lots, amounts: state.data.holdings, histories: hist, mode, fromTs: today - days * DAY_MS, toTs: today });
    const pts = res.points.slice();
    if (p.total > 0 && pts.length) pts.push([Date.now(), p.total]);
    if (pts.length < 2) {
      box.replaceChildren(h('div', { class: 'center' }, h('div', null,
        failed.length === ids.length ? 'Nie udało się pobrać historii cen (brak połączenia lub źródło niedostępne).' : 'Za mało danych historycznych dla wybranego zakresu.',
        h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn', onclick: () => { failed.forEach((id) => delete loaded[id]); draw(); } }, iconEl('refresh', 14), 'Spróbuj ponownie')))));
      return;
    }
    const ss = Core.seriesStats(pts);
    const pct = (n, d) => (n == null ? '—' : Core.fmtPct(n, d));
    const setDefault = () => readout.replaceChildren('Zmiana w okresie ', h('b', { class: pctClass(ss.changePct) }, pct(ss.changePct)), ` (${signed(ss.changeValue)})`);
    const canvas = h('canvas', { role: 'img', 'aria-label': `Wartość portfela w czasie, zmiana ${pct(ss.changePct)}` });
    box.replaceChildren(canvas);
    chartHandle = Charts.priceChart(canvas, pts, { days, format: (v) => money(v, { compact: true }), onHover: (hv) => {
      if (!hv) { setDefault(); return; }
      const d = (hv.price / hv.base - 1) * 100;
      readout.replaceChildren(hv.label + ' · ', h('b', null, money(hv.price)), ' · ', h('span', { class: pctClass(d) }, pct(d)));
    } });
    setDefault();
    const dt = (t) => new Date(t).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' });
    const cell = (k, v, cls) => h('div', { class: 'kv' }, h('div', { class: 'k' }, k), h('div', { class: 'v ' + (cls || '') }, v));
    facts.replaceChildren(
      cell('Najwyższa wartość', `${money(ss.max[1])} · ${dt(ss.max[0])}`),
      cell('Najniższa wartość', `${money(ss.min[1])} · ${dt(ss.min[0])}`),
      cell('Największe obsunięcie', pct(ss.maxDrawdownPct), pctClass(ss.maxDrawdownPct)),
      cell('Dni w zakresie', String(res.points.length)));
    const names = (list) => list.map((id) => coinInfo(id).symbol || id).join(', ');
    const approx = Object.values(loaded).some((x) => x.approx);
    const srcs = [...new Set(Object.values(loaded).map((x) => (x.source === 'binance' ? 'Binance' : 'CryptoCompare')))].join(', ');
    note.textContent = (mode === 'lots'
      ? 'Wartość z wpisów: ilość posiadana danego dnia (kupna i sprzedaże z datami) × cena z tego dnia. Wpisy bez daty liczone są od początku zakresu. '
      : 'Dzisiejsze ilości przy dawnych cenach (bez dat zakupów). ')
      + `Rozdzielczość dzienna, ceny zamknięcia dnia (UTC), źródło: ${srcs || '—'}${approx ? ' (przybliżenie wg kursu USDT)' : ''}.`
      + (res.missing.length || failed.length ? ` Pominięto (brak historii): ${names([...res.missing, ...failed])}.` : '');
  };

  const modeSeg = segmented([{ value: 'lots', label: 'Wg wpisów' }, { value: 'current', label: 'Obecne ilości' }], state.histMode, (v) => { state.histMode = v; draw(); });
  const card = h('div', { class: 'card chart-card', style: { marginTop: '16px' } },
    h('div', { class: 'chart-top' }, h('div', { class: 'card-title', style: { margin: 0 } }, iconEl('chart', 16), 'Wartość portfela w czasie'), h('div', { class: 'spacer' }), modeSeg),
    h('div', { class: 'chart-top' }, segmented(HIST_RANGES, state.statsDays, (v) => { state.statsDays = v; draw(); }), h('div', { class: 'spacer' }), readout),
    box, facts, note);
  setTimeout(draw, 0);
  return card;
}

// ───────────────────────── wiadomości i anomalie ─────────────────────────

function intelCoins() {
  const owned = Object.keys(state.data.holdings);
  const rest = state.data.watch.map((w) => w.id).filter((id) => !owned.includes(id));
  return [...owned, ...rest].map((id) => ({ ...coinInfo(id), id })).filter((c) => c.name);
}

function marketAnomalyList() {
  const out = [];
  const fx = state.priceSrc.fx || (cur() === 'usd' ? 1 : null);
  for (const c of intelCoins()) {
    const q = state.market[c.id];
    if (!q) continue;
    const usdPrice = fx ? (q.cgPrice || q.price) / fx : null;
    out.push(...Intel.marketAnomalies(c, { change1h: q.change1h, change24h: q.change24h, volume: q.volume, marketCap: q.marketCap, usdPrice }, state.consensus[c.id], { stable: Core.isStable(c.symbol) }));
  }
  return out;
}

function anomalyList() {
  const out = [];
  for (const [coinId, list] of Object.entries(state.news.items)) {
    for (const it of list) if (it.anomaly && !it.anomaly.denied && it.anomaly.severity >= 3 && Date.now() - it.ts < 72 * 3600000) out.push({ ...it.anomaly, coinId, item: it });
  }
  out.push(...marketAnomalyList());
  return out.sort((a, b) => b.severity - a.severity || (b.item ? b.item.ts : Date.now()) - (a.item ? a.item.ts : Date.now()));
}

const hiAnomalies = () => anomalyList().filter((a) => a.severity >= 4);

async function refreshNews(manual) {
  const st = state.news;
  if (st.loading || !state.settings.intel || state.settings.intel.enabled === false) return;
  st.loading = true;
  if (state.view === 'alerts') softRender();
  try {
    const coins = intelCoins();
    if (!coins.length) { st.items = {}; st.at = Date.now(); return; }
    const res = await Svc.intel.fetchNews(coins, { limit: 12 });
    const first = !st.at && !(await Svc.cache.get('intel:seen'));
    st.items = res.items; st.at = res.at; st.errors = res.errors; st.feeds = res.feeds;
    await notifyAnomalies(first);
  } catch (e) {
    if (manual) errToast(e);
  } finally {
    st.loading = false;
    renderSidebar();
    if (state.view === 'alerts' || state.view === 'dashboard') softRender();
  }
}

// Powiadamia raz o każdej nowej, poważnej anomalii (pierwszy skan tylko zapamiętuje stan – bez lawiny powiadomień).
async function notifyAnomalies(first) {
  const set = state.settings.intel;
  const rec = (await Svc.cache.get('intel:seen')) || { keys: [], scanAt: 0 };
  const seen = new Set(rec.keys);
  const day = new Date().toISOString().slice(0, 10);
  const fresh = [];
  for (const a of anomalyList()) {
    if (a.severity < (set.minSeverity || 4)) continue;
    const key = a.item ? a.item.key : `m|${a.coinId}|${a.kind}|${day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(a);
  }
  await Svc.cache.set('intel:seen', { keys: [...seen].slice(-400), scanAt: Date.now() });
  if (first || platform.hosted || set.notify === false) return;
  for (const a of fresh.slice(0, 3)) {
    const c = coinInfo(a.coinId);
    const body = a.item ? `${a.item.title}${a.item.count > 1 ? ` (${a.item.count} serwisów)` : ''}` : a.detail;
    platform.notify(`Anomalia: ${c.name} — ${a.label}`, String(body).slice(0, 180)).catch(() => {});
  }
}

let intelTimer = null;
function startIntelLoop() {
  clearInterval(intelTimer);
  Svc.intel.last().then((r) => { if (r && !state.news.at) { state.news.items = r.items; state.news.at = r.at; } }).catch(() => {});
  if (platform.hosted) return; // okno aplikacji skanuje w tle; podgląd w przeglądarce pobiera na żądanie
  setTimeout(() => refreshNews(), 6000);
  intelTimer = setInterval(() => refreshNews(), 20 * 60000);
}

const SEV_LABEL = { 5: 'krytyczna', 4: 'wysoka', 3: 'podwyższona', 2: 'niska', 1: 'niska' };
const sevClass = (n) => (n >= 5 ? 'red' : n >= 4 ? 'red' : n >= 3 ? 'orange' : 'blue');

function newsItemEl(it) {
  const c = coinInfo(it.coinId);
  const tone = it.tone;
  return h('div', { class: 'news-item click', role: 'link', tabindex: '0', onclick: () => platform.openExternal(it.link), onkeydown: (e) => { if (e.key === 'Enter') platform.openExternal(it.link); } },
    h('div', { class: 'news-tone ' + tone, title: tone === 'bullish' ? 'Wiadomość pozytywna (bullish)' : tone === 'bearish' ? 'Wiadomość negatywna (bearish)' : 'Neutralna' }, iconEl(tone === 'bullish' ? 'arrowUp' : tone === 'bearish' ? 'arrowDown' : 'minus', 15)),
    h('div', { class: 'grow' },
      h('div', { class: 'news-title' }, it.title),
      h('div', { class: 'news-meta' }, [String(c.symbol || c.name).toUpperCase(), it.source, ago(it.ts), it.count > 1 ? `${it.count} serwisów` : null].filter(Boolean).join(' · '),
        it.anomaly ? h('span', { class: 'chip ' + sevClass(it.anomaly.severity), style: { marginLeft: '8px' } }, it.anomaly.label + (it.anomaly.rumor ? ' · plotka' : '') + (it.anomaly.spreading ? ' · rozprzestrzenia się' : '')) : null)));
}

function viewNews() {
  const st = state.news;
  const set = state.settings.intel || { enabled: true };
  const page = h('div', { class: 'page' }, offlineBanner());
  const head = h('div', { class: 'toolbar' }, h('h1', null, 'Alerty'), h('div', { class: 'spacer' }),
    st.at ? h('span', { class: 'muted', style: { marginRight: '8px' } }, 'Zaktualizowano ' + ago(st.at)) : null,
    h('button', { class: 'btn', disabled: st.loading || set.enabled === false, onclick: () => refreshNews(true) }, st.loading ? spinner(13) : iconEl('refresh', 14), st.loading ? 'Szukam…' : 'Szukaj teraz'));
  if (set.enabled === false) {
    page.append(h('div', { class: 'card onboard' }, h('div', { class: 'ob-ic', html: icon('news', 30) }), h('h2', null, 'Wyszukiwanie alertów jest wyłączone'),
      h('p', null, 'Aplikacja może sprawdzać w internecie wiadomości o aktywach z portfela i ostrzegać o anomaliach: włamaniach, nadużyciach, problemach z płynnością czy siecią.'),
      h('div', { class: 'acts' }, h('button', { class: 'btn primary lg', onclick: async () => { await saveSettings({ intel: { enabled: true } }, true); refreshNews(true); render(); } }, 'Włącz'))));
    return h('div', null, head, page);
  }
  if (!intelCoins().length) {
    page.append(h('div', { class: 'card onboard' }, h('div', { class: 'ob-ic', html: icon('news', 30) }), h('h2', null, 'Dodaj aktywa, aby śledzić alerty'),
      h('p', null, 'Wiadomości, sygnały i ostrzeżenia są szukane dla kryptowalut z Twoich aktywów i listy obserwowanych.'),
      h('div', { class: 'acts' }, h('button', { class: 'btn primary lg', onclick: () => go('dashboard') }, 'Przejdź do pulpitu'))));
    return h('div', null, head, page);
  }
  if (!st.at && !st.loading) setTimeout(() => refreshNews(), 0);

  // anomalie
  const anomalies = anomalyList();
  const aCard = h('div', { class: 'card card-pad' }, h('div', { class: 'card-title' }, iconEl('warn', 16), 'Ostrzeżenia i anomalie', h('div', { class: 'spacer' }), anomalies.length ? h('span', { class: 'chip ' + sevClass(anomalies[0].severity) }, anomalies.length) : null));
  if (!anomalies.length) aCard.append(h('div', { class: 'muted' }, st.at ? 'Nie wykryto niepokojących sygnałów w nagłówkach ani w danych rynkowych.' : 'Szukam…'));
  else aCard.append(h('div', { class: 'facts' }, anomalies.slice(0, 12).map((a) => {
    const c = coinInfo(a.coinId);
    return h('div', { class: 'fact anomaly' + (a.item ? ' click' : ''), onclick: a.item ? () => platform.openExternal(a.item.link) : () => go('coin', { id: a.coinId }) },
      h('span', { class: 'chip ' + sevClass(a.severity), title: 'Waga: ' + SEV_LABEL[a.severity] }, 'waga ' + a.severity),
      h('div', { class: 'grow' }, h('div', { class: 'f-k' }, `${c.name} — ${a.label}${a.item && a.item.anomaly.rumor ? ' (niepotwierdzone)' : ''}`),
        h('div', { class: 'row-hint' }, a.item ? `${a.item.title} · ${a.item.source}${a.item.count > 1 ? ` i ${a.item.count - 1} inne` : ''} · ${ago(a.item.ts)}` : a.detail + ' · dane rynkowe')));
  })));

  // ton wiadomości
  const sentRows = intelCoins().map((c) => ({ c, s: Intel.sentiment(st.items[c.id] || []) })).filter((x) => (st.items[x.c.id] || []).length);
  const sCard = h('div', { class: 'card card-pad' }, h('div', { class: 'card-title' }, iconEl('chart', 16), 'Sygnały – ton wiadomości (7 dni)'));
  if (!sentRows.length) sCard.append(h('div', { class: 'muted' }, st.at ? 'Brak świeżych wiadomości o Twoich aktywach.' : 'Szukam…'));
  else sCard.append(h('div', { class: 'facts' }, sentRows.map(({ c, s }) => h('div', { class: 'fact click', onclick: () => { st.coin = c.id; render(true); } },
    coinIcon(c, 'sm'), h('div', { class: 'grow' }, h('div', { class: 'f-k' }, c.name), h('div', { class: 'row-hint' }, s.label)),
    h('span', { class: 'chip green' }, '▲ ' + s.bullish), h('span', { class: 'chip red' }, '▼ ' + s.bearish)))));
  page.append(h('div', { class: 'two-col' }, aCard, sCard));

  // lista
  const all = Object.values(st.items).flat().filter((i) => !st.coin || i.coinId === st.coin).sort((a, b) => b.ts - a.ts);
  const filters = [{ value: 'all', label: 'Wszystkie' }, { value: 'bullish', label: 'Pozytywne' }, { value: 'bearish', label: 'Negatywne' }, { value: 'anomaly', label: 'Anomalie' }];
  const shown = all.filter((i) => st.filter === 'all' || (st.filter === 'anomaly' ? i.anomaly : i.tone === st.filter)).slice(0, 80);
  page.append(h('div', { class: 'section-head' }, h('h2', null, 'Wiadomości'), h('div', { class: 'spacer' }),
    select([{ value: '', label: 'Wszystkie aktywa' }, ...intelCoins().map((c) => ({ value: c.id, label: c.name }))], st.coin, (v) => { st.coin = v; render(true); }),
    segmented(filters, st.filter, (v) => { st.filter = v; render(true); })));
  page.append(h('div', { class: 'card' }, shown.length ? shown.map(newsItemEl) : h('div', { class: 'muted', style: { padding: '18px' } }, st.loading ? 'Szukam wiadomości…' : 'Brak doniesień w tej kategorii.')));
  page.append(h('p', { class: 'group-footer' }, `Źródła: Google News oraz kanały CoinDesk, Cointelegraph, Decrypt i The Block${st.feeds != null && st.feeds < 4 ? ` (dostępnych teraz: ${st.feeds}/4)` : ''}. Ton (bullish/bearish) i anomalie są ustalane automatycznie po słowach kluczowych w nagłówkach — to pomoc w przeglądzie, nie ocena prawdziwości ani porada inwestycyjna. Plotki oznaczone jako „niepotwierdzone” zweryfikuj w oryginalnym źródle; sygnał rośnie, gdy ten sam temat podaje wiele niezależnych serwisów.`));
  return h('div', null, head, page);
}


// ───────────────────────── kalkulator ─────────────────────────
// Przelicza ilość kryptowaluty na PLN/USD/EUR lub inną kryptowalutę – w obie strony (wpisz dowolną stronę).
// Tryb „Kurs z dnia” pokazuje, ile dana ilość kosztowała w wybranym dniu (cena zamknięcia dnia UTC, historia do 6 lat i starsza).
const CALC_FIAT = [{ id: 'pln', label: 'PLN – złoty' }, { id: 'usd', label: 'USD – dolar' }, { id: 'eur', label: 'EUR – euro' }];
const calcKey = (a) => (a.k === 'fiat' ? 'f:' : 'c:') + a.id;
let calcToken = 0;

function calcInit() {
  if (state.calc) return state.calc;
  const first = Object.keys(state.data.holdings)[0] || (state.data.watch[0] && state.data.watch[0].id) || 'bitcoin';
  state.calc = { from: { k: 'coin', id: first }, to: { k: 'fiat', id: 'pln' }, fromAmt: '1', toAmt: '', driver: 'from', mode: 'now', date: Core.sameDayYearsAgo(1), extra: [] };
  return state.calc;
}

function calcCoinList() {
  const c = calcInit();
  const ids = [];
  for (const id of [...Object.keys(state.data.holdings), ...state.data.watch.map((w) => w.id), ...c.extra, c.from.k === 'coin' ? c.from.id : null, c.to.k === 'coin' ? c.to.id : null]) if (id && !ids.includes(id)) ids.push(id);
  return ids.map((id) => coinInfo(id));
}

// Cena 1 jednostki w walucie bazowej `pivot` ('pln' | 'usd' | 'eur'); dla dnia `iso` – cena zamknięcia z historii.
async function calcUnit(asset, pivot, iso) {
  if (asset.k === 'fiat') {
    if (asset.id === pivot) return { price: 1 };
    const r = state.rates;
    if (!r || !r[pivot] || !r[asset.id]) throw new Error('Brak kursów walut – spróbuj ponownie za chwilę.');
    return { price: r[pivot] / r[asset.id] };
  }
  if (iso) {
    const r = await Svc.history.priceOn(coinInfo(asset.id), pivot, iso);
    return { price: r.price, approx: r.approx, source: r.source, date: r.date };
  }
  let q = state.market[asset.id];
  if (!q || !isFinite(q.price)) {
    const got = await Market.quotes([asset.id], cur());
    for (const x of got) state.market[x.id] = x;
    q = state.market[asset.id];
  }
  if (!q || !isFinite(q.price)) throw new Error('Brak aktualnej ceny tej kryptowaluty.');
  if (pivot === cur()) return { price: q.price };
  const r = state.rates;
  if (!r || !r[pivot] || !r[cur()]) throw new Error('Brak kursów walut – spróbuj ponownie za chwilę.');
  return { price: q.price * r[pivot] / r[cur()] };
}

function calcFmt(v, asset) {
  if (!isFinite(v)) return '';
  const digits = asset.k === 'fiat' ? 2 : Math.abs(v) >= 1000 ? 2 : Math.abs(v) >= 1 ? 6 : 10;
  return v.toLocaleString('pl-PL', { useGrouping: false, maximumFractionDigits: digits });
}

function viewCalc() {
  const c = calcInit();
  const assetOptions = () => [
    ...CALC_FIAT.map((f) => ({ value: 'f:' + f.id, label: f.label })),
    ...calcCoinList().map((x) => ({ value: 'c:' + x.id, label: `${x.name}${x.symbol ? ' (' + String(x.symbol).toUpperCase() + ')' : ''}` })),
    { value: '__pick', label: 'Inna kryptowaluta…' }
  ];
  const parseKey = (v) => (v.startsWith('f:') ? { k: 'fiat', id: v.slice(2) } : { k: 'coin', id: v.slice(2) });
  const label = (a) => (a.k === 'fiat' ? a.id.toUpperCase() : String(coinInfo(a.id).symbol || a.id).toUpperCase());

  const info = h('div', { class: 'calc-info' });
  const fromIn = h('input', { class: 'input calc-num', inputmode: 'decimal', value: c.fromAmt, 'aria-label': 'Ilość', placeholder: '0', oninput: (e) => { c.fromAmt = e.target.value; c.driver = 'from'; recalc(); } });
  const toIn = h('input', { class: 'input calc-num', inputmode: 'decimal', value: c.toAmt, 'aria-label': 'Wynik', placeholder: '0', oninput: (e) => { c.toAmt = e.target.value; c.driver = 'to'; recalc(); } });

  const assetSelect = (side) => {
    const sel = select(assetOptions(), calcKey(c[side]), (v) => {
      if (v === '__pick') { sel.value = calcKey(c[side]); pickCoin({ title: 'Wybierz kryptowalutę', onPick: (coin) => { addCalcCoin(coin); c[side] = { k: 'coin', id: coin.id }; render(true); } }); return; }
      c[side] = parseKey(v);
      if (c.from.k === 'fiat' && c.to.k === 'fiat' && c.from.id === c.to.id) c[side === 'from' ? 'to' : 'from'] = { k: 'coin', id: calcCoinList()[0].id };
      render(true);
    }, { 'aria-label': side === 'from' ? 'Przelicz z' : 'Przelicz na' });
    return sel;
  };
  const addCalcCoin = (coin) => {
    if (!state.data.watch.some((w) => w.id === coin.id) && !c.extra.includes(coin.id)) c.extra.push(coin.id);
    state.market[coin.id] = state.market[coin.id] || { id: coin.id, name: coin.name, symbol: coin.symbol, image: coin.image };
  };

  const dateRow = h('div', { class: 'calc-date' });
  if (c.mode === 'date') {
    dateRow.append(
      h('input', { class: 'input', type: 'date', max: todayIso(), value: c.date, 'aria-label': 'Data', onchange: (e) => { if (e.target.value) { c.date = e.target.value; recalc(); } } }),
      h('div', { class: 'calc-quick' }, [1, 2, 3, 5, 6].map((y) => h('button', { class: 'btn sm' + (c.date === Core.sameDayYearsAgo(y) ? ' primary' : ''), onclick: () => { c.date = Core.sameDayYearsAgo(y); render(true); } }, y === 1 ? '1 rok temu' : y < 5 ? `${y} lata temu` : `${y} lat temu`))));
  }

  async function recalc() {
    const my = ++calcToken;
    const useDate = c.mode === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(c.date);
    if (c.from.k === 'fiat' && c.to.k === 'fiat') { /* tylko kursy bieżące */ }
    const pivot = c.from.k === 'fiat' ? c.from.id : c.to.k === 'fiat' ? c.to.id : cur();
    const dated = useDate && !(c.from.k === 'fiat' && c.to.k === 'fiat');
    info.replaceChildren(h('div', { class: 'analyzing' }, spinner(14), dated ? 'Pobieram cenę z wybranego dnia…' : 'Przeliczam…'));
    try {
      if (!state.rates && (pivot !== cur() || (c.from.k === 'fiat' && c.to.k === 'fiat') || c.from.k === 'fiat' || c.to.k === 'fiat')) { try { state.rates = await Market.rates(); } catch (_) { /* błąd zgłosi calcUnit */ } }
      const iso = dated ? c.date : null;
      const [uf, ut] = await Promise.all([calcUnit(c.from, pivot, iso), calcUnit(c.to, pivot, iso)]);
      if (my !== calcToken) return;
      const driverFrom = c.driver !== 'to';
      const amt = Core.parseAmount(driverFrom ? c.fromAmt : c.toAmt);
      const out = isFinite(amt) ? Core.convertAmount(amt, uf.price, ut.price, !driverFrom) : NaN;
      if (driverFrom) { c.toAmt = calcFmt(out, c.to); toIn.value = c.toAmt; } else { c.fromAmt = calcFmt(out, c.from); fromIn.value = c.fromAmt; }
      const rate = Core.convertAmount(1, uf.price, ut.price);
      const bits = [h('div', { class: 'calc-rate' }, `1 ${label(c.from)} = `, h('b', null, `${calcFmt(rate, c.to)} ${label(c.to)}`), dated ? ` (${dateStr(c.date)})` : '')];
      if (dated) {
        const approx = uf.approx || ut.approx;
        const src = uf.source || ut.source;
        bits.push(h('div', { class: 'row-hint' }, `Cena zamknięcia dnia (UTC)${src ? ' · ' + (Oracles.SOURCES[src] ? Oracles.SOURCES[src].label : src) : ''}${approx ? ' · wartość przybliżona (zapasowe źródło danych)' : ''}.`));
        // porównanie z dniem dzisiejszym
        try {
          const [nf, nt] = await Promise.all([calcUnit(c.from, pivot, null), calcUnit(c.to, pivot, null)]);
          if (my !== calcToken) return;
          const fromAmount = Core.parseAmount(c.fromAmt);
          if (isFinite(fromAmount) && fromAmount > 0 && isFinite(out)) {
            const nowOut = Core.convertAmount(fromAmount, nf.price, nt.price);
            const diff = (nowOut / Core.parseAmount(c.toAmt) - 1) * 100;
            if (isFinite(diff)) bits.push(h('div', { class: 'calc-today' }, 'Dziś ta sama ilość to ', h('b', null, `${calcFmt(nowOut, c.to)} ${label(c.to)}`), ' ', h('span', { class: 'chip ' + (diff >= 0 ? 'green' : 'red') }, Core.fmtPct(diff, 1))));
          }
        } catch (_) { /* porównanie jest dodatkiem */ }
      } else {
        bits.push(h('div', { class: 'row-hint' }, c.from.k === 'fiat' && c.to.k === 'fiat' ? 'Kursy walut z Coinbase.' : 'Aktualne ceny z wielu źródeł (patrz Ustawienia → Źródła cen).'));
      }
      info.replaceChildren(...bits);
    } catch (e) {
      if (my !== calcToken) return;
      info.replaceChildren(h('div', { class: 'calc-err' }, iconEl('warn', 15), e.message || String(e)));
    }
  }

  setTimeout(recalc, 0);
  state.onQuotes = () => { renderSidebar(); if (c.mode === 'now' && !(document.activeElement && document.activeElement.closest('.calc-card'))) recalc(); };

  const swap = () => { const t = c.from; c.from = c.to; c.to = t; const a = c.fromAmt; c.fromAmt = c.toAmt; c.toAmt = a; c.driver = c.driver === 'to' ? 'from' : 'to'; render(true); };

  return h('div', null,
    h('div', { class: 'toolbar' }, h('h1', null, 'Kalkulator')),
    h('div', { class: 'page' }, offlineBanner(),
      h('div', { class: 'card card-pad calc-card' },
        h('div', { class: 'calc-line' }, h('div', { class: 'field' }, h('label', null, 'Mam'), fromIn), h('div', { class: 'field calc-asset' }, h('label', null, 'Jednostka'), assetSelect('from'))),
        h('div', { class: 'calc-swap' }, h('button', { class: 'icon-btn', title: 'Zamień strony', 'aria-label': 'Zamień strony', onclick: swap, html: icon('swap', 18) })),
        h('div', { class: 'calc-line' }, h('div', { class: 'field' }, h('label', null, 'Otrzymam'), toIn), h('div', { class: 'field calc-asset' }, h('label', null, 'Jednostka'), assetSelect('to'))),
        h('div', { class: 'calc-mode' }, segmented([{ value: 'now', label: 'Kurs aktualny' }, { value: 'date', label: 'Kurs z dnia' }], c.mode, (v) => { c.mode = v; render(true); })),
        dateRow,
        info),
      h('p', { class: 'group-footer' }, 'Wpisz ilość w dowolnym polu – drugie przeliczy się samo, w obie strony. W trybie „Kurs z dnia” ten sam dzień i miesiąc sprzed lat wybierzesz jednym kliknięciem; używana jest cena zamknięcia dnia (UTC), więc godzina w ciągu doby nie ma znaczenia. Wyceny historyczne mają charakter informacyjny.')));
}

// ───────────────────────── odświeżanie przeciągnięciem (Android / dotyk) ─────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wymuszona aktualizacja wszystkiego: notowania (z pominięciem pamięci podręcznej), ceny z oracle, kursy walut, ranking i wiadomości.
async function forceRefresh() {
  for (let i = 0; i < 100 && refreshing; i++) await sleep(150); // poczekaj na trwające odświeżanie
  try { Market.clearCache(); } catch (_) { /* brak pamięci podręcznej */ }
  Remote.forceFresh(25000); // zapytania z tej aktualizacji omijają pamięć podręczną
  state.rates = null;
  state.top = null;
  state.conn.lastUpdate = 0;
  const news = (state.settings.intel || {}).enabled === false ? Promise.resolve() : refreshNews(true).catch(() => {});
  await Promise.all([refresh(true), news]);
}

function initPullToRefresh() {
  const content = document.getElementById('content');
  if (!content || content.dataset.ptr) return;
  content.dataset.ptr = '1';
  const el = h('div', { class: 'ptr', 'aria-hidden': 'true', html: icon('refresh', 20) });
  document.body.appendChild(el);
  const TRIGGER = 70, MAX = 110;
  let startY = 0, startX = 0, pull = 0, active = false, busyNow = false;

  const topOffset = () => Math.max(0, content.getBoundingClientRect().top);
  const reset = () => { el.className = 'ptr'; el.style.transform = ''; active = false; pull = 0; };

  content.addEventListener('touchstart', (e) => {
    if (busyNow || e.touches.length !== 1 || content.scrollTop > 0 || document.querySelector('.sheet-overlay')) { active = false; return; }
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, .chart-card canvas, .chart-box')) { active = false; return; }
    startY = e.touches[0].clientY; startX = e.touches[0].clientX; pull = 0; active = true;
    el.style.setProperty('--ptr-top', topOffset() + 'px');
  }, { passive: true });

  content.addEventListener('touchmove', (e) => {
    if (!active) return;
    const dy = e.touches[0].clientY - startY;
    const dx = Math.abs(e.touches[0].clientX - startX);
    if (dy <= 0 || content.scrollTop > 0 || dx > dy) { if (pull) reset(); active = dy > 0 && content.scrollTop <= 0 && dx <= dy; return; }
    if (e.cancelable) e.preventDefault();
    pull = Math.min(MAX, dy * 0.55);
    el.className = 'ptr pulling';
    el.style.transform = `translateY(${topOffset() + pull - 44}px)`;
    el.firstChild.style.transform = `rotate(${pull * 4}deg)`;
    el.style.opacity = String(Math.min(1, pull / 40));
  }, { passive: false });

  const end = async () => {
    if (!active) return;
    active = false;
    el.firstChild.style.transform = '';
    el.style.opacity = '';
    if (pull < TRIGGER) { reset(); return; }
    busyNow = true;
    el.style.transform = '';
    el.className = 'ptr loading';
    if (navigator.vibrate) try { navigator.vibrate(12); } catch (_) { /* brak wibracji */ }
    const started = Date.now();
    try {
      await forceRefresh();
      if (state.conn.status === 'live') toast('Zaktualizowano wszystkie dane', 'success', 1800);
    } catch (e) { errToast(e); }
    await sleep(Math.max(0, 700 - (Date.now() - started))); // krótka animacja nawet przy szybkim łączu
    el.className = 'ptr done';
    await sleep(320);
    reset();
    busyNow = false;
  };
  content.addEventListener('touchend', end, { passive: true });
  content.addEventListener('touchcancel', () => { if (!busyNow) reset(); }, { passive: true });
}

// ostrzeżenie na pulpicie
function anomalyBanner() {
  const hi = hiAnomalies();
  if (!hi.length) return null;
  const a = hi[0];
  const c = coinInfo(a.coinId);
  return h('div', { class: 'offline-banner warn-banner', role: 'button', onclick: () => go('alerts') }, iconEl('warn', 18),
    h('div', { style: { flex: 1 } }, h('b', null, `${c.name}: ${a.label}`), a.item ? ` — ${a.item.title}` : ` — ${a.detail}`, hi.length > 1 ? ` (+${hi.length - 1} inne)` : ''),
    h('button', { class: 'btn sm' }, 'Szczegóły'));
}

// ───────────────────────── ustawienia: źródła i wiadomości ─────────────────────────

function settingsSources() {
  const s = state.settings;
  const m = s.market;
  const names = { pyth: 'Oracle on-chain/off-chain – ceny od wydawców danych (giełdy, market makerzy)', redstone: 'Oracle z podpisanymi danymi od niezależnych dostawców', chainlink: 'Oracle w sieci Ethereum – odczyt z kontraktu (BTC, ETH i inne główne pary)', cryptocompare: 'Indeks ważony z wielu giełd', coinbase: 'Cena giełdowa Coinbase', binance: 'Cena giełdowa Binance (para z USDT)', coingecko: 'Agregator – bywa opóźniony lub błędny przy mniej płynnych tokenach' };
  const sourceRows = Object.keys(Oracles.SOURCES).map((k) => row(Oracles.SOURCES[k].label, toggle(m.sources[k] !== false, async (v) => { await saveSettings({ market: { sources: { [k]: v } } }, true); state.conn.lastUpdate = 0; refresh(true); }),
    { icon: Oracles.SOURCES[k].kind === 'oracle' ? 'shield' : 'globe', color: Oracles.SOURCES[k].kind === 'oracle' ? 'var(--green)' : 'var(--accent)', hint: names[k] }));
  const ints = s.intel || {};
  return h('div', null,
    group('Wycena', [
      row('Cena ze zgodnych źródeł', toggle(m.useConsensus !== false, async (v) => { await saveSettings({ market: { useConsensus: v } }, true); refresh(true); }), { icon: 'shield', color: 'var(--green)', hint: 'Cena w aplikacji (portfel, alerty, wykresy bieżące) to średnia ze źródeł zgodnych ze sobą. Gdy wyłączone, używana jest wyłącznie cena CoinGecko; porównanie nadal jest widoczne przy każdej kryptowalucie.' }),
      row('Tolerancja zgodności', select([{ value: '1', label: '±1%' }, { value: '2', label: '±2%' }, { value: '3', label: '±3%' }, { value: '5', label: '±5%' }], String(m.tolerancePct || 2), async (v) => { await saveSettings({ market: { tolerancePct: Number(v) } }, true); refresh(true); }), { icon: 'cpu', color: 'var(--orange)', hint: 'Źródło odbiegające od mediany o więcej niż tyle procent jest odrzucane z średniej i oznaczane jako podejrzane.' })
    ], 'Cenę uznajemy za wiarygodną, gdy zgadzają się co najmniej dwa źródła; najwyższa pewność — trzy źródła, w tym dwa oracle.'),
    group('Źródła cen', sourceRows, 'Oracle: Pyth Network, RedStone, Chainlink. Każde włączone źródło to dodatkowe zapytania co odświeżenie; wyłącz te, których nie potrzebujesz.'),
    group('Alerty: wiadomości, sygnały i ostrzeżenia', [
      row('Wyszukuj wiadomości', toggle(ints.enabled !== false, async (v) => { await saveSettings({ intel: { enabled: v } }, true); if (v) refreshNews(true); render(true); }), { icon: 'news', color: 'var(--indigo)', hint: 'Co 20 minut aplikacja sprawdza nagłówki o aktywach z portfela i ocenia ton oraz anomalie.' }),
      row('Powiadamiaj o anomaliach', toggle(ints.notify !== false, async (v) => { await saveSettings({ intel: { notify: v } }, true); if (v && platform.requestNotifications) platform.requestNotifications(); }), { icon: 'bell', color: 'var(--red)', hint: 'Powiadomienie systemowe o nowej, poważnej anomalii (raz na temat).' }),
      row('Próg powiadomień', select([{ value: '3', label: 'od wagi 3 (podwyższona)' }, { value: '4', label: 'od wagi 4 (wysoka)' }, { value: '5', label: 'tylko waga 5 (krytyczna)' }], String(ints.minSeverity || 4), (v) => saveSettings({ intel: { minSeverity: Number(v) } }, true)), { icon: 'flag', color: 'var(--orange)' })
    ]),
    group('Pamięć podręczna', [
      row('Historia cen i wiadomości', h('button', { class: 'btn', onclick: async () => { await Svc.cache.clear(); state.news = { ...state.news, items: {}, at: 0 }; toast('Wyczyszczono pamięć podręczną', 'success', 1800); } }, 'Wyczyść'), { icon: 'trash', color: 'var(--red)', hint: 'Dzienna historia cen (do 6 lat) jest zapisywana lokalnie, by nie pobierać jej za każdym razem.' })
    ]));
}
