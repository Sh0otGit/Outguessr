# CLAUDE.md — Outguessr Project Constitution

Read this before doing anything. It defines what this game is and the rules that must never be broken.

## What Outguessr is

A daily social guessing game at outguessr.com. One dilemma per day with **no right answer** — the answer is decided by what today's players pick. Everyone answers blind; at midnight UTC the day closes and the reveal shows the full crowd distribution, your percentile, and a shareable emoji result card. Think Wordle's habit loop, but the puzzle is *other people*.

Two modes sharing one engine:
- **Solo daily** (outguessr.com): the core game, described above.
- **Arena** (outguessr.com/:roomname — future phase): a streamer locks their pick on camera first, their chat votes secretly on phones, then the on-stream reveal shows whether the streamer outguessed their own community. Running head-to-head record per channel ("Chat 12 – 9 Streamer").

## Golden rules — never break these

1. **Always deployable.** Every session ends with the site working. Small changes, tested, committed.
2. **Never expose today's live tally or distribution.** Blind answering IS the game. Live vote *counts* (number of players) are fine; distributions are not, until the day is over.
3. **Every challenge rule must be explainable in one sentence.** If it needs a paragraph, it doesn't go in the deck.
4. **In Arena, the streamer always locks first**, before chat voting opens.
5. **Zero friction.** No accounts, no logins. Player identity = random ID in localStorage. Streaks and played-state live in localStorage.
6. **The reveal must tell a story, not just show a chart.** Every challenge includes "roast copy" — commentary on how the crowd behaved. This is the screenshot-able content.
7. **`og_history` is a persistence schema.** Any change to what `lockIn()` stores must ship a migration for old entries in the same commit — repair what can be repaired, delete what can't, never leave a shape change to crash silently for returning players.

## Current phase: Phase 1 — "fake it" solo game (static, no backend)

