// Alfie Cloudflare Worker — economical refresh edition
//
// fetch()     — proxies Anthropic API calls from the browser app (unchanged).
// scheduled() — nightly cron: refreshes prices/news/insider via FREE finance
//               APIs (Finnhub for equities, Yahoo Finance public chain for
//               options). Zero Anthropic spend in the refresh path.
//
// Required vars/secrets (CF dashboard):
//   ANTHROPIC_API_KEY  (secret) — for browser proxy
//   SUPABASE_URL       (text)   — https://fkaegalhseaihongoreq.supabase.co
//   SUPABASE_KEY       (secret) — Supabase publishable key
//   FINNHUB_API_KEY    (secret) — https://finnhub.io free tier
//
// Cron triggers:
//   0 22 * * 1-5  (~6pm EDT / 5pm EST, post-close)
//   0 11 * * 1-5  (~7am EDT / 6am EST, pre-market)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, anthropic-version, anthropic-beta",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });
    const body = await request.text();
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
      },
      body,
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runRefresh(env, event.cron));
  },
};

// ─── REFRESH ENTRY ──────────────────────────────────────────────────────────

async function runRefresh(env, cronExpr) {
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY || !env.FINNHUB_API_KEY) {
    console.error("Missing required env vars (SUPABASE_URL / SUPABASE_KEY / FINNHUB_API_KEY)");
    return;
  }
  console.log("Refresh started", { cronExpr, at: new Date().toISOString() });

  const trades = (await sbGet(env, "alfie_trades")) || [];
  const equities = (await sbGet(env, "alfie_equities")) || [];
  const openOpts = trades.filter(t => t.isOption && t.status === "open");

  // 1. Equities via Finnhub (parallel)
  let eqUpdated = 0;
  if (equities.length) {
    const updates = await Promise.all(equities.map(e => refreshEquity(env, e).catch(err => {
      console.error(`Equity ${e.ticker} failed:`, err.message);
      return null;
    })));
    const newEquities = equities.map((e, i) => updates[i] ? { ...e, ...updates[i] } : e);
    await sbSet(env, "alfie_equities", newEquities);
    eqUpdated = updates.filter(Boolean).length;
  }

  // 2. Options via Yahoo Finance (sequential, small delay to avoid rate limits)
  let optUpdated = 0;
  if (openOpts.length) {
    const idMap = {};
    for (const t of openOpts) {
      try {
        const update = await refreshOption(t);
        if (update) idMap[t.id] = update;
      } catch (err) {
        console.error(`Option ${t.ticker} ${t.strike} ${t.expiration} failed:`, err.message);
      }
      await sleep(150);
    }
    if (Object.keys(idMap).length) {
      const current = (await sbGet(env, "alfie_trades")) || [];
      const newTrades = current.map(x => idMap[x.id] ? { ...x, ...idMap[x.id] } : x);
      await sbSet(env, "alfie_trades", newTrades);
      optUpdated = Object.keys(idMap).length;
    }
  }

  // 3. Mark refresh window + status
  const today = new Date().toISOString().slice(0, 10);
  const isPM = cronExpr && cronExpr.startsWith("0 22");
  await sbSet(env, isPM ? "alfie_last_refresh_pm" : "alfie_last_refresh_am", today);
  await sbSet(env, "alfie_nightly_status", {
    lastRun: new Date().toISOString(),
    window: isPM ? "pm" : "am",
    cronExpr,
    equitiesRefreshed: eqUpdated,
    optionsRefreshed: optUpdated,
    source: "finnhub+yahoo",
  });
  console.log(`Refresh done: ${eqUpdated} equities, ${optUpdated} options`);
}

// ─── EQUITY REFRESH VIA FINNHUB ────────────────────────────────────────────

