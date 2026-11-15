'use strict';
/* global UI, Core, Market, Charts, platform, icon */
const { h, iconEl, toast, sheet, toggle, segmented, select, spinner, group, row, busy } = UI;

const state = {
  info: null,
  settings: null,
  data: null,
  view: 'dashboard',
  backTo: 'dashboard',
  coinId: null,
  market: {}, // id → notowanie
  rates: null, // kursy walut względem USD (do przeliczania cen zakupu)
  statsDays: 30,
  top: null, // ranking (pierwsza strona)
  topError: null,
  conn: { status: 'connecting', lastUpdate: 0, error: '' },
  chartDays: 7,
  settingsTab: 'general',
  browser: null, // stan podglądu w przeglądarce (tylko komputer)
  onQuotes: null,
  consensus: {}, // id → porównanie cen z wielu źródeł (extras.js)
  priceSrc: { at: 0, errors: {}, ok: [], fx: null },
  histMode: 'lots', // wykres historii portfela: 'lots' (wg wpisów) | 'current' (obecne ilości)
  news: { items: {}, at: 0, loading: false, errors: 0, feeds: null, filter: 'all', coin: '' }
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
  Market.setKey(state.settings.market.cgKey);
  applyPalette();
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
  // dane lub ustawienia zmienione poza tym oknem (druga karta przeglądarki, okno aplikacji)
  platform.on('data:external', (data) => applyExternal({ data }));
  platform.on('settings:external', (settings) => applyExternal({ settings }));
  platform.on('state:external', (st) => applyExternal(st));
  window.addEventListener('online', () => refresh(true));
  window.addEventListener('offline', () => { state.conn = { ...state.conn, status: 'offline', error: 'Brak połączenia z internetem.' }; renderSidebar(); });
  window.onAppBack = onBack;

  render();
  if (state.info.platform === 'android' || (window.matchMedia && matchMedia('(pointer: coarse)').matches)) initPullToRefresh(); // przeciągnięcie w dół = pełna aktualizacja
  refresh(); // po uruchomieniu od razu łączymy się z siecią i pobieramy notowania
  startIntelLoop(); // wiadomości i anomalie w tle
}

function applyExternal({ data, settings }) {
  if (settings) {
    const curChanged = settings.market && settings.market.currency !== cur();
    state.settings = settings;
    applyPalette();
    if (curChanged) { state.market = {}; state.consensus = {}; state.top = null; state.rates = null; Market.clearCache(); state.conn.lastUpdate = 0; refresh(true); }
  }
  if (data) state.data = Core.sanitizeData(data);
  softRender();
}

