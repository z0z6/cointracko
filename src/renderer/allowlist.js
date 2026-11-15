'use strict';
// Lista dozwolonych zdalnych adresów (wspólna dla procesu głównego, podglądu w przeglądarce i Androida). Aplikacja łączy się wyłącznie z tymi serwisami i tylko z wymienionymi
// ścieżkami – zapytania z okna (i z przeglądarki podglądu) przechodzą przez ten filtr w procesie głównym.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Allowlist = factory();
})(typeof self !== 'undefined' ? self : this, function () {
const RULES = {
  // notowania i historia
  'api.coingecko.com': { path: /^\/api\/v3\/[a-z0-9_\-/.]+$/i },
  'min-api.cryptocompare.com': { path: /^\/data\/(v2\/)?(histoday|pricemulti)$/ },
  'data-api.binance.vision': { path: /^\/api\/v3\/(klines|ticker\/price)$/ },
  // oracle i niezależne źródła cen
  'hermes.pyth.network': { path: /^\/v2\/(price_feeds|updates\/price\/latest)$/ },
  'api.redstone.finance': { path: /^\/prices\/?$/ },
  'reference-data-directory.vercel.app': { path: /^\/feeds-mainnet\.json$/ },
  'ethereum-rpc.publicnode.com': { path: /^\/$/, methods: ['POST'], rpc: true },
  'cloudflare-eth.com': { path: /^\/$/, methods: ['POST'], rpc: true },
  'api.coinbase.com': { path: /^\/v2\/exchange-rates$/ },
  // wiadomości
  'news.google.com': { path: /^\/rss\/search$/ },
  'www.coindesk.com': { path: /^\/arc\/outboundfeeds\/rss\/?$/ },
  'cointelegraph.com': { path: /^\/rss\/?$/ },
  'decrypt.co': { path: /^\/feed\/?$/ },
  'www.theblock.co': { path: /^\/rss\.xml$/ }
};

// JSON-RPC: wolno wyłącznie odczyt kontraktu (eth_call) – nic, co zmienia stan lub wysyła transakcje.
function rpcBodyAllowed(body) {
  let parsed;
  try { parsed = typeof body === 'string' ? JSON.parse(body) : body; } catch (_) { return false; }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.length > 0 && list.length <= 200 && list.every((r) => r && r.method === 'eth_call');
}

function isAllowed(rawUrl, method = 'GET', body) {
  let u;
  try { u = new URL(rawUrl); } catch (_) { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const rule = RULES[u.hostname];
  if (!rule || !rule.path.test(u.pathname)) return false;
  if (!(rule.methods || ['GET']).includes(String(method).toUpperCase())) return false;
  if (rule.rpc && !rpcBodyAllowed(body)) return false;
  return true;
}

const hostsOf = () => Object.keys(RULES);

return { RULES, isAllowed, rpcBodyAllowed, hostsOf };
});
