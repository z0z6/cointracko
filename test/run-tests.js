'use strict';
// Testy logiki bez Electrona: node test/run-tests.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Core = require('../src/renderer/core');
const { Store } = require('../src/main/store');
const { BrowserServer } = require('../src/main/web-server');
const Autostart = require('../src/main/autostart');
const { Remote } = require('../src/main/remote');
const Allow = require('../src/renderer/allowlist');
const Oracles = require('../src/renderer/oracles');
const PriceHistory = require('../src/renderer/history');
const Intel = require('../src/renderer/intel');
const KVCache = require('../src/renderer/cache');

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
  let d = Core.sanitizeData({ watch: [], holdings: {}, lots: {} });
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
  d = Core.applyLots({ watch: [], holdings: {}, lots: {} }, 'eth', [{ type: 'buy', amount: 1, price: 1 }, { type: 'sell', amount: 1, price: 2 }]);
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
  const data = Core.sanitizeData({ watch: [{ id: 'btc', symbol: 'btc', name: 'Bitcoin' }], holdings: { btc: 2, eth: 1 }, lots: { btc: [{ id: 'x', type: 'buy', date: '2025-01-01', amount: 1.5, price: 100, currency: 'pln' }, { amount: -1 }] } });
  const file = JSON.stringify(Core.buildExport(data, { market: { currency: 'pln' } }, new Date('2026-11-14T10:00:00Z')));
  const imp = Core.parseImport(file);
  assert.deepStrictEqual(imp.data.holdings, { btc: 2, eth: 1 });
  assert.strictEqual(imp.data.lots.btc.length, 2, 'wpis + migrowana reszta ilości');
  assert.strictEqual(imp.currency, 'pln');
  assert.deepStrictEqual(imp.counts, { holdings: 2, lots: 3, watch: 2 });
  assert.ok(imp.data.watch.some((w) => w.id === 'eth'), 'posiadana moneta trafia do obserwowanych');
  assert.ok(/^cointracko-portfel-\d{4}-\d{2}-\d{2}\.json$/.test(Core.exportFileName()));
  assert.throws(() => Core.parseImport('{"foo":1}'), /CoinTracko/);
  assert.throws(() => Core.parseImport('nie json'), /JSON/);
  assert.throws(() => Core.parseImport(JSON.stringify({ app: 'CoinTracko', format: 99 })), /nowszej/);
});
test('mergeImport: zastąp i połącz', () => {
  const cur = Core.sanitizeData({ watch: [{ id: 'sol' }], holdings: {}, lots: { sol: [{ id: 's1', type: 'buy', amount: 5, price: 1 }], btc: [{ id: 'old', type: 'buy', amount: 1, price: 1 }] } });
  const inc = Core.parseImport(JSON.stringify(Core.buildExport(Core.sanitizeData({ watch: [{ id: 'btc' }], lots: { btc: [{ id: 'new', type: 'buy', amount: 3, price: 2 }] } }), {}))).data;
  const rep = Core.mergeImport(cur, inc, 'replace');
  assert.deepStrictEqual(rep.holdings, { btc: 3 });
  const mer = Core.mergeImport(cur, inc, 'merge');
  assert.deepStrictEqual(mer.lots.btc.map((l) => l.id), ['new'], 'wpisy z pliku zastępują obecne dla tej samej monety');
  near(mer.holdings.btc, 3); near(mer.holdings.sol, 5);
  assert.strictEqual(mer.watch.length, 2);
  const again = Core.mergeImport(mer, inc, 'merge');
  assert.strictEqual(again.lots.btc.length, 1, 'ponowny import nie dubluje wpisów');
});
test('import pliku w starym formacie 1 (ilość „na sztywno”) nadal działa', () => {
  const old = JSON.stringify({ app: 'CoinTracko', format: 1, watch: [{ id: 'bitcoin' }], holdings: { bitcoin: 1.25 }, lots: {} });
  const imp = Core.parseImport(old);
  near(imp.data.holdings.bitcoin, 1.25); assert.strictEqual(imp.data.lots.bitcoin.length, 1);
});

