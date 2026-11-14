'use strict';
/* global UI, Core, Market, Charts, Ocr, platform, icon */
const { h, iconEl, toast, sheet, toggle, segmented, select, spinner, group, row, busy } = UI;

const state = {
  info: null,
  settings: null,
  data: null,
  hasApiKey: false,
  claudePath: null,
  view: 'dashboard',
  backTo: 'dashboard',
  coinId: null,
  market: {}, // id → notowanie
  top: null, // ranking (pierwsza strona)
  topError: null,
  conn: { status: 'connecting', lastUpdate: 0, error: '' },
  marketTab: 'watch',
  marketQuery: '',
  chartDays: 7,
  settingsTab: 'general',
  claude: { status: null, login: null, installing: false, log: '', advanced: false },
  onQuotes: null
};

const ALLOC_COLORS = ['#0a84ff', '#30d158', '#ff9f0a', '#bf5af2', '#ff453a', '#64d2ff', '#ffd60a', '#8e8e93'];
const cur = () => state.settings.market.currency;
const money = (v, opts) => Core.fmtMoney(v, cur(), opts);
const pctClass = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
const timeStr = (t) => new Date(t).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateTimeStr = (t) => new Date(t).toLocaleString('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function errToast(e) { toast(e.message || String(e), 'error', 7000); }

// ───────────────────────── start ─────────────────────────
async function init() {
  state.info = await platform.info();
  document.body.classList.add('platform-' + state.info.platform);
  if (state.info.mock && window.installMarketMock) window.installMarketMock();
  const s = await platform.load();
  state.settings = s.settings;
  state.data = s.data;
  state.hasApiKey = s.hasApiKey;
  state.claudePath = s.claudePath;
  Market.setKey(state.settings.market.cgKey);
  if (!state.data.hints.seeded) {
    state.data.hints.seeded = true;
    if (!state.data.watch.length) state.data.watch = Core.STARTER_WATCH.map((w) => ({ ...w }));
    saveData();
  }

  document.querySelectorAll('#traffic .tl').forEach((b) => b.addEventListener('click', async () => {
    const maximized = await platform.windowControl(b.dataset.act);
    if (b.dataset.act === 'maximize') setMaxTitle(maximized);
  }));
  platform.on('window:state', (st) => setMaxTitle(st.maximized));
  document.querySelector('.titlebar').addEventListener('dblclick', async (e) => { if (!e.target.closest('.traffic')) setMaxTitle(await platform.windowControl('maximize')); });
  window.addEventListener('blur', () => document.body.classList.add('window-blur'));
  window.addEventListener('focus', () => document.body.classList.remove('window-blur'));
  document.getElementById('content').addEventListener('scroll', (e) => e.target.classList.toggle('scrolled', e.target.scrollTop > 4));

  platform.on('app:refresh', () => refresh(true));
  platform.on('app:shown', () => { if (Date.now() - state.conn.lastUpdate > 20000) refresh(); });
  platform.on('claude:log', (t) => { state.claude.log = (state.claude.log + t).slice(-4000); const el = document.querySelector('.acc-log'); if (el) el.textContent = state.claude.log.split('\n').slice(-6).join('\n'); });
  platform.on('claude:login', (ev) => {
    const C = state.claude;
    if (ev.stage === 'url' || ev.stage === 'code') { C.login = { ...(C.login || {}), stage: ev.stage, url: ev.url || (C.login && C.login.url) }; if (state.view === 'settings') render(); }
    if (ev.stage === 'done') { C.login = null; C.status = ev.status; toast('Połączono z kontem Claude', 'success'); render(); }
    if (ev.stage === 'error') { C.login = null; errToast(new Error(ev.error)); render(); }
  });
  window.addEventListener('online', () => refresh(true));
  window.addEventListener('offline', () => { state.conn = { ...state.conn, status: 'offline', error: 'Brak połączenia z internetem.' }; renderSidebar(); });
  document.addEventListener('paste', onPaste);
  window.onAppBack = onBack;

  render();
  refresh(); // po uruchomieniu od razu łączymy się z siecią i pobieramy notowania
  if (platform.claude && state.settings.ai.provider === 'claude-code') refreshClaude();
}

function setMaxTitle(maximized) {
  const b = document.querySelector('#traffic .tl.max');
  if (b) b.title = maximized ? 'Przywróć' : 'Maksymalizuj';
}

let saveTimer = null;
function saveData() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => platform.saveData(state.data).catch(errToast), 250);
}

async function saveSettings(patch, quiet) {
  try {
    state.settings = await platform.saveSettings(patch);
    if (!quiet) toast('Zapisano ustawienia', 'success', 1600);
  } catch (e) { errToast(e); }
}

// ───────────────────────── notowania na żywo ─────────────────────────
let refreshing = false;
let refreshTimer = null;
let failures = 0;

function trackedIds() {
  const ids = new Set(state.data.watch.map((w) => w.id));
  Object.keys(state.data.holdings).forEach((id) => ids.add(id));
  state.data.alerts.forEach((a) => ids.add(a.coinId));
  if (state.view === 'coin' && state.coinId) ids.add(state.coinId);
  return [...ids];
}

async function refresh(manual) {
  if (refreshing) return;
  refreshing = true;
  clearTimeout(refreshTimer);
  const before = state.conn.status;
  state.conn = { ...state.conn, status: before === 'live' ? 'busy' : 'connecting' };
  renderSidebar();
  try {
    const ids = trackedIds();
    const quotes = await Market.quotes(ids, cur());
    for (const q of quotes) state.market[q.id] = q;
    // uzupełnij ikony i nazwy obserwowanych (np. po dodaniu z wyszukiwarki lub ze zrzutu)
    let touched = false;
    for (const w of state.data.watch) {
      const q = state.market[w.id];
      if (q && (w.image !== q.image || w.name !== q.name || w.symbol !== q.symbol)) { w.image = q.image || w.image; w.name = q.name; w.symbol = q.symbol; touched = true; }
    }
    if (touched) saveData();
    if (state.top && state.view === 'market' && state.marketTab === 'top') { try { state.top = await Market.top(cur(), 1, { ttl: 45000 }); } catch (_) { /* zostaje poprzedni ranking */ } }
    failures = 0;
    state.conn = { status: 'live', lastUpdate: Date.now(), error: '' };
    checkAlerts();
    updateTray();
    if (manual === true && before === 'offline') toast('Połączono – notowania są aktualne', 'success', 2200);
    afterQuotes();
  } catch (e) {
    failures++;
    state.conn = { ...state.conn, status: 'offline', error: e.message || String(e) };
    if (manual === true) errToast(e);
    if (state.view === 'dashboard' && !document.querySelector('.offline-banner')) softRender(); else renderSidebar();
  } finally {
    refreshing = false;
    const base = Math.max(20, Number(state.settings.market.refreshSec) || 60);
    const delay = failures ? Math.min(base, 5 * Math.pow(2, Math.min(failures, 4))) : base;
    state.conn.nextAt = Date.now() + delay * 1000;
    refreshTimer = setTimeout(() => refresh(), delay * 1000);
  }
}

function afterQuotes() {
  if (state.onQuotes) { renderSidebar(); state.onQuotes(); return; }
  softRender();
}

// Odświeża widok po nowych notowaniach, ale nie przerywa pisania w polu formularza.
function softRender() {
  const a = document.activeElement;
  if (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.closest('#content')) { renderSidebar(); return; }
  render(true);
}

function updateTray() {
  const p = Core.portfolio(state.data.holdings, state.market);
  platform.setTrayInfo(p.total > 0 ? `CoinTracko — portfel ${money(p.total)} (${Core.fmtPct(p.change24hPct)} w 24 h)` : 'CoinTracko').catch(() => {});
}

function checkAlerts() {
  const res = Core.evaluateAlerts(state.data.alerts, state.market, cur());
  if (!res.changed) return;
  state.data.alerts = res.alerts;
  for (const f of res.fired) {
    const coin = coinInfo(f.alert.coinId);
    const msg = Core.alertMessage(f, coin, cur());
    state.data.alertLog.unshift({ at: Date.now(), coinId: f.alert.coinId, title: msg.title, body: msg.body });
    toast(`${msg.title}. ${msg.body}`, 'info', 9000);
    if (state.settings.alerts.notifications) platform.notify(msg.title, msg.body).catch(() => {});
  }
  state.data.alertLog = state.data.alertLog.slice(0, 100);
  saveData();
}

// ───────────────────────── pomocnicze: monety ─────────────────────────
function coinInfo(id) {
  const q = state.market[id];
  const w = state.data.watch.find((x) => x.id === id);
  const t = state.top && state.top.find((x) => x.id === id);
  const src = q || t || w;
  if (!src) return { id, name: id, symbol: '', image: '' };
  return { id, name: src.name, symbol: src.symbol, image: src.image || (w && w.image) || '' };
}

function coinIcon(c, cls) {
  const ph = () => h('span', { class: 'c-ic ph ' + (cls || '') }, String(c.symbol || c.name || '?').slice(0, 3));
  if (!c.image) return ph();
  const img = h('img', { class: 'c-ic ' + (cls || ''), src: c.image, alt: '', loading: 'lazy', draggable: 'false' });
  img.addEventListener('error', () => img.replaceWith(ph()));
  return img;
}

function coinCell(c, extra) {
  return h('div', { class: 'c-coin' }, coinIcon(c),
    h('div', { style: { minWidth: 0 } }, h('div', { class: 'c-name' }, c.name), h('div', { class: 'c-sym' }, c.symbol, extra ? ' · ' + extra : '')));
}

