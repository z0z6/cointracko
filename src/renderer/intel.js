'use strict';
// Wiadomości o aktywach z portfela: pobieranie (Google News RSS + kanały branżowe), ocena tonu (bullish / bearish)
// oraz wykrywanie anomalii – tekstowych (włamania, nadużycia, problemy z płynnością, awarie sieci, plotki)
// i rynkowych (nagłe ruchy ceny, odklejenie stablecoina, rozbieżność źródeł cen).
// UWAGA: ocena opiera się na słowach kluczowych w nagłówkach – to heurystyka pomocnicza, nie porada inwestycyjna.
// Część czysta jest testowana w test/run-tests.js.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Intel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const HOUR = 3600000;
  const R = (src, flags = 'i') => new RegExp(src, flags);

  // [wyrażenie, waga 1–3]
  const BULLISH = [
    [R('\\b(spot )?etf (approv|launch|inflow)'), 3], [R('all[- ]time high|record high|\\bath\\b|new high'), 3], [R('mainnet (launch|live|goes live)'), 3],
    [R('(strategic|major) partnership|partners? with|partnership'), 2], [R('institutional (adoption|demand|buying|investors? (buy|accumulat))'), 3],
    [R('\\b(buys|acquires|accumulates|adds) (\\$?[\\d.,]+ ?(m|b|million|billion)? ?(worth of )?)?(bitcoin|ether|eth|btc|sol|xrp)'), 2],
    [R('\\b(surge[sd]?|soars?|soared|rall(y|ies|ied)|jumps?|jumped|skyrocket|spikes?|climbs?|breakout|breaks out)\\b'), 2],
    [R('\\b(bullish|upgrade[sd]?|upgrades|approv(al|es|ed)|adopt(s|ion|ed)|integrat(es|ion|ed)|launch(es|ed)|listing|listed on|lists)\\b'), 2],
    [R('net inflows?|inflows?\\b'), 2], [R('buyback|token burn|burns? '), 2], [R('milestone|record (volume|inflow|users|tvl)'), 2],
    [R('raises? \\$|funding round|secures? (funding|investment)|backed by'), 2],
    [R('\\b(gains?|rises?|rose|recover(s|y|ed)|rebound(s|ed)?|growth|positive|optimis)'), 1],
    [R('wzrost|rekord|partnerstw|zatwierdz|rajd|hossa'), 2]
  ];
  const BEARISH = [
    [R('\\b(crash(es|ed)?|plunge[sd]?|collaps(e|es|ed)|tank(s|ed)?|nosedive)\\b'), 3], [R('delist(s|ed|ing)?'), 3], [R('\\bbans?\\b|\\bbanned\\b|\\bprohibit'), 3],
    [R('lawsuit|\\bsues?\\b|\\bsued\\b|sec (charges|sues|action)|class action'), 3], [R('insolven|bankrupt|liquidat(ed|ion|ions)\\b'), 3], [R('\\bhack(ed|s)?\\b|exploit(ed|s)?\\b|drained|stolen'), 3],
    [R('\\b(drops?|dropped|falls?|fell|tumbles?|slumps?|sinks?|sell[- ]?off|dumps?|dumped|bearish|downgrade[sd]?)\\b'), 2],
    [R('net outflows?|outflows?\\b'), 2], [R('\\b(warns?|warning|probe|investigation|fined?|penalty|subpoena)\\b'), 2],
    [R('outage|delays?\\b|postpones?|cancels?|layoffs?|lays off|resign(s|ed|ation)'), 2], [R('\\b(fears?|concerns?|risks?|uncertainty)\\b'), 1],
    [R('\\b(declines?|losses|loses|weak|struggles?)\\b'), 1],
    [R('spadek|spadki|krach|zakaz|pozew|upadłoś|przecen|wyprzedaż'), 2]
  ];
  const NEGATION = /\b(no|not|never|without|denies|denied|dismisses|dismissed|debunk(s|ed)?|false|fake|refutes?|refuted|isn't|wasn't|won't)\b/i;

  // Anomalie tekstowe: rodzaj → wzorce z wagą (1–5)
  const KINDS = {
    hack: { label: 'Atak / włamanie', patterns: [
      [R('51% attack'), 5], [R('bridge (exploit|hack|attack)'), 5], [R('\\b(hack(ed|er|ers)?|exploit(ed)?|drain(ed|er)?|stolen|theft|heist)\\b'), 4],
      [R('(security )?breach|compromised|private keys?|rug ?pull|ddos'), 4], [R('vulnerabilit(y|ies)|bug bounty|critical (bug|flaw)'), 3], [R('phishing|wallet drainer'), 2],
      [R('haker|włam|kradzie|wyciek'), 4]
    ] },
    fraud: { label: 'Nadużycia / oszustwo', patterns: [
      [R('embezzl|misappropriat|ponzi|insider trading|money laundering'), 5], [R('\\bfraud(ulent)?\\b|defraud|\\bscam(s|med)?\\b|rug ?pull'), 4],
      [R('indict(ed|ment)|arrest(ed|s)?|charged with|subpoena|sec (sues|charges)|criminal (charges|probe)|class action'), 4],
      [R('mismanag|misuse of (investor )?funds|investors? (were )?(misled|defrauded)|undisclosed|conflict of interest|related[- ]party'), 3],
      [R('oszust|malwersac|defraud|pozew|pranie pieni'), 4]
    ] },
    insolvency: { label: 'Płynność / niewypłacalność', patterns: [
      [R('insolven|bankrupt'), 5], [R('(halts?|halted|pauses?|paused|suspends?|suspended|freez(es|ing)|froze|frozen) (all )?(customer )?(withdrawals?|redemptions?|deposits?)|withdrawals? (halted|paused|suspended|frozen)|can.?t withdraw'), 5],
      [R('bank run|liquidity crisis|liquidity crunch|cash crunch'), 4], [R('de-?peg(ged|s|ging)?|lost (its )?peg|loses peg'), 4],
      [R('upadłoś|wstrzyman\\w+ wypłat'), 5]
    ] },
    network: { label: 'Problemy z siecią', patterns: [
      [R('chain halt|network (halt|down|stall|outage)|halts? (block|network|chain)|block production (halt|stop)|mainnet (down|outage|issue)'), 4],
      [R('\\boutage\\b|downtime|stalled|consensus (failure|bug)|\\breorg\\b|node (crash|failure)'), 3], [R('validators? (offline|slashed)|mass slashing|congestion'), 2], [R('awaria sieci|przestój'), 3]
    ] },
    dump: { label: 'Wyprzedaż insiderów', patterns: [
      [R('(dev(eloper)?s?|team|founders?|insiders?|whales?) (wallet )?(dump|dumps|dumped|sell|sells|sold|offload)'), 3], [R('team wallet|dev wallet|unlock(s|ed)? (of )?(\\$|[\\d.,]+ ?(m|b))'), 2]
    ] }
  };
  const RUMOR = R('rumou?rs?|reportedly|allegedly|alleged|unconfirmed|speculation|suspect(ed|s)?|whistleblower|plotk|podobno');
  const DENIAL = R('denies|denied|dismisses|debunk|refutes?|refuted|false claim|fake news|no evidence|baseless|unfounded|dementuj');
  const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'after', 'amid', 'over', 'into', 'about', 'its', 'are', 'was', 'has', 'have', 'will', 'new', 'says', 'say', 'crypto', 'token', 'coin', 'price', 'news', 'as', 'to', 'of', 'in', 'on', 'at', 'a', 'an']);

  // ───────────────────────── RSS ─────────────────────────

  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  function decodeEntities(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
      return Object.prototype.hasOwnProperty.call(ENT, e.toLowerCase()) ? ENT[e.toLowerCase()] : m;
    });
  }
  const unCdata = (s) => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const stripTags = (s) => decodeEntities(unCdata(s).replace(/<[^>]*>/g, ' ')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  function tag(block, name) {
    const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
    return m ? m[1] : '';
  }

  // → [{ title, link, ts, source, summary }]; bezpieczne wobec uszkodzonego XML (wyrażenia bez zagnieżdżonych kwantyfikatorów)
  function parseRss(xml, { now = Date.now(), maxItems = 120 } = {}) {
    const out = [];
    if (typeof xml !== 'string') return out;
    const re = /<item[\s>]([\s\S]*?)<\/item>/gi;
    let m;
    while ((m = re.exec(xml)) && out.length < maxItems) {
      const b = m[1];
      let title = stripTags(tag(b, 'title'));
      const link = stripTags(tag(b, 'link'));
      let source = stripTags(tag(b, 'source'));
      const ts = Date.parse(stripTags(tag(b, 'pubDate')));
      if (!title || !/^https?:\/\//i.test(link) || !isFinite(ts)) continue;
      if (!source) { const sp = /^(.*\S)\s+-\s+([^-]{2,60})$/.exec(title); if (sp) { title = sp[1]; source = sp[2]; } }
      else if (title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
      out.push({ title: title.slice(0, 300), link, ts: Math.min(ts, now + HOUR), source: source.slice(0, 80), summary: stripTags(tag(b, 'description')).slice(0, 280) });
    }
    return out;
  }

  // ───────────────────────── klasyfikacja ─────────────────────────

  function scoreLexicon(text, list) {
    let sum = 0; const hits = [];
    for (const [re, w] of list) {
      const g = new RegExp(re.source, 'ig');
      let m;
      while ((m = g.exec(text))) {
        const before = text.slice(Math.max(0, m.index - 28), m.index);
        if (NEGATION.test(before)) continue; // „no hack”, „denies fraud”
        sum += w; hits.push(m[0].trim().toLowerCase());
        if (m[0].length === 0) g.lastIndex++;
        break; // jedna pozycja leksykonu liczy się raz
      }
    }
    return { sum, hits };
  }

  // item: { title, summary } → { tone, score, anomaly, hits }
  function classify(item) {
    const text = `${item.title || ''}. ${(item.summary || '').slice(0, 200)}`;
    const bull = scoreLexicon(text, BULLISH);
    const bear = scoreLexicon(text, BEARISH);
    const denied = DENIAL.test(text);
    const rumor = RUMOR.test(text);
    let anomaly = null;
    for (const [kind, def] of Object.entries(KINDS)) {
      const r = scoreLexicon(text, def.patterns);
      if (!r.hits.length) continue;
      let sev = 0;
      for (const [re, w] of def.patterns) { const m = re.exec(text); if (m && !NEGATION.test(text.slice(Math.max(0, m.index - 28), m.index))) sev = Math.max(sev, w); }
      if (!sev) continue;
      if (denied) sev -= 2;
      if (rumor) sev -= 1;
      if (sev >= 1 && (!anomaly || sev > anomaly.severity)) anomaly = { kind, label: def.label, severity: Math.min(5, sev), rumor, denied };
    }
    let score = bull.sum - bear.sum;
    if (anomaly && !anomaly.denied) score -= anomaly.severity;
    const tone = score >= 2 ? 'bullish' : score <= -2 ? 'bearish' : 'neutral';
    return { tone, score, anomaly, hits: [...bull.hits, ...bear.hits].slice(0, 6) };
  }

  // czy nagłówek dotyczy monety (nazwa lub symbol z ograniczeniami, żeby nie łapać zwykłych słów)
  function mentions(item, coin) {
    const text = `${item.title || ''} ${(item.summary || '').slice(0, 200)}`;
    const name = String(coin.name || '').trim();
    if (name.length >= 3) {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|[^\\p{L}\\p{N}])${esc}([^\\p{L}\\p{N}]|$)`, 'iu').test(text)) return true;
    }
    const sym = String(coin.symbol || '').toUpperCase();
    if (sym.length >= 2) return new RegExp(`(^|[^A-Za-z0-9])\\$?${sym.replace(/[^A-Z0-9]/g, '')}([^A-Za-z0-9]|$)`).test(text); // symbol tylko wielkimi literami
    return false;
  }

  const tokens = (t) => new Set(String(t).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)));
  const jaccard = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; const u = a.size + b.size - i; return u ? i / u : 0; };

  // grupuje powtarzające się doniesienia; count = liczba różnych serwisów
  function cluster(items, threshold = 0.5) {
    const groups = [];
    for (const it of [...items].sort((a, b) => b.ts - a.ts)) {
      const tk = tokens(it.title);
      const g = groups.find((x) => jaccard(x.tk, tk) >= threshold);
      if (g) { g.items.push(it); if (it.source) g.sources.add(it.source.toLowerCase()); g.oldest = Math.min(g.oldest, it.ts); }
      else groups.push({ tk, items: [it], sources: new Set(it.source ? [it.source.toLowerCase()] : []), oldest: it.ts });
    }
    return groups.map((g) => ({ ...g.items[0], count: Math.max(1, g.sources.size), firstSeen: g.oldest, others: g.items.slice(1, 4).map((i) => ({ source: i.source, link: i.link })) }));
  }

  // → [{ …item, tone, score, anomaly, coinId, key }]; scal wiele wyników dla jednej monety
  function analyzeCoin(coin, items, { now = Date.now(), maxAgeH = 24 * 7 } = {}) {
    const fresh = items.filter((i) => now - i.ts <= maxAgeH * HOUR && mentions(i, coin));
    return cluster(fresh).map((c) => {
      const cl = classify(c);
      let anomaly = cl.anomaly;
      if (anomaly) {
        const spreading = c.count >= 3 && now - c.firstSeen <= 72 * HOUR;
        anomaly = { ...anomaly, spreading, severity: Math.min(5, anomaly.severity + (c.count >= 3 && !anomaly.denied ? 1 : 0)) };
      }
      return { ...c, tone: cl.tone, score: cl.score, anomaly, hits: cl.hits, coinId: coin.id, key: `${coin.id}|${[...tokens(c.title)].sort().slice(0, 6).join('-')}` };
    }).sort((a, b) => b.ts - a.ts);
  }

  // Podsumowanie tonu monety: ważone świeżością (połowa wagi co 48 h)
  function sentiment(items, now = Date.now()) {
    let bull = 0; let bear = 0; let nb = 0; let ns = 0; let w = 0;
    for (const i of items) {
      const k = Math.pow(0.5, (now - i.ts) / (48 * HOUR)) * (1 + Math.min(2, i.count - 1) * 0.25);
      if (i.tone === 'bullish') { bull += k; nb++; } else if (i.tone === 'bearish') { bear += k; ns++; }
      w += k;
    }
    const net = bull + bear > 0 ? (bull - bear) / (bull + bear) : 0;
    const label = items.length < 2 ? 'za mało danych' : net >= 0.35 ? 'przewaga pozytywnych' : net <= -0.35 ? 'przewaga negatywnych' : 'mieszane';
    return { bullish: nb, bearish: ns, neutral: items.length - nb - ns, net, label };
  }

  // ───────────────────────── anomalie rynkowe ─────────────────────────
  // q: { change1h, change24h, volume, marketCap, usdPrice }, cons: wynik Oracles.consensus, stable: bool
  function marketAnomalies(coin, q, cons, { stable = false } = {}) {
    const out = [];
    const add = (kind, label, severity, detail) => out.push({ kind, label, severity, detail, coinId: coin.id, market: true });
    if (!q) return out;
    if (stable && q.usdPrice > 0) {
      const dev = Math.abs(q.usdPrice - 1);
      if (dev >= 0.01) add('depeg', 'Odklejenie od kursu 1 USD', dev >= 0.03 ? 5 : 4, `cena ${(q.usdPrice).toFixed(4)} USD`);
    } else {
      const a = Math.abs(q.change24h);
      if (a >= 25) add('move', 'Gwałtowny ruch ceny', 4, `${q.change24h > 0 ? '+' : ''}${q.change24h.toFixed(1)}% w 24 h`);
      else if (a >= 15) add('move', 'Silny ruch ceny', 3, `${q.change24h > 0 ? '+' : ''}${q.change24h.toFixed(1)}% w 24 h`);
      else if (Math.abs(q.change1h) >= 8) add('move', 'Nagły ruch w ciągu godziny', 3, `${q.change1h > 0 ? '+' : ''}${q.change1h.toFixed(1)}% w 1 h`);
      if (q.marketCap > 5e7 && q.volume / q.marketCap >= 1) add('volume', 'Nietypowo wysoki wolumen', 2, `wolumen ${(q.volume / q.marketCap).toFixed(1)}× kapitalizacji`);
    }
    if (cons && cons.entries) {
      const worst = cons.entries.filter((e) => e.outlier && !e.stale).sort((x, y) => Math.abs(y.devPct) - Math.abs(x.devPct))[0];
      if (worst && Math.abs(worst.devPct) >= 5) add('divergence', 'Rozbieżność źródeł cen', Math.abs(worst.devPct) >= 10 ? 4 : 3, `${worst.label}: ${worst.devPct > 0 ? '+' : ''}${worst.devPct.toFixed(1)}% od mediany`);
      if (cons.conflict) add('divergence', 'Źródła cen nie są zgodne', 3, `rozrzut ${cons.spreadPct ? cons.spreadPct.toFixed(1) : '?'}%`);
      const staleOracle = cons.entries.find((e) => e.stale && e.kind === 'oracle');
      if (staleOracle) add('stale', 'Oracle nie aktualizuje ceny', 2, staleOracle.label);
    }
    return out;
  }

  // ───────────────────────── pobieranie ─────────────────────────

  const FEEDS = [
    'https://www.coindesk.com/arc/outboundfeeds/rss/',
    'https://cointelegraph.com/rss',
    'https://decrypt.co/feed',
    'https://www.theblock.co/rss.xml'
  ];

  function googleUrl(coin) {
    const name = String(coin.name || coin.id).replace(/["()]/g, '');
    const sym = String(coin.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const who = sym && sym.length >= 3 ? `("${name}" OR ${sym})` : `"${name}"`;
    const q = `${who} (crypto OR token OR blockchain OR coin) when:7d`;
    return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  }

  function create({ remote, cache }) {
    // coins: [{ id, name, symbol }] → { items: { id: [analyzed] }, errors: n, at }
    async function fetchNews(coins, { limit = 12, now = Date.now() } = {}) {
      const list = coins.slice(0, limit);
      const feedItems = [];
      let errors = 0;
      const feedResults = await Promise.allSettled(FEEDS.map((u) => remote.text(u, { ttl: 15 * 60000 })));
      for (const r of feedResults) { if (r.status === 'fulfilled') feedItems.push(...parseRss(r.value, { now })); else errors++; }
      const items = {};
      let i = 0;
      const worker = async () => {
        while (i < list.length) {
          const coin = list[i++];
          let own = [];
          try { own = parseRss(await remote.text(googleUrl(coin), { ttl: 15 * 60000 }), { now }); } catch (_) { errors++; }
          items[coin.id] = analyzeCoin(coin, [...own, ...feedItems], { now });
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      const res = { items, errors, at: now, feeds: feedResults.filter((r) => r.status === 'fulfilled').length };
      if (cache) cache.set('news:last', res).catch(() => {});
      return res;
    }
    return { fetchNews, last: () => (cache ? cache.get('news:last', 24 * HOUR).catch(() => null) : Promise.resolve(null)) };
  }

  return { parseRss, classify, mentions, cluster, analyzeCoin, sentiment, marketAnomalies, googleUrl, create, FEEDS, KINDS, decodeEntities };
});