// Motyw kolorystyczny: atrybut na <html> przełącza zmienne w styles.css
function applyPalette() {
  const id = (state.settings && state.settings.ui && state.settings.ui.palette) || 'ocean';
  document.documentElement.dataset.palette = id;
  const meta = document.querySelector('meta[name="theme-color"]');
  const pal = Core.PALETTES.find((x) => x.id === id);
  if (meta && pal) meta.setAttribute('content', pal.color);
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
    applyPalette();
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
  Object.keys(state.data.lots).forEach((id) => ids.add(id));
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
    const oracleJob = startOracles(ids); // ceny z oracle i giełd pobierane równolegle z notowaniami
    const quotes = await Market.quotes(ids, cur());
    for (const q of quotes) state.market[q.id] = q;
    applyOracles(await oracleJob, ids);
    // uzupełnij ikony i nazwy obserwowanych (np. po dodaniu z wyszukiwarki lub ze zrzutu)
    let touched = false;
    for (const w of state.data.watch) {
      const q = state.market[w.id];
      if (q && (w.image !== q.image || w.name !== q.name || w.symbol !== q.symbol)) { w.image = q.image || w.image; w.name = q.name; w.symbol = q.symbol; touched = true; }
    }
    if (touched) saveData();
    if (needRates()) { try { state.rates = await Market.rates(); } catch (_) { /* zostają poprzednie kursy */ } }
    failures = 0;
    state.conn = { status: 'live', lastUpdate: Date.now(), error: '' };
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

// Kursy walut są potrzebne tylko wtedy, gdy któryś wpis ma cenę w innej walucie niż bieżąca.
function needRates() {
  return Object.values(state.data.lots).some((list) => list.some((l) => l.price != null && l.currency !== cur()));
}

const lotsOf = (id) => state.data.lots[id] || [];
const posStats = (id) => Core.positionStats(lotsOf(id), (state.market[id] || {}).price, cur(), state.rates);
const assetsWord = (n) => `${n} ${n === 1 ? 'aktywo' : n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14) ? 'aktywa' : 'aktywów'}`;
const signed = (v) => (v == null ? '—' : (v > 0 ? '+' : '') + money(v));

function afterQuotes() {
  if (state.onSheetQuotes) state.onSheetQuotes();
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
    h('div', { style: { minWidth: 0 } }, h('div', { class: 'c-name' }, c.name), h('div', { class: 'c-sym' }, h('span', { class: 'up-sym' }, c.symbol), extra ? ' · ' + extra : '')));
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

function removePosition(id) {
  delete state.data.holdings[id];
  delete state.data.lots[id];
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
  const items = [
    ['dashboard', 'home', 'Pulpit'],
    ['alerts', 'bell', 'Alerty', hiAnomalies().length || null],
    ['calc', 'calc', 'Kalkulator'],
    ['stats', 'pie', 'Statystyki']
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
  const views = { dashboard: viewDashboard, alerts: viewNews, calc: viewCalc, stats: viewStats, settings: viewSettings, coin: viewCoin };
  const el = (views[state.view] || viewDashboard)();
  if (!keepScroll) el.classList.add('fade-in');
  c.replaceChildren(el);
  if (keepScroll) c.scrollTop = top;
  const titles = { dashboard: 'Pulpit', alerts: 'Alerty', calc: 'Kalkulator', stats: 'Statystyki', settings: 'Ustawienia', coin: coinInfo(state.coinId).name };
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
// Pulpit = dawny Pulpit + Portfel: wartość aktywów, udział (wykres kołowy) i tabela aktywów z wykresem 7 dni
// w wolnym miejscu między ikoną aktywa a ceną. Obserwowane są poniżej.
function viewDashboard() {
  const p = Core.portfolio(state.data.holdings, state.market);
  const hasHoldings = p.items.length > 0;
  const loading = !state.conn.lastUpdate && state.conn.status !== 'offline';
  const page = h('div', { class: 'page' }, offlineBanner(), anomalyBanner());

  if (hasHoldings) {
    const segs = allocSegments(p);
    const ps = Core.portfolioStats(state.data, state.market, cur(), state.rates, coinInfo);
    page.append(h('div', { class: 'card total' },
      h('div', { class: 'total-main' },
        h('div', { class: 'total-label' }, 'Wartość aktywów'),
        h('div', { class: 'total-value' }, loading ? '…' : money(p.total)),
        loading ? null : h('div', { class: 'total-change' }, pctChip(p.change24hPct),
          h('span', { class: pctClass(p.change24hValue) }, signed(p.change24hValue)), h('span', { class: 'muted' }, 'w ciągu 24 h')),
        loading || ps.pnl == null ? null : h('div', { class: 'total-change' }, pctChip(ps.pnlPct),
          h('span', { class: pctClass(ps.pnl) }, signed(ps.pnl)), h('span', { class: 'muted' }, 'od zakupu' + (ps.cost > 0 ? ` (zainwestowano ${money(ps.cost)})` : '')))),
      loading ? null : h('div', { class: 'total-side pie-side', role: 'button', title: 'Otwórz statystyki', onclick: () => go('stats') }, donutBox(segs, 132, 22), allocLegend(segs))));

    page.append(h('div', { class: 'section-head' }, h('h2', null, 'Twoje aktywa'), h('span', { class: 'muted' }, assetsWord(p.items.length))));
    page.append(h('div', { class: 'card coin-list holdings portfolio-list' },
      h('div', { class: 'coin-head' }, h('div', { class: 'c-coin' }, 'Aktywo'), h('div', { class: 'c-chart' }, '7 dni'), h('div', { class: 'c-amt', style: { textAlign: 'right' } }, 'Ilość'), h('div', { class: 'c-price' }, 'Cena'), h('div', { class: 'c-val' }, 'Wartość'), h('div', { class: 'c-pnl' }, 'Zysk / strata'), h('div', { class: 'c-pct' }, '24 h'), h('div', { class: 'c-act' })),
      p.items.map((i) => {
        const c = coinInfo(i.id);
        const q = state.market[i.id] || {};
        const st = posStats(i.id);
        const spark = q.spark ? Charts.sparkline(q.spark, 160, 34) : null;
        if (spark) spark.setAttribute('preserveAspectRatio', 'none');
        return h('div', { class: 'coin-row click', onclick: () => go('coin', { id: i.id }) },
          coinCell(c, st.count ? `${st.count} ${st.count === 1 ? 'wpis' : st.count < 5 ? 'wpisy' : 'wpisów'}` : ''),
          h('div', { class: 'c-chart' }, spark),
          h('div', { class: 'c-amt' }, h('button', { class: 'amt-btn num', title: 'Edytuj wpisy (suma ilości)', 'aria-label': `Ilość ${c.name}: ${Core.fmtAmount(i.amount)}. Edytuj wpisy`, onclick: (e) => { e.stopPropagation(); openLots(i.id); } }, Core.fmtAmount(i.amount), iconEl('pencil', 12))),
          h('div', { class: 'c-price' }, money(q.price)),
          h('div', { class: 'c-val' }, money(i.value), h('div', { class: 'sub' }, i.value != null ? Core.fmtPct(i.share * 100, 1).replace('+', '') : 'brak notowań'),
            st.pnl != null ? h('div', { class: 'sub m-only ' + pctClass(st.pnl) }, `${signed(st.pnl)} (${Core.fmtPct(st.pnlPct, 1)})`) : null),
          h('div', { class: 'c-pnl ' + pctClass(st.pnl) }, st.pnl == null ? h('span', { class: 'muted' }, '—') : [signed(st.pnl), h('div', { class: 'sub' }, Core.fmtPct(st.pnlPct))]),
          pctEl(i.change24h),
          h('div', { class: 'c-act' },
            h('button', { class: 'icon-btn', title: 'Wpisy – zakupy i sprzedaże', 'aria-label': 'Wpisy – zakupy i sprzedaże', onclick: (e) => { e.stopPropagation(); openLots(i.id); }, html: icon('layers', 16) }),
            h('button', { class: 'icon-btn danger', title: 'Usuń pozycję', 'aria-label': 'Usuń pozycję', onclick: (e) => { e.stopPropagation(); confirmRemoveHolding(i.id); }, html: icon('trash', 16) })));
      })));
    page.append(h('p', { class: 'group-footer' }, '„Ilość” to suma wpisów danej kryptowaluty. Kliknij ją (lub ikonę z warstwami), aby dodać kolejny zakup albo poprawić datę, ilość i cenę dowolnego wpisu – zysk i strata liczą się od cen zakupu.'));
  } else {
    page.append(h('div', { class: 'card onboard' },
      h('div', { class: 'ob-ic', html: icon('wallet', 30) }),
      h('h2', null, 'Dodaj swoje kryptowaluty'),
      h('p', null, 'Wybierz kryptowalutę i wpisz, ile jej masz – kolejne zakupy dopisujesz jako osobne wpisy, a aplikacja sumuje ilość i na bieżąco wycenia aktywa. Możesz też zaimportować plik z innego urządzenia.'),
      h('div', { class: 'acts' },
        h('button', { class: 'btn primary lg', onclick: addHoldingFlow }, iconEl('plus', 16), 'Dodaj pozycję'),
        h('button', { class: 'btn lg', onclick: importFile }, iconEl('upload', 16), 'Importuj plik'))));
  }

  page.append(h('div', { class: 'section-head' }, h('h2', null, 'Obserwowane'), h('div', { class: 'spacer' }),
    h('button', { class: 'btn plain sm', onclick: () => pickCoin({ title: 'Dodaj do obserwowanych', onPick: (c) => { addWatch(c); refresh(); render(true); } }) }, iconEl('plus', 13), 'Dodaj')));
  page.append(state.data.watch.length
    ? h('div', { class: 'card coin-list' }, marketHead(), sortedWatch().map((w) => marketRow(w)))
    : h('div', { class: 'card empty' }, 'Nie obserwujesz jeszcze żadnej kryptowaluty.'));

  return h('div', null,
    h('div', { class: 'toolbar' }, h('h1', null, 'Pulpit'), h('div', { class: 'spacer' }),
      h('button', { class: 'btn', title: 'Zapisz portfel do pliku', onclick: exportFile }, iconEl('download', 15), h('span', { class: 'opt' }, 'Eksport')),
      h('button', { class: 'btn', title: 'Wczytaj portfel z pliku', onclick: importFile }, iconEl('upload', 15), h('span', { class: 'opt' }, 'Import')),
      h('button', { class: 'btn primary', onclick: addHoldingFlow }, iconEl('plus', 15), 'Dodaj pozycję')),
    page);
}

// Segmenty struktury portfela z kolorami (największe pozycje + „Inne”).
function allocSegments(p, max = 6) {
  return Core.allocation(p.items, (id) => (coinInfo(id).symbol || id).toUpperCase(), max)
    .map((s, k) => ({ ...s, color: s.id ? ALLOC_COLORS[k % 7] : ALLOC_COLORS[7], title: `${s.label}: ${money(s.value)} (${Core.fmtPct(s.share * 100, 1).replace('+', '')})` }));
}

function donutBox(segs, size, thickness, center) {
  return h('div', { class: 'donut-box', style: { width: size + 'px', height: size + 'px' } }, Charts.donut(segs, size, thickness), center ? h('div', { class: 'donut-center' }, center) : null);
}

function allocLegend(segs, withValue) {
  return h('div', { class: 'alloc-legend' + (withValue ? ' col' : '') }, segs.map((s) => h('span', null, h('i', { class: 'sw', style: { background: s.color } }), h('b', null, s.label),
    Core.fmtPct(s.share * 100, 1).replace('+', ''), withValue ? h('em', null, money(s.value)) : null)));
}

function sortedWatch() {
  return [...state.data.watch].sort((a, b) => ((state.market[b.id] || {}).marketCap || 0) - ((state.market[a.id] || {}).marketCap || 0));
}

// ───────────────────────── ranking (dla wyszukiwarki monet) ─────────────────────────
let topLoading = false;
async function loadTop() {
  if (topLoading) return;
  topLoading = true;
  try {
    state.top = await Market.top(cur(), 1);
    state.topError = null;
  } catch (e) { if (!state.top) state.topError = e.message; }
  topLoading = false;
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

// ───────────────────────── usuwanie pozycji ─────────────────────────
function confirmRemoveHolding(id) {
  const c = coinInfo(id);
  const n = lotsOf(id).length;
  sheet({
    title: `Usunąć ${c.name} z portfela?`,
    subtitle: (n ? `Usuniętych zostanie ${n} ${n === 1 ? 'wpis' : n < 5 ? 'wpisy' : 'wpisów'}. ` : '') + 'Kryptowaluta pozostanie na liście obserwowanych.',
    body: h('div'),
    actions: [{ label: 'Anuluj' }, { label: 'Usuń pozycję', kind: 'danger', onClick: () => { removePosition(id); render(true); } }],
    onClose: () => { if (state.view === 'dashboard') render(true); }
  });
}

// ───────────────────────── wpisy pozycji ─────────────────────────
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dateStr = (iso) => (iso ? new Date(iso + 'T12:00:00').toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' }) : 'bez daty');

// Okno wpisów pozycji: każdy zakup/sprzedaż to osobny wpis z datą, ilością i ceną – wszystkie pola można poprawiać
// wprost na liście. Posiadana ilość jest zawsze sumą wpisów i przelicza się po każdej zmianie.
function openLots(id) {
  const c = coinInfo(id);
  const sym = String(c.symbol || '').toUpperCase();
  const body = h('div');
  const summaryBox = h('div');
  const listBox = h('div');
  const form = { type: 'buy', date: todayIso(), amount: '', price: '' };
  const results = new Map(); // id wpisu → element z wynikiem
  const typeOpts = [{ value: 'buy', label: 'Kupno' }, { value: 'sell', label: 'Sprzedaż' }];
  if (!state.rates && needRates()) Market.rates().then((r) => { state.rates = r; refreshDerived(); }).catch(() => {});

  const commit = (lots) => {
    state.data = Core.applyLots(state.data, id, lots);
    if (state.data.holdings[id] > 0 && !isWatched(id)) addWatch(c, true);
    saveData(); updateTray();
    if (!state.market[id] || state.market[id].price == null) refresh();
    softRender(); // pulpit i portfel pod oknem od razu pokazują nową sumę
    refreshDerived();
  };

  // zmiana jednego pola wpisu; revert przywraca poprzednią wartość w polu, gdy zmiana jest niedozwolona
  const change = (lotId, patch, revert) => {
    const next = lotsOf(id).map((l) => (l.id === lotId ? { ...l, ...patch } : l));
    if (Core.lotsBalance(next) < -1e-12) { toast('Sprzedaż nie może przekraczać posiadanej ilości – zmniejsz sprzedaż lub dodaj zakup.', 'error', 6000); revert(); return; }
    commit(next);
  };

  const refreshDerived = () => {
    const q = state.market[id] || {};
    const st = posStats(id);
    const cell = (k, v, cls, sub) => h('div', { class: 'kv' }, h('div', { class: 'k' }, k), h('div', { class: 'v ' + (cls || '') }, v), sub ? h('div', { class: 'k ' + (cls || '') }, sub) : null);
    summaryBox.replaceChildren(h('div', { class: 'card', style: { overflow: 'hidden', marginBottom: '14px' } }, h('div', { class: 'kv-grid' },
      cell('Posiadana ilość (suma wpisów)', `${Core.fmtAmount(st.total)} ${sym}`, '', st.count ? `${st.count} ${st.count === 1 ? 'wpis' : st.count < 5 ? 'wpisy' : 'wpisów'}` : ''),
      cell('Wartość', st.value != null ? money(st.value) : '—', '', isFinite(q.price) ? `cena ${money(q.price)}` : 'brak notowań'),
      cell('Średnia cena zakupu', st.avgPrice != null ? money(st.avgPrice) : '—', '', st.cost > 0 ? `zainwestowano ${money(st.cost)}` : 'uzupełnij ceny zakupu'),
      cell('Zysk / strata od zakupu', signed(st.pnl), pctClass(st.pnl), st.pnl != null ? Core.fmtPct(st.pnlPct) : ''),
      st.realized ? cell('Zysk zrealizowany (sprzedaże)', signed(st.realized), pctClass(st.realized)) : null)));
    for (const l of lotsOf(id)) {
      const el = results.get(l.id);
      if (!el) continue;
      const r = Core.lotResult(l, q.price, cur(), state.rates);
      const foreign = l.price != null && l.currency !== cur();
      el.replaceChildren(...[
        l.type === 'sell'
          ? h('div', null, r.value != null ? money(r.value) : '—', h('div', { class: 'sub' }, 'przychód'))
          : h('div', { class: pctClass(r.pnl) }, r.pnl != null ? signed(r.pnl) : '—', h('div', { class: 'sub' }, r.pnl != null ? Core.fmtPct(r.pnlPct) : l.price == null ? 'brak ceny zakupu' : 'brak notowań')),
        foreign ? h('div', { class: 'sub' }, r.unitPrice != null ? `cena ≈ ${money(r.unitPrice)} dziś` : 'inna waluta') : null].filter(Boolean));
    }
  };

  const entryRow = (l) => {
    const now = () => lotsOf(id).find((x) => x.id === l.id) || l; // aktualna wersja wpisu (po wcześniejszych poprawkach)
    const typeSel = select(typeOpts, l.type, (v) => change(l.id, { type: v }, () => { typeSel.value = now().type; }), { 'aria-label': 'Rodzaj wpisu' });
    const date = h('input', { class: 'input', type: 'date', max: todayIso(), value: l.date || '', 'aria-label': 'Data',
      onchange: (e) => { if (e.target.value > todayIso()) { toast('Data nie może być z przyszłości', 'error'); e.target.value = now().date || ''; return; } change(l.id, { date: e.target.value }, () => { e.target.value = now().date || ''; }); } });
    const amount = h('input', { class: 'input', inputmode: 'decimal', value: Core.fmtAmount(l.amount), 'aria-label': `Ilość (${sym})`,
      onfocus: (e) => e.target.select(),
      onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
      onchange: (e) => {
        const n = Core.parseAmount(e.target.value);
        if (!isFinite(n) || n <= 0) { toast('Wpisz ilość większą od zera, np. 0,25', 'error'); e.target.value = Core.fmtAmount(now().amount); return; }
        change(l.id, { amount: n }, () => { e.target.value = Core.fmtAmount(now().amount); });
        e.target.value = Core.fmtAmount(n);
      } });
    const price = h('input', { class: 'input', inputmode: 'decimal', placeholder: 'brak', value: l.price != null ? String(l.price).replace('.', ',') : '', 'aria-label': `Cena za 1 ${sym}`,
      onfocus: (e) => e.target.select(),
      onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
      onchange: (e) => {
        const raw = e.target.value.trim();
        const n = raw === '' ? null : Core.parseAmount(raw);
        if (n != null && (!isFinite(n) || n < 0)) { toast('Wpisz poprawną cenę albo zostaw pole puste', 'error'); e.target.value = now().price != null ? String(now().price).replace('.', ',') : ''; return; }
        change(l.id, { price: n }, () => { e.target.value = now().price != null ? String(now().price).replace('.', ',') : ''; });
      } });
    const res = h('div', { class: 'e-res num' });
    results.set(l.id, res);
    return h('div', { class: 'entry-row' },
      h('div', { class: 'e-type' }, typeSel),
      h('div', { class: 'e-date' }, date),
      h('div', { class: 'e-amt' }, amount),
      h('div', { class: 'e-price' }, price, h('span', { class: 'e-cur' }, (l.currency || 'usd').toUpperCase())),
      res,
      h('div', { class: 'e-act' }, h('button', { class: 'icon-btn danger', title: 'Usuń wpis', 'aria-label': 'Usuń wpis', onclick: () => {
        const next = lotsOf(id).filter((x) => x.id !== l.id);
        commit(next); drawList();
      }, html: icon('trash', 15) })));
  };

  function drawList() {
    results.clear();
    const lots = [...lotsOf(id)].reverse(); // najnowsze na górze
    if (!lots.length) {
      listBox.replaceChildren(h('div', { class: 'empty', style: { padding: '14px 0 18px' } }, 'Brak wpisów. Dodaj pierwszy poniżej – np. „10 marca kupiłem 0,05 BTC po 250 000 zł”.'));
    } else {
      listBox.replaceChildren(
        h('div', { class: 'lot-list entries' },
          h('div', { class: 'entry-head' }, h('div', { class: 'e-type' }, 'Rodzaj'), h('div', { class: 'e-date' }, 'Data'), h('div', { class: 'e-amt' }, `Ilość (${sym})`), h('div', { class: 'e-price' }, `Cena za 1 ${sym}`), h('div', { class: 'e-res' }, 'Wynik'), h('div', { class: 'e-act' })),
          lots.map(entryRow)),
        lots.some((l) => l.type === 'buy' && l.price == null)
          ? h('p', { class: 'group-footer', style: { marginTop: '-6px' } }, 'Wpisy bez ceny zakupu liczą się do ilości i wartości, ale nie do zysku i straty – wpisz cenę wprost na liście, aby je uwzględnić.') : null);
    }
    refreshDerived();
  }

  const add = () => {
    const amount = Core.parseAmount(form.amount);
    const price = String(form.price).trim() === '' ? null : Core.parseAmount(form.price);
    if (!isFinite(amount) || amount <= 0) { toast('Wpisz ilość większą od zera', 'error'); return; }
    if (price != null && (!isFinite(price) || price < 0)) { toast('Wpisz poprawną cenę albo zostaw pole puste', 'error'); return; }
    if (form.date && form.date > todayIso()) { toast('Data nie może być z przyszłości', 'error'); return; }
    const lot = { id: uid(), type: form.type, date: form.date, amount, price, currency: cur() };
    const next = [...lotsOf(id), lot];
    if (Core.lotsBalance(next) < -1e-12) { toast(`Nie możesz sprzedać więcej, niż posiadasz (${Core.fmtAmount(posStats(id).total)} ${sym})`, 'error', 5000); return; }
    Object.assign(form, { amount: '', price: '' });
    commit(next);
    drawList();
    drawForm();
    toast('Dodano wpis – suma zaktualizowana', 'success', 1600);
    const first = body.querySelector('.lot-add input[inputmode]');
    if (first) first.focus();
  };

  const fetchPrice = async (btn, priceInput) => {
    if (!form.date) { toast('Wybierz datę', 'error'); return; }
    await busy(btn, async () => {
      try {
        let v;
        if (form.date === todayIso() && isFinite((state.market[id] || {}).price)) v = state.market[id].price;
        else {
          const r = await Svc.history.priceOn(coinInfo(id), cur(), form.date);
          v = r.price;
          if (r.approx) toast('Cena przybliżona (zapasowe źródło danych).', 'info', 4000);
        }
        form.price = String(Number(v.toPrecision(8))).replace('.', ',');
        priceInput.value = form.price;
        priceInput.dispatchEvent(new Event('input'));
      } catch (e) { errToast(e); }
    }, 'Pobieram…');
  };

  const formBox = h('div', { class: 'lot-add' });
  function drawForm() {
    const amountInput = h('input', { class: 'input', inputmode: 'decimal', placeholder: 'np. 0,25', value: form.amount, 'aria-label': 'Ilość', oninput: (e) => { form.amount = e.target.value; sum(); }, onkeydown: (e) => { if (e.key === 'Enter') add(); } });
    const priceInput = h('input', { class: 'input', inputmode: 'decimal', placeholder: 'opcjonalnie', value: form.price, 'aria-label': 'Cena za jednostkę', oninput: (e) => { form.price = e.target.value; sum(); }, onkeydown: (e) => { if (e.key === 'Enter') add(); } });
    const total = h('div', { class: 'row-hint' });
    const sum = () => { const a = Core.parseAmount(form.amount); const pr = Core.parseAmount(form.price); total.textContent = isFinite(a) && isFinite(pr) ? `Razem: ${money(a * pr)}` : ''; };
    const priceBtn = h('button', { class: 'btn', type: 'button', title: 'Pobierz cenę z wybranego dnia' }, iconEl('clock', 14), 'Cena z dnia');
    priceBtn.addEventListener('click', () => fetchPrice(priceBtn, priceInput));
    formBox.replaceChildren(
      h('div', { class: 'card-title', style: { marginBottom: '8px' } }, 'Nowy wpis'),
      h('div', { class: 'lot-form' },
        h('div', { class: 'field' }, h('label', null, 'Rodzaj'), segmented(typeOpts, form.type, (v) => { form.type = v; drawForm(); })),
        h('div', { class: 'field' }, h('label', null, 'Data'), h('input', { class: 'input', type: 'date', max: todayIso(), value: form.date, 'aria-label': 'Data', onchange: (e) => { form.date = e.target.value; } })),
        h('div', { class: 'field' }, h('label', null, `Ilość (${sym})`), amountInput),
        h('div', { class: 'field grow' }, h('label', null, `Cena za 1 ${sym} (${cur().toUpperCase()})`), h('div', { class: 'inline-form' }, priceInput, priceBtn), total)),
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '6px' } }, h('button', { class: 'btn primary', onclick: add }, iconEl('plus', 14), 'Dodaj wpis')));
    sum();
  }

  body.append(summaryBox, listBox, formBox);
  state.onSheetQuotes = refreshDerived;
  sheet({ title: `${c.name} – wpisy`, subtitle: 'Każdy zakup lub sprzedaż to osobny wpis. Posiadana ilość to ich suma – popraw dowolne pole wprost na liście, a wartość i wynik przeliczą się od razu.', body, wide: true, actions: [{ label: 'Gotowe', kind: 'primary' }], onClose: () => { state.onSheetQuotes = null; render(true); } });
  drawList();
  drawForm();
  setTimeout(() => { const f = formBox.querySelector('input[inputmode]'); if (f && !lotsOf(id).length) f.focus(); }, 120);
}

// ───────────────────────── eksport / import pliku ─────────────────────────
async function exportFile() {
  try {
    const name = Core.exportFileName();
    const where = await platform.saveFile(name, JSON.stringify(Core.buildExport(state.data, state.settings), null, 2));
    if (where) toast(platform.desktop ? `Zapisano portfel: ${where}` : 'Plik portfela gotowy', 'success', 5000);
  } catch (e) { errToast(e); }
}

function importFile() {
  const input = h('input', { type: 'file', accept: '.json,application/json', class: 'hide' });
  document.body.appendChild(input);
  input.addEventListener('change', async () => {
    const f = input.files[0];
    input.remove();
    if (!f) return;
    try {
      if (f.size > 5 * 1024 * 1024) throw new Error('Plik jest zbyt duży jak na plik CoinTracko (limit 5 MB).');
      const imp = Core.parseImport(await f.text());
      const c = imp.counts;
      if (!c.holdings && !c.watch) throw new Error('Ten plik nie zawiera żadnych danych portfela.');
      let mode = Object.keys(state.data.holdings).length ? 'merge' : 'replace';
      const apply = () => {
        state.data = Core.mergeImport(state.data, imp.data, mode);
        saveData(); updateTray(); refresh(); go('dashboard');
        toast('Zaimportowano portfel z pliku', 'success', 3000);
      };
      sheet({
        title: 'Importuj portfel z pliku',
        subtitle: imp.exportedAt ? `Plik zapisano ${dateTimeStr(Date.parse(imp.exportedAt))}.` : f.name,
        body: h('div', null,
          h('div', { class: 'note-box' }, iconEl('info', 16), h('div', null, `W pliku: pozycji w portfelu ${c.holdings}, wpisów ${c.lots}, obserwowanych ${c.watch}.`)),
          Object.keys(state.data.holdings).length ? h('div', { class: 'field' }, h('label', null, 'Co zrobić z obecnymi danymi?'),
            segmented([{ value: 'merge', label: 'Połącz z plikiem' }, { value: 'replace', label: 'Zastąp danymi z pliku' }], mode, (v) => { mode = v; }),
            h('div', { class: 'row-hint' }, 'Połączenie: monety z pliku dostają wpisy z pliku (zastępują obecne wpisy tej monety), pozostałe zostają bez zmian. Zastąpienie: aktywa i obserwowane będą dokładnie takie jak w pliku.')) : null),
        actions: [{ label: 'Anuluj' }, { label: 'Importuj', kind: 'primary', onClick: apply }]
      });
    } catch (e) { errToast(e); }
  });
  input.click();
}

// ───────────────────────── statystyki ─────────────────────────
function viewStats() {
  const ps = Core.portfolioStats(state.data, state.market, cur(), state.rates, coinInfo);
  const p = Core.portfolio(state.data.holdings, state.market);
  const page = h('div', { class: 'page' }, offlineBanner());
  const head = h('div', { class: 'toolbar' }, h('h1', null, 'Statystyki'));
  if (!p.items.length) {
    page.append(h('div', { class: 'card onboard' },
      h('div', { class: 'ob-ic', html: icon('pie', 30) }),
      h('h2', null, 'Statystyki pojawią się po dodaniu portfela'),
      h('p', null, 'Dodaj posiadane kryptowaluty – zobaczysz strukturę portfela, zysk i stratę od zakupu, zmiany wartości w czasie i wyniki poszczególnych pozycji.'),
      h('div', { class: 'acts' }, h('button', { class: 'btn primary lg', onclick: () => go('dashboard') }, iconEl('wallet', 16), 'Przejdź do portfela'))));
    return h('div', null, head, page);
  }
  const pct = (n, d) => (n == null ? '—' : Core.fmtPct(n, d));
  const stat = (label, ic, value, cls, sub, subCls) => h('div', { class: 'card stat' }, h('div', { class: 'label' }, iconEl(ic, 14), label), h('div', { class: 'value num ' + (cls || '') }, value), sub ? h('div', { class: 'stat-sub ' + (subCls || '') }, sub) : null);
  page.append(h('div', { class: 'grid grid-4' },
    stat('Wartość portfela', 'wallet', money(ps.total), '', assetsWord(ps.assets)),
    stat('Zainwestowano', 'coins', ps.cost > 0 ? money(ps.cost) : '—', '', ps.cost > 0 ? (ps.costCoverage < 0.995 ? `cena zakupu znana dla ${Core.fmtPct(ps.costCoverage * 100, 0).replace('+', '')} portfela` : 'koszt posiadanych tokenów') : 'wpisz ceny zakupu we wpisach (Portfel)'),
    stat('Zysk / strata od zakupu', 'arrowUp', signed(ps.pnl), pctClass(ps.pnl), ps.pnl != null ? pct(ps.pnlPct) : 'brak cen zakupu', pctClass(ps.pnlPct)),
    stat('Zysk zrealizowany', 'check', ps.realized ? signed(ps.realized) : '—', pctClass(ps.realized), 'ze sprzedaży zapisanych we wpisach')));
  page.append(h('div', { class: 'grid grid-4', style: { marginTop: '16px' } },
    stat('Zmiana 1 h', 'clock', pct(ps.change1hPct), pctClass(ps.change1hPct)),
    stat('Zmiana 24 h', 'chart', pct(ps.change24hPct), pctClass(ps.change24hPct), signed(ps.change24hValue), pctClass(ps.change24hValue)),
    stat('Zmiana 7 dni', 'calendar', pct(ps.change7dPct), pctClass(ps.change7dPct), signed(ps.change7dValue), pctClass(ps.change7dValue)),
    stat('Wpisy (zakupy i sprzedaże)', 'layers', String(ps.lotsCount), '', ps.firstDate ? `pierwszy zakup ${dateStr(ps.firstDate)}` : 'brak wpisów z datą')));

  // struktura portfela
  const segs = allocSegments(p, 7);
  page.append(h('div', { class: 'two-col' },
    h('div', { class: 'card card-pad' },
      h('div', { class: 'card-title' }, iconEl('pie', 16), 'Struktura portfela'),
      h('div', { class: 'pie-wrap' }, donutBox(segs, 210, 34, [h('div', { class: 'dc-k' }, 'Razem'), h('div', { class: 'dc-v num' }, money(ps.total, { compact: true }))]), allocLegend(segs, true))),
    h('div', { class: 'card card-pad' },
      h('div', { class: 'card-title' }, iconEl('flag', 16), 'Koncentracja i wyniki'),
      h('div', { class: 'facts' },
        fact('Największa pozycja', ps.largest ? `${ps.largest.coin.name} · ${pct(ps.largest.share * 100, 1).replace('+', '')}` : '—'),
        fact('Efektywna liczba aktywów', ps.effectiveAssets ? new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 1 }).format(ps.effectiveAssets) : '—', 'Im bliżej liczby pozycji, tym równiej rozłożony portfel'),
        fact('Udział stablecoinów', pct(ps.stableShare * 100, 1).replace('+', '')),
        fact('Najlepszy w 24 h', perf(ps.best24h, 'change24h'), null, ps.best24h && pctClass(ps.best24h.change24h)),
        fact('Najsłabszy w 24 h', perf(ps.worst24h, 'change24h'), null, ps.worst24h && pctClass(ps.worst24h.change24h)),
        fact('Najlepszy w 7 dni', perf(ps.best7d, 'change7d'), null, ps.best7d && pctClass(ps.best7d.change7d)),
        fact('Najsłabszy w 7 dni', perf(ps.worst7d, 'change7d'), null, ps.worst7d && pctClass(ps.worst7d.change7d)),
        fact('Najlepszy od zakupu', perf(ps.bestPnl, 'pnlPct'), null, ps.bestPnl && pctClass(ps.bestPnl.pnlPct)),
        fact('Najsłabszy od zakupu', perf(ps.worstPnl, 'pnlPct'), null, ps.worstPnl && pctClass(ps.worstPnl.pnlPct))))));

  // wartość w czasie (historia dzienna do 6 lat – extras.js)
  page.append(portfolioHistoryCard(p));

  // wyniki pozycji
  page.append(h('div', { class: 'section-head' }, h('h2', null, 'Wyniki pozycji')));
  page.append(h('div', { class: 'card', style: { overflowX: 'auto' } }, h('table', { class: 'tbl stats-tbl' },
    h('thead', null, h('tr', null, ['Aktywo', 'Ilość', 'Śr. cena zakupu', 'Zainwestowano', 'Wartość', 'Zysk / strata', 'Udział', '24 h', '7 dni', 'Od szczytu'].map((t, k) => h('th', { class: k ? 'r' : '' }, t)))),
    h('tbody', null, ps.rows.map((r) => h('tr', { class: 'click' + (r.closed ? ' off' : ''), onclick: () => go('coin', { id: r.id }) },
      h('td', null, h('div', { class: 'c-coin' }, coinIcon(r.coin), h('div', null, h('div', { class: 'c-name' }, r.coin.name), h('div', { class: 'c-sym' }, r.coin.symbol, r.closed ? ' · sprzedane' : '')))),
      h('td', { class: 'r num' }, Core.fmtAmount(r.total)),
      h('td', { class: 'r num' }, r.avgPrice != null ? money(r.avgPrice) : '—'),
      h('td', { class: 'r num' }, r.cost > 0 ? money(r.cost) : '—'),
      h('td', { class: 'r num' }, r.closed ? '—' : money(r.value)),
      h('td', { class: 'r num ' + pctClass(r.closed ? r.realized : r.pnl) }, r.closed ? [signed(r.realized), h('div', { class: 'sub' }, 'zrealizowany')] : r.pnl == null ? '—' : [signed(r.pnl), h('div', { class: 'sub' }, pct(r.pnlPct))]),
      h('td', { class: 'r num' }, r.closed ? '—' : pct(r.share * 100, 1).replace('+', '')),
      h('td', { class: 'r num ' + pctClass(r.change24h) }, pct(r.change24h)),
      h('td', { class: 'r num ' + pctClass(r.change7d) }, pct(r.change7d)),
      h('td', { class: 'r num ' + pctClass(r.athChange) }, pct(r.athChange, 1))))))));
  return h('div', null, head, page);
}

