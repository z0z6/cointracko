'use strict';
// Testy logiki bez Electrona: node test/run-tests.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Core = require('../src/renderer/core');
const { Store } = require('../src/main/store');
const { BrowserServer } = require('../src/main/web-server');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); } catch (e) { console.error('  ✗ ' + name + '\n    ' + (e.stack || e.message)); process.exitCode = 1; }
}
const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${a} ≠ ${b}${msg ? ' – ' + msg : ''}`);

console.log('Liczby');
test('parseAmount: formaty polskie i angielskie', () => {
  near(Core.parseAmount('1 234,56'), 1234.56);
  near(Core.parseAmount('1,234.56'), 1234.56);
  near(Core.parseAmount('1.234,56'), 1234.56);
  near(Core.parseAmount('0.00012345'), 0.00012345);
  near(Core.parseAmount('0,5'), 0.5);
  near(Core.parseAmount('1,234,567'), 1234567);
  near(Core.parseAmount('12k'), 12000);
  near(Core.parseAmount('1,5 mln'), 1500000);
  near(Core.parseAmount(42), 42);
  assert.ok(isNaN(Core.parseAmount('abc')));
  assert.ok(isNaN(Core.parseAmount('')));
  assert.ok(isNaN(Core.parseAmount(null)));
});
test('fmtMoney: małe ceny zachowują cyfry znaczące', () => {
  assert.ok(/0,00002314/.test(Core.fmtMoney(0.00002314, 'usd')));
  assert.ok(/97\s?250,00/.test(Core.fmtMoney(97250, 'usd')));
  assert.ok(/zł/.test(Core.fmtMoney(10, 'pln')));
  assert.strictEqual(Core.fmtMoney(null, 'usd'), '—');
  assert.strictEqual(Core.fmtPct(1.234), '+1,23%');
  assert.strictEqual(Core.fmtPct(-5), '−5,00%');
});

console.log('Portfel');
test('portfolio: wartość, udział i zmiana 24 h', () => {
  const p = Core.portfolio({ bitcoin: 0.5, ethereum: 2, ghost: 10 }, { bitcoin: { price: 100000, change24h: 10 }, ethereum: { price: 2500, change24h: -50 } });
  near(p.total, 55000);
  assert.strictEqual(p.items[0].id, 'bitcoin');
  near(p.items[0].share, 50000 / 55000);
  assert.strictEqual(p.unpriced, 1);
  // wczoraj: 50000/1.1 + 5000/0.5
  const prev = 50000 / 1.1 + 10000;
  near(p.change24hValue, 55000 - prev);
  near(p.change24hPct, ((55000 - prev) / prev) * 100);
});
test('portfolio: pusty portfel', () => {
  const p = Core.portfolio({}, {});
  assert.strictEqual(p.total, 0);
  assert.strictEqual(p.change24hPct, 0);
});
console.log('Alerty');
test('alert jednorazowy uruchamia się raz i wyłącza', () => {
  const alerts = [{ id: '1', coinId: 'bitcoin', type: 'above', value: 100, currency: 'usd', active: true, repeat: false }];
  let r = Core.evaluateAlerts(alerts, { bitcoin: { price: 99, change24h: 0 } }, 'usd');
  assert.strictEqual(r.fired.length, 0);
  r = Core.evaluateAlerts(r.alerts, { bitcoin: { price: 101, change24h: 0 } }, 'usd', 1234);
  assert.strictEqual(r.fired.length, 1);
  assert.strictEqual(r.alerts[0].active, false);
  assert.strictEqual(r.alerts[0].lastTriggered, 1234);
  r = Core.evaluateAlerts(r.alerts, { bitcoin: { price: 150, change24h: 0 } }, 'usd');
  assert.strictEqual(r.fired.length, 0);
});
test('alert powtarzalny uzbraja się ponownie po ustaniu warunku', () => {
  let alerts = [{ id: '1', coinId: 'bitcoin', type: 'below', value: 100, currency: 'usd', active: true, repeat: true }];
  let r = Core.evaluateAlerts(alerts, { bitcoin: { price: 90 } }, 'usd');
  assert.strictEqual(r.fired.length, 1);
  r = Core.evaluateAlerts(r.alerts, { bitcoin: { price: 80 } }, 'usd');
  assert.strictEqual(r.fired.length, 0, 'nie powtarza, dopóki warunek trwa');
  r = Core.evaluateAlerts(r.alerts, { bitcoin: { price: 120 } }, 'usd');
  assert.strictEqual(r.alerts[0].armed, true);
  r = Core.evaluateAlerts(r.alerts, { bitcoin: { price: 95 } }, 'usd');
  assert.strictEqual(r.fired.length, 1);
  assert.strictEqual(r.alerts[0].active, true);
});
test('alert procentowy i inna waluta', () => {
  const alerts = [
    { id: '1', coinId: 'eth', type: 'changeDown', value: 5, active: true },
    { id: '2', coinId: 'eth', type: 'changeUp', value: 5, active: true },
    { id: '3', coinId: 'eth', type: 'above', value: 1, currency: 'pln', active: true }
  ];
  const r = Core.evaluateAlerts(alerts, { eth: { price: 2000, change24h: -6.2 } }, 'usd');
  assert.deepStrictEqual(r.fired.map((f) => f.alert.id), ['1']);
  assert.strictEqual(r.alerts[2].active, true, 'alert w PLN nie uruchamia się przy notowaniach w USD');
  const msg = Core.alertMessage(r.fired[0], { name: 'Ethereum', symbol: 'eth' }, 'usd');
  assert.ok(/Ethereum \(ETH\)/.test(msg.title) && /6,20%/.test(msg.title));
});
test('brak notowań nie uruchamia alertu', () => {
  const r = Core.evaluateAlerts([{ id: '1', coinId: 'x', type: 'below', value: 5, active: true }], {}, 'usd');
  assert.strictEqual(r.fired.length, 0);
  assert.strictEqual(r.changed, false);
});

console.log('Wpisy pozycji');
const RATES = { usd: 1, pln: 4, eur: 0.5 };
test('positionStats: średnia cena, zysk niezrealizowany, część bez ceny', () => {
  const lots = [
    { id: 'a', type: 'buy', date: '2025-01-10', amount: 1, price: 100, currency: 'usd' },
    { id: 'b', type: 'buy', date: '2025-03-01', amount: 3, price: 200, currency: 'usd' }
  ];
  lots.push({ id: 'c', type: 'buy', date: '', amount: 1, price: null, currency: 'usd' });
  const st = Core.positionStats(lots, 300, 'usd', RATES);
  near(st.lotQty, 5); near(st.total, 5); near(st.knownQty, 4);
  near(st.cost, 700); near(st.avgPrice, 175);
  near(st.value, 1500);
  near(st.pnl, 4 * 300 - 700); near(st.pnlPct, (500 / 700) * 100);
  assert.strictEqual(st.firstDate, '2025-01-10');
});
test('positionStats: sprzedaż zmniejsza koszt proporcjonalnie i daje zysk zrealizowany', () => {
  const lots = [
    { id: 'a', type: 'buy', date: '2025-01-01', amount: 2, price: 100, currency: 'usd' },
    { id: 'b', type: 'buy', date: '2025-02-01', amount: 2, price: 300, currency: 'usd' },
    { id: 'c', type: 'sell', date: '2025-03-01', amount: 1, price: 500, currency: 'usd' }
  ];
  const st = Core.positionStats(lots, 400, 'usd', RATES);
  near(st.total, 3); near(st.cost, 600); near(st.avgPrice, 200);
  near(st.realized, 500 - 200);
  near(st.pnl, 3 * 400 - 600);
  near(Core.lotsNet(lots), 3);
});
test('positionStats: przeliczenie waluty partii i brak ceny', () => {
  const st = Core.positionStats([{ id: 'a', type: 'buy', date: '2025-01-01', amount: 2, price: 400, currency: 'pln' }, { id: 'b', type: 'buy', date: '', amount: 1, price: null, currency: 'usd' }], 150, 'usd', RATES);
  near(st.cost, 200); near(st.knownQty, 2); near(st.pnl, 100); near(st.value, 450);
  const none = Core.positionStats([{ id: 'z', type: 'buy', date: '', amount: 2, price: null, currency: 'usd' }], 10, 'usd', RATES);
  assert.strictEqual(none.pnl, null); near(none.value, 20);
  const r = Core.lotResult({ type: 'buy', amount: 2, price: 400, currency: 'pln' }, 150, 'usd', RATES);
  near(r.cost, 200); near(r.pnl, 100); near(r.pnlPct, 50);
});
test('ilość pozycji to suma wpisów – każdy wpis jest edytowalny', () => {
  let d = Core.sanitizeData({ watch: [], holdings: {}, lots: {}, alerts: [] });
  d = Core.applyLots(d, 'btc', [{ type: 'buy', date: '2025-05-05', amount: 0.5, price: 10, currency: 'usd' }]);
  near(d.holdings.btc, 0.5);
  assert.ok(d.lots.btc[0].id);
  d = Core.applyLots(d, 'btc', [...d.lots.btc, { type: 'buy', date: '2025-01-01', amount: 2, price: 5, currency: 'usd' }]);
  near(d.holdings.btc, 2.5, 'drugi wpis dodaje się do sumy');
  d = Core.applyLots(d, 'btc', [...d.lots.btc, { type: 'buy', date: '', amount: 1, price: null, currency: 'usd' }]);
  near(d.holdings.btc, 3.5, 'trzeci wpis (bez daty i ceny) też się sumuje');
  assert.strictEqual(d.lots.btc[0].date, '', 'wpisy bez daty na początku, reszta wg daty');
  // edycja ilości dowolnego wpisu zmienia sumę
  d = Core.applyLots(d, 'btc', d.lots.btc.map((l) => (l.date === '2025-01-01' ? { ...l, amount: 10 } : l)));
  near(d.holdings.btc, 11.5);
  // sprzedaż odejmuje
  d = Core.applyLots(d, 'btc', [...d.lots.btc, { type: 'sell', date: '2025-06-01', amount: 1.5, price: 20, currency: 'usd' }]);
  near(d.holdings.btc, 10);
  near(Core.lotsBalance([{ type: 'buy', amount: 1 }, { type: 'sell', amount: 3 }]), -2);
  d = Core.applyLots(d, 'btc', []);
  assert.strictEqual(d.holdings.btc, undefined); assert.strictEqual(d.lots.btc, undefined);
  d = Core.applyLots({ watch: [], holdings: {}, lots: {}, alerts: [] }, 'eth', [{ type: 'buy', amount: 1, price: 1 }, { type: 'sell', amount: 1, price: 2 }]);
  assert.strictEqual(d.holdings.eth, undefined);
  assert.strictEqual(d.lots.eth.length, 2, 'historia zamkniętej pozycji zostaje');
});
test('migracja: stara ilość „na sztywno” staje się zwykłym, edytowalnym wpisem', () => {
  const d = Core.sanitizeData({ holdings: { btc: 2, eth: 1 }, lots: { btc: [{ id: 'x', type: 'buy', date: '2026-11-14', amount: 0.5, price: 100, currency: 'usd' }] } });
  assert.strictEqual(d.lots.btc.length, 2);
  const start = d.lots.btc.find((l) => l.id === 'start-btc');
  assert.ok(start && start.date === '' && start.price === null);
  near(start.amount, 1.5); near(d.holdings.btc, 2);
  assert.strictEqual(d.lots.eth.length, 1); near(d.holdings.eth, 1);
  // ponowne czyszczenie nie dubluje wpisów
  const again = Core.sanitizeData(d);
  assert.strictEqual(again.lots.btc.length, 2); near(again.holdings.btc, 2);
  // wpis startowy można poprawić – suma idzie za nim
  const edited = Core.applyLots(again, 'btc', again.lots.btc.map((l) => (l.id === 'start-btc' ? { ...l, amount: 3, date: '2025-02-02', price: 40 } : l)));
  near(edited.holdings.btc, 3.5);
});

console.log('Statystyki');
test('portfolioStats: zainwestowano, zysk, koncentracja, najlepsze/najgorsze', () => {
  const data = Core.sanitizeData({ holdings: { btc: 1, eth: 10, usdt: 500 }, lots: { btc: [{ id: '1', type: 'buy', date: '2025-02-02', amount: 1, price: 500, currency: 'usd' }], eth: [{ id: '2', type: 'buy', date: '2025-01-01', amount: 10, price: 60, currency: 'usd' }] } });
  const market = { btc: { price: 1000, change24h: 10, change7d: 25, change1h: 1 }, eth: { price: 50, change24h: -5, change7d: -10, change1h: 0 }, usdt: { price: 1, change24h: 0, change7d: 0, change1h: 0 } };
  const st = Core.portfolioStats(data, market, 'usd', RATES, (id) => ({ symbol: id, name: id }));
  near(st.total, 2000); near(st.cost, 1100); near(st.pnl, 400); near(st.pnlPct, (400 / 1100) * 100);
  near(st.costCoverage, 1500 / 2000); near(st.stableShare, 0.25);
  assert.strictEqual(st.largest.id, 'btc');
  assert.strictEqual(st.best24h.id, 'btc'); assert.strictEqual(st.worst24h.id, 'eth');
  assert.strictEqual(st.bestPnl.id, 'btc'); assert.strictEqual(st.worstPnl.id, 'eth');
  near(st.effectiveAssets, 1 / (0.25 + 0.0625 + 0.0625));
  near(st.change7dPct, (2000 / (800 + 500 / 0.9 + 500) - 1) * 100);
  assert.strictEqual(st.firstDate, '2025-01-01'); assert.strictEqual(st.lotsCount, 3, 'wpisy: 2 zakupy + migrowane 500 USDT');
});
test('allocation, combineHistory, seriesStats', () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ id: 'c' + i, value: 9 - i, share: (9 - i) / 45 }));
  const a = Core.allocation(items, (id) => id.toUpperCase(), 6);
  assert.strictEqual(a.length, 7); assert.strictEqual(a[6].label, 'Inne'); near(a[6].value, 3 + 2 + 1);
  near(a.reduce((s2, x) => s2 + x.share, 0), 1);
  const h = Core.combineHistory([{ amount: 2, points: [[0, 10], [100, 20]] }, { amount: 1, points: [[0, 5], [50, 5], [100, 15]] }], 3);
  assert.deepStrictEqual(h.map((p) => p[0]), [0, 50, 100]);
  near(h[0][1], 25); near(h[1][1], 35); near(h[2][1], 55);
  const ss = Core.seriesStats([[0, 100], [1, 150], [2, 90], [3, 120]]);
  near(ss.changePct, 20); near(ss.maxDrawdownPct, -40); assert.strictEqual(ss.max[1], 150); assert.strictEqual(ss.min[1], 90);
  assert.strictEqual(Core.seriesStats([]), null);
});

console.log('Eksport i import');
test('plik eksportu przenosi portfel między urządzeniami', () => {
  const data = Core.sanitizeData({ watch: [{ id: 'btc', symbol: 'btc', name: 'Bitcoin' }], holdings: { btc: 2, eth: 1 }, lots: { btc: [{ id: 'x', type: 'buy', date: '2025-01-01', amount: 1.5, price: 100, currency: 'pln' }, { amount: -1 }] }, alerts: [{ id: 'a', coinId: 'btc', type: 'above', value: 5, currency: 'usd', lastTriggered: 5 }], alertLog: [{ at: 1 }] });
  const file = JSON.stringify(Core.buildExport(data, { market: { currency: 'pln' } }, new Date('2026-11-14T10:00:00Z')));
  const imp = Core.parseImport(file);
  assert.deepStrictEqual(imp.data.holdings, { btc: 2, eth: 1 });
  assert.strictEqual(imp.data.lots.btc.length, 2, 'wpis + migrowana reszta ilości');
  assert.strictEqual(imp.currency, 'pln');
  assert.deepStrictEqual(imp.counts, { holdings: 2, lots: 3, watch: 2, alerts: 1 });
  assert.ok(imp.data.watch.some((w) => w.id === 'eth'), 'posiadana moneta trafia do obserwowanych');
  assert.ok(/^cointracko-portfel-\d{4}-\d{2}-\d{2}\.json$/.test(Core.exportFileName()));
  assert.throws(() => Core.parseImport('{"foo":1}'), /CoinTracko/);
  assert.throws(() => Core.parseImport('nie json'), /JSON/);
  assert.throws(() => Core.parseImport(JSON.stringify({ app: 'CoinTracko', format: 99 })), /nowszej/);
});
test('mergeImport: zastąp i połącz', () => {
  const cur = Core.sanitizeData({ watch: [{ id: 'sol' }], holdings: {}, lots: { sol: [{ id: 's1', type: 'buy', amount: 5, price: 1 }], btc: [{ id: 'old', type: 'buy', amount: 1, price: 1 }] }, alerts: [], alertLog: [{ at: 1, title: 't' }] });
  const inc = Core.parseImport(JSON.stringify(Core.buildExport(Core.sanitizeData({ watch: [{ id: 'btc' }], lots: { btc: [{ id: 'new', type: 'buy', amount: 3, price: 2 }] } }), {}))).data;
  const rep = Core.mergeImport(cur, inc, 'replace');
  assert.deepStrictEqual(rep.holdings, { btc: 3 }); assert.strictEqual(rep.alertLog.length, 1);
  const mer = Core.mergeImport(cur, inc, 'merge');
  assert.deepStrictEqual(mer.lots.btc.map((l) => l.id), ['new'], 'wpisy z pliku zastępują obecne dla tej samej monety');
  near(mer.holdings.btc, 3); near(mer.holdings.sol, 5);
  assert.strictEqual(mer.watch.length, 2);
  const again = Core.mergeImport(mer, inc, 'merge');
  assert.strictEqual(again.lots.btc.length, 1, 'ponowny import nie dubluje wpisów');
});
test('import pliku w starym formacie 1 (ilość „na sztywno”) nadal działa', () => {
  const old = JSON.stringify({ app: 'CoinTracko', format: 1, watch: [{ id: 'bitcoin' }], holdings: { bitcoin: 1.25 }, lots: {}, alerts: [] });
  const imp = Core.parseImport(old);
  near(imp.data.holdings.bitcoin, 1.25); assert.strictEqual(imp.data.lots.bitcoin.length, 1);
});

console.log('Wykres');
test('niceTicks i downsample', () => {
  assert.deepStrictEqual(Core.niceTicks(0, 100, 4), [0, 20, 40, 60, 80, 100]);
  const t = Core.niceTicks(0.000012, 0.000019, 4);
  assert.ok(t.length >= 3 && t.every((v) => v >= 0.000012 && v <= 0.0000191));
  const pts = Array.from({ length: 1000 }, (_, i) => [i, i]);
  const d = Core.downsample(pts, 100);
  assert.strictEqual(d.length, 100);
  assert.deepStrictEqual(d[0], [0, 0]);
  assert.deepStrictEqual(d[99], [999, 999]);
});

console.log('Magazyn danych');
test('Store: zapis, odczyt, scalanie ustawień, odporność na uszkodzony plik', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cointracko-test-'));
  let s = new Store(dir);
  assert.strictEqual(s.settings.market.currency, 'usd');
  s.updateSettings({ market: { currency: 'pln' } });
  s.setData({ watch: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }, { id: 'bitcoin' }, { nope: 1 }], holdings: { bitcoin: '0.5', zero: 0, bad: 'x' }, alerts: [{ coinId: 'bitcoin', type: 'above', value: '10' }, { coinId: 'x', type: 'zly', value: 1 }] });
  assert.strictEqual(s.rev, 3, 'licznik zmian rośnie przy każdym zapisie');
  s = new Store(dir);
  assert.strictEqual(s.settings.market.currency, 'pln');
  assert.strictEqual(s.settings.market.refreshSec, 60);
  assert.strictEqual(s.data.watch.length, 1);
  assert.deepStrictEqual(s.data.holdings, { bitcoin: 0.5 });
  assert.strictEqual(s.data.lots.bitcoin.length, 1, 'ilość zapisana na sztywno stała się wpisem');
  assert.strictEqual(s.data.alerts.length, 1);
  assert.strictEqual(s.data.alerts[0].value, 10);
  fs.writeFileSync(path.join(dir, 'cointracko-dane.json'), '{zepsute');
  s = new Store(dir);
  assert.deepStrictEqual(s.data.watch, []);
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('uszkodzony')));
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('Podgląd w przeglądarce');
const http = require('http');
const req = (port, p, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
  });
  r.on('error', reject); if (body) r.write(body); r.end();
});
const serverTest = async () => {
  const state = { settings: { market: { currency: 'usd' } }, data: { watch: [], holdings: {}, lots: {} }, rev: 1 };
  const calls = { fetch: 0 };
  const port = 47000 + Math.floor(Math.random() * 2000);
  const srv = new BrowserServer({
    getState: () => state,
    setData: (d) => { state.data = d; state.rev++; },
    setSettings: (patch) => { state.settings = { ...state.settings, ...patch }; state.rev++; return state.settings; },
    fetchJson: async () => { calls.fetch++; return { status: 200, data: [{ id: 'bitcoin' }] }; },
    root: path.join(__dirname, '..', 'src', 'renderer'), iconFile: path.join(__dirname, '..', 'src', 'assets', 'icon.png'), version: '9.9.9'
  });
  srv.apply({ enabled: true, port });
  await new Promise((r) => setTimeout(r, 200));
  try {
    assert.ok(srv.status().running, 'serwer działa');
    const index = await req(port, '/');
    assert.strictEqual(index.status, 200);
    assert.ok(index.text.includes('cointracko-host') && index.text.includes('data-version="9.9.9"'), 'strona wie, że działa w przeglądarce');
    assert.strictEqual((await req(port, '/app.js')).status, 200);
    assert.strictEqual((await req(port, '/../package.json')).status, 404, 'brak wyjścia poza katalog interfejsu');
    assert.strictEqual((await req(port, '/%2e%2e/main/main.js')).status === 200, false);
    assert.strictEqual((await req(port, '/api/state', { headers: { host: 'evil.example:' + port } })).status, 403, 'obcy Host odrzucony (DNS rebinding)');
    assert.strictEqual((await req(port, '/api/state', { headers: { origin: 'http://evil.example' } })).status, 403, 'obca strona nie czyta danych');
    const post = (p, obj, h2 = { 'x-cointracko': '1' }) => req(port, p, { method: 'POST', headers: { 'content-type': 'text/plain', ...h2 }, body: JSON.stringify(obj) });
    assert.strictEqual((await post('/api/data', { watch: [] }, {})).status, 403, 'zapis bez nagłówka odrzucony (CSRF)');
    const st = JSON.parse((await req(port, '/api/state')).text);
    assert.strictEqual(st.rev, 1);
    const w = JSON.parse((await post('/api/data', { watch: [], lots: { bitcoin: [{ amount: 1 }] } })).text);
    assert.strictEqual(w.rev, 2);
    assert.strictEqual(JSON.parse((await req(port, '/api/rev')).text).rev, 2);
    await post('/api/settings', { market: { currency: 'pln' }, browser: { enabled: false }, window: { closeAction: 'quit' } });
    assert.strictEqual(state.settings.market.currency, 'pln'); assert.strictEqual(state.settings.browser, undefined, 'przeglądarka nie steruje serwerem'); assert.strictEqual(state.settings.window, undefined);
    const u = encodeURIComponent('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd');
    await req(port, '/api/json?url=' + u); await req(port, '/api/json?url=' + u);
    assert.strictEqual(calls.fetch, 1, 'wspólna pamięć notowań');
    assert.strictEqual((await req(port, '/api/json?url=' + encodeURIComponent('https://example.com/x'))).status, 500, 'tylko adresy CoinGecko');
    srv.apply({ enabled: false, port });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!srv.status().running, 'wyłączony serwer nie nasłuchuje');
  } finally { srv.stop(); }
};
console.log('  (serwer: test asynchroniczny)');
serverTest().then(() => { passed++; console.log('  ✓ serwer podglądu: pliki, API, zabezpieczenia'); }, (e) => { console.error('  ✗ serwer podglądu\n    ' + (e.stack || e.message)); process.exitCode = 1; }).finally(() => {
console.log(`\n${passed} testów zaliczonych` + (process.exitCode ? ', są błędy' : ''));
});
