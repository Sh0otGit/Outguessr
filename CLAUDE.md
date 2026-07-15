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
- Challenges load from `challenges.json`, keyed by date (YYYY-MM-DD). One challenge per day, selected by the current **UTC** day (`todayKey()` in app.js — see "The day is UTC").
- Crowd results shown to players are still **simulated** (realistic distributions authored per challenge in the JSON) — real distributions exist in D1 now (see Phase 2 architecture) but the reveal doesn't consume them yet, so what a player sees hasn't changed.
- Every lock-in also fires a fire-and-forget `POST /api/submit` to the real backend (retried once after 5s, then queued in `og_pending_submit` and retried on next load) — but the game **never** blocks on it or changes behavior based on its result. If the backend is down, play continues on simulated data exactly as before the backend existed.
- The challenge card shows a subtle live line — "🔒 N players locked in so far" — fed by `GET /api/count`, today's real submission count. Fails silent (line just doesn't appear) if the endpoint errors, per golden rule 2's "counts are fine, distributions aren't."
- `verdicts.json` holds the tier jab copy — 8 player-directed lines per tier, picked deterministically from the day number so every player sees the same line on the same day.
- localStorage keys: `og_player_id`, `og_streak`, `og_last_played`, `og_points`, `og_history`, `og_pending_submit`.
- Reveal unlocks after the player locks in (Phase 1 simplification; later it gates to midnight).
- Screens: Today's challenge (locks in place into a **betting-slip** state — original prompt stays visible, your pick shown as a ticket stub under a one-time LOCKED stamp, factoid, countdown) → Reveal (tier verdict, annotated distribution chart, payout ceremony, roast copy) → Share card (copy button).
- Build the reveal screen as a **reusable component** — Arena will reuse it with "CHAT" and "STREAMER" markers instead of "YOU".

## Phase 2 architecture

One Cloudflare Worker + one D1 database. No microservices, no queues — still a one-person daily game, just with real data instead of authored JSON.

**Status: live and wired up, tally job computes real results.** `POST /api/submit`, `GET /api/results/:day`, and `GET /api/count/:day` are deployed and verified against the real D1 database at outguessr.com, and the game itself calls the first and third (fire-and-forget submit, live count on the challenge card) — see the Phase 1 bullets above. The 00:03 UTC cron now does the full job: bot blending, per-format results blob (with a percentile lookup so any pick can be scored without recomputing), Split or Steal pairing, and roast-copy templating, all verified deterministic (byte-identical `results` + `results_players` rows across repeated re-tallies of the same `answers`). `GET /api/results/:day` isn't consumed by the client yet — **the reveal flip (wiring the client to read real results instead of simulated `challenges.json` data) is the next session.** Not yet implemented: `/api/admin/*`. See DEPLOY.md for the deploy history and current live configuration.

### Endpoints

- `POST /api/submit` `{day, playerId, answer}` — records a player's answer. Rejected if `day` isn't today (UTC) or already closed.
- `GET /api/results/:day` — the precomputed results blob for a **finished** day only, never today. Golden rule 2 doesn't relax just because a backend now exists. Accepts an optional `?playerId=` — for a `splitsteal` day only, this adds a `yourOutcome` field with that one player's paired result (`mutual_split` / `betrayed` / `clean_steal` / `mutual_steal`) and nothing about any other player.
- `/api/admin/*` — every admin endpoint, gated by an `X-Admin-Key` header checked against a Worker secret. Belt-and-suspenders under Cloudflare Access, per ADMIN-PANEL-PLAN.md's security section — never trust Access alone on a write path.

### D1 tables

- `answers` — raw, append-only. This is the source of truth.
- `results` — one precomputed blob per finished day. What `/api/results/:day` actually serves.
- `results_players` — one row per real player per finished `splitsteal` day (`day, player_id, outcome`), rewritten wholesale (delete + reinsert) by every tally run. What the `?playerId=` extension on `/api/results/:day` reads from. Bots never get a row here — they're not real players and nothing ever looks up their outcome.

### Daily tally

