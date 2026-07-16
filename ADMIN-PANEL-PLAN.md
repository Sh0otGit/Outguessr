# Outguessr Admin Panel — Design Plan

*The operator's cockpit for a one-person daily game. Desktop-first (you'll use it from your PC, unlike the mobile-first game), same dark visual identity as the game, built for the Phase 2 backend (Workers + D1). This doc + the clickable mockup together are the spec you hand to Claude Code.*

## Build status

- **Dashboard**: live. Real tiles (real players, bots blended, new/returning players today), 30-day players chart, cron status in the status bar — all from `GET /api/admin/stats`. The spoiler shield reveals *real* live data via `GET /api/admin/live/:day` (still gated behind the click-through, still admin-key-only) as a **stacked real/bot chart** — solid purple for real players, a striped overlay for bots, winner/peak bars labeled directly on the chart. Yesterday's recap reads the same public `GET /api/results/:day` the game itself uses and gets the same stacked treatment. Streak distribution and share-card counts show an honest "—" with a tooltip explaining why (client-side-only and untracked, respectively) instead of a fabricated number.
- **Calendar / Challenges**: same features as Phase 1, but now backed by the key-gated `GET /api/admin/challenges` instead of a public `challenges.json` file (see CLAUDE.md's "Challenge data is server-only") — both tabs now require the admin key like everything else.
- **Bots**: live. Floor control is a slider + number input (synced) with 0/300/1,000/10,000 presets, up to a 10,000 ceiling, writing `POST /api/admin/config`. Kill switch with a confirmation modal. Today's projected blend uses the honest `GET /api/admin/count/:day` split (real ramped live, not the Dashboard tile's static full-floor projection). Static note that bot profiles are always each challenge's own authored `crowd` — there's no separate per-format profile to configure.
- **System**: live. Last 14 `cron_runs` with status tags, cron error rate, D1 row counts across all four tables, manual re-tally for any day. Today's open/closed state is now a full visible state machine: an OPEN/CLOSED EARLY chip at the top of the tab (and a matching red chip in the status bar everywhere), force-close (confirmation names both effects: submissions stop AND results publish immediately), reopen (confirmation: deletes today's published results), and reset (double confirmation — type `RESET` — deletes today's answers too). Every action renders its own response state in place, no re-fetch.
- **Players**: live. Summary tiles (total players, DAU, WAU, new today) + a 14-day new-player cohort chart, both from the key-gated `GET /api/admin/players`. A flagged-activity table surfaces players with more than 5 rejected submissions today (`submit_rejections`, written by every `POST /api/submit` rejection — duplicate/closed/invalid/blocked) and players sitting in the config-backed blocklist. Player lookup accepts any `player_id` and shows day-by-day participation via `GET /api/admin/players/:id` — today's own pick is never shown, even here (golden rule 2 doesn't bend for an admin looking up one player). Per-player actions: Invalidate a closed day (deletes that answer, re-tallies immediately), Block/Unblock (shadow-block — a blocked player's future submissions are silently rejected but they get an identical success response, never a signal), and Delete (full removal from `answers`/`results_players`/`shares`/`submit_rejections`, typed-DELETE confirmation, re-tallies any closed day they played within the last 7 days). CSV export via `GET /api/admin/players.csv`. No IP is stored anywhere in this codebase — the flagged list is player-ID-only by design, not by omission.
- **Arena**: still placeholder tiles, not built yet (Phase 3).
- **Admin auth**: a whole-panel **login gate**, not per-section prompts. Nothing but the centered login card renders until the entered key verifies against a real `GET /api/admin/config` call — no nav, no status bar, no tab content leaks out before that. A successful unlock swaps straight to the full panel in place, no reload. A "🔒 Lock" button in the status bar clears the key and drops back to the login card; any 401 from any later call does the same automatically (session-expired handling). Every `/api/admin/*` route still checks `X-Admin-Key` against the `ADMIN_KEY` Worker secret server-side and fails closed if the secret was never set — the client-side gate is a UX layer on top of that, not a replacement for it. `/admin` itself is still a public page — Cloudflare Access can wrap it later with zero code changes, per the Security section below.

---

## What an admin panel for a daily game must answer

Every morning you'll open this panel with four questions. The layout is organized so each has a home:

1. **Is the game healthy today?** → Dashboard
2. **Is content queued up?** → Challenge Calendar (running out of scheduled challenges is the #1 way daily games die)
3. **Did the midnight reveal work?** → Results & System status
4. **Is anything weird happening?** → Players & anti-abuse

## Layout

Left **sidebar navigation** (persistent): Dashboard · Calendar · Challenges · Bots · Players · Arena (grayed out until Phase 3) · System. Top **status bar** (always visible on every section): today's challenge number and format, live submission count, countdown to midnight UTC close, and a green/red dot for "last cron run succeeded." A red top bar is how you find out something broke before your players do.

Main content area per section, max ~1100px wide. Same palette as the game (bg `#0e1016`, cards `#171b24`, lime `#b7f04a`, purple `#8e78ff`) — it's your brand, and it makes the panel feel like part of the product rather than a chore.

## Section by section — stats shown, actions allowed

### 1. Dashboard (default view)

**Stat tiles (today):** live submissions (split: real players vs. bots currently blended), unique returning players, new players, share-card copies yesterday, current bot blend %.

**Trend charts:** daily players last 30 days (the line that tells you if you're growing), D1 retention (% of yesterday's players who came back today — the single most important number a daily game has), share rate (shares ÷ players), streak distribution (how many players hold 3+, 7+, 30+ day streaks — your most valuable users).

**Yesterday's recap card:** final distribution, winning zone, roast copy as shipped, player count. This is also your daily QA — you see exactly what players saw.

**⚠️ The spoiler shield (a rule, not a feature):** today's *live distribution* is hidden by default behind a "Reveal (forfeits your play today)" click-through. You're the game's #1 player; the panel shouldn't ruin your own daily. You see the *count* freely, never the shape, unless you explicitly forfeit. This mirrors the game's golden rule: the blind answer is sacred.

**Actions:** none on the dashboard. It's read-only on purpose — actions live where their context lives.

### 2. Challenge Calendar

A month grid. Each day shows its scheduled challenge (format icon + number) or a **red "EMPTY" flag**. A banner counts down your runway: "Content scheduled through Aug 12 — 18 days of runway." When runway < 7 days, the top status bar goes yellow everywhere. Running dry is the death mode this section exists to prevent.

**Actions:** add challenge to a day, edit scheduled challenge, swap two days (drag or swap button), duplicate a past challenge to a future date, **preview any day as a player** (renders the real game UI in a modal), delete (with confirmation, only for future days — past days are history, never editable except roast-copy typos).

### 3. Challenges (the deck)

Table of every challenge ever run + the format library. Per format: times run, avg players, avg share rate, completion rate. This is how you decide which formats to double down on and which to retire — the deck curation loop from the roadmap.

**Actions:** create challenge (format picker → format-specific fields → sim-distribution params → roast copy), edit future challenges, archive a format (stops suggesting it, keeps history), fix typos in past roast copy (the one retroactive edit allowed).

### 4. Bots (cold-start controls)

**Stats:** current bot target (default 300), real players today, effective blend today (e.g., "217 bots + 83 real = 300 floor"), per-format distribution profiles in use.

**Actions:** set bot floor (slider 0–500), edit per-format distribution profiles (the shape bots answer with), **kill switch** (all bots off, big red toggle, confirmation required), and a "retirement rule" display: bots = max(0, floor − real players), so they age out automatically as the game grows.

### 5. Players — ✅ built

**Stats:** total known player IDs, DAU/WAU, a 14-day new-player cohort chart, flagged activity: players with more than 5 rejected submissions today (`submit_rejections`, logged by every rejected `POST /api/submit`), and players sitting in the blocklist. Deliberately **not** built: abnormal-submission-burst detection by IP range — no IP is stored anywhere in this codebase, and that's a rule, not a gap. Streaks stay client-side-only (localStorage) — no top-streaks table here, same reasoning as the Dashboard's honest "—" for streak distribution.

**Actions:** invalidate a player ID's submissions for a closed day (deletes the answer, re-tallies immediately — rejected for today, which self-corrects at tonight's tally), block/unblock an ID (shadow-block: identical success response, no signal to the player), delete all data for an ID (privacy requests — full removal from `answers`/`results_players`/`shares`/`submit_rejections`, typed-DELETE confirmation, re-tallies any closed day they played in the last 7 days), export players CSV.

### 6. Arena (Phase 3 — visible but grayed out now)

Placeholder tile so the panel's information architecture is ready: rooms list, active rooms right now, weekly "smartest chat" leaderboard, per-room head-to-head records. Actions will be: rename/remove room, reset a room's record, feature a channel. Designing the nav slot now costs nothing and keeps Phase 3 from becoming a bolt-on.

### 7. System

**Stats:** last midnight cron run (time, duration, success/fail, players tallied), API error rate (24h), D1 storage used, requests today vs. free-tier limit.

**Actions:** **re-run tally** for a given day (the "cron failed at 3am" fix — recomputes results blob from raw answers, idempotent and safe), force-close today early (emergency only, confirmation), export any day's raw answers CSV, view recent error log.

## Actions deliberately NOT allowed

As important as what's in: no editing today's challenge after it opens (players already answered it — swap tomorrow's instead), no editing past results (the game's integrity is the product; the single exception is roast-copy typos), no viewing individual players' answer histories linked to anything identifying (you store random IDs and nothing else — keep it that way), and no admin write actions from the dashboard (read and act are separated so a misclick can't break the live game).

