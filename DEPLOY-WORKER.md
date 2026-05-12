# Deploy `alfie-proxy` Worker with nightly refresh

The Worker now does two things:
- proxies Anthropic API calls from the Alfie browser app (unchanged)
- runs a **scheduled cron** twice a day (post-close + pre-market, weekdays) that
  reads your `alfie_trades` and `alfie_equities` from Supabase, refreshes
  prices/news/insider/greeks via the same combined prompts the app uses,
  and writes the updates back to Supabase

When you next open Alfie, the data is already fresh — no in-browser refresh
wait.

---

## Deploy via Cloudflare dashboard (no CLI required)

1. **https://dash.cloudflare.com** → Workers & Pages → `alfie-proxy`
2. **Edit Code** → replace the entire file with the contents of
   `worker.js` from this repo → **Save and deploy**
3. **Settings → Variables and Secrets** — make sure these three exist:

   | Name                | Type   | Value                                                       |
   | ------------------- | ------ | ----------------------------------------------------------- |
   | `ANTHROPIC_API_KEY` | secret | (already set — leave alone)                                  |
   | `SUPABASE_URL`      | text   | `https://fkaegalhseaihongoreq.supabase.co`                  |
   | `SUPABASE_KEY`      | secret | the same `sb_publishable_...` key from `index.html` line 31 |

4. **Settings → Triggers → Cron Triggers → Add Cron Trigger**, add **both**:

   - `0 22 * * 1-5` — 22:00 UTC weekdays (≈6pm EDT / 5pm EST, post-close)
   - `0 11 * * 1-5` — 11:00 UTC weekdays (≈7am EDT / 6am EST, pre-market)

5. **Verify** — wait until the next scheduled fire, or manually trigger from
   the **Triggers** tab → **Send** → choose a cron → run it. Then:
   - Cloudflare dashboard → Worker → **Logs (Real-time)** should show
     `Nightly refresh started` and `Nightly refresh complete: N equities, M options`
   - Supabase → table `alfie_data` → row `alfie_nightly_status` will exist
     with `lastRun`, `window`, counts

---

## Deploy via wrangler CLI (alternative)

```powershell
npm install -g wrangler
wrangler login
wrangler secret put SUPABASE_KEY
wrangler deploy
```

`wrangler.toml` already declares the cron triggers and the `SUPABASE_URL` var.

---

## DST note

Cloudflare crons are UTC and don't shift for DST. `0 22 UTC` is 6pm EDT in
summer and 5pm EST in winter — both safely after the 4pm ET close, so it
doesn't matter. Same logic for the 11:00 UTC pre-market run.

## What the Worker does NOT do

- Doesn't fire on weekends (markets closed; data is stale)
- Doesn't touch `alfie_backup_*` rows (those are the in-app daily snapshots)
- Doesn't run if Supabase or Anthropic credentials are missing — silent
  error to the log

## Cost

Cloudflare Workers free tier: 3 cron triggers per Worker, unlimited cron
invocations within the standard daily-request limit (100k/day). Your Anthropic
spend is the same combined prompts you'd run anyway — just shifted to
server-side and guaranteed to execute regardless of whether Alfie is open.
