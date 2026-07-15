# Deploy runbook — Phase 2 backend cutover

Everything in this file is a manual, one-time step done by hand from the Cloudflare account that owns outguessr.com. None of it can be done from a coding session — I don't have your Cloudflare credentials.

## ⚠️ Do this first, before (or immediately after) merging this commit

The game files moved from the repo root into `public/` (needed so the Worker can serve them as its static-assets directory). **Your current live Cloudflare Pages project is still configured to build from the repo root.** Left alone, the next push will make Pages serve an empty/broken site.

Fix (30 seconds, keeps the site on Pages exactly as before — no Worker involvement yet):

1. Cloudflare dashboard → **Workers & Pages** → your Pages project (outguessr) → **Settings** → **Builds & deployments**.
2. Set **Build output directory** to `public`.
3. Save. Trigger a redeploy (or just push again) and confirm outguessr.com still loads.

Do this whether or not you're ready to cut over to the Worker below — it's the difference between "site keeps working" and "site breaks on next push."

## Provisioning the Phase 2 backend

Everything below gets the Worker + D1 running and tested, without touching outguessr.com yet — safe to do at any pace.

### 1. Authenticate wrangler

```
npx wrangler login
```

Opens a browser to authorize the CLI against your account.

### 2. Create the D1 database

```
npx wrangler d1 create outguessr-db
```

Copy the `database_id` from the output into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "outguessr-db"
database_id = "PASTE_IT_HERE"   # currently "REPLACE_WITH_D1_DATABASE_ID"
```

### 3. Apply the schema

```
npm run db:migrate:remote
```

(Runs `wrangler d1 execute outguessr-db --remote --file=migrations/0001_init.sql`.) Verify:

```
npx wrangler d1 execute outguessr-db --remote --command="SELECT name FROM sqlite_master WHERE type='table'"
```

Expect `answers`, `results`, `cron_runs`, `config`.

### 4. Set the admin secret

Not consumed by any code yet (`/api/admin/*` is a future session), but set it now so it's ready:

```
npx wrangler secret put ADMIN_KEY
```

Paste a long random value when prompted (e.g. `openssl rand -hex 32`). This becomes the value the future `/api/admin/*` routes check against an `X-Admin-Key` header.

### 5. First deploy (to workers.dev, NOT your custom domain yet)

```
npx wrangler deploy
```

Wrangler prints a `*.workers.dev` URL. This is a completely separate address from outguessr.com — nothing about your live site changes yet.

### 6. Smoke test against that workers.dev URL

Replace `WORKER_URL` below with the URL from step 5.

```bash
WORKER_URL="https://outguessr.YOUR-SUBDOMAIN.workers.dev"

# static site still serves
curl -s -o /dev/null -w "home: %{http_code}\n" "$WORKER_URL/"
curl -s -o /dev/null -w "admin: %{http_code}\n" "$WORKER_URL/admin/"

# submit — use today's real UTC date and a valid answer for whatever
# format is live that day (0-100 for crunch/herdmeter, a valid option
# index for oddonein, 0 or 1 for splitsteal)
curl -s -X POST "$WORKER_URL/api/submit" -H "Content-Type: application/json" \
  -d '{"day":"2026-07-15","playerId":"p_smoketest1","answer":0}'
# expect: {"ok":true,"accepted":true}

# duplicate of the same submission
curl -s -X POST "$WORKER_URL/api/submit" -H "Content-Type: application/json" \
  -d '{"day":"2026-07-15","playerId":"p_smoketest1","answer":0}'
# expect: {"ok":true,"accepted":false}

# today's results must be blocked
curl -s -o /dev/null -w "results today: %{http_code} (expect 403)\n" \
  "$WORKER_URL/api/results/2026-07-15"

# count is safe to expose
curl -s "$WORKER_URL/api/count/2026-07-15"
# expect: {"count":<some number ≥ 1>}
```

If all of those look right, the backend is solid. Now it's just wiring it to the real domain.

## Wire up git-push-to-deploy (Workers Builds)

Keeps `git push` as the deploy step, same as Pages does today.

1. Cloudflare dashboard → **Workers & Pages** → your Worker (**outguessr**) → **Settings** → **Builds**.
2. **Connect** → authorize GitHub if needed → select this repo → branch `main`.
3. Save. Every push to `main` now deploys the Worker automatically — you'll see build status in the GitHub commit checks, same as Pages did.

## Cut over the custom domain

A domain can only point at one project at a time, so this is the one step with a brief switchover.

1. Old project first: dashboard → **Workers & Pages** → your **Pages** project → **Custom domains** → remove `outguessr.com`.
2. New project: dashboard → **Workers & Pages** → your **Worker** (outguessr) → **Settings** → **Domains & Routes** → **Add Custom Domain** → `outguessr.com`.
3. DNS propagates quickly on Cloudflare (usually seconds since it's already on their network) — reload outguessr.com to confirm.

## Post-cutover smoke test (production)

Same commands as before, pointed at the real domain:

```bash
curl -s -o /dev/null -w "home: %{http_code}\n" "https://outguessr.com/"
curl -s -o /dev/null -w "admin: %{http_code}\n" "https://outguessr.com/admin/"

curl -s -X POST "https://outguessr.com/api/submit" -H "Content-Type: application/json" \
  -d '{"day":"'"$(date -u +%Y-%m-%d)"'","playerId":"p_prodsmoketest","answer":0}'

curl -s -o /dev/null -w "results today: %{http_code} (expect 403)\n" \
  "https://outguessr.com/api/results/$(date -u +%Y-%m-%d)"

curl -s "https://outguessr.com/api/count/$(date -u +%Y-%m-%d)"
```

## If something goes wrong

Re-adding `outguessr.com` to the old Pages project (and removing it from the Worker) reverts to the exact site that was live before — Pages was never deleted, just detached from the domain. Nothing about this cutover is destructive or irreversible.

## Not in this skeleton (future sessions)

- `/api/admin/*` routes (the `ADMIN_KEY` secret above is set and waiting for them)
- Bot blending in the daily tally (currently tallies real answers only)
- Roast-copy placeholder templating (`{avg}`, `{target}`, etc. — see CLAUDE.md)