## Security (simple and adequate)

- Admin panel lives at `/admin` as a **separate page** — its JS is never bundled into the public game.
- Protect it with **Cloudflare Access** (free for up to 50 users): you log in with your Google account, Cloudflare blocks everyone else *before* the page even loads. Zero auth code to write, which for a hobbyist is the difference between secure and "TODO: add auth."
- Admin API endpoints (`/api/admin/*`) check a secret header set as a Worker environment variable — belt and suspenders under Access.
- Never put the admin secret in the frontend repo. It lives in Cloudflare's dashboard as an encrypted variable.

## Build order (vibe-coding sessions)

1. ✅ `/admin` static page + Cloudflare Access in front of it.
2. ✅ Challenge Calendar reading `challenges.json`. Preview-as-player modal reusing the game's own components.
3. ✅ Dashboard tiles wired to `GET /api/admin/stats`.
4. ✅ Bots panel + re-run tally button (shipped together with System, since both needed the same admin-auth layer).
5. ✅ Players section — summary tiles, cohort chart, flagged activity, lookup, block/unblock/invalidate/delete, CSV export.

Each session ends with a deploy, as always.

Note: Cloudflare Access itself (step 1) still needs to be turned on in the Cloudflare dashboard — the code-side half (the page staying public, `/api/admin/*` never trusting Access alone) is done, but no session has actually gone into the dashboard and configured an Access policy yet. Until that happens, the `X-Admin-Key` check is the *only* thing gating the admin panel's data — real, but not "belt and suspenders" yet.
