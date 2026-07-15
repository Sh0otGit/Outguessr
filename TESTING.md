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
8. **USE_SIMULATED sanity check (optional).** Flip `USE_SIMULATED = true`
   at the top of `app.js` locally, reload with a clean localStorage,
   lock in. Confirm the OLD instant-reveal behavior is fully intact
   (peek button appears immediately, ceremony runs off simulated
   `challenges.json` data). Flip it back to `false` before committing
   anything — this flag must ship `false`.

## Deploy gate

Don't push until Part 1 passes in full and Part 2's steps 1–7 have been
manually clicked through at least once. Step 8 is a sanity check on the
preserved legacy path, not a blocker.