- Pure static site, all of it under `public/`: `index.html`, `theme.css`, `style.css`, `formats.js`, `reveal.js`, `app.js`, plus `admin/`. No frameworks, no build step. (Moved under `public/` when the Phase 2 Worker skeleton was built, so it can be served as the Worker's static-assets directory — see Deployment.)
- Challenges load from `challenges.json`, keyed by date (YYYY-MM-DD). One challenge per day, selected by the player's local date.
- Crowd results are **simulated** (realistic distributions stored per challenge in the JSON). This is intentional cold-start design; real backend comes in Phase 2.
- `verdicts.json` holds the tier jab copy — 8 player-directed lines per tier, picked deterministically from the day number so every player sees the same line on the same day.
- localStorage keys: `og_player_id`, `og_streak`, `og_last_played`, `og_points`, `og_history`.
- Reveal unlocks after the player locks in (Phase 1 simplification; later it gates to midnight).
- Screens: Today's challenge (locks in place into a **betting-slip** state — original prompt stays visible, your pick shown as a ticket stub under a one-time LOCKED stamp, factoid, countdown) → Reveal (tier verdict, annotated distribution chart, payout ceremony, roast copy) → Share card (copy button).
- Build the reveal screen as a **reusable component** — Arena will reuse it with "CHAT" and "STREAMER" markers instead of "YOU".

## Phase 2 architecture

One Cloudflare Worker + one D1 database. No microservices, no queues — still a one-person daily game, just with real data instead of authored JSON.

**Status: live.** `POST /api/submit`, `GET /api/results/:day`, and `GET /api/count/:day` are deployed and verified against the real D1 database at outguessr.com. Not yet implemented: `/api/admin/*`, bot blending, and roast-copy templating (all future sessions — bot blending means the tally currently reflects real submitted answers only). See DEPLOY.md for the deploy history and current live configuration.

### Endpoints

- `POST /api/submit` `{day, playerId, answer}` — records a player's answer. Rejected if `day` isn't today (UTC) or already closed.
- `GET /api/results/:day` — the precomputed results blob for a **finished** day only, never today. Golden rule 2 doesn't relax just because a backend now exists.
- `/api/admin/*` — every admin endpoint, gated by an `X-Admin-Key` header checked against a Worker secret. Belt-and-suspenders under Cloudflare Access, per ADMIN-PANEL-PLAN.md's security section — never trust Access alone on a write path.

### D1 tables

- `answers` — raw, append-only. This is the source of truth.
- `results` — one precomputed blob per finished day. What `/api/results/:day` actually serves.

### Daily tally

A cron fires at **00:00 UTC**: closes the day, tallies `answers` into that day's `results` row, and fills in the roast-copy placeholders (below) from the real numbers. Idempotent — re-running it recomputes fresh from `answers` and overwrites the same `results` row. This is the "cron failed at 3am" fix from ADMIN-PANEL-PLAN.md's System section: re-run the tally, never hand-edit `results`.

### Bot blending

Floor of 300. `bots = max(0, 300 − real players)` — they retire themselves as the game grows. Bot answers are sampled from that challenge's **authored** `crowd` distribution (the same array admins already write in Phase 1) rather than generated fresh, so a cold-start day keeps exactly the shape the admin designed for it.

## The day is UTC

Once the backend exists, the day key is the **UTC date** — server and client both. Answers close at 00:00 UTC. This supersedes Phase 1's "player's local date" simplification, which stays correct only because Phase 1 has no shared submission window to protect.

Results are **immutable** once tallied. The only way to change a finished day's numbers is a re-tally from raw `answers` — never a hand-edit of a `results` row.

## Roast copy is a template (Phase 2)

Crowd data stops being authored and starts being real, so roast copy can't have hardcoded numbers anymore. Admin-authored roast becomes a template string; the daily tally cron fills placeholders from that day's real results before writing the `results` row:

```
{avg}          crowd average (Crowd Crunch / Herd Meter)
{target}       the winning number
{winnerLabel}  winning option's label (Odd One In)
{winnerPct}    winning option's real vote share
{peakLabel}    most-picked option's label
{peakPct}      most-picked option's real vote share
{splitPct}     real % who chose SPLIT (Split or Steal)
```

Example: `"The crowd averaged {avg}. The galaxy-brains who picked 0 got burned again."` ships from the admin looking exactly like that, and becomes `"The crowd averaged 38.4. The galaxy-brains who picked 0 got burned again."` once the cron fills it in.

## Phase 3 (later): Arena
Rooms, streamer view (OBS-friendly: big type, dark bg), phone voter view, polling for live vote count (no websockets), weekly "smartest chat" channel leaderboard.

## Challenge formats (the deck)

1. **Crowd Crunch** 🎯 — pick 0–100, closest to ⅔ of today's average wins. (slider input)
2. **Odd One In** 🚪 — five options, least-picked one wins. (choice input)
3. **Split or Steal** 🤝 — paired with one random player; both split = 50 each, steal beats split = 100/0, both steal = 0. (two-choice input)
4. **Herd Meter** 📊 — predict what % of players answer a poll question a certain way. (percent slider)
5. More formats later; each must pass the one-sentence rule.

Challenge JSON shape:
```json
{
  "2026-07-20": {
    "format": "crunch",
    "number": 214,
    "prompt": "Pick a number from 0 to 100.",
    "sub": "Closest to two-thirds of today's average wins.",
    "crowd": [2,3,4,6,8,14,11,7,5,9,12,6,4,3,2,1,1,1,0,1],
    "target": 27,
    "roast": "The crowd averaged 41. The galaxy-brains who picked 0 got burned again."
  }
}
```

## Visual identity

Dark theme. Background `#0e1016`, cards `#171b24`, text `#eceff4`, muted `#8b93a7`. Accent lime `#b7f04a` (actions, winning zone), purple `#8e78ff` (the player's marker), gold `#ffd166` (streaks). Big bold type, mobile-first (max-width 440px column). Share cards in monospace. Tone of all copy: playful roasting, sports-commentator energy. The reference mockup implementing this is `outguessr-mockup.html`; the reveal screen's tier system is specced by `outguessr-reveal-tiers-mockup.html`.

## Design system

`theme.css` is the single source of tokens and shared components for the whole site (game + admin). `style.css` and `admin/admin.css` load it first and only add their own layout on top — never redefine a token or a shared component.

### Tokens (theme.css `:root`)

```
--bg: #0e1016        --card: #171b24      --card2: #1e2330     --line: #2a3040
--text: #eceff4      --muted: #8b93a7
--lime: #b7f04a       --lime-dim: #8fc22e
--purple: #8e78ff     --gold: #ffd166      --coral: #ff6b6b
--radius: 16px
font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif
share-card font: ui-monospace, SFMono-Regular, Menlo, monospace
```

### Tier accent palettes

Every reveal lands in one of five tiers. A `tier-<key>` class (applied to `<body>` only while the reveal is showing) recolors `--tier` / `--tier-soft` / `--page-tint` — nothing else about the page changes.

| Tier | `--tier` | `--tier-soft` | `--page-tint` | extra |
|---|---|---|---|---|
| **mastermind** (gold) | `#ffd166` | `#2c2413` | `rgba(255,209,102,.05)` | — |
| **sharp** (lime) | `#b7f04a` | `#20281a` | `rgba(183,240,74,.03)` | — |
| **mid** (beige) | `#c9bfa8` | `#26241e` | `transparent` | — |
| **sheep** (desaturated) | `#7d8aa3` | `#1d2129` | `rgba(20,24,32,.5)` | `.app{filter:saturate(.55)}` |
| **npc** (grayscale) | `#9a9a9a` | `#222222` | `rgba(0,0,0,.35)` | `.app{filter:saturate(.15)}` |

### Tier table

| Tier | Badge | Percentile threshold | Payout | Ceremony intensity |
|---|---|---|---|---|
| Mastermind | 🧠 | top 5% | ×10 | particles, marquee, shimmer |
| Sharp | ⚡ | top 25% | ×3 | few particles |
| Certified Mid | 🙂 | top 60% | ×1 | none |
| Sheep | 🐑 | top 90% | ×0.3 | page desaturation |
| NPC of the Day | 🗿 | top 100% | flat +3 | grayscale + tumbleweed |

Percentile is computed live against that day's stored crowd distribution, not a fixed lookup table — so every tier is reachable on every challenge.

### Hard rules

1. **Tier changes palette, copy, motion energy, and payout ceremony ONLY.** Layout never changes between tiers.
2. **Every animation plays once and finishes in under ~400ms**, except payout count-ups, which scale duration with the amount awarded.
3. **The chart labels only the story bars** — YOU, the winning zone, and the crowd's peak bucket. Every other bar's number is available on hover, not printed on the chart.
4. **The target is shown as a gold dashed line plus a legend entry** — never a floating label on the chart.

## Share card format (keep this exact structure)

```
OUTGUESSR #214 🎯
🧠 MASTERMIND · top 4% · +500 🧠
🔥 14 streak
outguessr.com
```

## Deployment

A single Cloudflare Worker (`wrangler.toml` + `src/index.js`) serves `public/` as static assets *and* `/api/*`, backed by D1 and a 00:00 UTC cron. Workers Builds (Cloudflare's native GitHub integration) deploys automatically — `git push` is still the deploy step, same as it's always been. Custom domain: outguessr.com.

One thing worth knowing before pushing anything experimental: this project has no per-branch preview isolation — any branch with a connected build deploys straight to the live Worker and all its bound routes, including outguessr.com. There's no safe "preview URL that doesn't touch prod" the way Cloudflare Pages had. See DEPLOY.md for the full deploy history and current live configuration.
