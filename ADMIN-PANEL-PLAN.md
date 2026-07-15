# Outguessr Admin Panel — Design Plan

*The operator's cockpit for a one-person daily game. Desktop-first (you'll use it from your PC, unlike the mobile-first game), same dark visual identity as the game, built for the Phase 2 backend (Workers + D1). This doc + the clickable mockup together are the spec you hand to Claude Code.*

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

### 5. Players

**Stats:** total known player IDs, DAU/WAU, top streaks table (anonymized IDs — celebrate them later via a public leaderboard, not here), flagged activity: multiple submissions from one ID (blocked, but logged), abnormal submission bursts from one IP range (someone scripting votes).

**Actions:** invalidate a player ID's submissions for a day (cheating), block an ID, delete all data for an ID (privacy requests — you want this button to exist *before* you need it), export players CSV.

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

1. `/admin` static page + Cloudflare Access in front of it. (One session, mostly dashboard clicking.)
2. Challenge Calendar reading `challenges.json` → later D1. Preview-as-player modal reusing the game's own components.
3. Dashboard tiles wired to a new `GET /api/admin/stats` endpoint.
4. Bots panel + re-run tally button.
5. Players + System sections.

Each session ends with a deploy, as always.