function pctEl(n, cls) { return h('div', { class: (cls || 'c-pct') + ' ' + pctClass(n) }, Core.fmtPct(n)); }
function pctChip(n, suffix) { return h('span', { class: 'pct-chip ' + pctClass(n) }, Core.fmtPct(n), suffix ? ' ' + suffix : ''); }

const isWatched = (id) => state.data.watch.some((w) => w.id === id);

function addWatch(c, quiet) {
  if (isWatched(c.id)) return false;
  state.data.watch.push(Core.pickCoin(c));
  saveData();
  if (!quiet) toast(`${c.name} dodano do obserwowanych`, 'success', 2000);
  return true;
}

function removeWatch(id) {
  const c = coinInfo(id);
  state.data.watch = state.data.watch.filter((w) => w.id !== id);
  saveData();
  toast(`${c.name} usunięto z obserwowanych`, 'info', 2000);
}

function toggleWatch(c) {
  if (isWatched(c.id)) removeWatch(c.id); else { addWatch(c); refresh(); }
  render(true);
}

function setHolding(id, amount) {
  if (amount > 0) {
    state.data.holdings[id] = amount;
    if (!isWatched(id)) addWatch(coinInfo(id), true);
  } else delete state.data.holdings[id];
  saveData();
  updateTray();
}

// ───────────────────────── nawigacja ─────────────────────────
function go(view, opts = {}) {
  if (view === 'coin') {
    if (state.view !== 'coin') state.backTo = state.view;
    state.coinId = opts.id;
  }
  state.view = view;
  render();
  document.getElementById('content').scrollTop = 0;
  if (view === 'coin' && !state.market[opts.id]) refresh();
}

function onBack() {
  const overlays = document.querySelectorAll('.sheet-overlay');
  if (overlays.length) { const b = overlays[overlays.length - 1].querySelector('.sheet-head .icon-btn'); if (b) b.click(); return true; }
  if (state.view === 'coin') { go(state.backTo || 'dashboard'); return true; }
  if (state.view !== 'dashboard') { go('dashboard'); return true; }
  return false;
}

function renderSidebar() {
  const sb = document.getElementById('sidebar');
  const active = state.data.alerts.filter((a) => a.active).length;
  const items = [
    ['dashboard', 'home', 'Pulpit'],
    ['market', 'chart', 'Rynek'],
    ['portfolio', 'wallet', 'Portfel'],
    ['alerts', 'bell', 'Alerty', active || null]
  ];
  const cv = state.view === 'coin' ? state.backTo : state.view;
  const c = state.conn;
  const dot = c.status === 'live' ? '' : c.status === 'offline' ? 'err' : 'busy';
  const t1 = c.status === 'live' ? 'Notowania na żywo' : c.status === 'busy' ? 'Aktualizuję…' : c.status === 'offline' ? 'Brak połączenia' : 'Łączę z siecią…';
  const t2 = c.status === 'offline' ? 'Ponawiam automatycznie' : c.lastUpdate ? 'Aktualizacja ' + timeStr(c.lastUpdate) : 'Pobieram notowania';
  sb.replaceChildren(
    h('div', { class: 'brand' },
      h('div', { class: 'brand-logo', html: icon('coins', 20) }),
      h('div', null, h('div', { class: 'brand-name' }, 'CoinTracko'), h('div', { class: 'brand-sub' }, 'Kryptowaluty na żywo'))),
    h('div', { class: 'nav-section' }, 'Notowania'),
    ...items.map(([v, ic, label, badge]) => h('div', { class: 'nav-item' + (cv === v ? ' active' : ''), role: 'button', onclick: () => go(v) },
      h('span', { html: icon(ic, 17) }), label, badge ? h('span', { class: 'nav-badge' }, badge) : null)),
    h('div', { class: 'nav-section' }, 'Aplikacja'),
    h('div', { class: 'nav-item' + (cv === 'settings' ? ' active' : ''), role: 'button', onclick: () => go('settings') }, h('span', { html: icon('gear', 17) }), 'Ustawienia'),
    h('div', { class: 'sidebar-spacer' }),
    h('button', { class: 'agent-pill pill-btn', title: c.error || 'Kliknij, aby odświeżyć notowania teraz', onclick: () => refresh(true) },
      h('span', { class: 'agent-dot ' + dot }),
      h('div', { style: { minWidth: 0 } }, h('div', { class: 't1' }, t1), h('div', { class: 't2' }, t2)))
  );
}

let chartHandle = null;
function render(keepScroll) {
  renderSidebar();
  const c = document.getElementById('content');
  const top = c.scrollTop;
  if (chartHandle) { chartHandle.destroy(); chartHandle = null; }
  state.onQuotes = null;
  const views = { dashboard: viewDashboard, market: viewMarket, portfolio: viewPortfolio, alerts: viewAlerts, settings: viewSettings, coin: viewCoin };
  const el = (views[state.view] || viewDashboard)();
  if (!keepScroll) el.classList.add('fade-in');
  c.replaceChildren(el);
  if (keepScroll) c.scrollTop = top;
  const titles = { dashboard: 'Pulpit', market: 'Rynek', portfolio: 'Portfel', alerts: 'Alerty', settings: 'Ustawienia', coin: coinInfo(state.coinId).name };
  document.getElementById('window-title').textContent = titles[state.view] + ' — CoinTracko';
}

function offlineBanner() {
  if (state.conn.status !== 'offline') return null;
  return h('div', { class: 'offline-banner' }, iconEl('wifi', 18),
    h('div', { style: { flex: 1 } }, state.conn.error || 'Brak połączenia.', state.conn.lastUpdate ? ` Pokazuję dane z ${timeStr(state.conn.lastUpdate)}.` : ''),
    h('button', { class: 'btn sm', onclick: () => refresh(true) }, 'Spróbuj teraz'));
}

// ───────────────────────── wiersze list ─────────────────────────
function marketRow(c, opts = {}) {
  const q = state.market[c.id] || c;
  const watched = isWatched(c.id);
  return h('div', { class: 'coin-row click', onclick: () => go('coin', { id: c.id }) },
    opts.rank ? h('div', { class: 'c-rank' }, q.rank || '') : null,
    coinCell({ id: c.id, name: q.name || c.name, symbol: q.symbol || c.symbol, image: q.image || c.image }),
    h('div', { class: 'c-spark' }, q.spark ? Charts.sparkline(q.spark) : null),
    h('div', { class: 'c-price' }, money(q.price)),
    pctEl(q.change24h),
    opts.cap ? h('div', { class: 'c-cap' }, money(q.marketCap, { compact: true })) : null,
    h('div', { class: 'c-act' },
      h('button', { class: 'icon-btn' + (watched ? ' on' : ''), title: watched ? 'Usuń z obserwowanych' : 'Dodaj do obserwowanych', 'aria-label': watched ? 'Usuń z obserwowanych' : 'Dodaj do obserwowanych',
        onclick: (e) => { e.stopPropagation(); toggleWatch({ ...c, ...q }); }, html: icon('star', 16) })));
}

function marketHead(opts = {}) {
  return h('div', { class: 'coin-head' },
    opts.rank ? h('div', { class: 'c-rank' }, '#') : null,
    h('div', { class: 'c-coin' }, 'Kryptowaluta'),
    h('div', { class: 'c-spark' }, '7 dni'),
    h('div', { class: 'c-price' }, 'Cena'),
    h('div', { class: 'c-pct' }, '24 h'),
    opts.cap ? h('div', { class: 'c-cap' }, 'Kapitalizacja') : null,
    h('div', { class: 'c-act' }));
}

