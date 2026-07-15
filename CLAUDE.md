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

## Current phase: Phase 1 — "fake it" solo game (static, no backend)

- Pure static site: `index.html`, `theme.css`, `style.css`, `formats.js`, `reveal.js`, `app.js`. No frameworks, no build step.
- Challenges load from `challenges.json`, keyed by date (YYYY-MM-DD). One challenge per day, selected by the player's local date.
- Crowd results are **simulated** (realistic distributions stored per challenge in the JSON). This is intentional cold-start design; real backend comes in Phase 2.
- `verdicts.json` holds the tier jab copy — 8 player-directed lines per tier, picked deterministically from the day number so every player sees the same line on the same day.
- localStorage keys: `og_player_id`, `og_streak`, `og_last_played`, `og_points`, `og_history`.
- Reveal unlocks after the player locks in (Phase 1 simplification; later it gates to midnight).
- Screens: Today's challenge (locks in place into a **betting-slip** state — original prompt stays visible, your pick shown as a ticket stub under a one-time LOCKED stamp, factoid, countdown) → Reveal (tier verdict, annotated distribution chart, payout ceremony, roast copy) → Share card (copy button).
- Build the reveal screen as a **reusable component** — Arena will reuse it with "CHAT" and "STREAMER" markers instead of "YOU".

## Phase 2 (later): Cloudflare Worker backend
Two endpoints: `POST /api/submit` {day, playerId, answer} and `GET /api/results/:day` (precomputed blob, finished days only). D1 tables: `answers`, `results`. Midnight UTC cron tallies the day. Bot blending: seed ~300 simulated answers per day, bots = max(0, 300 − real players).

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

GitHub → Cloudflare Pages auto-deploy on push to main. Custom domain: outguessr.com. Deploying = `git push`.
