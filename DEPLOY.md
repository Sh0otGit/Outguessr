# Deploy runbook — Phase 2 backend

## Status: live

The Phase 2 backend is deployed and verified working at `outguessr.com`. `POST /api/submit`, `GET /api/results/:day`, and `GET /api/count/:day` are all confirmed live against the real D1 database. This section records what actually happened, since it went differently than first planned — useful context for the next person (or session) touching this.

### What we learned mid-deploy (corrections to the original plan)

- **There was never a separate Cloudflare Pages project.** `outguessr.com` was already served by a Worker named `outguessr` with Workers Builds (git integration) already connected to this repo — Cloudflare's dashboard now provisions new "connect a repo" setups as Workers by default, not classic Pages, even though CLAUDE.md's older "Deployment" section still described Pages. There was no build-output-directory setting to fix.
- **Branch pushes are not an isolated preview for this project.** Pushing to a non-`main` branch (`phase2-backend`) still deployed straight to the live Worker and all its bound routes, including the `outguessr.com` custom domain — there's no Pages-style per-branch preview isolation here. One Worker, one live version; any push that triggers a build overwrites it. Worth remembering before pushing anything experimental to any branch on this repo.
- **The D1 Studio's SQL console didn't reliably run multi-statement scripts.** Pasting the whole `migrations/0001_init.sql` in one go left the database in a partially-applied state (one table existed, others didn't) with no clear error pointing at why. Running one `CREATE TABLE` statement at a time, individually, is what actually worked reliably. `npx wrangler d1 execute --remote --file=...` (CLI) should apply a whole file atomically and avoid this — prefer that over the dashboard console for future migrations if CLI access is available.
- **Because of the branch-push behavior above, `/api/*` was briefly live and erroring** (bare Cloudflare 500 page, since observability wasn't enabled yet either) between the first push and the D1 schema actually landing. The static game and admin pages were unaffected throughout (unrelated to D1). Low-traffic hobby project, so real impact was minimal, but worth knowing the sequencing risk for next time: get the schema applied and confirmed *before* pushing the code that depends on it, not after.

### Current live configuration

- Worker: `outguessr`, custom domain `outguessr.com` (and workers.dev at `outguessr.matts-account-3de.workers.dev`)
- D1: `outguessr-db` (id `0e6b08e0-8889-4c4f-9018-b380499548e1`), schema applied — `answers`, `results`, `cron_runs`, `config` all exist, `config` seeded with `bot_floor=300` and `bots_enabled=1`
- `[observability] enabled = true` in `wrangler.toml`, so future errors show up in the dashboard's Logs tab
- `/api/*` failures return `{error: message}` JSON instead of a bare 500 page
- Workers Builds deploys on every push to any connected branch (see the isolation note above)

### Smoke test (rerun any time to confirm prod health)

```bash
curl -s -o /dev/null -w "home: %{http_code}\n" "https://outguessr.com/"
curl -s -o /dev/null -w "admin: %{http_code}\n" "https://outguessr.com/admin/"

curl -s -X POST "https://outguessr.com/api/submit" -H "Content-Type: application/json" \
  -d '{"day":"'"$(date -u +%Y-%m-%d)"'","playerId":"p_smoketest1","answer":0}'
# expect {"ok":true,"accepted":true} the first time, {"ok":true,"accepted":false} if rerun

curl -s -o /dev/null -w "results today: %{http_code} (expect 403)\n" \
  "https://outguessr.com/api/results/$(date -u +%Y-%m-%d)"

curl -s "https://outguessr.com/api/count/$(date -u +%Y-%m-%d)"
```

## Still to do

- **Set the `ADMIN_KEY` secret** — not consumed by any code yet (`/api/admin/*` doesn't exist), but nothing depends on it existing until that lands, so this can wait for the session that builds those routes:
  ```
  npx wrangler secret put ADMIN_KEY
  ```
- `/api/admin/*` routes
- Bot blending in the daily tally (currently tallies real submitted answers only)
- Roast-copy placeholder templating (`{avg}`, `{target}`, etc. — see CLAUDE.md's "Roast copy is a template" section)

## If something goes wrong

The Worker's dashboard page → **Deployments** tab has every previous build; rolling back is selecting an earlier one. D1 is separate from the Worker code, so a code rollback doesn't touch the data — `answers` is append-only and `results` can always be recomputed from it via the cron's tally logic (`src/index.js`, `runDailyTally`).