// ───────────────────────── pulpit ─────────────────────────
function viewDashboard() {
  const p = Core.portfolio(state.data.holdings, state.market);
  const hasHoldings = Object.keys(state.data.holdings).length > 0;
  const loading = !state.conn.lastUpdate && state.conn.status !== 'offline';
  const page = h('div', { class: 'page' }, offlineBanner());

  if (hasHoldings) {
    const top = p.items.filter((i) => i.value != null).slice(0, 6);
    const rest = p.items.filter((i) => i.value != null).slice(6).reduce((s, i) => s + i.share, 0);
    const segs = top.map((i, k) => ({ label: (coinInfo(i.id).symbol || i.id).toUpperCase(), share: i.share, color: ALLOC_COLORS[k] }));
    if (rest > 0.0005) segs.push({ label: 'Inne', share: rest, color: ALLOC_COLORS[7] });
    page.append(h('div', { class: 'card total' },
      h('div', { class: 'total-main' },
        h('div', { class: 'total-label' }, 'Wartość portfela'),
        h('div', { class: 'total-value' }, loading ? '…' : money(p.total)),
        loading ? null : h('div', { class: 'total-change' }, pctChip(p.change24hPct),
          h('span', { class: pctClass(p.change24hValue) }, (p.change24hValue > 0 ? '+' : '') + money(p.change24hValue)), h('span', { class: 'muted' }, 'w ciągu 24 h'))),
      h('div', { class: 'total-side' },
        h('div', { class: 'alloc', role: 'img', 'aria-label': 'Struktura portfela' }, segs.map((s) => h('div', { style: { width: (s.share * 100).toFixed(2) + '%', background: s.color }, title: `${s.label} ${Core.fmtPct(s.share * 100, 1).replace('+', '')}` }))),
        h('div', { class: 'alloc-legend' }, segs.map((s) => h('span', null, h('i', { class: 'sw', style: { background: s.color } }), h('b', null, s.label), Core.fmtPct(s.share * 100, 1).replace('+', '')))))));

    page.append(h('div', { class: 'section-head' }, h('h2', null, 'Twoje aktywa'), h('div', { class: 'spacer' }),
      h('button', { class: 'btn plain sm', onclick: () => go('portfolio') }, 'Edytuj portfel', iconEl('chevronR', 12))));
    page.append(h('div', { class: 'card coin-list holdings' },
      h('div', { class: 'coin-head' }, h('div', { class: 'c-coin' }, 'Aktywo'), h('div', { class: 'c-price' }, 'Cena'), h('div', { class: 'c-val' }, 'Wartość'), h('div', { class: 'c-pct' }, '24 h')),
      p.items.slice(0, 8).map((i) => {
        const c = coinInfo(i.id);
        const q = state.market[i.id] || {};
        return h('div', { class: 'coin-row click', onclick: () => go('coin', { id: i.id }) },
          coinCell(c, Core.fmtAmount(i.amount)),
          h('div', { class: 'c-price' }, money(q.price)),
          h('div', { class: 'c-val' }, money(i.value), h('div', { class: 'sub' }, i.value != null ? Core.fmtPct(i.share * 100, 1).replace('+', '') + ' portfela' : 'brak notowań')),
          pctEl(i.change24h));
      })));
  } else {
    page.append(h('div', { class: 'card onboard' },
      h('div', { class: 'ob-ic', html: icon('wallet', 30) }),
      h('h2', null, 'Dodaj swoje kryptowaluty'),
      h('p', null, 'Wczytaj zrzut ekranu z giełdy lub portfela – aplikacja odczyta tokeny i ich ilości, doda je do obserwowanych i na bieżąco wyceni. Możesz też wpisać pozycje ręcznie.'),
      h('div', { class: 'acts' },
        h('button', { class: 'btn primary lg', onclick: () => openImport() }, iconEl('camera', 16), 'Wczytaj zrzut ekranu'),
        h('button', { class: 'btn lg', onclick: addHoldingFlow }, iconEl('plus', 16), 'Dodaj ręcznie'))));
  }

  page.append(h('div', { class: 'section-head' }, h('h2', null, 'Obserwowane'), h('div', { class: 'spacer' }),
    h('button', { class: 'btn plain sm', onclick: () => go('market') }, 'Rynek', iconEl('chevronR', 12))));
  page.append(state.data.watch.length
    ? h('div', { class: 'card coin-list' }, marketHead(), sortedWatch().map((w) => marketRow(w)))
    : h('div', { class: 'card empty' }, 'Nie obserwujesz jeszcze żadnej kryptowaluty.'));

  if (state.data.alertLog.length) {
    page.append(h('div', { class: 'section-head' }, h('h2', null, 'Ostatnie alerty'), h('div', { class: 'spacer' }),
      h('button', { class: 'btn plain sm', onclick: () => go('alerts') }, 'Wszystkie', iconEl('chevronR', 12))));
    page.append(h('div', { class: 'card' }, state.data.alertLog.slice(0, 3).map(logRow)));
  }

  return h('div', null,
    h('div', { class: 'toolbar' }, h('h1', null, 'Pulpit'), h('div', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => openImport() }, iconEl('camera', 15), 'Wczytaj zrzut'),
      h('button', { class: 'btn primary', onclick: () => pickCoin({ title: 'Dodaj do obserwowanych', onPick: (c) => { addWatch(c); refresh(); render(true); } }) }, iconEl('plus', 15), 'Dodaj')),
    page);
}

function sortedWatch() {
  return [...state.data.watch].sort((a, b) => ((state.market[b.id] || {}).marketCap || 0) - ((state.market[a.id] || {}).marketCap || 0));
}

// ───────────────────────── rynek ─────────────────────────
function viewMarket() {
  const q = state.marketQuery.trim().toLowerCase();
  const match = (c) => !q || String(c.name).toLowerCase().includes(q) || String(c.symbol).toLowerCase().includes(q);
  const listBox = h('div');
  const fill = () => {
    if (state.marketTab === 'watch') {
      const items = sortedWatch().filter(match);
      listBox.replaceChildren(items.length
        ? h('div', { class: 'card coin-list' }, marketHead({ cap: true }), items.map((w) => marketRow(w, { cap: true })))
        : h('div', { class: 'card empty' }, q ? 'Brak obserwowanych pasujących do wyszukiwania.' : 'Lista obserwowanych jest pusta. Dodaj kryptowaluty przyciskiem „Dodaj” lub gwiazdką w zakładce „Top 100”.'));
      return;
    }
    if (!state.top) {
      listBox.replaceChildren(h('div', { class: 'card empty' }, state.topError ? h('div', null, state.topError, h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn', onclick: () => { state.topError = null; loadTop(); fill(); } }, 'Spróbuj ponownie'))) : h('div', { class: 'analyzing', style: { justifyContent: 'center' } }, spinner(18), 'Pobieram ranking…')));
      return;
    }
    const items = state.top.slice(0, 100).filter(match);
    listBox.replaceChildren(items.length
      ? h('div', { class: 'card coin-list' }, marketHead({ rank: true, cap: true }), items.map((c) => marketRow(c, { rank: true, cap: true })))
      : h('div', { class: 'card empty' }, 'Brak wyników w pierwszej setce. Użyj przycisku „Dodaj”, aby przeszukać wszystkie kryptowaluty.'));
  };
  if (state.marketTab === 'top' && !state.top && !state.topError) loadTop();
  fill();
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Filtruj listę…', value: state.marketQuery, 'aria-label': 'Filtruj listę', oninput: (e) => { state.marketQuery = e.target.value; fill(); } });
  return h('div', null,
    h('div', { class: 'toolbar' }, h('h1', null, 'Rynek'),
      segmented([{ value: 'watch', label: 'Obserwowane' }, { value: 'top', label: 'Top 100' }], state.marketTab, (v) => { state.marketTab = v; render(); }),
      h('div', { class: 'spacer' }),
      h('div', { class: 'search-field' }, iconEl('search', 14), search),
      h('button', { class: 'btn primary', onclick: () => pickCoin({ title: 'Dodaj do obserwowanych', onPick: (c) => { addWatch(c); refresh(); render(true); } }) }, iconEl('plus', 15), 'Dodaj')),
    h('div', { class: 'page' }, offlineBanner(), listBox));
}

let topLoading = false;
async function loadTop() {
  if (topLoading) return;
  topLoading = true;
  try {
    state.top = await Market.top(cur(), 1);
    state.topError = null;
  } catch (e) { if (!state.top) state.topError = e.message; }
  topLoading = false;
  if (state.view === 'market' && state.marketTab === 'top') softRender();
}

// ───────────────────────── wyszukiwarka monet (arkusz) ─────────────────────────
function pickCoin({ title, onPick }) {
  const results = h('div', { class: 'search-results' });
  const input = h('input', { class: 'input full', type: 'search', placeholder: 'Nazwa lub symbol, np. Bitcoin, ETH…', 'aria-label': 'Szukaj kryptowaluty' });
  let token = 0;
  let timer = null;
  let sh = null;
  const show = (list, note) => {
    results.replaceChildren(...(list.length ? list.map((c) => h('div', { class: 'coin-row click', onclick: () => { sh.close(); onPick(c); } },
      coinCell(c, c.rank ? '#' + c.rank : ''),
      isWatched(c.id) ? h('span', { class: 'chip blue' }, 'obserwowana') : null)) : [h('div', { class: 'empty' }, note || 'Brak wyników.')]));
  };
  const local = (q) => {
    const pool = [...(state.top || []), ...Object.values(state.market)];
    const seen = new Set();
    return pool.filter((c) => !seen.has(c.id) && seen.add(c.id) && (!q || c.name.toLowerCase().includes(q) || c.symbol.toLowerCase().includes(q))).slice(0, 12);
  };
  const run = async () => {
    const q = input.value.trim();
    const my = ++token;
    if (!q) { show(local(''), 'Wpisz nazwę lub symbol kryptowaluty.'); return; }
    show(local(q.toLowerCase()), 'Szukam…');
    try {
      const found = await Market.search(q);
      if (my !== token) return;
      show(found, 'Nie znaleziono kryptowaluty o takiej nazwie.');
    } catch (e) { if (my === token && !results.querySelector('.coin-row')) show([], e.message); }
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 380); });
  sh = sheet({ title, subtitle: 'Wyszukiwanie obejmuje wszystkie kryptowaluty z CoinGecko.', body: h('div', null, h('div', { class: 'field' }, input), results) });
  show(local(''), 'Wpisz nazwę lub symbol kryptowaluty.');
  if (!state.top) loadTop().then(() => { if (!input.value.trim() && document.body.contains(results)) show(local(''), 'Wpisz nazwę lub symbol kryptowaluty.'); });
  setTimeout(() => input.focus(), 60);
}

// ───────────────────────── portfel ─────────────────────────
function viewPortfolio() {
  const p = Core.portfolio(state.data.holdings, state.market);
  const page = h('div', { class: 'page' }, offlineBanner());
  if (!p.items.length) {
    page.append(h('div', { class: 'card onboard' },
      h('div', { class: 'ob-ic', html: icon('wallet', 30) }),
      h('h2', null, 'Portfel jest pusty'),
      h('p', null, 'Wczytaj zrzut ekranu z giełdy lub portfela albo dodaj pozycję ręcznie. Ilości możesz w każdej chwili poprawić – wartość przelicza się na bieżąco.'),
      h('div', { class: 'acts' },
        h('button', { class: 'btn primary lg', onclick: () => openImport() }, iconEl('camera', 16), 'Wczytaj zrzut ekranu'),
        h('button', { class: 'btn lg', onclick: addHoldingFlow }, iconEl('plus', 16), 'Dodaj pozycję'))));
  } else {
    page.append(h('div', { class: 'grid grid-3', style: { marginBottom: '16px' } },
      h('div', { class: 'card stat' }, h('div', { class: 'label' }, iconEl('wallet', 14), 'Wartość portfela'), h('div', { class: 'value num' }, money(p.total))),
      h('div', { class: 'card stat' }, h('div', { class: 'label' }, iconEl('chart', 14), 'Zmiana w 24 h'),
        h('div', { class: 'value num ' + pctClass(p.change24hValue) }, (p.change24hValue > 0 ? '+' : '') + money(p.change24hValue), h('small', { class: pctClass(p.change24hPct) }, Core.fmtPct(p.change24hPct)))),
      h('div', { class: 'card stat' }, h('div', { class: 'label' }, iconEl('coins', 14), 'Liczba aktywów'), h('div', { class: 'value num' }, p.items.length))));
    page.append(h('div', { class: 'card coin-list holdings portfolio-list' },
      h('div', { class: 'coin-head' }, h('div', { class: 'c-coin' }, 'Aktywo'), h('div', { class: 'c-amt', style: { textAlign: 'right' } }, 'Ilość'), h('div', { class: 'c-price' }, 'Cena'), h('div', { class: 'c-val' }, 'Wartość'), h('div', { class: 'c-pct' }, '24 h'), h('div', { class: 'c-act' })),
      p.items.map((i) => {
        const c = coinInfo(i.id);
        const q = state.market[i.id] || {};
        const input = h('input', { class: 'input', inputmode: 'decimal', value: Core.fmtAmount(i.amount), 'aria-label': `Ilość ${c.name}`, onclick: (e) => e.stopPropagation(),
          onfocus: (e) => e.target.select(),
          onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { e.target.value = Core.fmtAmount(i.amount); e.target.blur(); } },
          onchange: (e) => {
            const n = Core.parseAmount(e.target.value);
            if (!isFinite(n) || n < 0) { toast('Wpisz poprawną liczbę, np. 0,25', 'error'); e.target.value = Core.fmtAmount(i.amount); return; }
            if (n === 0) { confirmRemoveHolding(i.id); return; }
            setHolding(i.id, n); render(true);
          } });
        return h('div', { class: 'coin-row click', onclick: () => go('coin', { id: i.id }) },
          coinCell(c),
          h('div', { class: 'c-amt' }, input),
          h('div', { class: 'c-price' }, money(q.price)),
          h('div', { class: 'c-val' }, money(i.value), h('div', { class: 'sub' }, i.value != null ? Core.fmtPct(i.share * 100, 1).replace('+', '') : 'brak notowań')),
          pctEl(i.change24h),
          h('div', { class: 'c-act' },
            h('button', { class: 'icon-btn opt', title: 'Ustaw alert', 'aria-label': 'Ustaw alert', onclick: (e) => { e.stopPropagation(); editAlert({ coinId: i.id }); }, html: icon('bell', 16) }),
            h('button', { class: 'icon-btn danger', title: 'Usuń pozycję', 'aria-label': 'Usuń pozycję', onclick: (e) => { e.stopPropagation(); confirmRemoveHolding(i.id); }, html: icon('trash', 16) })));
      })));
    page.append(h('p', { class: 'group-footer' }, 'Kliknij pole „Ilość”, aby zmienić liczbę posiadanych tokenów. Wartość przelicza się przy każdej aktualizacji notowań.'));
  }
  return h('div', null,
    h('div', { class: 'toolbar' }, h('h1', null, 'Portfel'), h('div', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => openImport() }, iconEl('camera', 15), 'Wczytaj zrzut'),
      h('button', { class: 'btn primary', onclick: addHoldingFlow }, iconEl('plus', 15), 'Dodaj pozycję')),
    page);
}