async function refreshEquity(env, eq) {
  const ticker = (eq.ticker || "").toUpperCase().trim();
  if (!ticker || ticker.includes(" ")) {
    // Skip non-standard tickers like "STANDARD LITHIUM" (Finnhub needs SLI etc)
    return null;
  }
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const [quote, news, insider] = await Promise.all([
    finnhub(env, `/quote?symbol=${ticker}`),
    finnhub(env, `/company-news?symbol=${ticker}&from=${from}&to=${to}`),
    finnhub(env, `/stock/insider-transactions?symbol=${ticker}`),
  ]);
  if (!quote || !quote.c) return null; // Finnhub returns c=0 for unknown tickers
  const ts = new Date().toLocaleTimeString();
  const update = {
    currentPrice: String(quote.c),
    priceChange: quote.d != null ? String(quote.d) : eq.priceChange,
    priceChangePercent: quote.dp != null ? String(quote.dp) : eq.priceChangePercent,
    dayHigh: quote.h != null ? String(quote.h) : eq.dayHigh,
    dayLow: quote.l != null ? String(quote.l) : eq.dayLow,
    prevClose: quote.pc != null ? String(quote.pc) : eq.prevClose,
    lastUpdated: ts,
  };
  if (Array.isArray(news) && news.length) {
    update.lastNews = news[0].headline || "";
    update.newsCount7d = news.length;
  }
  if (insider && Array.isArray(insider.data) && insider.data.length) {
    const recent = insider.data.slice(0, 50);
    const buys = recent.filter(x => (x.transactionCode || "").toUpperCase().startsWith("P") || (x.change || 0) > 0).length;
    const sells = recent.filter(x => (x.transactionCode || "").toUpperCase().startsWith("S") || (x.change || 0) < 0).length;
    update.lastInsider = `${buys} buys / ${sells} sells (last ~90d)`;
    update.insiderBuys = buys;
    update.insiderSells = sells;
  }
  return update;
}

async function finnhub(env, path) {
  const url = `https://finnhub.io/api/v1${path}${path.includes("?") ? "&" : "?"}token=${env.FINNHUB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 429) {
      await sleep(1100);
      return finnhub(env, path);
    }
    console.error(`Finnhub ${path} HTTP ${res.status}`);
    return null;
  }
  return res.json();
}

// ─── OPTION REFRESH VIA YAHOO FINANCE ──────────────────────────────────────

async function refreshOption(t) {
  const ticker = (t.ticker || "").toUpperCase().trim();
  if (!ticker) return null;
  const expUnix = Math.floor(new Date(t.expiration + "T16:00:00Z").getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker)}?date=${expUnix}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "application/json",
    },
  });
  if (!res.ok) {
    console.error(`Yahoo ${ticker} HTTP ${res.status}`);
    return null;
  }
  const data = await res.json();
  const result = data && data.optionChain && data.optionChain.result && data.optionChain.result[0];
  if (!result) return null;
  const chain = result.options && result.options[0];
  if (!chain) return null;
  const list = (t.contractType || "CALL").toUpperCase() === "PUT" ? chain.puts : chain.calls;
  if (!Array.isArray(list)) return null;
  const strike = Number(t.strike);
  const contract = list.find(c => Math.abs(Number(c.strike) - strike) < 0.0001);
  if (!contract) return null;
  const ts = new Date().toLocaleTimeString();
  const mid = (contract.bid != null && contract.ask != null && contract.bid > 0 && contract.ask > 0)
    ? (Number(contract.bid) + Number(contract.ask)) / 2
    : Number(contract.lastPrice || 0);
  return {
    currentPrice: mid,
    mark: mid,
    bid: contract.bid != null ? Number(contract.bid) : t.bid,
    ask: contract.ask != null ? Number(contract.ask) : t.ask,
    lastTrade: contract.lastPrice != null ? Number(contract.lastPrice) : t.lastTrade,
    volume: contract.volume != null ? Number(contract.volume) : t.volume,
    openInterest: contract.openInterest != null ? Number(contract.openInterest) : t.openInterest,
    iv: contract.impliedVolatility != null ? Number((contract.impliedVolatility * 100).toFixed(2)) : t.iv,
    spread: (contract.bid != null && contract.ask != null) ? Number((Number(contract.ask) - Number(contract.bid)).toFixed(2)) : t.spread,
    inTheMoney: contract.inTheMoney,
    lastUpdated: ts,
  };
}

// ─── SUPABASE REST ──────────────────────────────────────────────────────────

async function sbGet(env, key) {
  const url = `${env.SUPABASE_URL}/rest/v1/alfie_data?key=eq.${encodeURIComponent(key)}&select=value`;
  const res = await fetch(url, {
    headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}` },
  });
  if (!res.ok) {
    console.error(`sbGet ${key} HTTP ${res.status}`);
    return null;
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return null;
  try { return JSON.parse(rows[0].value); } catch { return null; }
}

async function sbSet(env, key, value) {
  const url = `${env.SUPABASE_URL}/rest/v1/alfie_data?on_conflict=key`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_KEY,
      Authorization: `Bearer ${env.SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ key, value: JSON.stringify(value) }),
  });
  if (!res.ok) console.error(`sbSet ${key} HTTP ${res.status}`);
}

// ─── UTIL ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
