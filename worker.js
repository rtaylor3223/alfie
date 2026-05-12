// Alfie Cloudflare Worker
//
// Two responsibilities:
// 1. fetch()     — proxies Anthropic API calls from the Alfie browser app.
// 2. scheduled() — runs nightly (cron) to refresh trades + equities in
//                  Supabase even when no browser is open. This is the
//                  "after market close" auto-update Raleigh wanted.
//
// Required secrets / vars (set via CF dashboard):
//   ANTHROPIC_API_KEY  (secret)  — Anthropic API key
//   SUPABASE_URL       (var)     — https://fkaegalhseaihongoreq.supabase.co
//   SUPABASE_KEY       (secret)  — Supabase anon/service-role key
//
// Cron triggers (set via CF dashboard > Triggers):
//   0 22 * * 1-5   — 22:00 UTC weekdays (~6pm EDT / 5pm EST, post-close)
//   0 11 * * 1-5   — 11:00 UTC weekdays (~7am EDT / 6am EST, pre-market)

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
    ctx.waitUntil(runNightlyRefresh(env, event.cron));
  },
};

// ─── NIGHTLY REFRESH ────────────────────────────────────────────────────────

async function runNightlyRefresh(env, cronExpr) {
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY || !env.ANTHROPIC_API_KEY) {
    console.error("Missing required env vars");
    return;
  }
  const startedAt = new Date().toISOString();
  console.log("Nightly refresh started", { cronExpr, startedAt });

  const trades = (await sbGet(env, "alfie_trades")) || [];
  const equities = (await sbGet(env, "alfie_equities")) || [];

  const openOpts = trades.filter(t => t.isOption && t.status === "open");
  const eqTickers = [...new Set(equities.map(e => (e.ticker || "").toUpperCase()).filter(Boolean))];

  // 1. Batched equity refresh
  if (eqTickers.length > 0) {
    const eqPrompt = `In one combined web search, look up the current stock price, one-sentence latest news, and recent SEC Form 4 insider activity (last 30 days) for each of these tickers: ${eqTickers.join(", ")}. Return ONLY JSON, no citation tags, plain text: {"results":{"TICKER":{"currentPrice":"","news":"one sentence","insider":"one sentence summarizing recent insider buys/sells, or 'none'"}}}`;
    try {
      const r = await callAnthropic(env, eqPrompt);
      if (r && r.results) {
        const ts = new Date().toLocaleTimeString();
        const updated = equities.map(e => {
          const k = (e.ticker || "").toUpperCase();
          const u = r.results[k] || r.results[e.ticker];
          return u
            ? { ...e, currentPrice: u.currentPrice || e.currentPrice, lastNews: u.news || e.lastNews, lastInsider: u.insider || e.lastInsider, lastUpdated: ts }
            : e;
        });
        await sbSet(env, "alfie_equities", updated);
        console.log(`Equities refreshed: ${eqTickers.length}`);
      }
    } catch (err) {
      console.error("Equity refresh failed:", err.message);
    }
  }

  // 2. Sequential per-option analysis
  let optionCount = 0;
  for (const t of openOpts) {
    const dte = t.expiration ? Math.ceil((new Date(t.expiration) - new Date()) / 86400000) : "Unknown";
    const optPrompt = `You are an options trading analyst. In ONE combined web search, find: latest news, options flow, put/call ratio, dark pool data, AND recent SEC Form 4 insider activity for ${t.ticker}. Then analyze this ${t.contractType} contract.\n\nContract: ${t.ticker} ${t.contractType} $${t.strike} exp ${t.expiration} (${dte} DTE) | Premium: $${t.price} | Breakeven: $${t.breakeven || "?"} | Delta: ${t.delta || "?"} Theta: ${t.theta || "?"} IV: ${t.iv || "?"}%\n\nWeights: Technical Bias 30%, Options Flow/IV 20%, Sector Rotation 20%, News 15%, Insider Activity 15%.\n\nReturn ONLY JSON, no citation tags, plain text values:\n{"currentPrice":"","verdict":"STAY IN","grade":"B","urgency":"no rush","bottomLine":"2-3 sentence recommendation","sectorRotation":{"grade":"B","phase":"Leading","summary":"one sentence"},"newssentiment":{"headline":"","bias":"bullish","summary":"one sentence"},"technicalBias":{"direction":"bullish","summary":"one sentence"},"optionsFlow":{"putCallRatio":"","unusualActivity":"","darkPool":"","socialSentiment":"","summary":"one sentence"},"ivAnalysis":{"environment":"high","decayRisk":"moderate","summary":"one sentence"},"insiderActivity":{"recentBuys":"","recentSells":"","netBias":"neutral","summary":"one sentence"},"weighting":{"sectorRotation":0,"newssentiment":0,"technicalBias":0,"optionsFlow":0,"ivDecay":0},"weightingSummary":"2 sentences on weighting"}`;
    try {
      const r = await callAnthropic(env, optPrompt);
      if (r) {
        const current = (await sbGet(env, "alfie_trades")) || [];
        const ts = new Date().toLocaleTimeString();
        const iso = new Date().toISOString();
        const updated = current.map(x =>
          x.id === t.id
            ? { ...x, currentPrice: r.currentPrice || x.currentPrice, lastAnalysis: r, lastAnalysisAt: iso, lastUpdated: ts }
            : x
        );
        await sbSet(env, "alfie_trades", updated);
        optionCount++;
      }
    } catch (err) {
      console.error(`Option refresh failed for ${t.ticker}:`, err.message);
    }
  }

  // 3. Mark refresh window in Supabase so app skips the in-browser refresh
  const today = new Date().toISOString().slice(0, 10);
  const window = cronExpr && cronExpr.startsWith("0 22") ? "pm" : "am";
  await sbSet(env, window === "am" ? "alfie_last_refresh_am" : "alfie_last_refresh_pm", today);
  await sbSet(env, "alfie_nightly_status", {
    lastRun: new Date().toISOString(),
    window,
    cronExpr,
    equitiesRefreshed: eqTickers.length,
    optionsRefreshed: optionCount,
  });

  console.log(`Nightly refresh complete: ${eqTickers.length} equities, ${optionCount} options`);
}