function confirmRemoveHolding(id) {
  const c = coinInfo(id);
  sheet({
    title: `Usunąć ${c.name} z portfela?`,
    subtitle: 'Kryptowaluta pozostanie na liście obserwowanych.',
    body: h('div'),
    actions: [{ label: 'Anuluj' }, { label: 'Usuń pozycję', kind: 'danger', onClick: () => { setHolding(id, 0); render(true); } }],
    onClose: () => { if (state.view === 'portfolio') render(true); }
  });
}

function addHoldingFlow() {
  pickCoin({ title: 'Dodaj pozycję do portfela', onPick: (c) => { if (!state.market[c.id]) state.market[c.id] = { ...c }; editHolding(c); } });
}

function editHolding(c) {
  const current = state.data.holdings[c.id] || 0;
  const input = h('input', { class: 'input full', inputmode: 'decimal', placeholder: 'np. 0,25', value: current ? Core.fmtAmount(current) : '' });
  const save = () => {
    const n = Core.parseAmount(input.value);
    if (!isFinite(n) || n < 0) { toast('Wpisz poprawną liczbę, np. 0,25', 'error'); return false; }
    addWatch(c, true);
    setHolding(c.id, n);
    refresh();
    render(true);
    toast(n > 0 ? `Zapisano: ${Core.fmtAmount(n)} ${String(c.symbol).toUpperCase()}` : 'Usunięto pozycję', 'success', 2200);
  };
  const sh = sheet({
    title: `${c.name} – ilość`,
    subtitle: 'Podaj, ile jednostek tej kryptowaluty posiadasz.',
    body: h('div', { class: 'field' }, h('label', null, `Ilość (${String(c.symbol).toUpperCase()})`), input),
    actions: [{ label: 'Anuluj' }, { label: 'Zapisz', kind: 'primary', onClick: save }]
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && save() !== false) sh.close(); });
  setTimeout(() => { input.focus(); input.select(); }, 60);
}

// ───────────────────────── szczegóły i wykres ─────────────────────────
const RANGES = [{ value: 1, label: '24 h' }, { value: 7, label: '7 dni' }, { value: 30, label: '30 dni' }, { value: 90, label: '90 dni' }, { value: 365, label: '1 rok' }];

function viewCoin() {
  const id = state.coinId;
  const c = coinInfo(id);
  const priceEl = h('div', { class: 'price' });
  const chipBox = h('span');
  const kv = h('div', { class: 'kv-grid' });
  const valueEl = h('div', { class: 'muted', style: { marginTop: '8px' } });
  const readout = h('div', { class: 'chart-readout' });
  const box = h('div', { class: 'chart-box' });
  let rangeInfo = '';

  const fillQuotes = () => {
    const q = state.market[id] || {};
    priceEl.textContent = money(q.price);
    chipBox.replaceChildren(pctChip(q.change24h, '24 h'));
    const cell = (k, v, cls) => h('div', { class: 'kv' }, h('div', { class: 'k' }, k), h('div', { class: 'v ' + (cls || '') }, v));
    kv.replaceChildren(
      cell('Kapitalizacja', money(q.marketCap, { compact: true })),
      cell('Wolumen 24 h', money(q.volume, { compact: true })),
      cell('Najniższa / najwyższa 24 h', `${money(q.low24h)} / ${money(q.high24h)}`),
      cell('Pozycja w rankingu', q.rank ? '#' + q.rank : '—'),
      cell('Zmiana 1 h', Core.fmtPct(q.change1h), pctClass(q.change1h)),
      cell('Zmiana 7 dni', Core.fmtPct(q.change7d), pctClass(q.change7d)),
      cell('Najwyższa cena w historii', money(q.ath)),
      cell('W obiegu', q.supply ? new Intl.NumberFormat('pl-PL', { notation: 'compact', maximumFractionDigits: 2 }).format(q.supply) + ' ' + String(c.symbol).toUpperCase() : '—'));
    const amt = state.data.holdings[id] || 0;
    valueEl.textContent = amt > 0 && isFinite(q.price) ? `Wartość: ${money(amt * q.price)}` : amt > 0 ? 'Wartość: brak notowań' : 'Nie masz tej kryptowaluty w portfelu.';
  };

  let token = 0;
  const loadChart = async () => {
    const my = ++token;
    const days = state.chartDays;
    if (chartHandle) { chartHandle.destroy(); chartHandle = null; }
    box.replaceChildren(h('div', { class: 'center' }, spinner(18), 'Wczytuję wykres…'));
    readout.textContent = '';
    try {
      const pts = await Market.chart(id, cur(), days);
      if (my !== token || state.view !== 'coin' || state.coinId !== id) return;
      if (pts.length < 2) throw new Error('Brak danych historycznych dla tej kryptowaluty.');
      const change = (pts[pts.length - 1][1] / pts[0][1] - 1) * 100;
      const label = RANGES.find((r) => r.value === days).label;
      const setDefault = () => { readout.replaceChildren('Zmiana w okresie ', h('b', { class: pctClass(change) }, Core.fmtPct(change)), ` · ${label}`); };
      rangeInfo = label;
      const canvas = h('canvas', { role: 'img', 'aria-label': `Wykres ceny ${c.name}, ${rangeInfo}, zmiana ${Core.fmtPct(change)}` });
      box.replaceChildren(canvas);
      chartHandle = Charts.priceChart(canvas, pts, {
        days,
        format: (v) => money(v),
        onHover: (hv) => {
          if (!hv) { setDefault(); return; }
          const d = (hv.price / hv.base - 1) * 100;
          readout.replaceChildren(hv.label + ' · ', h('b', null, money(hv.price)), ' · ', h('span', { class: pctClass(d) }, Core.fmtPct(d)));
        }
      });
      setDefault();
    } catch (e) {
      if (my !== token) return;
      box.replaceChildren(h('div', { class: 'center' }, h('div', null, h('div', null, e.message || String(e)), h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn', onclick: loadChart }, iconEl('refresh', 14), 'Spróbuj ponownie')))));
    }
  };

  const amt = state.data.holdings[id] || 0;
  const amtInput = h('input', { class: 'input', style: { width: '180px', textAlign: 'right' }, inputmode: 'decimal', placeholder: '0', value: amt ? Core.fmtAmount(amt) : '', 'aria-label': 'Posiadana ilość' });
  const saveAmt = () => {
    const n = amtInput.value.trim() === '' ? 0 : Core.parseAmount(amtInput.value);
    if (!isFinite(n) || n < 0) { toast('Wpisz poprawną liczbę, np. 0,25', 'error'); return; }
    setHolding(id, n);
    amtInput.value = n ? Core.fmtAmount(n) : '';
    fillQuotes(); renderSidebar();
    toast(n > 0 ? 'Zapisano ilość' : 'Usunięto z portfela', 'success', 1800);
  };
  amtInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { saveAmt(); amtInput.blur(); } });

  const alerts = state.data.alerts.filter((a) => a.coinId === id);
  const watched = isWatched(id);
  fillQuotes();
  state.onQuotes = fillQuotes;
  setTimeout(loadChart, 0);

  return h('div', null,
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn', onclick: () => go(state.backTo || 'dashboard') }, iconEl('chevronL', 13), 'Wróć'),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => toggleWatch({ ...c, ...(state.market[id] || {}) }) }, h('span', { class: 'icon-wrap ' + (watched ? 'up' : ''), html: icon(watched ? 'check' : 'star', 14) }), watched ? 'Obserwowana' : 'Obserwuj'),
      h('button', { class: 'btn', title: 'Otwórz stronę tej kryptowaluty w CoinGecko', onclick: () => platform.openExternal('https://www.coingecko.com/pl/waluty/' + encodeURIComponent(id)) }, iconEl('external', 14), 'CoinGecko')),
    h('div', { class: 'page' }, offlineBanner(),
      h('div', { class: 'coin-hero' }, coinIcon(c),
        h('div', null, h('h1', null, c.name), h('div', { class: 'c-sym' }, c.symbol)),
        h('div', { class: 'spacer' }), priceEl, chipBox),
      h('div', { class: 'card chart-card' },
        h('div', { class: 'chart-top' }, segmented(RANGES, state.chartDays, (v) => { state.chartDays = v; loadChart(); }), h('div', { class: 'spacer' }), readout),
        box),
      h('div', { class: 'card', style: { marginTop: '16px', overflow: 'hidden' } }, kv),
      h('div', { class: 'two-col' },
        h('div', { class: 'card card-pad' },
          h('div', { class: 'card-title' }, iconEl('wallet', 16), 'Twoja pozycja'),
          h('div', { class: 'inline-form' }, amtInput, h('span', { class: 'c-sym' }, c.symbol), h('button', { class: 'btn primary', onclick: saveAmt }, 'Zapisz')),
          valueEl),
        h('div', { class: 'card card-pad' },
          h('div', { class: 'card-title' }, iconEl('bell', 16), 'Alerty', h('div', { class: 'spacer' }),
            h('button', { class: 'btn sm', onclick: () => editAlert({ coinId: id }) }, iconEl('plus', 12), 'Nowy alert')),
          alerts.length ? h('div', { style: { margin: '0 -16px -8px' } }, alerts.map((a) => alertRow(a, true))) : h('div', { class: 'muted' }, 'Brak alertów dla tej kryptowaluty.')))));
}

