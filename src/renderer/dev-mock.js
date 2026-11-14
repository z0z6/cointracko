'use strict';
// Dane przykładowe do pracy bez internetu (tryb deweloperski: COINTRACKO_MOCK=1 lub ?mock=1).
// W zwykłym uruchomieniu ten plik nic nie robi.

window.installMarketMock = function installMarketMock() {
  const COINS = [
    ['bitcoin', 'btc', 'Bitcoin', 97250, 1.9e12], ['ethereum', 'eth', 'Ethereum', 3412, 4.1e11], ['tether', 'usdt', 'Tether', 1.0, 1.4e11],
    ['ripple', 'xrp', 'XRP', 2.31, 1.3e11], ['binancecoin', 'bnb', 'BNB', 688, 9.9e10], ['solana', 'sol', 'Solana', 214.6, 1.0e11],
    ['dogecoin', 'doge', 'Dogecoin', 0.3821, 5.6e10], ['cardano', 'ada', 'Cardano', 0.972, 3.4e10], ['tron', 'trx', 'TRON', 0.2512, 2.1e10],
    ['avalanche-2', 'avax', 'Avalanche', 41.2, 1.7e10], ['chainlink', 'link', 'Chainlink', 23.4, 1.5e10], ['shiba-inu', 'shib', 'Shiba Inu', 0.00002314, 1.3e10],
    ['polkadot', 'dot', 'Polkadot', 7.42, 1.1e10], ['litecoin', 'ltc', 'Litecoin', 104.3, 7.8e9], ['uniswap', 'uni', 'Uniswap', 13.9, 8.3e9],
    ['pepe', 'pepe', 'Pepe', 0.00001987, 8.1e9], ['near', 'near', 'NEAR Protocol', 5.61, 6.6e9], ['aptos', 'apt', 'Aptos', 9.3, 5.2e9]
  ];
  const RATE = { usd: 1, pln: 4.05, eur: 0.93 };
  const seed = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return () => { h += 0x6d2b79f5; let t = Math.imul(h ^ (h >>> 15), 1 | h); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  const walk = (id, n, vol) => { const r = seed(id + n); const out = [1]; for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + (r() - 0.48) * vol)); const k = 1 / out[n - 1]; return out.map((v) => v * k); };
  const tick = () => 1 + Math.sin(Date.now() / 20000) * 0.002;
  const svg = (sym, i) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="32" fill="hsl(${(i * 47) % 360} 70% 52%)"/><text x="32" y="40" font-family="sans-serif" font-size="22" font-weight="700" text-anchor="middle" fill="#fff">${sym.slice(0, 3).toUpperCase()}</text></svg>`);

  const row = (c, i, cur) => {
    const [id, symbol, name, usd, cap] = c;
    const w = walk(id, 168, 0.018);
    const price = usd * RATE[cur] * tick();
    const pct = (a, b) => (a / b - 1) * 100;
    return {
      id, symbol, name, image: svg(symbol, i), current_price: price, market_cap: cap * RATE[cur], market_cap_rank: i + 1, total_volume: cap * RATE[cur] * 0.04,
      high_24h: price * 1.021, low_24h: price * 0.975, ath: price * 1.6, ath_change_percentage: -37.5, circulating_supply: cap / usd,
      price_change_percentage_1h_in_currency: pct(w[167], w[166]), price_change_percentage_24h_in_currency: pct(w[167], w[143]), price_change_percentage_7d_in_currency: pct(w[167], w[0]),
      sparkline_in_7d: { price: w.map((v) => v * price) }, last_updated: new Date().toISOString()
    };
  };

  Market.setTransport(async (path, params) => {
    await new Promise((r) => setTimeout(r, 120));
    const cur = params.vs_currency || 'usd';
    if (path === '/coins/markets') {
      let list = COINS.map((c, i) => row(c, i, cur));
      if (params.ids) { const ids = params.ids.split(','); list = list.filter((c) => ids.includes(c.id)); }
      return params.page > 1 ? [] : list;
    }
    if (path === '/search') {
      const q = params.query.toLowerCase();
      return { coins: COINS.map((c, i) => ({ id: c[0], symbol: c[1], name: c[2], large: svg(c[1], i), market_cap_rank: i + 1 })).filter((c) => c.name.toLowerCase().includes(q) || c.symbol.includes(q)) };
    }
    if (path === '/simple/price') return { bitcoin: { usd: COINS[0][3], pln: COINS[0][3] * RATE.pln, eur: COINS[0][3] * RATE.eur } };
    const hm = path.match(/^\/coins\/(.+)\/history$/);
    if (hm) {
      const c = COINS.find((x) => x[0] === decodeURIComponent(hm[1])) || COINS[0];
      const [d, mo, y] = params.date.split('-').map(Number);
      const age = Math.max(0, (Date.now() - new Date(y, mo - 1, d).getTime()) / 86400000);
      const price = c[3] * (1 - Math.min(0.6, age / 600)) * (0.9 + seed(c[0] + params.date)() * 0.2);
      return { market_data: { current_price: { usd: price, pln: price * RATE.pln, eur: price * RATE.eur } } };
    }
    const m = path.match(/^\/coins\/(.+)\/market_chart$/);
    if (m) {
      const c = COINS.find((x) => x[0] === decodeURIComponent(m[1])) || COINS[0];
      const days = Number(params.days) || 7;
      const n = days <= 1 ? 288 : days <= 90 ? days * 24 : 365;
      const w = walk(c[0] + days, n, days <= 1 ? 0.004 : days <= 90 ? 0.012 : 0.05);
      const now = Date.now();
      return { prices: w.map((v, i) => [now - (n - 1 - i) * ((days * 86400000) / n), v * c[3] * RATE[cur]]) };
    }
    return {};
  });
};
