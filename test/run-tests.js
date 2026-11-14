'use strict';
// Testy logiki bez Electrona: node test/run-tests.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Core = require('../src/renderer/core');
const { Store } = require('../src/main/store');
const { extractJson } = require('../src/main/ai/providers');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); } catch (e) { console.error('  ✗ ' + name + '\n    ' + (e.stack || e.message)); process.exitCode = 1; }
}
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} ≠ ${b}`);

const COINS = [
  { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', image: 'b.png' },
  { id: 'ethereum', symbol: 'eth', name: 'Ethereum' },
  { id: 'tether', symbol: 'usdt', name: 'Tether' },
  { id: 'solana', symbol: 'sol', name: 'Solana' },
  { id: 'dogecoin', symbol: 'doge', name: 'Dogecoin' },
  { id: '1inch', symbol: '1inch', name: '1inch' },
  { id: 'shiba-inu', symbol: 'shib', name: 'Shiba Inu' },
  { id: 'harmony', symbol: 'one', name: 'Harmony' },
  { id: 'fake-btc', symbol: 'btc', name: 'Bitcoin Fake' }
];

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
test('mergeHoldings: zastąp i dodaj', () => {
  assert.deepStrictEqual(Core.mergeHoldings({ a: 1, b: 2 }, [{ id: 'a', amount: 5 }, { id: 'c', amount: 3 }, { id: 'x', amount: 0 }], 'replace'), { a: 5, b: 2, c: 3 });
  assert.deepStrictEqual(Core.mergeHoldings({ a: 1 }, [{ id: 'a', amount: 5 }], 'add'), { a: 6 });
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

console.log('Import ze zrzutu');
test('normalizeAiRows: porządkuje odpowiedź modelu', () => {
  const r = Core.normalizeAiRows({ holdings: [
    { symbol: 'btc', name: 'Bitcoin', amount: 0.1234 },
    { symbol: 'ETH', amount: '1 234,5' },
    { symbol: 'SOL', amount: null, note: 'nieczytelne' },
    { symbol: 'BTC', amount: 9 },
    { foo: 1 }, null
  ], warnings: ['rozmyte'] });
  assert.strictEqual(r.rows.length, 3);
  assert.strictEqual(r.rows[0].symbol, 'BTC');
  near(r.rows[0].amount, 0.1234);
  near(r.rows[1].amount, 1234.5);
  assert.strictEqual(r.rows[2].amount, null);
  assert.deepStrictEqual(r.warnings, ['rozmyte']);
  assert.deepStrictEqual(Core.normalizeAiRows('bzdura').rows, []);
});
test('extractJson: blok ```json i goły obiekt', () => {
  assert.deepStrictEqual(Core.extractJson('Oto wynik:\n```json\n{"holdings":[]}\n```'), { holdings: [] });
  assert.deepStrictEqual(Core.extractJson('tekst {"a":1} koniec'), { a: 1 });
  assert.deepStrictEqual(extractJson('```json\n[1,2]\n```'), [1, 2]);
  assert.throws(() => Core.extractJson('nic'));
});
test('parseOcrText: układ giełdowy (symbol, ilość, wartość)', () => {
  const text = [
    'Total Balance $12,345.67',
    'BTC Bitcoin 0.12345678 $11,987.10',
    'ETH 1.5 ≈ 5 118,00 USD',
    'USDT 250.00 $250.00',
    'DOGE Dogecoin 1,234.5 +3.21%',
    'Buy Sell Swap'
  ].join('\n');
  const rows = Core.parseOcrText(text, COINS);
  const by = Object.fromEntries(rows.map((r) => [r.symbol, r.amount]));
  near(by.BTC, 0.12345678);
  near(by.ETH, 1.5);
  near(by.USDT, 250);
  near(by.DOGE, 1234.5);
  assert.strictEqual(rows.length, 4);
  assert.strictEqual(rows[0].coin.id, 'bitcoin', 'przy powtórzonym symbolu wygrywa wyższa kapitalizacja');
});
test('parseOcrText: ilość przed symbolem, nazwy, liczba w następnym wierszu', () => {
  const text = ['Solana', '12,5 SOL', '2 450,10 zł', 'Shiba Inu 1 500 000 SHIB 34,71 zł', '0.75 1INCH', 'Ethereum', '$3,400.12 2.25'].join('\n');
  const rows = Core.parseOcrText(text, COINS);
  const by = Object.fromEntries(rows.map((r) => [r.symbol, r.amount]));
  near(by.SOL, 12.5);
  near(by.SHIB, 1500000);
  near(by['1INCH'], 0.75);
  near(by.ETH, 2.25);
});
test('parseOcrText: pomija słowa interfejsu i waluty', () => {
  const rows = Core.parseOcrText('ONE DAY 24 USD\nTOTAL 500 PLN\nALL ASSETS 3', COINS);
  assert.ok(rows.every((r) => r.symbol === 'ONE'), JSON.stringify(rows));
});
test('matchRows: symbol → moneta, nazwa ważniejsza przy konflikcie', () => {
  const m = Core.matchRows([{ symbol: 'BTC', name: '', amount: 1 }, { symbol: 'BTC', name: 'Bitcoin Fake', amount: 2 }, { symbol: 'XYZ', name: 'Nieznany', amount: 3 }, { symbol: '', name: 'solana', amount: 4 }], COINS);
  assert.strictEqual(m[0].coin.id, 'bitcoin');
  assert.strictEqual(m[0].coin.image, 'b.png');
  assert.strictEqual(m[1].coin.id, 'fake-btc');
  assert.strictEqual(m[2].coin, null);
  assert.strictEqual(m[3].coin.id, 'solana');
});

test('parseOcrText: nieczytelny symbol, ilość z wiersza nad nazwą', () => {
  const rows = Core.parseOcrText('© UsSDT 1,594.75\nTether $1,594.75\nO BTC 0.5\nBitcoin $48,000.00', COINS);
  const by = Object.fromEntries(rows.map((r) => [r.symbol, r.amount]));
  near(by.USDT, 1594.75);
  near(by.BTC, 0.5);
  assert.strictEqual(rows.length, 2);
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
  s = new Store(dir);
  assert.strictEqual(s.settings.market.currency, 'pln');
  assert.strictEqual(s.settings.market.refreshSec, 60);
  assert.strictEqual(s.data.watch.length, 1);
  assert.deepStrictEqual(s.data.holdings, { bitcoin: 0.5 });
  assert.strictEqual(s.data.alerts.length, 1);
  assert.strictEqual(s.data.alerts[0].value, 10);
  fs.writeFileSync(path.join(dir, 'cointracko-dane.json'), '{zepsute');
  s = new Store(dir);
  assert.deepStrictEqual(s.data.watch, []);
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('uszkodzony')));
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} testów zaliczonych` + (process.exitCode ? ', są błędy' : ''));
