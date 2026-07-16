# TESTING.md — the reveal-flip test plan

How to verify the real-data reveal flip (lock-in records a pending pick,
payoff happens later off real `GET /api/results/:day` data) before
deploying. Split into two parts: what's scriptable against `wrangler dev`
and D1 directly (no browser needed), and the manual click-through for the
parts that actually need a browser — this environment doesn't have one,
so treat that second half as required before you personally deploy, not
optional polish.

No clock mocking anywhere in this plan. The trick: seed answers for the
*real* yesterday (relative to whenever you're running the test) and let
the scheduled handler compute "yesterday" the same way it does in
production. That exercises the exact same code paths as a real day
rollover without touching the system clock.

## Part 1 — backend + payoff logic (scriptable, no browser)

### 1a. Start clean

```
npx wrangler dev --port 8787 --test-scheduled
```

Confirm local D1 has both migrations applied (`npm run db:migrate:local`
then `npm run db:migrate:local:0002` if you're starting from a fresh
`.wrangler/state`).

### 1b. Seed 3 fake players for yesterday

Pick a challenge format to test (crunch is the easiest to eyeball).
`REAL_YESTERDAY=$(date -u -d yesterday +%Y-%m-%d)` (or just read it off
`challenges.json` — whatever key is one UTC day behind today). Confirm
`challenges.json` actually has an entry for that date; if not, pick a
different close-in-the-past date it does have and swap it in below.

`POST /api/submit` only accepts the *currently open* day (by design —
that's the whole point of golden rule 2), so it will correctly reject
anything dated yesterday with `"day is not open"`. To seed a past day
you have to write directly into D1's `answers` table instead:

```bash
node -e "
const rows = [['p_alice000',22],['p_bob00000',55],['p_carol000',8]];
let sql = '';
rows.forEach(([id,a]) => { sql += \`INSERT INTO answers (day, player_id, answer, created_at) VALUES ('$REAL_YESTERDAY', '\${id}', '\${a}', \${Date.now()});\n\`; });
require('fs').writeFileSync('scratch_seed.sql', sql);
"
npx wrangler d1 execute outguessr-db --local --file=scratch_seed.sql
rm scratch_seed.sql
```

### 1c. Confirm today's distribution is unreachable before close

```bash
TODAY=$(date -u +%Y-%m-%d)
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8787/api/results/$TODAY"
# expect 403 — golden rule 2, never relaxes even for a day you played
```

### 1d. Run the scheduled tally

```bash
curl -s "http://127.0.0.1:8787/cdn-cgi/handler/scheduled"
npx wrangler d1 execute outguessr-db --local --command \
  "SELECT day, ok, players, bots, error FROM cron_runs ORDER BY ran_at DESC LIMIT 1"
```

Expect `ok=1`, `players=3`, `bots` = configured floor minus 3.

### 1e. Fetch each player's real result

```bash
curl -s "http://127.0.0.1:8787/api/results/$REAL_YESTERDAY?playerId=p_alice000"
curl -s "http://127.0.0.1:8787/api/results/$REAL_YESTERDAY?playerId=p_bob00000"
curl -s "http://127.0.0.1:8787/api/results/$REAL_YESTERDAY?playerId=p_carol000"
```

All three should return the same aggregate blob (`crowd`, `avg`,
`target`, `percentiles`, rendered `roast`). For a `splitsteal` day
instead, each should additionally carry a distinct `yourOutcome`.

### 1f. Verify the client-side scoring math against that real blob

`formats.js` has no DOM dependency at load time, so its `resolveReal()`
is directly testable in plain Node:

```bash
node -e "
const fs = require('fs'), vm = require('vm');
const code = fs.readFileSync('public/formats.js','utf8') + '\nthis.FORMATS = FORMATS;';
const sandbox = {}; vm.createContext(sandbox); vm.runInContext(code, sandbox);
const blob = JSON.parse(require('child_process').execSync(
  'curl -s \"http://127.0.0.1:8787/api/results/$REAL_YESTERDAY?playerId=p_alice000\"'
));
const challenge = require('./public/challenges.json')['$REAL_YESTERDAY'];
const result = sandbox.FORMATS[challenge.format].resolveReal(challenge, 22, blob);
console.log(JSON.stringify(result, null, 2));
"
```

Confirm `topPct` is in [1,100], `chart.buckets === blob.crowd`, and (for
crunch/herdmeter) `chart.youIndex` matches the bucket your submitted
pick falls in.

### 1g. Idempotency (re-tally must not change anything already paid out)

```bash
curl -s "http://127.0.0.1:8787/api/results/$REAL_YESTERDAY" -o /tmp/before.json
curl -s "http://127.0.0.1:8787/cdn-cgi/handler/scheduled"
curl -s "http://127.0.0.1:8787/api/results/$REAL_YESTERDAY" -o /tmp/after.json
diff /tmp/before.json /tmp/after.json && echo IDENTICAL
```

### 1h. Missing-blob case (cron never ran for some day)

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  "http://127.0.0.1:8787/api/results/2020-01-01"
# expect 404 {"error":"not computed yet"} — app.js's revealEntry() treats
# this as "still cooking", toasts, and leaves the entry unviewed
```

### 1i. Split or Steal specifically (per-player outcomes)

`scheduled()` (and the `/cdn-cgi/handler/scheduled` test endpoint) always
tallies "yesterday relative to right now" — there's no way to point it at
an arbitrary past day. To test a `splitsteal` challenge that isn't
literally yesterday, temporarily add a manual-trigger route, use it, then
remove it before committing anything (never ship this route):

```js
// in src/index.js's fetch handler, right after the /api/count route —
// TEMP-TEST-ROUTE, strip before commit:
const testTallyMatch = url.pathname.match(/^\/__test\/tally\/([^/]+)$/);
if (testTallyMatch && request.method === "GET") {
  return json(await runDailyTally(env, decodeURIComponent(testTallyMatch[1])));
}
```

```bash
curl -s "http://127.0.0.1:8787/__test/tally/<a-splitsteal-date>"
curl -s "http://127.0.0.1:8787/api/results/<date>?playerId=<player>"
```

Seed at least 2 real players with opposite picks so you can confirm each
gets a *different* `yourOutcome` from the same tally run, and that
`resolveReal()`'s partner-note prefix ("Your partner split."/"Your
partner stole.") matches what the outcome string implies. After
verifying, revert the temp route (`git diff src/index.js` should come
back empty) — confirmed working this way for both `crunch` and
`splitsteal` while building this flip.

## Part 2 — client flow (manual click-through, needs a real browser)

Serve `public/` over `http://` (not `file://` — `fetch` needs a real
origin) pointed at the same `wrangler dev` instance, e.g. `wrangler dev`
itself already serves both the API and the static site on
`http://127.0.0.1:8787`.

1. **Fresh player, lock in today.** Clear localStorage. Load the site,
   answer today's challenge, lock in. Confirm: the betting slip appears
   (ticket stub, factoid, countdown to 00:00 UTC) with **no** "see your
   reveal" button anywhere. Streak shows 1. Brain count is unchanged
   (still 0) — no points awarded yet.
2. **Reload same day.** Refresh the page. Same betting slip reappears,
   still no reveal button, streak/points unchanged. Confirms lock-in
   truly doesn't grant a same-day peek.
3. **Payoff-then-hook.** Using the seeded/tallied data from Part 1 (or
   your own real play from yesterday, tallied the same way): with
   `state.history[yesterday]` present and `viewed` false, reload the
   page. Expect: the reveal screen appears **immediately on load**,
   before you ever see today's challenge — full ceremony (tier badge,
   chart, payout count-up, jab line), real player count in the "you vs
   N players" line (not the old seeded-looking round number), and roast
   copy pulled from the real blob. Brain count in the header updates to
   include the new payout. Click "Back to today" — today's challenge
   appears, unplayed if you haven't locked in yet today.
