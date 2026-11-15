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

  installRemoteMock();

  // Pozostałe źródła (oracle, giełdy, historia dzienna, wiadomości) – dane przykładowe z niewielkimi, deterministycznymi odchyłkami.
  function installRemoteMock() {
    const bySym = Object.fromEntries(COINS.map((c, i) => [c[1].toUpperCase(), { i, id: c[0], name: c[2], usd: c[3] }]));
    const feedId = (i) => (i + 1).toString(16).padStart(64, 'a');
    const drift = (src, sym) => { const k = (seed(src + sym)() - 0.5) * 0.003; return sym === 'DOGE' && src === 'binance' ? 1.09 : 1 + k; };
    const px = (sym, src) => bySym[sym].usd * tick() * drift(src, sym);
    const rssItem = (title, source, hours, link) => `<item><title>${title} - ${source}</title><link>${link}</link><pubDate>${new Date(Date.now() - hours * 3600000).toUTCString()}</pubDate><source url="https://example.com">${source}</source><description>${title}</description></item>`;
    const news = (q) => {
      const hit = COINS.find((c) => q.includes(c[2]) || q.includes(c[1].toUpperCase()));
      if (!hit) return '<rss><channel></channel></rss>';
      const n = hit[2];
      const items = [];
      if (hit[0] === 'solana') items.push(rssItem('Solana network outage halts block production for hours', 'CoinDesk', 3, 'https://example.com/sol1'), rssItem('Solana validators report outage, chain halt under investigation', 'The Block', 4, 'https://example.com/sol2'), rssItem('Solana stalled: outage hits network again', 'Decrypt', 5, 'https://example.com/sol3'));
      if (hit[0] === 'ethereum') items.push(rssItem('Ethereum spot ETF inflows hit record high as institutional adoption grows', 'Bloomberg', 6, 'https://example.com/eth1'), rssItem('Ethereum upgrade goes live on mainnet', 'Cointelegraph', 20, 'https://example.com/eth2'));
      if (hit[0] === 'bitcoin') items.push(rssItem('Bitcoin rallies as strategic partnership announced with major bank', 'Reuters', 2, 'https://example.com/btc1'), rssItem('Bitcoin faces selloff fears, analysts warn of correction', 'CNBC', 9, 'https://example.com/btc2'));
      if (hit[0] === 'dogecoin') items.push(rssItem('Rumors of insolvency spread as exchange pauses withdrawals of Dogecoin', 'CryptoSlate', 7, 'https://example.com/doge1'));
      if (!items.length) items.push(rssItem(`${n} price analysis: market stays quiet`, 'Decrypt', 12, 'https://example.com/x-' + hit[0]));
      return `<?xml version="1.0"?><rss><channel>${items.join('')}</channel></rss>`;
    };
    Remote.setTransport(async (req) => {
      await new Promise((r) => setTimeout(r, 80));
      const u = new URL(req.url);
      const host = u.hostname;
      const ok = (data) => ({ status: 200, data });
      if (host === 'hermes.pyth.network') {
        if (u.pathname.endsWith('price_feeds')) return ok(COINS.map((c, i) => ({ id: feedId(i), attributes: { asset_type: 'Crypto', base: c[1].toUpperCase(), quote_currency: 'USD', symbol: `Crypto.${c[1].toUpperCase()}/USD` } })));
        const ids = [...u.searchParams.getAll('ids[]')];
        return ok({ parsed: ids.map((id) => { const idx = COINS.findIndex((_, k) => feedId(k) === id); const c = COINS[idx]; const p = px(c[1].toUpperCase(), 'pyth'); return { id, price: { price: String(Math.round(p * 1e8)), conf: String(Math.round(p * 1e8 * 0.0005)), expo: -8, publish_time: Math.floor(Date.now() / 1000) - 3 } }; }) });
      }
      if (host === 'api.redstone.finance') {
        const out = {};
        for (const sym of (u.searchParams.get('symbols') || '').split(',')) if (bySym[sym]) out[sym] = { value: px(sym, 'redstone'), timestamp: Date.now() - 20000, symbol: sym };
        return ok(out);
      }
      if (host === 'min-api.cryptocompare.com') {
        if (u.pathname.endsWith('pricemulti')) { const out = {}; for (const sym of u.searchParams.get('fsyms').split(',')) if (bySym[sym]) out[sym] = { USD: px(sym, 'cc') }; return ok(out); }
        const sym = u.searchParams.get('fsym'); const cur = (u.searchParams.get('tsym') || 'USD').toLowerCase();
        const limit = Number(u.searchParams.get('limit')) || 30; const toTs = Number(u.searchParams.get('toTs')) || Math.floor(Date.now() / 1000);
        const c = bySym[sym]; if (!c) return ok({ Response: 'Error', Message: 'unknown symbol' });
        const DAYS = 2300; const w = walk(sym + 'd', DAYS, 0.035); const today = Math.floor(Date.now() / 86400000) * 86400;
        const data = [];
        for (let k = 0; k <= limit; k++) {
          const t = Math.floor(toTs / 86400) * 86400 - (limit - k) * 86400; const age = Math.round((today - t) / 86400);
          if (age < 0 || age >= DAYS) continue;
          data.push({ time: t, close: w[DAYS - 1 - age] * c.usd * RATE[cur] });
        }
        return ok({ Response: 'Success', Data: { Data: data } });
      }
      if (host === 'data-api.binance.vision') return ok(COINS.map((c) => ({ symbol: c[1].toUpperCase() + 'USDT', price: String(px(c[1].toUpperCase(), 'binance')) })));
      if (host === 'api.coinbase.com') { const rates = { USD: '1', PLN: String(RATE.pln), EUR: String(RATE.eur) }; for (const [sym, c] of Object.entries(bySym)) rates[sym] = String(1 / px(sym, 'coinbase')); return ok({ data: { currency: 'USD', rates } }); }
      if (host === 'reference-data-directory.vercel.app') return { status: 404 };
      if (host === 'ethereum-rpc.publicnode.com' || host === 'cloudflare-eth.com') {
        const word = (n) => BigInt(n).toString(16).padStart(64, '0');
        return ok(req.body.map((r) => { const to = r.params[0].to.toLowerCase(); const sym = to === '0xf4030086522a5beea4988f8ca5b36dbc97bee88c' ? 'BTC' : 'ETH'; const p = px(sym, 'chainlink'); return { jsonrpc: '2.0', id: r.id, result: '0x' + word(1) + word(Math.round(p * 1e8)) + word(1) + word(Math.floor(Date.now() / 1000) - 600) + word(1) }; }));
      }
      if (host === 'news.google.com') return { status: 200, text: news(u.searchParams.get('q') || '') };
      if (host === 'api.coingecko.com') return { status: 404 };
      return { status: 200, text: '<rss><channel></channel></rss>' };
    });
  }
};