console.log('Kalkulator i motywy');
test('convertAmount: w obie strony, błędne dane', () => {
  near(Core.convertAmount(100, 2.5, 1), 250); // 100 XRP po 2,5 PLN → 250 PLN
  near(Core.convertAmount(250, 2.5, 1, true), 100); // 250 PLN → 100 XRP
  near(Core.convertAmount(2, 3000, 60000), 0.1); // 2 ETH → 0,1 BTC
  assert.ok(isNaN(Core.convertAmount(1, 0, 1)) && isNaN(Core.convertAmount('x', 1, 1)) && isNaN(Core.convertAmount(1, 1, -2)));
});
test('sameDayYearsAgo: ten sam dzień i miesiąc, 29 lutego', () => {
  assert.strictEqual(Core.sameDayYearsAgo(5, new Date(2026, 10, 15)), '2021-11-15');
  assert.strictEqual(Core.sameDayYearsAgo(1, new Date(2028, 1, 29)), '2027-02-28');
  assert.strictEqual(Core.sameDayYearsAgo(4, new Date(2028, 1, 29)), '2024-02-29');
});
test('7 motywów kolorystycznych w ustawieniach', () => {
  assert.strictEqual(Core.PALETTES.length, 7);
  assert.strictEqual(new Set(Core.PALETTES.map((x) => x.id)).size, 7);
  assert.strictEqual(Core.sanitizeSettings({ ui: { palette: 'rose' } }).ui.palette, 'rose');
  assert.strictEqual(Core.sanitizeSettings({ ui: { palette: '<x>' } }).ui.palette, 'ocean');
  assert.strictEqual(Core.DEFAULT_SETTINGS.ui.palette, 'ocean');
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

console.log('Bezpieczeństwo danych');
test('sanitizeData: prototyp, identyfikatory, obrazy, limity, bez alertów', () => {
  const evil = JSON.parse('{"watch":[{"id":"__proto__","name":"x"},{"id":"bitcoin","symbol":"btc","name":"B","image":"javascript:alert(1)"},{"id":"eth","image":"https://evil.example/a.png"},{"id":"ok","image":"https://coin-images.coingecko.com/coins/images/1/large/bitcoin.png?1696"}],"lots":{"__proto__":[{"amount":1}],"bitcoin":[{"amount":1,"price":5}],"BAD ID":[{"amount":1}]},"holdings":{"constructor":5,"<script>":3},"hints":{"seeded":true,"junk":1}}');
  const d = Core.sanitizeData(evil);
  assert.deepStrictEqual(d.watch.map((w) => w.id), ['bitcoin', 'eth', 'ok']);
  assert.deepStrictEqual(d.watch.map((w) => w.image), ['', '', 'https://coin-images.coingecko.com/coins/images/1/large/bitcoin.png?1696'], 'tylko obrazy z CoinGecko');
  assert.deepStrictEqual(Object.keys(d.lots), ['bitcoin']); assert.strictEqual(Object.getPrototypeOf(d.lots), Object.prototype);
  assert.deepStrictEqual(Object.keys(d.holdings), ['bitcoin']);
  assert.deepStrictEqual(Object.keys(d).sort(), ['hints', 'holdings', 'lots', 'watch'], 'brak alertów w modelu danych');
  assert.deepStrictEqual(d.hints, { seeded: true });
  const big = Core.sanitizeData({ watch: Array.from({ length: 2000 }, (_, i) => ({ id: 'c' + i })), lots: { bitcoin: Array.from({ length: 9000 }, () => ({ amount: 1 })) } });
  assert.strictEqual(big.watch.length, 500); assert.strictEqual(big.lots.bitcoin.length, 5000);
});
test('deepMerge i ustawienia: brak zatrucia prototypu, walidacja zakresów i typów', () => {
  const m = Core.deepMerge({ a: { b: 1 } }, JSON.parse('{"__proto__":{"x":1},"a":{"__proto__":{"y":1},"c":2},"constructor":{"prototype":{"z":1}}}'));
  assert.strictEqual({}.x, undefined); assert.strictEqual(m.x, undefined); assert.strictEqual(m.a.y, undefined); assert.strictEqual(m.a.c, 2);
  const s = Core.sanitizeSettings({ ui: { theme: 'neon' }, market: { currency: 'xyz', refreshSec: 1, cgKey: 'a b<c>', tolerancePct: 99, sources: { pyth: 'yes', bogus: true } }, window: { closeAction: 'explode', autostart: 'x' }, browser: { port: 80, enabled: 1 }, intel: { minSeverity: 9 }, ai: { x: 1 }, import: {} });
  assert.deepStrictEqual([s.ui.theme, s.market.currency, s.market.refreshSec, s.market.cgKey, s.market.tolerancePct, s.market.sources.pyth, 'bogus' in s.market.sources], ['system', 'usd', 60, '', 2, true, false]);
  assert.deepStrictEqual([s.window.closeAction, s.window.autostart, s.browser.port, s.browser.enabled, s.intel.minSeverity, 'ai' in s, 'import' in s], ['tray', true, 47820, false, 4, false, false]);
  assert.deepStrictEqual(Core.sanitizeSettings(null), Core.sanitizeSettings({}));
  assert.deepStrictEqual(Core.pickSettingsPatch({ market: { currency: 'pln', hack: 1 }, window: { closeAction: 'quit' }, nope: {} }, ['market']), { market: { currency: 'pln' } });
  assert.strictEqual(Core.sanitizeSettings({ market: { cgKey: 'CG-abc_123.x-y' } }).market.cgKey, 'CG-abc_123.x-y');
});

console.log('Magazyn danych');
test('Store: zapis, odczyt, scalanie ustawień, odporność na uszkodzony plik', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cointracko-test-'));
  let s = new Store(dir);
  assert.strictEqual(s.settings.market.currency, 'usd');
  s.updateSettings({ market: { currency: 'pln' } });
  s.setData({ watch: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }, { id: 'bitcoin' }, { nope: 1 }], holdings: { bitcoin: '0.5', zero: 0, bad: 'x' } });
  assert.strictEqual(s.rev, 3, 'licznik zmian rośnie przy każdym zapisie');
  s = new Store(dir);
  assert.strictEqual(s.settings.market.currency, 'pln');
  assert.strictEqual(s.settings.market.refreshSec, 60);
  assert.strictEqual(s.data.watch.length, 1);
  assert.deepStrictEqual(s.data.holdings, { bitcoin: 0.5 });
  assert.strictEqual(s.data.lots.bitcoin.length, 1, 'ilość zapisana na sztywno stała się wpisem');
  fs.writeFileSync(path.join(dir, 'cointracko-dane.json'), '{zepsute');
  s = new Store(dir);
  assert.deepStrictEqual(s.data.watch, []);
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('uszkodzony')));
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('Autostart');
test('autostart: polecenie, wpis XDG, zapis i usunięcie', () => {
  assert.strictEqual(Autostart.execPath({ APPIMAGE: '/home/u/Aplikacje/CoinTracko.AppImage' }, '/tmp/.mount_x/cointracko.bin'), '/home/u/Aplikacje/CoinTracko.AppImage');
  assert.strictEqual(Autostart.execPath({}, '/opt/CoinTracko/cointracko.bin'), '/opt/CoinTracko/cointracko', 'z paczki .deb uruchamiamy skrypt (z --no-sandbox), nie plik .bin');
  assert.strictEqual(Autostart.quoteExec('/home/u/Moje "apki"/a$b'), '"/home/u/Moje \\"apki\\"/a\\$b"');
  const entry = Autostart.desktopEntry({ exe: '/opt/CoinTracko/cointracko', hidden: true });
  assert.ok(entry.includes('Exec="/opt/CoinTracko/cointracko" --hidden\n') && entry.startsWith('[Desktop Entry]\nType=Application'));
  assert.ok(!Autostart.desktopEntry({ exe: '/x', hidden: false }).includes('--hidden'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-auto-'));
  const sub = path.join(dir, 'autostart');
  const f = Autostart.setLinuxAutostart(true, { exe: '/opt/CoinTracko/cointracko', hidden: true, dir: sub });
  assert.ok(fs.readFileSync(f, 'utf8').includes('--hidden'));
  Autostart.setLinuxAutostart(true, { exe: '/nowa/sciezka.AppImage', hidden: false, dir: sub });
  assert.ok(fs.readFileSync(f, 'utf8').includes('Exec="/nowa/sciezka.AppImage"\n'), 'ponowny zapis podmienia ścieżkę');
  assert.strictEqual(Autostart.setLinuxAutostart(false, { dir: sub }), null);
  assert.ok(!fs.existsSync(f));
  assert.strictEqual(Autostart.setLinuxAutostart(false, { dir: sub }), null, 'usuwanie nieistniejącego wpisu nie psuje');
  assert.strictEqual(Autostart.autostartDir({ XDG_CONFIG_HOME: '/x/cfg' }), '/x/cfg/autostart');
  assert.strictEqual(Core.DEFAULT_SETTINGS.window.autostart, true);
  fs.rmSync(dir, { recursive: true, force: true });
});


console.log('Lista dozwolonych adresów i klient zapytań');
test('allowlist: tylko HTTPS, znane hosty i ścieżki, RPC tylko eth_call', () => {
  const ok = (u, m, b) => Allow.isAllowed(u, m, b);
  assert.ok(ok('https://api.coingecko.com/api/v3/coins/markets?x=1'));
  assert.ok(!ok('http://api.coingecko.com/api/v3/coins/markets'), 'http');
  assert.ok(!ok('https://api.coingecko.com.evil.com/api/v3/coins'), 'podszycie domeny');
  assert.ok(!ok('https://evil.com/api/v3/coins'));
  assert.ok(!ok('https://api.coingecko.com/other'));
  assert.ok(!ok('https://user:p@api.coingecko.com/api/v3/ping'), 'dane logowania w adresie');
  assert.ok(!ok('https://api.coingecko.com:8443/api/v3/ping'), 'inny port');
  assert.ok(ok('https://ethereum-rpc.publicnode.com/', 'POST', '[{"method":"eth_call"}]'));
  assert.ok(!ok('https://ethereum-rpc.publicnode.com/', 'POST', '[{"method":"eth_sendRawTransaction"}]'));
  assert.ok(!ok('https://ethereum-rpc.publicnode.com/', 'POST', '[{"method":"eth_call"},{"method":"eth_sendTransaction"}]'));
  assert.ok(!ok('https://ethereum-rpc.publicnode.com/', 'GET'));
  assert.ok(!ok('https://api.coingecko.com/api/v3/coins/markets', 'POST'));
});
const remoteTest = async () => {
  let calls = 0; let lastInit = null;
  const mk = (impl) => new Remote(async (url, init) => { calls++; lastInit = init; return impl(url, init); });
  const json = (o, extra = {}) => Object.assign(new Response(JSON.stringify(o), { status: 200 }), extra);
  let r = mk(() => json({ a: 1 }));
  const url = 'https://api.coingecko.com/api/v3/ping';
  assert.deepStrictEqual((await r.request({ url, key: 'K1' })).data, { a: 1 });
  await r.request({ url, key: 'K1' }); assert.strictEqual(calls, 1, 'pamięć podręczna');
  assert.strictEqual(lastInit.headers['x-cg-demo-api-key'], 'K1');
  await r.request({ url, key: 'K1', fresh: true }); assert.strictEqual(calls, 2, 'fresh: wymuszona aktualizacja omija pamięć podręczną');
  calls = 1;
  await assert.rejects(() => r.request({ url: 'https://example.com/' }), /Niedozwolony/);
  await r.request({ url: 'https://api.coinbase.com/v2/exchange-rates?currency=USD', key: 'SECRET' });
  assert.strictEqual(lastInit.headers['x-cg-demo-api-key'], undefined, 'klucz CoinGecko nie wycieka do innych serwisów');
  // równoległe identyczne zapytania są łączone
  calls = 0; r = mk(async () => { await new Promise((x) => setTimeout(x, 20)); return json({ n: 1 }); });
  await Promise.all([r.request({ url }), r.request({ url }), r.request({ url })]); assert.strictEqual(calls, 1);
  // przekierowania: na niedozwolony adres – odrzucone zanim zapytanie zostanie wysłane; na dozwolony – obsłużone, a klucz nie wycieka
  const hops = [];
  r = mk((u, init) => { hops.push([u, init.headers['x-cg-demo-api-key']]); return u.includes('coinbase') ? json({ ok: 1 }) : new Response(null, { status: 302, headers: { location: 'https://api.coinbase.com/v2/exchange-rates' } }); });
  assert.deepStrictEqual((await r.request({ url, key: 'SECRET' })).data, { ok: 1 });
  assert.deepStrictEqual(hops.map((h2) => h2[1]), ['SECRET', undefined], 'klucz CoinGecko nie jest wysyłany po przekierowaniu do innego serwisu');
  calls = 0; r = mk(() => new Response(null, { status: 301, headers: { location: 'https://evil.example/x' } }));
  await assert.rejects(() => r.request({ url }), /przekierowa/); assert.strictEqual(calls, 1, 'drugie zapytanie nie zostało wysłane');
  r = mk(() => new Response(null, { status: 302, headers: { location: url } }));
  await assert.rejects(() => r.request({ url }), /przekierowań/);
  // zbyt duża odpowiedź
  r = mk(() => new Response('x'.repeat(5 * 1024 * 1024), { status: 200 }));
  await assert.rejects(() => r.request({ url }), /zbyt duża/);
  // błąd HTTP nie jest zapamiętywany; niepoprawny JSON
  calls = 0; r = mk(() => new Response('', { status: 429 }));
  assert.strictEqual((await r.request({ url })).status, 429); await r.request({ url }); assert.strictEqual(calls, 2);
  r = mk(() => new Response('<html>', { status: 200 }));
  await assert.rejects(() => r.request({ url }), /niepoprawną/);
};
remoteTest().then(() => { passed++; console.log('  ✓ Remote: lista adresów, klucz tylko dla CoinGecko, limity, przekierowania'); }, (e) => { console.error('  ✗ Remote\n    ' + (e.stack || e.message)); process.exitCode = 1; });

console.log('Źródła cen (oracle)');
test('parsery: Pyth, RedStone, CryptoCompare, Binance, Coinbase, Chainlink', () => {
  const id = 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';
  assert.deepStrictEqual(Oracles.parsePythFeeds([{ id, attributes: { asset_type: 'Crypto', base: 'BTC', quote_currency: 'USD', symbol: 'Crypto.BTC/USD' } }, { id: 'zz', attributes: {} }, { id: id.replace('e', 'f'), attributes: { asset_type: 'FX', base: 'EUR', quote_currency: 'USD' } }]), { BTC: id });
  const p = Oracles.parsePythPrices({ parsed: [{ id, price: { price: '6500012345678', conf: '1000000', expo: -8, publish_time: 1700000000 } }, { id: 'a'.repeat(64), price: { price: '100', conf: '50', expo: 0, publish_time: 1 } }] });
  near(p[id].price, 65000.12345678); assert.strictEqual(Object.keys(p).length, 1, 'wycena z szerokim przedziałem ufności odrzucona');
  assert.deepStrictEqual(Oracles.parseRedstone({ BTC: { value: 65000, timestamp: 5 }, X: { value: 0 } }), { BTC: { price: 65000, ts: 5 } });
  assert.deepStrictEqual(Oracles.parseRedstone([{ symbol: 'eth', value: 3000, timestamp: 7 }]), { ETH: { price: 3000, ts: 7 } });
  assert.deepStrictEqual(Oracles.parseCryptoCompareMulti({ BTC: { USD: 65000 }, BAD: { USD: 0 } }), { BTC: 65000 });
  assert.deepStrictEqual(Oracles.parseCryptoCompareMulti({ Response: 'Error' }), {});
  assert.deepStrictEqual(Oracles.parseBinance([{ symbol: 'BTCUSDT', price: '65000.5' }, { symbol: 'ETHBTC', price: '0.05' }]), { BTC: 65000.5 });
  const cb = Oracles.parseCoinbaseRates({ data: { rates: { BTC: '0.00001538', PLN: '4.05' } } });
  near(cb.crypto.BTC, 1 / 0.00001538); near(cb.fiat.PLN, 4.05);
  const dir = Oracles.parseChainlinkDirectory([{ name: 'BTC / USD', proxyAddress: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c', decimals: 8, feedCategory: 'verified' }, { name: 'ETH / BTC', proxyAddress: '0x1' }]);
  assert.deepStrictEqual(Object.keys(dir), ['BTC']);
  const w = (n) => BigInt(n).toString(16).padStart(64, '0');
  const d = Oracles.decodeRoundData('0x' + w(1) + w(6500012345678n) + w(1) + w(1700000000) + w(1), 8);
  near(d.price, 65000.12345678); assert.strictEqual(d.ts, 1700000000000);
  assert.strictEqual(Oracles.decodeRoundData('0x' + w(1) + w(0) + w(1) + w(1) + w(1), 8), null, 'zerowa odpowiedź');
  assert.strictEqual(Oracles.decodeRoundData('0x12', 8), null);
});
test('konsensus: średnia ze zgodnych, odrzucanie odchyleń i nieaktualnych oracle', () => {
  const now = Date.now();
  const c = Oracles.consensus([{ source: 'pyth', price: 100, ts: now }, { source: 'redstone', price: 100.4, ts: now }, { source: 'chainlink', price: 99.8, ts: now }, { source: 'coingecko', price: 130 }], { now });
  near(c.price, 100.06666666666666); assert.deepStrictEqual(c.outliers, ['coingecko']); assert.strictEqual(c.confidence, 'high'); assert.strictEqual(c.oracleCount, 3);
  const stale = Oracles.consensus([{ source: 'pyth', price: 100, ts: now - 3 * 3600000 }, { source: 'coinbase', price: 101 }, { source: 'binance', price: 100.5 }], { now });
  assert.deepStrictEqual(stale.stale, ['pyth']); near(stale.price, 100.75); assert.strictEqual(stale.confidence, 'medium');
  const conflict = Oracles.consensus([{ source: 'coinbase', price: 100 }, { source: 'binance', price: 120 }], { now });
  assert.strictEqual(conflict.conflict, true); assert.strictEqual(conflict.confidence, 'low');
  const one = Oracles.consensus([{ source: 'coingecko', price: 5 }], { now }); assert.strictEqual(one.inliers, 1); assert.strictEqual(one.confidence, 'low');
  assert.strictEqual(Oracles.consensus([], { now }), null);
  assert.strictEqual(Oracles.consensus([{ source: 'coinbase', price: NaN }, { source: 'binance', price: -1 }], { now }), null, 'niepoprawne ceny odrzucone');
  const allStale = Oracles.consensus([{ source: 'pyth', price: 100, ts: now - 9 * 3600000 }], { now }); assert.strictEqual(allStale.price, null);
});
const oracleFetchTest = async () => {
  const urls = [];
  const remote = { json: async (url, o = {}) => {
    urls.push(url);
    if (url.includes('hermes') && url.includes('price_feeds')) return [{ id: 'a'.repeat(64), attributes: { asset_type: 'Crypto', base: 'BTC', quote_currency: 'USD', symbol: 'Crypto.BTC/USD' } }];
    if (url.includes('hermes')) return { parsed: [{ id: 'a'.repeat(64), price: { price: '6500000000000', conf: '100000', expo: -8, publish_time: Math.floor(Date.now() / 1000) } }] };
    if (url.includes('redstone')) return { BTC: { value: 65100, timestamp: Date.now() } };
    if (url.includes('pricemulti')) return { BTC: { USD: 64900 } };
    if (url.includes('binance')) return [{ symbol: 'BTCUSDT', price: '65050' }];
    if (url.includes('coinbase')) return { data: { rates: { BTC: String(1 / 65000), PLN: '4' } } };
    if (url.includes('reference-data')) throw new Error('404');
    if (url.includes('rpc') || url.includes('publicnode')) { const w = (n) => BigInt(n).toString(16).padStart(64, '0'); return o.body.map((r) => ({ id: r.id, result: '0x' + w(1) + w(6490000000000n) + w(1) + w(Math.floor(Date.now() / 1000)) + w(1) })); }
    throw new Error('nieoczekiwany ' + url);
  } };
  const o = Oracles.create({ remote, cache: null });
  const res = await o.fetchAll([{ id: 'bitcoin', symbol: 'btc' }], { currency: 'pln', enabled: { binance: false } });
  const srcs = res.byId.bitcoin.map((e) => e.source).sort();
  assert.deepStrictEqual(srcs, ['chainlink', 'coinbase', 'cryptocompare', 'pyth', 'redstone']);
  near(res.byId.bitcoin.find((e) => e.source === 'pyth').price, 65000 * 4, 'przeliczenie na PLN');
  assert.ok(!urls.some((u) => u.includes('binance')), 'wyłączone źródło nie jest odpytywane');
  // awaria jednego źródła nie psuje reszty
  const broken = Oracles.create({ remote: { json: async (u, o) => { if (u.includes('redstone')) throw new Error('boom'); return remote.json(u, o); } }, cache: null });
  const r2 = await broken.fetchAll([{ id: 'bitcoin', symbol: 'btc' }], { currency: 'usd' });
  assert.ok(r2.errors.redstone && r2.byId.bitcoin.length >= 4);
};
oracleFetchTest().then(() => { passed++; console.log('  ✓ pobieranie: równoległe, wyłączanie źródeł, izolacja awarii'); }, (e) => { console.error('  ✗ pobieranie oracle\n    ' + (e.stack || e.message)); process.exitCode = 1; });

console.log('Historia dzienna');
test('historia: parsery, scalanie, filtr skoków, wartość portfela dzień po dniu', () => {
  const D = 86400000; const t0 = Date.parse('2024-01-01');
  const cc = PriceHistory.parseCryptoCompareDaily({ Response: 'Success', Data: { Data: [{ time: t0 / 1000, close: 100 }, { time: t0 / 1000 + 86400, close: 0 }, { time: t0 / 1000 + 2 * 86400, close: 102 }] } });
  assert.deepStrictEqual(cc, [[t0, 100], [t0 + 2 * D, 102]], 'dni z ceną 0 pominięte');
  assert.deepStrictEqual(PriceHistory.parseBinanceKlines([[t0, '1', '2', '0.5', '1.5', '10']]), [[t0, 1.5]]);
  assert.deepStrictEqual(PriceHistory.mergeDaily([[1, 1], [2, 2]], [[2, 9], [3, 3]]), [[1, 1], [2, 9], [3, 3]]);
  assert.deepStrictEqual(PriceHistory.cleanSpikes([[0, 100], [1, 0.001], [2, 101], [3, 102]]), [[0, 100], [2, 101], [3, 102]]);
  const mk = (p0, n) => Array.from({ length: n }, (_, i) => [t0 + i * D, p0 + i]);
  const r = PriceHistory.portfolioDaily({ lots: { a: [{ date: '2024-01-03', type: 'buy', amount: 2 }, { date: '2024-01-05', type: 'sell', amount: 1 }, { date: '', type: 'buy', amount: 0.5 }] }, histories: { a: mk(100, 10) }, mode: 'lots' });
  assert.deepStrictEqual(r.points.slice(0, 5).map((p) => p[1]), [50, 50.5, 255, 257.5, 156], 'ilość z wpisów obowiązująca danego dnia');
  const dated = PriceHistory.portfolioDaily({ lots: { a: [{ date: '2024-01-04', type: 'buy', amount: 1 }] }, histories: { a: mk(100, 10) }, mode: 'lots' });
  assert.strictEqual(dated.points[0][0], t0 + 3 * D, 'wykres zaczyna się od pierwszego zakupu');
  const c = PriceHistory.portfolioDaily({ amounts: { a: 3, b: 1 }, histories: { a: mk(10, 3) }, mode: 'current' });
  assert.deepStrictEqual(c.missing, ['b']); assert.deepStrictEqual(c.points.map((p) => p[1]), [30, 33, 36]);
  const clipped = PriceHistory.portfolioDaily({ amounts: { a: 1 }, histories: { a: mk(10, 10) }, mode: 'current', fromTs: t0 + 5 * D, toTs: t0 + 7 * D });
  assert.deepStrictEqual(clipped.points.map((p) => p[1]), [15, 16, 17]);
  assert.strictEqual(PriceHistory.priceOnOrBefore(mk(1, 5), t0 - D), null);
});
const historyFetchTest = async () => {
  const D = 86400000; const today = Math.floor(Date.now() / D) * D; const calls = [];
  const series = (days, toTs) => { const end = Math.floor(toTs / D) * D; return Array.from({ length: days + 1 }, (_, i) => ({ time: (end - (days - i) * D) / 1000, close: 100 + i })); };
  const remote = { json: async (url) => { calls.push(url); const u = new URL(url); const lim = Number(u.searchParams.get('limit')); const to = Number(u.searchParams.get('toTs') || 0) * 1000 || Date.now(); return { Response: 'Success', Data: { Data: series(lim, to) } }; } };
  const cache = KVCache.create(null);
  const hist = PriceHistory.create({ remote, cache });
  const first = await hist.daily({ id: 'bitcoin', symbol: 'btc' }, 'usd', 6);
  assert.ok(first.points.length > 2100, '6 lat dziennych punktów: ' + first.points.length);
  assert.ok(calls.length >= 2 && calls.length <= 3, 'kilka zapytań: ' + calls.length);
  for (let i = 1; i < first.points.length; i++) assert.ok(first.points[i][0] > first.points[i - 1][0], 'rosnąco i bez duplikatów');
  const n = calls.length; await hist.daily({ id: 'bitcoin', symbol: 'btc' }, 'usd', 6);
  assert.strictEqual(calls.length, n, 'drugi raz z pamięci podręcznej');
  // cena z konkretnej daty: 5 lat temu (z historii), 8 lat temu (pojedyncze zapytanie), przyszłość i brak danych
  const dIso = (t) => new Date(t).toISOString().slice(0, 10);
  const five = await hist.priceOn({ id: 'bitcoin', symbol: 'btc' }, 'usd', dIso(today - 5 * 365 * D));
  assert.strictEqual(five.date, today - 5 * 365 * D); near(five.price, first.points.find((p) => p[0] === five.date)[1], 'cena z dnia sprzed 5 lat zgodna z historią');
  const before = calls.length;
  const eight = await hist.priceOn({ id: 'bitcoin', symbol: 'btc' }, 'usd', dIso(today - 8 * 365 * D));
  assert.strictEqual(eight.date, today - 8 * 365 * D); assert.strictEqual(calls.length, before + 1, 'starsza data: jedno zapytanie o pojedynczy dzień');
  await assert.rejects(() => hist.priceOn({ id: 'bitcoin', symbol: 'btc' }, 'usd', dIso(today + 3 * D)), /przyszłości/);
  await assert.rejects(() => hist.priceOn({ id: 'bitcoin', symbol: 'btc' }, 'usd', 'wczoraj'), /data/i);
  // zapas: Binance przy awarii CryptoCompare
  const flaky = PriceHistory.create({ cache: KVCache.create(null), remote: { json: async (url) => {
    if (url.includes('cryptocompare')) throw new Error('down');
    const u = new URL(url); const from = Number(u.searchParams.get('startTime'));
    return Array.from({ length: 5 }, (_, i) => [from + i * D, '1', '1', '1', String(50 + i), '1']);
  } } });
  const f = await flaky.daily({ id: 'x', symbol: 'xx' }, 'usd', 1);
  assert.strictEqual(f.source, 'binance'); assert.ok(f.points.length >= 5);
};
historyFetchTest().then(() => { passed++; console.log('  ✓ historia: 6 lat, cache, zapas Binance'); }, (e) => { console.error('  ✗ historia (pobieranie)\n    ' + (e.stack || e.message)); process.exitCode = 1; });

console.log('Wiadomości i anomalie');
test('klasyfikacja: ton, rodzaje anomalii, zaprzeczenia, plotki', () => {
  const cl = (t, s = '') => Intel.classify({ title: t, summary: s });
  assert.strictEqual(cl('Bitcoin ETF approved, institutional adoption surges to record high').tone, 'bullish');
  assert.strictEqual(cl('Cardano partners with major bank, mainnet upgrade goes live').tone, 'bullish');
  const crash = cl('Token plunges 40% after exchange delisting'); assert.strictEqual(crash.tone, 'bearish');
  assert.strictEqual(cl('Ethereum developers announce routine meeting schedule').tone, 'neutral');
  const hack = cl('Protocol X hacked: attacker drained $80M from bridge'); assert.strictEqual(hack.anomaly.kind, 'hack'); assert.ok(hack.anomaly.severity >= 4); assert.strictEqual(hack.tone, 'bearish');
  assert.strictEqual(cl('Exchange denies hack rumors, says funds are safe').anomaly, null, 'zaprzeczenie nie jest alarmem');
  assert.strictEqual(cl('No hack found, audit clean').anomaly, null);
  const ins = cl('Rumors of insolvency spread as exchange pauses withdrawals'); assert.strictEqual(ins.anomaly.kind, 'insolvency'); assert.strictEqual(ins.anomaly.rumor, true);
  assert.strictEqual(cl('SEC sues team behind Token Y over alleged fraud and misuse of investor funds').anomaly.kind, 'fraud');
  assert.strictEqual(cl('Solana network outage halts block production').anomaly.kind, 'network');
  assert.strictEqual(cl('Whale wallet dumps 10M tokens, devs sell').anomaly.kind, 'dump');
  assert.strictEqual(cl('Haker włamał się do giełdy, skradziono środki').anomaly.kind, 'hack', 'słownictwo polskie');
});
test('RSS: parser, encje, odrzucanie niebezpiecznych odnośników, dopasowanie monet, grupowanie', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');
  const xml = '<rss><channel><item><title><![CDATA[Bitcoin hacked? &amp; fears - CoinDesk]]></title><link>https://x.com/a</link><pubDate>Sat, 14 Nov 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Desc &lt;b&gt;text&lt;/b&gt;&lt;/p&gt;</description><source url="https://coindesk.com">CoinDesk</source></item><item><title>bad</title><link>javascript:alert(1)</link><pubDate>Sat, 14 Nov 2026 10:00:00 GMT</pubDate></item><item><title>no date</title><link>https://x.com/b</link></item></channel></rss>';
  const items = Intel.parseRss(xml, { now });
  assert.strictEqual(items.length, 1); assert.strictEqual(items[0].title, 'Bitcoin hacked? & fears'); assert.strictEqual(items[0].source, 'CoinDesk'); assert.strictEqual(items[0].summary, 'Desc text');
  assert.deepStrictEqual(Intel.parseRss('<<<not xml', { now }), []); assert.deepStrictEqual(Intel.parseRss(null), []);
  assert.ok(Intel.mentions({ title: 'NEAR surges' }, { name: 'NEAR Protocol', symbol: 'near' }));
  assert.ok(!Intel.mentions({ title: 'Why near term outlook is weak' }, { name: 'NEAR Protocol', symbol: 'near' }), 'zwykłe słowo to nie moneta');
  const mk = (src, h) => ({ title: 'Token Y founders accused of fraud, funds missing', link: 'https://a/' + src, ts: now - h * 3600000, source: src, summary: '' });
  const res = Intel.analyzeCoin({ id: 'y', name: 'Token Y', symbol: 'TKY' }, [mk('A', 2), mk('B', 3), mk('C', 4), { title: 'Other news about Bitcoin', link: 'https://z', ts: now, source: 'Z', summary: '' }], { now });
  assert.strictEqual(res.length, 1); assert.strictEqual(res[0].count, 3); assert.strictEqual(res[0].anomaly.spreading, true); assert.strictEqual(res[0].anomaly.severity, 5); assert.strictEqual(res[0].tone, 'bearish');
  const s = Intel.sentiment(res, now); assert.strictEqual(s.bearish, 1);
});
test('anomalie rynkowe: odklejenie stablecoina, ruch ceny, rozbieżność źródeł', () => {
  const dep = Intel.marketAnomalies({ id: 'u' }, { usdPrice: 0.96 }, null, { stable: true }); assert.strictEqual(dep[0].kind, 'depeg'); assert.strictEqual(dep[0].severity, 5);
  assert.deepStrictEqual(Intel.marketAnomalies({ id: 'u' }, { usdPrice: 0.999 }, null, { stable: true }), []);
  const mv = Intel.marketAnomalies({ id: 'a' }, { change24h: -27, change1h: 1, marketCap: 1e9, volume: 2e9 }, null); assert.deepStrictEqual(mv.map((x) => x.kind), ['move', 'volume']);
  const cons = Oracles.consensus([{ source: 'coinbase', price: 100 }, { source: 'binance', price: 101 }, { source: 'coingecko', price: 115 }]);
  assert.ok(Intel.marketAnomalies({ id: 'a' }, { change24h: 1, change1h: 0 }, cons).some((x) => x.kind === 'divergence'));
});
test('KVCache: zapis, odczyt, wiek, czyszczenie (w pamięci)', async () => {
  const c = KVCache.create(null);
  await c.set('k', { a: 1 }); assert.deepStrictEqual(await c.get('k'), { a: 1 }); assert.strictEqual(await c.get('k', -1), null); assert.strictEqual(await c.get('brak'), null);
  await c.clear(); assert.strictEqual(await c.get('k'), null);
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
    remote: new Remote(async (url) => { calls.fetch++; return new Response(JSON.stringify([{ id: 'bitcoin' }]), { status: 200, headers: { 'content-type': 'application/json' } }); }),
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
    await post('/api/settings', { market: { currency: 'pln', evil: 1 }, browser: { enabled: false }, window: { closeAction: 'quit' }, '__proto__': { polluted: 1 } });
    assert.strictEqual(state.settings.market.currency, 'pln'); assert.strictEqual(state.settings.browser, undefined, 'przeglądarka nie steruje serwerem'); assert.strictEqual(state.settings.window, undefined); assert.strictEqual(state.settings.market.evil, undefined, 'nieznane pola odrzucone'); assert.strictEqual({}.polluted, undefined);
    const fetchReq = (obj, h2 = { 'x-cointracko': '1' }) => post('/api/fetch', obj, h2);
    const u = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd';
    await fetchReq({ url: u }); const second = JSON.parse((await fetchReq({ url: u })).text);
    assert.strictEqual(calls.fetch, 1, 'wspólna pamięć notowań'); assert.deepStrictEqual(second.data, [{ id: 'bitcoin' }]);
    assert.notStrictEqual((await fetchReq({ url: 'https://example.com/x' })).status, 200, 'tylko adresy z listy dozwolonych');
    assert.strictEqual((await fetchReq({ url: u }, {})).status, 403, 'zapytanie bez nagłówka odrzucone (CSRF)');
    assert.strictEqual((await req(port, '/api/json?url=' + encodeURIComponent(u))).status, 404, 'stary punkt API usunięty');
    srv.apply({ enabled: false, port });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!srv.status().running, 'wyłączony serwer nie nasłuchuje');
  } finally { srv.stop(); }
};
console.log('  (serwer: test asynchroniczny)');
serverTest().then(() => { passed++; console.log('  ✓ serwer podglądu: pliki, API, zabezpieczenia'); }, (e) => { console.error('  ✗ serwer podglądu\n    ' + (e.stack || e.message)); process.exitCode = 1; }).finally(() => {
console.log(`\n${passed} testów zaliczonych` + (process.exitCode ? ', są błędy' : ''));
});