// ───────────────────────── alerty ─────────────────────────
function alertRow(a, compact) {
  const c = coinInfo(a.coinId);
  const q = state.market[a.coinId] || {};
  const foreign = Core.ALERT_TYPES[a.type].unit === 'price' && a.currency && a.currency !== cur();
  const sub = [
    foreign ? `działa przy walucie ${a.currency.toUpperCase()}` : isFinite(q.price) ? `teraz ${money(q.price)}` : null,
    a.repeat ? 'powtarzalny' : 'jednorazowy',
    a.lastTriggered ? `uruchomiony ${dateTimeStr(a.lastTriggered)}` : null
  ].filter(Boolean).join(' · ');
  return h('div', { class: 'alert-row' + (a.active ? '' : ' off') },
    compact ? null : coinIcon(c),
    h('div', { class: 'grow' },
      h('div', { class: 't1' }, compact ? Core.alertSummary(a, cur()) : `${c.name}: ${Core.alertSummary(a, cur()).replace(/^./, (x) => x.toLowerCase())}`),
      h('div', { class: 't2' }, sub)),
    toggle(a.active, (v) => { a.active = v; if (v) a.armed = true; saveData(); render(true); }),
    h('button', { class: 'icon-btn', title: 'Edytuj alert', 'aria-label': 'Edytuj alert', onclick: () => editAlert(a), html: icon('pencil', 15) }),
    h('button', { class: 'icon-btn danger', title: 'Usuń alert', 'aria-label': 'Usuń alert', onclick: () => { state.data.alerts = state.data.alerts.filter((x) => x.id !== a.id); saveData(); render(true); }, html: icon('trash', 15) }));
}

function logRow(l) {
  const c = coinInfo(l.coinId);
  return h('div', { class: 'alert-row' }, coinIcon(c),
    h('div', { class: 'grow' }, h('div', { class: 't1' }, l.title), h('div', { class: 't2' }, `${dateTimeStr(l.at)} · ${l.body}`)));
}

function viewAlerts() {
  const page = h('div', { class: 'page' }, offlineBanner());
  if (!state.data.alerts.length) {
    page.append(h('div', { class: 'card onboard' },
      h('div', { class: 'ob-ic', html: icon('bell', 30) }),
      h('h2', null, 'Nie przegap ruchu ceny'),
      h('p', null, 'Ustaw alert, a aplikacja powiadomi Cię, gdy cena przekroczy wybrany poziom albo zmieni się o zadany procent w ciągu 24 godzin.'),
      h('div', { class: 'acts' }, h('button', { class: 'btn primary lg', onclick: () => editAlert({}) }, iconEl('plus', 16), 'Nowy alert'))));
  } else {
    page.append(h('div', { class: 'card' }, state.data.alerts.map((a) => alertRow(a))));
  }
  page.append(h('p', { class: 'group-footer' }, platform.desktop
    ? 'Alerty są sprawdzane przy każdej aktualizacji notowań – także wtedy, gdy okno jest schowane do zasobnika.'
    : 'Alerty są sprawdzane przy każdej aktualizacji notowań, gdy aplikacja jest uruchomiona. Android może wstrzymać aplikację działającą dłużej w tle.'));
  if (state.data.alertLog.length) {
    page.append(h('div', { class: 'section-head' }, h('h2', null, 'Historia'), h('div', { class: 'spacer' }),
      h('button', { class: 'btn plain sm', onclick: () => { state.data.alertLog = []; saveData(); render(true); } }, 'Wyczyść')));
    page.append(h('div', { class: 'card' }, state.data.alertLog.slice(0, 30).map(logRow)));
  }
  return h('div', null,
    h('div', { class: 'toolbar' }, h('h1', null, 'Alerty'), h('div', { class: 'spacer' }),
      h('button', { class: 'btn primary', onclick: () => editAlert({}) }, iconEl('plus', 15), 'Nowy alert')),
    page);
}

function editAlert(src) {
  const isNew = !src.id;
  const draft = { coinId: src.coinId || null, type: src.type || 'above', value: src.value != null ? src.value : null, repeat: !!src.repeat };
  const coinBox = h('div');
  const valueInput = h('input', { class: 'input', style: { width: '170px', textAlign: 'right' }, inputmode: 'decimal' });
  const unit = h('span', { class: 'muted' });
  const hint = h('div', { class: 'row-hint' });
  const suggest = () => {
    const q = state.market[draft.coinId];
    const isPrice = Core.ALERT_TYPES[draft.type].unit === 'price';
    unit.textContent = isPrice ? cur().toUpperCase() : '%';
    hint.textContent = q && isFinite(q.price) ? `Aktualna cena: ${money(q.price)} · zmiana 24 h: ${Core.fmtPct(q.change24h)}` : '';
    if (draft.value == null || valueInput.dataset.auto === '1') {
      let v = '';
      if (isPrice && q && isFinite(q.price)) v = Number((q.price * (draft.type === 'above' ? 1.05 : 0.95)).toPrecision(4));
      if (!isPrice) v = 5;
      valueInput.value = v === '' ? '' : String(v).replace('.', ',');
      valueInput.dataset.auto = '1';
    }
  };
  valueInput.addEventListener('input', () => { valueInput.dataset.auto = '0'; });
  const fillCoin = () => {
    const c = draft.coinId ? coinInfo(draft.coinId) : null;
    coinBox.replaceChildren(h('button', { class: 'btn', style: { height: '40px', width: '100%', justifyContent: 'flex-start' }, onclick: () => pickCoin({ title: 'Wybierz kryptowalutę', onPick: (p) => { if (!state.market[p.id]) state.market[p.id] = { ...p }; draft.coinId = p.id; fillCoin(); suggest(); refresh(); } }) },
      c ? [coinIcon(c), h('b', null, c.name), h('span', { class: 'c-sym' }, c.symbol)] : [iconEl('search', 14), 'Wybierz kryptowalutę…']));
  };
  if (draft.value != null) valueInput.value = String(draft.value).replace('.', ',');
  fillCoin(); suggest();
  sheet({
    title: isNew ? 'Nowy alert' : 'Edytuj alert',
    body: h('div', null,
      h('div', { class: 'field' }, h('label', null, 'Kryptowaluta'), coinBox),
      h('div', { class: 'field' }, h('label', null, 'Warunek'),
        select(Object.entries(Core.ALERT_TYPES).map(([value, t]) => ({ value, label: t.label })), draft.type, (v) => { draft.type = v; suggest(); }, { class: 'input full' })),
      h('div', { class: 'field' }, h('label', null, 'Wartość'), h('div', { class: 'inline-form' }, valueInput, unit), hint),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: draft.repeat, onchange: (e) => { draft.repeat = e.target.checked; } }), 'Powtarzaj (uruchom ponownie, gdy warunek znów zostanie spełniony)')),
    actions: [{ label: 'Anuluj' }, {
      label: isNew ? 'Dodaj alert' : 'Zapisz', kind: 'primary', onClick: () => {
        const v = Core.parseAmount(valueInput.value);
        if (!draft.coinId) { toast('Wybierz kryptowalutę', 'error'); return false; }
        if (!isFinite(v) || v <= 0) { toast('Wpisz wartość większą od zera', 'error'); return false; }
        const base = { coinId: draft.coinId, type: draft.type, value: v, currency: cur(), repeat: draft.repeat, active: true, armed: true };
        const cond = Core.alertCondition(base, state.market[draft.coinId]);
        if (isNew) state.data.alerts.unshift({ id: uid(), createdAt: Date.now(), ...base });
        else Object.assign(state.data.alerts.find((a) => a.id === src.id) || {}, base, { lastTriggered: null });
        saveData();
        if (state.settings.alerts.notifications && platform.requestNotifications) platform.requestNotifications();
        refresh();
        render(true);
        toast(cond ? 'Alert zapisany – warunek jest już spełniony, powiadomię przy najbliższej aktualizacji' : 'Alert zapisany', 'success', cond ? 5000 : 2000);
      }
    }]
  });
}