function fact(k, v, hint, cls) {
  return h('div', { class: 'fact' }, h('div', { class: 'f-k' }, k, hint ? h('div', { class: 'row-hint' }, hint) : null), h('div', { class: 'f-v num ' + (cls || '') }, v));
}
function perf(r, key) { return r ? `${r.coin.name} · ${Core.fmtPct(r[key])}` : '—'; }

function addHoldingFlow() {
  pickCoin({ title: 'Dodaj pozycję do portfela', onPick: (c) => {
    if (!state.market[c.id]) state.market[c.id] = { ...c };
    addWatch(c, true);
    refresh();
    setTimeout(() => openLots(c.id), 240); // po zamknięciu wyszukiwarki otwiera się okno wpisów
  } });
}

// ───────────────────────── szczegóły i wykres ─────────────────────────
const RANGES = [{ value: 1, label: '24 h' }, { value: 7, label: '7 dni' }, { value: 30, label: '30 dni' }, { value: 90, label: '90 dni' }, { value: 365, label: '1 rok' }, { value: 730, label: '2 lata' }, { value: 1825, label: '5 lat' }, { value: 2200, label: '6 lat' }];

function viewCoin() {
  const id = state.coinId;
  const c = coinInfo(id);
  const priceEl = h('div', { class: 'price' });
  const chipBox = h('span');
  const kv = h('div', { class: 'kv-grid' });
  const amtEl = h('div', { class: 'big-amt num' });
  const valueEl = h('div', { class: 'muted', style: { marginTop: '8px' } });
  const readout = h('div', { class: 'chart-readout' });
  const box = h('div', { class: 'chart-box' });
  const srcBox = h('div');
  let rangeInfo = '';

  const fillQuotes = () => {
    const q = state.market[id] || {};
    priceEl.textContent = money(q.price);
    srcBox.replaceChildren(priceSourcesCard(id));
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
    const st = posStats(id);
    amtEl.textContent = amt > 0 ? `${Core.fmtAmount(amt)} ${String(c.symbol).toUpperCase()}` : '—';
    valueEl.replaceChildren(amt > 0 && isFinite(q.price) ? `Wartość: ${money(amt * q.price)}` : amt > 0 ? 'Wartość: brak notowań' : 'Nie masz tej kryptowaluty w portfelu.',
      st.pnl != null ? h('div', { style: { marginTop: '4px' } }, 'Od zakupu: ', h('b', { class: pctClass(st.pnl) }, `${signed(st.pnl)} (${Core.fmtPct(st.pnlPct)})`), ` · średnia cena ${money(st.avgPrice)}`) : null);
  };

  let token = 0;
  const loadChart = async () => {
    const my = ++token;
    const days = state.chartDays;
    if (chartHandle) { chartHandle.destroy(); chartHandle = null; }
    box.replaceChildren(h('div', { class: 'center' }, spinner(18), 'Wczytuję wykres…'));
    readout.textContent = '';
    try {
      const pts = await coinChartPoints(id, days);
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
      srcBox,
      h('div', { class: 'card card-pad', style: { marginTop: '16px' } },
        h('div', { class: 'card-title' }, iconEl('wallet', 16), 'Twoja pozycja'),
        amtEl,
        valueEl,
        h('div', { style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: () => openLots(id) }, iconEl(lotsOf(id).length ? 'pencil' : 'plus', 14), lotsOf(id).length ? `Edytuj wpisy (${lotsOf(id).length})` : 'Dodaj ilość')))));
}