A cron fires at **00:03 UTC** (a few minutes of slack past the actual close, so a submit landing right at 23:59:59 doesn't get missed by a cron firing at the exact instant — the admin's re-run-tally button covers any remaining edge case): closes the day, blends in bots, tallies `answers` into that day's `results` row (and `results_players` for Split or Steal), and fills in the roast-copy placeholders (below) from the real numbers. Idempotent — re-running it recomputes fresh from `answers` and overwrites the same rows; both `results` and `results_players` are written together in one D1 `batch()` transaction. This is the "cron failed at 3am" fix from ADMIN-PANEL-PLAN.md's System section: re-run the tally, never hand-edit `results`.

Per-format results blob shape: `crunch`/`herdmeter` get a 20-bucket `crowd` distribution, `avg`, `target` (crunch: live ⅔-of-average; herdmeter: the authored ground-truth poll number, never derived from guesses), `peakIndex`/`peakLabel`/`peakPct`, and a `percentiles` array of 101 entries (index = a 0–100 pick, value = that pick's topPct) so the client can score any pick with a lookup instead of recomputing. `oddonein` gets a percentage-share `crowd`, `winnerLabel`/`winnerPct` (the least-picked option), `peakLabel`/`peakPct` (the most-picked), and a `percentiles` array indexed by option. `splitsteal` gets `crowd: [splitPct, stealPct]` plus the per-player `results_players` rows described above — there's no percentile lookup for this format, since a player's outcome is about their specific pairing, not a crowd-distance score.

Bots and Split-or-Steal pairing both draw from a seeded PRNG (`mulberry32`, seeded off the challenge's own daily `number`, with pairing offset by one so it doesn't share a stream with bot sampling) — never `Math.random()` — which is what makes re-tallying the same `answers` produce byte-identical output. The `answers` read for a tally is explicitly `ORDER BY player_id`, since an unordered read would make that determinism only accidental.

### Bot blending

Floor of 300, read live from the `config` table (`bot_floor`, `bots_enabled`) rather than hardcoded, so a future admin toggle can change it without a code deploy. `bots = max(0, bot_floor − real players)` when enabled — they retire themselves as the game grows. Bot answers are sampled from that challenge's **authored** `crowd` distribution (the same array admins already write in Phase 1) rather than generated fresh, so a cold-start day keeps exactly the shape the admin designed for it. Bots are never written to `answers` — they exist only inside a single tally computation, regenerated identically (same seed) every time that day is re-tallied.

## The day is UTC

The day key is the **UTC date** — server and client both. Answers close at 00:00 UTC. The client switched from local date to match: this used to be a documented Phase 1 simplification ("stays correct only because Phase 1 has no shared submission window to protect"), but now that the game actually submits to the backend, a local-date client talking to a UTC-day server would disagree about "today" for any player outside UTC — so it isn't a safe simplification to keep once the two are wired together.

This shift didn't need a destructive `og_history` migration (golden rule 7) — every entry is keyed by whatever date `resolveChallengeKey()` resolved to, which is always a real `challenges.json` date regardless of which clock computed "today." An entry keyed by a date that no longer matches "today" under the new UTC basis isn't broken, it's just history, same as the day after any other calendar rollover. The one accepted, un-repairable consequence: a streak computed right at the transition may read as reset for a player near a timezone boundary, since `og_last_played` was recorded under the old local-date basis and there's no way to recover which UTC day that corresponded to after the fact.

Results are **immutable** once tallied. The only way to change a finished day's numbers is a re-tally from raw `answers` — never a hand-edit of a `results` row.

## Roast copy is a template (Phase 2)

Crowd data stops being authored and starts being real, so roast copy can't have hardcoded numbers anymore. Admin-authored roast becomes a template string; the daily tally cron fills placeholders from that day's real results before writing the `results` row. This substitution is implemented and live in the cron — but every challenge authored so far still has a literal-numbers roast string from Phase 1 (no `{placeholders}` in it), so it passes through unchanged today. Nothing breaks either way: the substitution is a no-op on a string with no matching tokens. Authoring roast as an actual template (so it reflects the real numbers instead of the originally-simulated ones) is on the admin panel, not yet done.

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