// ───────────────────────── import ze zrzutu ekranu ─────────────────────────
async function prepareImage(file) {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name || 'Plik'}: to nie jest obraz.`);
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Nie mogę otworzyć tego formatu (zapisz zrzut jako PNG lub JPG).')); i.src = url; });
    const scale = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    // do OCR bezstratny PNG (artefakty JPEG psują drobne litery), do Claude lżejszy JPEG
    return { name: file.name || 'zrzut', dataUrl, ocrUrl: canvas.toDataURL('image/png'), data: dataUrl.split(',')[1], mediaType: 'image/jpeg' };
  } finally { URL.revokeObjectURL(url); }
}

function claudeReady() {
  if (!platform.claude || state.settings.ai.provider === 'api') return state.hasApiKey;
  return !!(state.claude.status && state.claude.status.loggedIn);
}

function importMethod() {
  const m = state.settings.import.method;
  if (m === 'claude' || m === 'ocr') return m;
  return claudeReady() ? 'claude' : 'ocr';
}

// Lista monet do rozpoznawania symboli (500 największych wg kapitalizacji).
async function referenceCoins() {
  const first = await Market.top(cur(), 1, { ttl: 15 * 60000 });
  state.top = state.top || first;
  let second = [];
  try { second = await Market.top(cur(), 2, { ttl: 15 * 60000 }); } catch (_) { /* wystarczy pierwsza strona */ }
  return [...first, ...second];
}

async function readScreenshot(image, onStatus) {
  let method = importMethod();
  const warnings = [];
  let rows = null;
  const coinsPromise = referenceCoins();
  coinsPromise.catch(() => {});
  if (method === 'claude') {
    onStatus(platform.claude && state.settings.ai.provider !== 'api' ? 'Claude (Twoje konto) odczytuje zrzut…' : 'Claude odczytuje zrzut…');
    try {
      const r = await platform.extractHoldings({ data: image.data, mediaType: image.mediaType });
      rows = r.rows; warnings.push(...r.warnings);
    } catch (e) {
      if (state.settings.import.method === 'claude') throw e;
      warnings.push(`Claude nie odczytał zrzutu (${e.message}) – użyto odczytu lokalnego.`);
      method = 'ocr';
    }
  }
  const coins = await coinsPromise.catch(() => { throw new Error('Do rozpoznania tokenów potrzebne jest połączenie z internetem (lista kryptowalut).'); });
  if (method === 'ocr') {
    onStatus('Rozpoznaję tekst na zrzucie…');
    const text = await Ocr.recognize(image.ocrUrl || image.dataUrl, (p) => onStatus(`Rozpoznaję tekst na zrzucie… ${Math.round(p * 100)}%`));
    if (state.info.mock) console.log('OCR>>' + JSON.stringify(text));
    rows = Core.parseOcrText(text, coins);
    if (rows.length) warnings.push('Odczyt lokalny (OCR) bywa mniej dokładny – sprawdź ilości przed zapisaniem.');
  }
  const matched = Core.matchRows(rows, coins);
  // nierozpoznane symbole: zapytaj wyszukiwarkę CoinGecko
  for (const r of matched.filter((x) => !x.coin).slice(0, 8)) {
    onStatus(`Szukam: ${r.symbol || r.name}…`);
    try {
      const found = await Market.search(r.symbol || r.name);
      const exact = found.filter((f) => r.symbol && String(f.symbol).toUpperCase() === r.symbol.toUpperCase()).sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9));
      const best = exact[0] || (r.name ? found.find((f) => f.name.toLowerCase() === r.name.toLowerCase()) : null);
      if (best) r.coin = Core.pickCoin(best);
    } catch (_) { /* zostaje do ręcznego wyboru */ }
  }
  return { rows: matched, warnings, method };
}

let importOpen = false;
function onPaste(e) {
  const item = [...((e.clipboardData && e.clipboardData.items) || [])].find((i) => i.type.startsWith('image/'));
  if (!item || importOpen) return;
  e.preventDefault();
  openImport(item.getAsFile());
}

function openImport(file) {
  importOpen = true;
  const st = { image: null, busy: false, status: '', result: null, mode: 'replace', error: null };
  const body = h('div');
  const fileInput = h('input', { type: 'file', accept: 'image/*', class: 'hide' });
  let sh = null;

  const setFile = async (f) => {
    if (!f) return;
    try { st.image = await prepareImage(f); st.result = null; st.error = null; draw(); analyze(); } catch (e) { errToast(e); }
  };
  fileInput.addEventListener('change', () => { setFile(fileInput.files[0]); fileInput.value = ''; });

  const analyze = async () => {
    st.busy = true; st.error = null; st.status = 'Przygotowuję…'; draw();
    try {
      const r = await readScreenshot(st.image, (s) => { st.status = s; const el = body.querySelector('.an-status'); if (el) el.textContent = s; });
      st.result = { ...r, rows: r.rows.map((x) => ({ ...x, sel: !!x.coin && x.amount != null, text: x.amount != null ? Core.fmtAmount(x.amount) : '' })) };
      const ids = st.result.rows.filter((x) => x.coin && !state.market[x.coin.id]).map((x) => x.coin.id);
      if (ids.length) Market.quotes(ids, cur()).then((qs) => { qs.forEach((q) => { state.market[q.id] = q; }); if (st.result) draw(); }).catch(() => {});
    } catch (e) { st.error = e.message || String(e); }
    st.busy = false; draw();
  };

  const apply = () => {
    const rows = st.result.rows.filter((r) => r.sel && r.coin).map((r) => ({ coin: r.coin, amount: Core.parseAmount(r.text) }));
    const bad = rows.find((r) => !isFinite(r.amount) || r.amount <= 0);
    if (bad) { toast(`Popraw ilość dla ${bad.coin.name}`, 'error'); return false; }
    if (!rows.length) { toast('Zaznacz co najmniej jedną pozycję', 'error'); return false; }
    rows.forEach((r) => addWatch(r.coin, true));
    state.data.holdings = Core.mergeHoldings(state.data.holdings, rows.map((r) => ({ id: r.coin.id, amount: r.amount })), st.mode);
    saveData();
    refresh();
    go('portfolio');
    toast(`Dodano ${rows.length} ${rows.length === 1 ? 'pozycję' : rows.length < 5 ? 'pozycje' : 'pozycji'} do portfela`, 'success', 3000);
  };

  const reviewRow = (r) => {
    const q = r.coin ? state.market[r.coin.id] : null;
    const amount = Core.parseAmount(r.text);
    const val = h('div', { class: 'val' }, q && isFinite(q.price) && isFinite(amount) ? money(amount * q.price) : '');
    const input = h('input', { class: 'input', inputmode: 'decimal', placeholder: 'ilość', value: r.text, 'aria-label': 'Ilość',
      oninput: (e) => { r.text = e.target.value; const a = Core.parseAmount(r.text); val.textContent = q && isFinite(q.price) && isFinite(a) ? money(a * q.price) : ''; } });
    const change = () => pickCoin({ title: `Wybierz kryptowalutę dla „${r.symbol || r.name}”`, onPick: (c) => { r.coin = Core.pickCoin(c); r.sel = true; if (!state.market[c.id]) Market.quotes([c.id], cur()).then((qs) => { qs.forEach((x) => { state.market[x.id] = x; }); draw(); }).catch(() => {}); draw(); } });
    return h('div', { class: 'review-row' },
      h('input', { type: 'checkbox', checked: r.sel, disabled: r.coin ? null : true, 'aria-label': 'Uwzględnij', onchange: (e) => { r.sel = e.target.checked; } }),
      r.coin ? coinCell(r.coin, r.note || '') : h('div', { class: 'c-coin' }, h('span', { class: 'c-ic ph' }, '?'), h('div', null, h('div', { class: 'c-name' }, r.symbol || r.name), h('div', { class: 'c-sym', style: { textTransform: 'none' } }, 'nie rozpoznano'))),
      h('button', { class: 'btn sm', onclick: change }, r.coin ? 'Zmień' : 'Wybierz'),
      input, val);
  };

  function draw() {
    if (!st.image) {
      const dz = h('div', { class: 'dropzone', role: 'button', tabindex: '0', onclick: () => fileInput.click() },
        h('div', { class: 'dz-ic', html: icon('photo', 30) }),
        h('h2', null, 'Wybierz zrzut ekranu'),
        h('p', null, platform.desktop ? 'Przeciągnij tutaj obraz, kliknij, aby wybrać plik, albo wklej zrzut ze schowka (Ctrl+V).' : 'Dotknij, aby wybrać zrzut ekranu z galerii.'));
      dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('over'));
      dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); setFile(e.dataTransfer.files[0]); });
      body.replaceChildren(dz, fileInput,
        h('p', { class: 'group-footer' }, importMethod() === 'claude'
          ? 'Zrzut odczyta Claude – obraz zostanie wysłany do usługi Claude (Anthropic).'
          : 'Zrzut zostanie odczytany lokalnie na tym urządzeniu (OCR) – obraz nie jest nigdzie wysyłany. Dokładniejszy odczyt przez Claude włączysz w Ustawieniach.'));
      setActions([{ label: 'Anuluj' }]);
      return;
    }
    const preview = h('div', { class: 'import-preview' }, h('img', { src: st.image.dataUrl, alt: 'Podgląd wczytanego zrzutu' }),
      h('div', { style: { flex: 1, minWidth: 0 } },
        st.busy ? h('div', { class: 'analyzing', style: { padding: '6px 0' } }, spinner(18), h('span', { class: 'an-status' }, st.status)) : null,
        st.error ? h('div', { class: 'note-box warn' }, iconEl('warn', 16), h('div', null, st.error)) : null,
        st.result ? h('div', null,
          h('div', { style: { fontWeight: 650, fontSize: '14px' } }, st.result.rows.length ? `Odczytano pozycji: ${st.result.rows.length}` : 'Nie znaleziono żadnych tokenów'),
          h('div', { class: 'muted small', style: { marginTop: '3px' } }, st.result.method === 'claude' ? 'Odczyt: Claude' : 'Odczyt: lokalny (OCR)'),
          st.result.warnings.map((w) => h('div', { class: 'issue warn' }, iconEl('warn', 14), h('span', null, w)))) : null,
        !st.busy ? h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' } },
          h('button', { class: 'btn sm', onclick: () => fileInput.click() }, 'Inny zrzut'),
          st.error || (st.result && !st.result.rows.length) ? h('button', { class: 'btn sm', onclick: analyze }, iconEl('refresh', 12), 'Spróbuj ponownie') : null) : null));
    const list = st.result && st.result.rows.length ? h('div', null,
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', margin: '6px 0 4px', flexWrap: 'wrap' } },
        h('span', { class: 'muted' }, 'Ilości z tego zrzutu:'),
        segmented([{ value: 'replace', label: 'zastąpią obecne' }, { value: 'add', label: 'zostaną dodane do obecnych' }], st.mode, (v) => { st.mode = v; })),
      st.result.rows.map(reviewRow)) : null;
    body.replaceChildren(preview, list || '', fileInput);
    setActions(st.result && st.result.rows.length ? [{ label: 'Anuluj' }, { label: 'Dodaj do portfela', kind: 'primary', onClick: apply }] : [{ label: 'Zamknij' }]);
  }

  function setActions(actions) {
    if (!sh) return;
    const bar = sh.panel.querySelector('.sheet-actions');
    bar.replaceChildren(...actions.map((a) => h('button', { class: 'btn ' + (a.kind || ''), onclick: async () => { if (a.onClick && (await a.onClick()) === false) return; sh.close(); } }, a.label)));
  }

  sh = sheet({ title: 'Wczytaj zrzut ekranu', subtitle: 'Zrzut z giełdy lub portfela z listą tokenów i ich ilościami.', body, wide: true, actions: [{ label: 'Anuluj' }], onClose: () => { importOpen = false; } });
  draw();
  if (file) setFile(file);
}

// ───────────────────────── ustawienia ─────────────────────────
function viewSettings() {
  const tabs = [
    { value: 'general', label: 'Ogólne', icon: 'gear' },
    { value: 'import', label: 'Odczyt zrzutów', icon: 'camera' },
    { value: 'about', label: 'O aplikacji', icon: 'info' }
  ];
  const body = { general: settingsGeneral, import: settingsImport, about: settingsAbout }[state.settingsTab]();
  return h('div', null,
    h('div', { class: 'toolbar' }, h('h1', null, 'Ustawienia')),
    h('div', { class: 'page' },
      h('div', { class: 'settings-tabs' }, segmented(tabs, state.settingsTab, (v) => { state.settingsTab = v; render(); })),
      body));
}

function settingsGeneral() {
  const s = state.settings;
  const keyInput = h('input', { class: 'input', style: { width: '260px' }, type: 'password', placeholder: 'opcjonalnie: CG-…', value: s.market.cgKey || '', 'aria-label': 'Klucz CoinGecko',
    onchange: async (e) => { await saveSettings({ market: { cgKey: e.target.value.trim() } }); Market.setKey(state.settings.market.cgKey); refresh(true); } });
  return h('div', null,
    group('Notowania', [
      row('Waluta', select(Object.entries(Core.CURRENCIES).map(([value, c]) => ({ value, label: c.label })), s.market.currency, async (v) => {
        await saveSettings({ market: { currency: v } }, true); state.market = {}; state.top = null; Market.clearCache(); state.conn.lastUpdate = 0; refresh(true); render();
      }), { icon: 'coins', color: 'var(--green)', hint: 'W tej walucie pokazywane są ceny i wartość portfela.' }),
      row('Odświeżanie notowań', select([{ value: '30', label: 'co 30 sekund' }, { value: '60', label: 'co minutę' }, { value: '120', label: 'co 2 minuty' }, { value: '300', label: 'co 5 minut' }], String(s.market.refreshSec), async (v) => { await saveSettings({ market: { refreshSec: Number(v) } }, true); refresh(); }),
        { icon: 'refresh', color: 'var(--accent)', hint: 'Po uruchomieniu aplikacja sama łączy się z siecią i aktualizuje dane.' }),
      row('Klucz CoinGecko', keyInput, { icon: 'key', color: 'var(--orange)', hint: 'Niewymagany. Bezpłatny klucz „Demo” z coingecko.com zwiększa limit zapytań przy częstym odświeżaniu.' })
    ], 'Źródło danych: CoinGecko. Publiczne API ma limit zapytań – przy chwilowym przekroczeniu aplikacja pokazuje ostatnie dane i ponawia próbę.'),
    platform.desktop ? group('Okno', [
      row('Przycisk zamknięcia', select([
        { value: 'tray', label: 'chowa okno do zasobnika (działa w tle)' },
        { value: 'minimize', label: 'minimalizuje okno na pasek zadań' },
        { value: 'quit', label: 'kończy aplikację' }
      ], s.window.closeAction, (v) => saveSettings({ window: { closeAction: v } }, true)), { icon: 'eye', color: 'var(--indigo)', hint: 'Schowaną aplikację otworzysz ikoną w zasobniku lub uruchamiając ją ponownie; zakończysz z menu ikony.' }),
      row('Wygląd', segmented([{ value: 'system', label: 'Systemowy' }, { value: 'light', label: 'Jasny' }, { value: 'dark', label: 'Ciemny' }], s.ui.theme, (v) => saveSettings({ ui: { theme: v } }, true)), { icon: 'moon', color: 'var(--purple)' })
    ], state.info.hasTray ? null : 'Na tym systemie nie udało się utworzyć ikony w zasobniku – okno będzie minimalizowane na pasek zadań.') : null,
    group('Alerty', [
      row('Powiadomienia systemowe', toggle(s.alerts.notifications, async (v) => { await saveSettings({ alerts: { notifications: v } }, true); if (v && platform.requestNotifications) platform.requestNotifications(); }), { icon: 'bell', color: 'var(--red)', hint: 'Powiadomienie pojawia się, gdy uruchomi się alert cenowy.' }),
      row('Sprawdź powiadomienia', h('button', { class: 'btn', onclick: async () => { const ok = await platform.notify('CoinTracko', 'Tak będzie wyglądało powiadomienie o alercie.').catch(() => false); if (!ok) toast('System nie pozwolił wyświetlić powiadomienia – sprawdź uprawnienia aplikacji.', 'error', 6000); } }, 'Wyślij testowe'), { icon: 'bolt', color: 'var(--teal)' })
    ]));
}

function settingsImport() {
  const s = state.settings;
  const hasAccount = !!platform.claude;
  const status = h('div', { class: 'status-line' });
  const adv = state.claude.advanced || s.ai.provider === 'api' || !hasAccount;
  const testBtn = h('button', { class: 'btn' }, iconEl('bolt', 14), 'Testuj połączenie');
  testBtn.addEventListener('click', () => busy(testBtn, async () => {
    status.className = 'status-line';
    status.replaceChildren(spinner(12), ' Łączę…');
    try { const r = await platform.testAi(); status.className = 'status-line ok'; status.replaceChildren(iconEl('checkCircle', 14), r); } catch (e) { status.className = 'status-line bad'; status.replaceChildren(iconEl('warn', 14), e.message); }
  }, 'Testuję…'));
  const keyInput = h('input', { class: 'input', type: 'password', style: { width: '280px' }, placeholder: state.hasApiKey ? '•••••••• (zapisany)' : 'sk-ant-…', 'aria-label': 'Klucz API Claude' });
  const ccStatus = state.claudePath ? h('div', { class: 'status-line ok' }, iconEl('checkCircle', 14), h('span', { class: 'path' }, state.claudePath))
    : h('div', { class: 'status-line bad' }, iconEl('warn', 14), 'Nie znaleziono Claude Code');
  const apiGroup = group('Klucz API Claude', [
    row('Klucz', h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, keyInput,
      h('button', { class: 'btn', onclick: async () => { try { state.hasApiKey = await platform.setApiKey(keyInput.value); keyInput.value = ''; toast(state.hasApiKey ? 'Zapisano klucz' : 'Usunięto klucz', 'success'); render(); } catch (e) { errToast(e); } } }, 'Zapisz')), { icon: 'key', color: 'var(--green)' }),
    row('Model', select([{ value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (zalecany)' }, { value: 'claude-opus-5-5', label: 'Claude Opus 5.5' }, { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' }], s.ai.apiModel, (v) => saveSettings({ ai: { apiModel: v } })), { icon: 'sparkles', color: 'var(--purple)' }),
    row('Pobierz klucz', h('button', { class: 'btn sm', onclick: () => platform.openExternal('https://platform.claude.com/settings/keys') }, 'platform.claude.com'), { icon: 'globe', color: 'var(--teal)' })
  ], 'Klucz API jest rozliczany osobno, za faktyczne zużycie – niezależnie od planu Claude.' + (hasAccount ? '' : ' Klucz jest zapisywany w pamięci aplikacji na tym urządzeniu.'));

  return h('div', null,
    group('Sposób odczytu zrzutów', [
      row('Odczyt', segmented([{ value: 'auto', label: 'Automatycznie' }, { value: 'claude', label: 'Claude' }, { value: 'ocr', label: 'Lokalnie (OCR)' }], s.import.method, async (v) => { await saveSettings({ import: { method: v } }, true); render(true); }), { icon: 'camera', color: 'var(--accent)' })
    ], 'Automatycznie: Claude, jeśli jest połączony – w przeciwnym razie odczyt lokalny. Claude czyta zrzuty dokładniej (obraz jest wysyłany do usługi Claude). Odczyt lokalny działa bez konta, a obraz nie opuszcza urządzenia.'),
    hasAccount && s.ai.provider === 'claude-code' ? h('div', { class: 'group' }, h('h3', { class: 'group-title' }, 'Konto Claude'), h('div', { class: 'group-body' }, accountCard()),
      h('p', { class: 'group-footer' }, 'Logujesz się na oficjalnej stronie Claude – aplikacja nie widzi Twojego hasła i nie przechowuje danych logowania. Zapytania wykonuje program Claude Code w ramach Twojego planu.')) : null,
    hasAccount && s.ai.provider === 'claude-code' ? group('Model', [
      row('Model Claude', select([{ value: 'sonnet', label: 'Sonnet (zalecany)' }, { value: 'opus', label: 'Opus (najmocniejszy)' }, { value: 'haiku', label: 'Haiku (najszybszy)' }], s.ai.model, (v) => saveSettings({ ai: { model: v } })), { icon: 'sparkles', color: 'var(--purple)' })
    ]) : null,
    hasAccount ? h('div', { class: 'group' }, h('button', { class: 'btn plain', onclick: () => { state.claude.advanced = !adv; render(); } }, iconEl(adv ? 'chevronL' : 'chevronR', 12), adv ? 'Ukryj ustawienia zaawansowane' : 'Ustawienia zaawansowane')) : null,
    adv ? h('div', null,
      hasAccount ? group('Sposób połączenia', [
        row('Dostawca', segmented([{ value: 'claude-code', label: 'Konto Claude' }, { value: 'api', label: 'Klucz API' }], s.ai.provider, async (v) => { await saveSettings({ ai: { provider: v } }, true); if (v === 'claude-code') refreshClaude(); render(); }), { icon: 'cpu', color: 'var(--accent)' })
      ]) : null,
      s.ai.provider === 'api' || !hasAccount ? apiGroup : group('Claude Code', [
        row('Program', h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-end' } }, ccStatus,
          h('button', { class: 'btn sm', onclick: async () => { try { const p = await platform.claude.browse(); if (p) { state.claudePath = p; await refreshClaude(); } } catch (e) { errToast(e); } } }, 'Wskaż ręcznie…')), { icon: 'cpu', color: 'var(--orange)' })
      ]),
      h('div', { class: 'group', style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } }, testBtn, status)) : null);
}

function settingsAbout() {
  return h('div', null,
    group('CoinTracko', [
      row('Wersja', h('span', { class: 'muted' }, state.info.version || '—'), { icon: 'info', color: 'var(--accent)' }),
      row('Notowania', h('button', { class: 'btn sm', onclick: () => platform.openExternal('https://www.coingecko.com') }, 'CoinGecko', iconEl('external', 12)), { icon: 'globe', color: 'var(--green)' }),
      platform.desktop ? row('Folder danych', h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' } }, h('span', { class: 'path' }, state.info.dataDir), h('button', { class: 'btn sm', onclick: () => platform.openDataDir() }, 'Otwórz')), { icon: 'folder', color: 'var(--orange)' }) : null
    ], 'Portfel, obserwowane i alerty są zapisywane wyłącznie na tym urządzeniu. Notowania mają charakter informacyjny i nie stanowią porady inwestycyjnej.'));
}

// ───────────────────────── konto Claude ─────────────────────────
function accountCard() {
  const C = state.claude;
  const st = C.status;
  const wrap = h('div', { class: 'account' });
  if (!st) {
    wrap.append(h('div', { class: 'acc-row' }, spinner(18), h('span', { class: 'muted' }, 'Sprawdzam połączenie z kontem Claude…')));
    return wrap;
  }
  const logo = (cls) => h('div', { class: 'acc-logo ' + (cls || ''), html: icon(st.loggedIn ? 'checkCircle' : 'person', 24) });
  if (st.loggedIn) {
    wrap.append(h('div', { class: 'acc-row' }, logo('ok'),
      h('div', { style: { flex: 1 } },
        h('div', { class: 'acc-title' }, 'Połączono z kontem Claude'),
        h('div', { class: 'muted small' }, [st.email, st.plan ? `plan ${st.plan}` : null].filter(Boolean).join(' · ') || 'Aplikacja korzysta z Twojego planu Claude.')),
      h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { try { const r = await platform.testAi(); toast(r, 'success', 5000); } catch (er) { errToast(er); } }, 'Testuję…') }, iconEl('bolt', 14), 'Testuj'),
      h('button', { class: 'btn danger', onclick: async () => { try { C.status = await platform.claude.logout(); render(); } catch (er) { errToast(er); } } }, 'Wyloguj')));
    return wrap;
  }
  if (!st.installed) {
    wrap.append(h('div', { class: 'acc-row' }, logo(),
      h('div', { style: { flex: 1 } },
        h('div', { class: 'acc-title' }, 'Połącz aplikację ze swoim kontem Claude'),
        h('div', { class: 'muted small' }, 'Jednorazowo zainstaluję oficjalny program Claude Code od Anthropic (ok. 1 minuty), a potem otworzę stronę logowania Claude.')),
      h('button', { class: 'btn primary lg', disabled: C.installing || null, onclick: installAndLogin }, C.installing ? spinner(14) : iconEl('upload', 15), C.installing ? 'Instaluję…' : 'Zainstaluj i połącz')));
    if (C.installing || C.log) wrap.append(h('pre', { class: 'acc-log' }, (C.log || '').split('\n').slice(-6).join('\n')));
    return wrap;
  }
  const L = C.login;
  if (!L) {
    wrap.append(h('div', { class: 'acc-row' }, logo(),
      h('div', { style: { flex: 1 } },
        h('div', { class: 'acc-title' }, 'Zaloguj się swoim kontem Claude'),
        h('div', { class: 'muted small' }, 'Otworzy się strona logowania Claude w przeglądarce – zaloguj się tak samo jak na claude.ai.')),
      h('button', { class: 'btn primary lg', onclick: startLogin }, iconEl('key', 15), 'Zaloguj się')));
    return wrap;
  }
  const code = h('input', { class: 'input', style: { flex: 1 }, placeholder: 'Wklej kod ze strony logowania (jeśli się pojawił)' });
  wrap.append(
    h('div', { class: 'acc-row' }, h('div', { class: 'acc-logo' }, spinner(20)),
      h('div', { style: { flex: 1 } },
        h('div', { class: 'acc-title' }, 'Czekam na zalogowanie w przeglądarce…'),
        h('div', { class: 'muted small' }, 'Zaloguj się na stronie Claude, która otworzyła się w przeglądarce. Po zalogowaniu aplikacja połączy się sama.')),
      h('button', { class: 'btn', onclick: async () => { await platform.claude.cancel(); C.login = null; render(); } }, 'Anuluj')),
    h('div', { class: 'acc-sub' },
      L.url ? h('button', { class: 'btn plain sm', onclick: () => platform.openExternal(L.url) }, iconEl('globe', 12), 'Przeglądarka się nie otworzyła? Otwórz stronę logowania') : null,
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } }, code,
        h('button', { class: 'btn primary', onclick: async () => { if (!code.value.trim()) return; try { await platform.claude.code(code.value); toast('Przekazano kod – trwa łączenie…', 'info', 3000); } catch (er) { errToast(er); } } }, 'Zatwierdź kod'))));
  return wrap;
}

async function refreshClaude() {
  try { state.claude.status = await platform.claude.status(); } catch (e) { state.claude.status = { installed: false, loggedIn: false }; }
  if (state.view === 'settings') render(true);
}

async function installAndLogin() {
  const C = state.claude;
  C.installing = true; C.log = ''; render();
  try {
    C.status = await platform.claude.install();
    C.installing = false; render();
    if (C.status.installed && !C.status.loggedIn) await startLogin();
  } catch (e) { C.installing = false; errToast(e); render(); }
}

async function startLogin() {
  const C = state.claude;
  try { C.login = { stage: 'start' }; render(); await platform.claude.login(); state.settings = (await platform.load()).settings; } catch (e) { C.login = null; errToast(e); render(); }
}

init().catch((e) => { console.error(e); document.getElementById('content').textContent = 'Błąd uruchamiania: ' + (e.message || e); });