// ─── SUPABASE REST HELPERS ──────────────────────────────────────────────────

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

// ─── ANTHROPIC CALL (mirrors the browser-side callAPI) ──────────────────────

async function callAnthropic(env, prompt) {
  let msgs = [{ role: "user", content: prompt }];
  let finalText = "";
  for (let round = 0; round < 8; round++) {
    const body = {
      model: "claude-sonnet-4-5",
      max_tokens: 2000,
      system: "You are a financial analyst. Respond ONLY with a valid JSON object. No markdown, no backticks, no explanation, no citation tags, no HTML tags — raw JSON only. All string values must be plain text.",
      messages: msgs,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    };
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Anthropic ${res.status}: ${t.slice(0, 200)}`);
    }
    const d = await res.json();
    if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
    const content = d.content || [];
    const texts = content.filter(b => b.type === "text").map(b => b.text || "");
    if (texts.length) finalText = texts.join("").trim();
    if (d.stop_reason !== "tool_use") break;
    const toolUses = content.filter(b => b.type === "tool_use");
    const toolResults = toolUses.map(b => ({ type: "tool_result", tool_use_id: b.id, content: "Search results retrieved." }));
    msgs = [...msgs, { role: "assistant", content }, { role: "user", content: toolResults }];
  }
  finalText = finalText.replace(/```json/gi, "").replace(/```/g, "").trim();
  const si = finalText.indexOf("{"), ei = finalText.lastIndexOf("}");
  if (si < 0 || ei < 0) throw new Error(`No JSON in response: ${finalText.slice(0, 120)}`);
  return JSON.parse(finalText.slice(si, ei + 1));
}