// ───────────────────────── ustawienia ─────────────────────────
function viewSettings() {
  const tabs = [
    { value: 'general', label: 'Ogólne', icon: 'gear' },
    { value: 'sources', label: 'Źródła i wiadomości', icon: 'shield' },
    { value: 'about', label: 'O aplikacji', icon: 'info' }
  ];
  const body = { general: settingsGeneral, sources: settingsSources, about: settingsAbout }[state.settingsTab]();
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
    group('Motyw kolorystyczny', [
      h('div', { class: 'palette-grid', role: 'radiogroup', 'aria-label': 'Motyw kolorystyczny' }, Core.PALETTES.map((x) => h('button', {
        class: 'palette-opt' + (s.ui.palette === x.id ? ' on' : ''), role: 'radio', 'aria-checked': s.ui.palette === x.id ? 'true' : 'false', title: x.label,
        onclick: async () => { await saveSettings({ ui: { palette: x.id } }, true); render(true); }
      }, h('span', { class: 'pal-dot', 'data-pal': x.id, style: { background: x.color } }), h('span', { class: 'pal-name' }, x.label))))
    ], 'Zmienia kolor wyróżniający i odcień tła. Jasny / ciemny wygląd wybierasz w ustawieniach okna lub według systemu.'),
    group('Notowania', [
      row('Waluta', select(Object.entries(Core.CURRENCIES).map(([value, c]) => ({ value, label: c.label })), s.market.currency, async (v) => {
        await saveSettings({ market: { currency: v } }, true); state.market = {}; state.consensus = {}; state.top = null; state.rates = null; Market.clearCache(); state.conn.lastUpdate = 0; refresh(true); render();
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
      row('Uruchamiaj z systemem', toggle(!!s.window.autostart, async (v) => { await saveSettings({ window: { autostart: v } }, true); render(true); }), { icon: 'power', color: 'var(--green)', hint: 'Aplikacja wczytuje się po zalogowaniu do systemu i od razu pobiera notowania oraz sprawdza alerty.' }),
      s.window.autostart ? row('Start w tle', toggle(s.window.startHidden !== false, (v) => saveSettings({ window: { startHidden: v } }, true)), { icon: 'eye', color: 'var(--indigo)', hint: 'Po uruchomieniu z systemem okno nie wyskakuje – aplikacja czeka w zasobniku (bez zasobnika: na pasku zadań).' }) : null,
      row('Wygląd', segmented([{ value: 'system', label: 'Systemowy' }, { value: 'light', label: 'Jasny' }, { value: 'dark', label: 'Ciemny' }], s.ui.theme, (v) => saveSettings({ ui: { theme: v } }, true)), { icon: 'moon', color: 'var(--purple)' })
    ], state.info.hasTray ? null : 'Na tym systemie nie udało się utworzyć ikony w zasobniku – okno będzie minimalizowane na pasek zadań.') : null,
    platform.desktop ? browserGroup() : null,
    group('Przenoszenie danych', [
      row('Zapisz portfel do pliku', h('button', { class: 'btn', onclick: exportFile }, iconEl('download', 14), 'Eksportuj'), { icon: 'download', color: 'var(--accent)', hint: 'Plik zawiera wpisy (ilości, daty, ceny) i obserwowane.' }),
      row('Wczytaj portfel z pliku', h('button', { class: 'btn', onclick: importFile }, iconEl('upload', 14), 'Importuj'), { icon: 'upload', color: 'var(--green)', hint: 'Ten sam plik działa na Linuksie i na Androidzie.' })
    ], platform.desktop ? null : 'Na Androidzie po eksporcie otworzy się okno udostępniania – zapisz plik w Plikach lub na Dysku albo wyślij go na inne urządzenie.'),
    group('Powiadomienia', [
      row('Sprawdź powiadomienia', h('button', { class: 'btn', onclick: async () => { if (platform.requestNotifications) platform.requestNotifications(); const ok = await platform.notify('CoinTracko', 'Tak będzie wyglądało powiadomienie o ważnym alercie.').catch(() => false); if (!ok) toast('System nie pozwolił wyświetlić powiadomienia – sprawdź uprawnienia aplikacji.', 'error', 6000); } }, 'Wyślij testowe'), { icon: 'bolt', color: 'var(--teal)', hint: 'Powiadomienia o poważnych alertach włączysz w Ustawieniach → Źródła i wiadomości.' })
    ]));
}

// Podgląd w przeglądarce: lokalny serwer w aplikacji (tylko ten komputer) – adres można otworzyć w Vivaldim lub Chrome.
function browserGroup() {
  const b = state.settings.browser || { enabled: false, port: 47820 };
  const box = h('div', { class: 'status-line' });
  const portInput = h('input', { class: 'input', style: { width: '90px' }, inputmode: 'numeric', value: String(b.port), 'aria-label': 'Port podglądu',
    onchange: async (e) => {
      const n = Number(e.target.value);
      if (!Number.isInteger(n) || n < 1024 || n > 65535) { toast('Podaj port z zakresu 1024–65535', 'error'); e.target.value = String(state.settings.browser.port); return; }
      await saveSettings({ browser: { port: n } }, true); showStatus();
    } });
  const showStatus = async () => {
    try {
      const st = await platform.browserStatus();
      if (!state.settings.browser.enabled) { box.className = 'status-line'; box.replaceChildren('Wyłączony.'); return; }
      if (st.running) {
        box.className = 'status-line ok';
        box.replaceChildren(iconEl('checkCircle', 14), h('span', { class: 'path' }, st.url),
          h('button', { class: 'btn sm', onclick: () => platform.browserOpen().catch(errToast) }, iconEl('external', 12), 'Otwórz w przeglądarce'),
          h('button', { class: 'btn sm', onclick: async () => { try { await navigator.clipboard.writeText(st.url); toast('Skopiowano adres', 'success', 1600); } catch (_) { toast(st.url, 'info', 6000); } } }, 'Kopiuj adres'));
      } else {
        box.className = 'status-line bad';
        box.replaceChildren(iconEl('warn', 14), st.error || 'Uruchamiam…');
        if (!st.error) setTimeout(showStatus, 600);
      }
    } catch (e) { box.className = 'status-line bad'; box.replaceChildren(iconEl('warn', 14), e.message); }
  };
  showStatus();
  return group('Podgląd w przeglądarce', [
    row('Udostępnij w przeglądarce', toggle(!!b.enabled, async (v) => { await saveSettings({ browser: { enabled: v } }, true); render(true); }), { icon: 'globe', color: 'var(--accent)', hint: 'Te same dane i wykresy otworzysz w Vivaldim, Chrome lub Edge. Adres działa tylko na tym komputerze, a aplikacja musi być uruchomiona.' }),
    b.enabled ? row('Port', portInput, { icon: 'cpu', color: 'var(--orange)' }) : null,
    row('Adres', box, { icon: 'external', color: 'var(--green)', stack: true })
  ], 'Vivaldi: dodaj adres jako panel internetowy (przycisk „+” na pasku bocznym) – wąski panel pokazuje wersję kompaktową. Zmiany zrobione w przeglądarce i w aplikacji synchronizują się w kilka sekund; alerty i powiadomienia obsługuje okno aplikacji.');
}

function settingsAbout() {
  return h('div', null,
    group('CoinTracko', [
      row('Wersja', h('span', { class: 'muted' }, state.info.version || '—'), { icon: 'info', color: 'var(--accent)' }),
      row('Notowania', h('button', { class: 'btn sm', onclick: () => platform.openExternal('https://www.coingecko.com') }, 'CoinGecko', iconEl('external', 12)), { icon: 'globe', color: 'var(--green)' }),
      platform.desktop ? row('Folder danych', h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' } }, h('span', { class: 'path' }, state.info.dataDir), h('button', { class: 'btn sm', onclick: () => platform.openDataDir() }, 'Otwórz')), { icon: 'folder', color: 'var(--orange)' }) : null
    ], 'Aktywa i obserwowane są zapisywane wyłącznie na tym urządzeniu. Notowania mają charakter informacyjny i nie stanowią porady inwestycyjnej.'));
}

init().catch((e) => { console.error(e); document.getElementById('content').textContent = 'Błąd uruchamiania: ' + (e.message || e); });