4. **Reload again after step 3.** The ceremony must NOT replay — that
   entry is now `viewed`, so today's challenge (or its betting slip)
   shows directly on load.
5. **History screen, resolved entry.** Click 📜 in the header. Yesterday
   should appear in the list marked "Revealed · +N 🧠". Click it — same
   reveal shows again instantly (no network fetch, no re-award; check
   the brain count doesn't move a second time).
6. **History screen, on-demand older entry.** Play (lock in) on a day,
   then skip forward past it without triggering payoff (e.g. seed/tally
   an even-older day than yesterday and don't let the automatic hook
   touch it — the hook only ever checks yesterday specifically). Open
   History, find that day marked "Tap to reveal", click it. Confirm the
   full ceremony fires **from History**, points award, and the entry
   flips to "Revealed" on the list without a page reload.
7. **Missing-blob toast.** Lock in on a day whose challenges.json entry
   exists but never gets tallied (don't run the scheduled handler for
   it). Once it's no longer "today" (i.e. `activeKey` has moved on),
   open History and tap it. Expect a toast — "Results still cooking —
   check back soon" — no ceremony, no points, entry stays "Tap to
   reveal" so it can be retried later.
8. **USE_SIMULATED — no longer testable end-to-end.** `challenges.json`
   moved server-side (see CLAUDE.md's "Challenge data is server-only"),
   so `GET /api/challenge/:day` never returns `crowd`/`target` anymore —
   the exact fields `formats.js`'s simulated `resolve()` needs. Flipping
   `USE_SIMULATED = true` in the public game will now throw once it
   tries to read `challenge.crowd`. This is expected, not a regression:
   the flag's only living use is the admin's own preview-as-player
   modal, which reads the FULL challenge object from the key-gated
   `GET /api/admin/challenges` and never calls `resolve()` at all (see
   `admin-calendar.js`'s `openPreviewModal`) — that path is covered by
   the admin playtest checklist below instead.

## Deploy gate (Part 1 + Part 2)

Don't push until Part 1 passes in full and Part 2's steps 1–7 have been
manually clicked through at least once.

## Part 3 — force-close, blended count, and challenge-data privacy (scriptable)

Extends Part 1 for the force-close state machine, blended `/api/count`,
and the new challenge endpoints. Same "no clock mocking" rule — use
real dates.

1. **Force-close cycle.** `POST /api/submit` for today succeeds → `GET
   /api/results/:today` is 403 → `POST /api/admin/close-today` →
   `POST /api/submit` for today now returns `{"ok":false,"error":"day
   is not open"}` (400) → `GET /api/results/:today` is now 200 with a
   real blob. `POST /api/admin/reopen-today` → `GET /api/results/:today`
   is 403 again → `POST /api/submit` succeeds again.
2. **Reset drops the count.** After reopen, submit 2–3 real answers,
   confirm `GET /api/admin/count/:today` shows them in `real`. `POST
   /api/admin/reset-today` → `real` drops to 0 and `count` falls back
   to the bots-only projection (`response.deleted.answers` matches how
   many you actually seeded).
3. **Count ramp is monotonic.** `utcDayFraction(day, now)` for five
   `now` values spread across one UTC day (00:00, 06:00, 12:00, 18:00,
   23:59:59) must be non-decreasing and land at exactly 0 / 0.25 / 0.5 /
   0.75 / 1. A day in the future returns 0; a day in the past returns 1.
4. **`/api/challenge/:day` never leaks secrets.** For every day in
   `src/challenges.json`, confirm the response has no `crowd`, `target`,
   or `roast` key — only `number`/`format`/`prompt`/`sub`/`factoid`/
   `options` (whichever exist). `/api/challenge/<tomorrow>` is 404, same
   shape as a day with no challenge at all (no signal either way).
5. **10,000-bot perf.** `POST /api/admin/config {"botFloor":10000}`,
   then `POST /api/admin/retally/:day` for a numeric format and a
   `splitsteal` day (pairing is the part with an actual per-real-player
   loop) — both should log `duration` in the tens of milliseconds, not
   seconds. Restore the floor afterward and confirm idempotency still
   holds (re-tally with the floor unchanged twice, diff the results).

## Part 4 — admin panel playtest checklist (manual, needs a real browser)

The login gate, stacked chart, Bots tab, and System tab's state machine
all need to be clicked through for real — none of this is meaningfully
verifiable from curl. Do this before pushing, same rule as Part 2.

1. **Fresh browser, no key.** Clear `og_admin_key` from localStorage (or
   just use a private window). Load `/admin`. Confirm: the login card is
   the ONLY thing on the page — no nav, no status bar, no tab content,
   no data of any kind visible or briefly flashed.
2. **Wrong key.** Type a bogus key, hit Unlock (or press Enter). Confirm
   an inline error appears ("Wrong key — try again"), the input clears,
   and the panel is still just the login card — nothing else rendered.
3. **Right key, no reload.** Type the real `ADMIN_KEY`, submit. Confirm
   the full panel renders immediately in place — no `location.reload()`,
   no flash of unstyled/empty content, Dashboard populated with real
   numbers.
4. **Lock button.** Click "🔒 Lock" in the status bar. Confirm it
   returns to the login card immediately, and reloading the page also
   stays on the login card (the key is actually gone from localStorage,
   not just hidden).
5. **Cancel/Escape on login.** Confirm there's no dismiss path off the
   login card other than successfully unlocking — Escape shouldn't
   reveal the panel underneath (there is no panel underneath; `#app-view`
   stays `hidden` until a real verify succeeds).
6. **Force-close → public site.** From System, force-close today
   (confirm the modal names both effects: "stops submissions AND
   publishes results"). Confirm: the status bar's red "CLOSED EARLY"
   chip appears immediately with no refresh, the System tab's state
   card flips to the CLOSED body with Reopen/Reset buttons in place of
   Force-close. Then, on the actual public game (a separate tab), the
   reveal for TODAY should now work if you already had a pending pick
   for today — since today is now a finished day.
7. **Reopen → public site back to normal.** Click Reopen (confirm the
   modal says "deletes today's published results, submissions resume").
   Confirm the chip disappears, the System card flips back to OPEN, and
   the public game's today reveal is blocked again (results pulled).
8. **Reset drops the count.** Force-close again, then Reset — type
   `RESET` in the confirmation field (button stays disabled until the
   text matches exactly), confirm. Toast reports the real deleted count
   from the server response. Dashboard's "Real players today" tile and
   the Bots tab's projected blend should both drop to reflect zero real
   answers on next view.
9. **Bots tab saves 10,000.** Drag the slider or type into the number
   input up to 10,000 (or click the 10,000 preset) — slider and number
   input should always agree with each other. Save. Reload the page
   (through the login gate again), confirm the floor persisted at
   10,000 and the Dashboard's "Bots blended" tile reflects it.
10. **Live chart shows labels + stacked split.** Play today's challenge
    on the public game first (so the shield has something non-zero to
    show), then on Dashboard click "Reveal anyway" on the spoiler
    shield. Confirm: bars are visibly two-toned (solid purple base,
    striped top), the winning/peak bars are labeled directly on the
    chart, everything else only shows detail on hover, and the subtitle
    reads "N real + M bots = T" matching the numbers you'd expect.
    Check yesterday's recap card shows the same stacked treatment.
