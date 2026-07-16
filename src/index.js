/* =====================================================
   Outguessr Worker — Phase 2 backend.

   Serves the static site (public/) and the public endpoints:
     POST /api/submit          record an answer for today (UTC)
     GET  /api/results/:day    tallied blob for a CLOSED day only
     GET  /api/count/:day      submission count only (safe to expose)

   Plus a 00:03 UTC cron that tallies the day that just closed: bot
   blending, per-format results blob, Split or Steal pairing, and
   roast-copy templating all happen here.

   Golden rule 2 (CLAUDE.md): today's distribution is never exposed
   publicly. /api/count is the only thing safe to reveal about a live
   day without the admin key.

   Challenge content (challenges.json) lives at src/challenges.json and
   is bundled directly into the Worker via static import — it is NOT
   served as a static asset anymore. Authored crowd/target/roast fields
   are cheat-relevant secrets (at a 10k bot floor, the authored crowd
   shape effectively determines the crunch target) and must never reach
   a player's browser. GET /api/challenge/:day is the only public route
   that exposes challenge content, and it strips every secret field.

   /api/admin/* — every route gated by checkAdminAuth (X-Admin-Key
   header vs the ADMIN_KEY Worker secret, fails closed if unset):
     GET  /api/admin/stats           today's real numbers + 30d totals
     GET  /api/admin/cron            last 14 cron_runs + D1 row counts
     GET  /api/admin/config          bot_floor / bots_enabled / closedDay
     POST /api/admin/config          update bot_floor / bots_enabled
     GET  /api/admin/live/:day       real live blend preview (any day)
     GET  /api/admin/count/:day      count with the honest real/bot split
     GET  /api/admin/challenges      the FULL challenge deck (secrets included)
     POST /api/admin/retally/:day    manual re-run of the idempotent tally
     POST /api/admin/close-today     tally now + stop submissions
     POST /api/admin/reopen-today    clear the close, delete today's results
     POST /api/admin/reset-today     reopen PLUS delete today's answers
===================================================== */

import CHALLENGES from "./challenges.json";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PLAYER_ID_RE = /^p_[a-z0-9]+$/;

function json(data, status = 200, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({ "Content-Type": "application/json" }, extraHeaders || {}),
  });
}

function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function shiftDayKey(dayKey, deltaDays) {
  const [y, m, d] = dayKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return utcDayKey(dt);
}

// challenges.json is a static import now (bundled into the Worker at
// deploy time, see the header comment) — no fetch, no cache, no TTL to
// go stale. A content-only push (editing challenges.json and nothing
// else) still redeploys the whole Worker, since the file is part of
// its bundle now rather than a same-repo static asset served
// independently.
async function loadConfig(env) {
  const { results: rows } = await env.DB.prepare("SELECT key, value FROM config").all();
  const cfg = {};
  rows.forEach((r) => {
    cfg[r.key] = r.value;
  });
  return cfg;
}

function validateAnswer(challenge, answer) {
  if (challenge.format === "crunch" || challenge.format === "herdmeter") {
    return Number.isInteger(answer) && answer >= 0 && answer <= 100;
  }
  if (challenge.format === "oddonein") {
    return Number.isInteger(answer) && answer >= 0 && answer < challenge.options.length;
  }
  if (challenge.format === "splitsteal") {
    return answer === 0 || answer === 1;
  }
  return false;
}

// Every rejection reason (duplicate/closed/invalid/blocked) increments the
// same upserted counter — without this, a duplicate submission vanishes
// silently into INSERT OR IGNORE and "flagged activity" would have nothing
// to measure. Only ever called with a syntactically valid playerId: an
// invalid ID isn't a real player to attribute a flag to.
//
// Errors here are swallowed on purpose: this is best-effort analytics
// riding along on the actual submit response, and it must never be able
// to change that response. That matters most for the shadow-block path
// (handleSubmit) — a blocked player's response has to be byte-identical
// to a real accepted submission every time, and a transient D1 hiccup
// while writing this counter must not turn that into a visible 500 that
// tips them off.
async function logRejection(env, day, playerId, reason) {
  try {
    await env.DB.prepare(
      `INSERT INTO submit_rejections (day, player_id, reason, count) VALUES (?, ?, ?, 1)
       ON CONFLICT(day, player_id, reason) DO UPDATE SET count = count + 1`
    )
      .bind(day, playerId, reason)
      .run();
  } catch (err) {
    // best-effort only — see comment above
  }
}

// Blocked player_ids live in config under key 'blocked_players' as a JSON
// array — same config table the bot floor already lives in, no new table
// needed for something this small.
function parseBlockedPlayers(config) {
  if (!config.blocked_players) return [];
  try {
    const arr = JSON.parse(config.blocked_players);
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    return [];
  }
}

/* ---------- POST /api/submit ---------- */
async function handleSubmit(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  const { day, playerId, answer } = body || {};
  const today = utcDayKey();
  const validPlayerId = typeof playerId === "string" && playerId.length <= 40 && PLAYER_ID_RE.test(playerId);

  if (day !== today) {
    if (validPlayerId) await logRejection(env, today, playerId, "closed");
    return json({ ok: false, error: "day is not open" }, 400);
  }
  // Emergency-only: POST /api/admin/close-today stamps config.closed_day
  // so a day can be shut early without waiting for the 00:03 UTC cron.
  // Self-clearing — once the UTC date rolls over, today's value no
  // longer matches closed_day, so no reset step is ever needed.
  const config = await loadConfig(env);
  if (config.closed_day === today) {
    if (validPlayerId) await logRejection(env, today, playerId, "closed");
    return json({ ok: false, error: "day is not open" }, 400);
  }
  if (!validPlayerId) {
    return json({ ok: false, error: "invalid playerId" }, 400);
  }

  // Shadow-block: a blocked player gets the exact same success response a
  // real submission would get, and their pick is never written to
  // `answers` — they can keep playing and never learn they're blocked.
  // See CLAUDE.md's blocklist section.
  if (parseBlockedPlayers(config).includes(playerId)) {
    await logRejection(env, today, playerId, "blocked");
    return json({ ok: true, accepted: true });
  }

  const challenge = CHALLENGES[day];
  if (!challenge) {
    await logRejection(env, today, playerId, "invalid");
    return json({ ok: false, error: "no challenge scheduled today" }, 400);
  }
  if (!validateAnswer(challenge, answer)) {
    await logRejection(env, today, playerId, "invalid");
    return json({ ok: false, error: "invalid answer for today's format" }, 400);
  }

  // INSERT OR IGNORE: the (day, player_id) primary key makes a repeat
  // submission a safe no-op instead of an error.
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO answers (day, player_id, answer, created_at) VALUES (?, ?, ?, ?)"
  )
    .bind(day, playerId, JSON.stringify(answer), Date.now())
    .run();

  const accepted = result.meta.changes > 0;
  if (!accepted) await logRejection(env, today, playerId, "duplicate");
  return json({ ok: true, accepted });
}

/* ---------- GET /api/results/:day[?playerId=] ---------- */
async function handleResults(day, env, playerId) {
  if (!DAY_RE.test(day)) {
    return json({ error: "invalid day" }, 400);
  }
  const today = utcDayKey();
  if (day > today) {
    // Future days are always blocked, no exception.
    return json({ error: "day not closed" }, 403);
  }
  if (day === today) {
    // Golden rule 2 — never expose today's distribution — with exactly
    // one carve-out: a force-closed day IS a finished day (see the
    // force-close state machine above), so its results are exactly as
    // public as any other closed day's once they exist. Not force-closed
    // means the normal block applies, full stop.
    const config = await loadConfig(env);
    if (config.closed_day !== today) {
      return json({ error: "day not closed" }, 403);
    }
  }

  const row = await env.DB.prepare("SELECT blob FROM results WHERE day = ?").bind(day).first();
  if (!row) {
    return json({ error: "not computed yet" }, 404);
  }

  // Results are immutable once tallied — cache forever. Still true with
  // a playerId attached: the query string makes it a distinct cache key,
  // and a given player's own outcome for a finished day never changes
  // either. The one accepted exception: reopen-today/reset-today
  // deliberately delete a force-closed day's results row, which a
  // long-lived cached "immutable" response wouldn't know about — an
  // acceptable staleness window for a rare, deliberate admin action,
  // not a correctness bug in the Worker itself (which always reads live).
  const headers = { "Content-Type": "application/json", "Cache-Control": "public, max-age=31536000, immutable" };

  if (playerId && PLAYER_ID_RE.test(playerId)) {
    const blob = JSON.parse(row.blob);
    if (blob.format === "splitsteal") {
      // Exactly this one player's outcome — never anyone else's, per
      // golden rule 2's spirit even on a closed day (no reason to leak
      // the pairing graph).
      const outcomeRow = await env.DB
        .prepare("SELECT outcome FROM results_players WHERE day = ? AND player_id = ?")
        .bind(day, playerId)
        .first();
      blob.yourOutcome = outcomeRow ? outcomeRow.outcome : null;
      return json(blob, 200, headers);
    }
  }

  return new Response(row.blob, { status: 200, headers });
}

/* ---------- GET /api/count/:day (blended) ----------
   The public "N players locked in so far" number is the lobby count —
   see computeTodayNumbers below for the canonical definitions. Never
   exposes the real/bot split itself; that's GET /api/admin/count/:day's
   job. */
async function handleCount(day, env) {
  if (!DAY_RE.test(day)) {
    return json({ error: "invalid day" }, 400);
  }
  const nums = await computeTodayNumbers(day, env);
  return json({ count: nums.lobbyCount });
}

// 0 before the day starts, 1 once it's fully elapsed, the fraction of
// the day elapsed so far for the current UTC day in between. Accepts
// `now` for testability (see TESTING.md's monotonic-ramp check).
function utcDayFraction(dayKey, now = new Date()) {
  const today = utcDayKey(now);
  if (dayKey < today) return 1;
  if (dayKey > today) return 0;
  const msIntoDay = now.getTime() - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.min(1, Math.max(0, msIntoDay / 86400000));
}

/* ---------- the ONE canonical source of "today's numbers" ----------
   Every admin surface (Dashboard tiles, live-distribution subtitle,
   System page, Bots page) and the public count both render from this
   single helper — nobody else is allowed to derive bot math again.
   Five numbers, two audiences:
     real        distinct real answers today
     lobbyBots   projected bots RAMPED over the UTC day — what the
                 PUBLIC lobby count is built from (grows smoothly
                 instead of jumping to the floor at 00:00 UTC)
     lobbyCount  real + lobbyBots  ← GET /api/count/:day
     tallyBots   the FULL floor projection, unramped — what tonight's
                 00:03 UTC tally will actually use
     tallyBlend  real + tallyBots  ← "at tally tonight"
   A day that's already been tallied has a real final total (the
   `results` blob already reflects whatever bot blend that tally
   actually used) — every field just reads off the blob directly rather
   than projecting, and lobby/tally collapse to the same real numbers
   since there's nothing left to project once the day is closed. */
async function computeTodayNumbers(day, env, now = new Date()) {
  const config = await loadConfig(env);
  const botsEnabled = config.bots_enabled === "1";
  const floor = Number(config.bot_floor) || 0;

  const resultsRow = await env.DB.prepare("SELECT blob FROM results WHERE day = ?").bind(day).first();
  if (resultsRow) {
    const blob = JSON.parse(resultsRow.blob);
    return {
      real: blob.realPlayers,
      lobbyBots: blob.bots,
      lobbyCount: blob.players,
      tallyBots: blob.bots,
      tallyBlend: blob.players,
      floor,
      botsEnabled,
    };
  }

  const realRow = await env.DB.prepare("SELECT COUNT(*) as c FROM answers WHERE day = ?").bind(day).first();
  const real = realRow ? realRow.c : 0;
  const tallyBots = botsEnabled ? Math.max(0, floor - real) : 0;
  const lobbyBots = Math.round(tallyBots * utcDayFraction(day, now));
  return {
    real,
    lobbyBots,
    lobbyCount: real + lobbyBots,
    tallyBots,
    tallyBlend: real + tallyBots,
    floor,
    botsEnabled,
  };
}

/* ---------- GET /api/challenge/:day ----------
   The ONLY public route that exposes challenge content, and only ever
   the fields a player is allowed to see before or during that day —
   never crowd, target, or roast (those determine or reveal the answer,
   see this file's header comment). day > today is always 404, same as
   day not existing at all — no early looks at tomorrow's prompt either. */
const CHALLENGE_PUBLIC_FIELDS = ["number", "format", "prompt", "sub", "factoid", "options"];
function pickPublicChallengeFields(challenge) {
  const safe = {};
  CHALLENGE_PUBLIC_FIELDS.forEach((f) => {
    if (challenge[f] !== undefined) safe[f] = challenge[f];
  });
  return safe;
}
async function handleChallenge(day) {
  if (!DAY_RE.test(day)) return json({ error: "invalid day" }, 400);
  const today = utcDayKey();
  if (day > today) return json({ error: "not found" }, 404);
  const challenge = CHALLENGES[day];
  if (!challenge) return json({ error: "not found" }, 404);
  return json(pickPublicChallengeFields(challenge));
}

/* ---------- POST /api/share ----------
   Fired when a player copies their share card — see app.js's
   copyShare(). Only ever today's or yesterday's reveal can be shared
   (the two days a player could plausibly be looking at: today's own
   betting slip doesn't have a share card yet, and payoff-then-hook
   only ever surfaces yesterday automatically — anything older comes
   from History, which is still a legitimate share, so this stays
   permissive back through yesterday specifically rather than "today
   only"). No count is ever returned — GET /api/admin/stats is the only
   place this number surfaces, admin-key gated. */
async function handleShare(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const { day, playerId } = body || {};
  const today = utcDayKey();
  const yesterday = shiftDayKey(today, -1);
  if (day !== today && day !== yesterday) {
    return json({ ok: false, error: "invalid day" }, 400);
  }
  if (typeof playerId !== "string" || playerId.length > 40 || !PLAYER_ID_RE.test(playerId)) {
    return json({ ok: false, error: "invalid playerId" }, 400);
  }
  await env.DB.prepare("INSERT OR IGNORE INTO shares (day, player_id, created_at) VALUES (?, ?, ?)")
    .bind(day, playerId, Date.now())
    .run();
  return json({ ok: true });
}

/* ---------- admin auth ----------
   Every /api/admin/* route checks this first. Fails closed: if the
   ADMIN_KEY secret was never set (wrangler secret put ADMIN_KEY), every
   admin request is rejected rather than silently comparing against
   undefined. Belt-and-suspenders under Cloudflare Access per
   ADMIN-PANEL-PLAN.md — this header check has to hold on its own even
   if Access is misconfigured or absent, since /admin itself stays a
   public page (Access can wrap it later with zero code changes). */
function checkAdminAuth(request, env) {
  if (!env.ADMIN_KEY) return { ok: false, status: 500, error: "admin key not configured on the server" };
  const key = request.headers.get("X-Admin-Key");
  if (!key || key !== env.ADMIN_KEY) return { ok: false, status: 401, error: "unauthorized" };
  return { ok: true };
}

/* ---------- GET /api/admin/stats ---------- */
async function handleAdminStats(env) {
  const today = utcDayKey();
  const yesterday = shiftDayKey(today, -1);
  const thirtyDaysAgo = shiftDayKey(today, -29);

  const [
    newPlayersRow,
    yesterdayCountRow,
    retainedRow,
    dailyRowsResult,
    dailyBlendRowsResult,
    cronRow,
    config,
    resultsRow,
    nums,
    sharesTodayRow,
    sharesTotalRow,
  ] = await Promise.all([
      // "New" = never answered on any earlier day. Cheap enough at this
      // scale (a correlated NOT EXISTS per row); revisit if answers
      // ever grows large enough for this to show up in duration_ms.
      env.DB
        .prepare(
          `SELECT COUNT(DISTINCT a.player_id) as c FROM answers a
           WHERE a.day = ? AND NOT EXISTS (SELECT 1 FROM answers b WHERE b.player_id = a.player_id AND b.day < ?)`
        )
        .bind(today, today)
        .first(),
      env.DB.prepare("SELECT COUNT(DISTINCT player_id) as c FROM answers WHERE day = ?").bind(yesterday).first(),
      env.DB
        .prepare(
          `SELECT COUNT(DISTINCT y.player_id) as c FROM answers y
           WHERE y.day = ? AND EXISTS (SELECT 1 FROM answers t WHERE t.player_id = y.player_id AND t.day = ?)`
        )
        .bind(yesterday, today)
        .first(),
      env.DB.prepare("SELECT day, COUNT(*) as c FROM answers WHERE day >= ? GROUP BY day").bind(thirtyDaysAgo).all(),
      env.DB.prepare("SELECT day, json_extract(blob, '$.players') as players FROM results WHERE day >= ?").bind(thirtyDaysAgo).all(),
      env.DB.prepare("SELECT * FROM cron_runs ORDER BY ran_at DESC LIMIT 1").first(),
      loadConfig(env),
      env.DB.prepare("SELECT 1 as x FROM results WHERE day = ?").bind(today).first(),
      // The canonical source for real/bot numbers (see its own doc
      // comment) — stats no longer derives bot math independently.
      computeTodayNumbers(today, env),
      env.DB.prepare("SELECT COUNT(*) as c FROM shares WHERE day = ?").bind(today).first(),
      env.DB.prepare("SELECT COUNT(*) as c FROM shares").first(),
    ]);

  const realCount = nums.real;
  const newPlayers = newPlayersRow ? newPlayersRow.c : 0;
  const returning = Math.max(0, realCount - newPlayers);
  const yesterdayCount = yesterdayCountRow ? yesterdayCountRow.c : 0;
  const retained = retainedRow ? retainedRow.c : 0;
  // null (not 0) when yesterday had no real players — "0% retention"
  // and "no baseline to measure retention from" are different facts.
  const d1RetentionPct = yesterdayCount ? Math.round((retained / yesterdayCount) * 100) : null;

  const dailyMap = {};
  (dailyRowsResult.results || []).forEach((r) => {
    dailyMap[r.day] = r.c;
  });
  // The tallied blend per day, only for days that actually have a results
  // row (a day with no row yet — today, or a day the cron hasn't reached —
  // has no blend to show, only the running real-answer count above).
  const blendMap = {};
  (dailyBlendRowsResult.results || []).forEach((r) => {
    blendMap[r.day] = r.players;
  });
  const dailyTotals = [];
  for (let i = 29; i >= 0; i--) {
    const day = shiftDayKey(today, -i);
    dailyTotals.push({ day, count: dailyMap[day] || 0, blend: blendMap[day] != null ? blendMap[day] : null });
  }

  const sharesToday = sharesTodayRow ? sharesTodayRow.c : 0;

  return json({
    today,
    realCount,
    // Deprecated aliases, kept for anything still reading the old
    // field names — both are now straight pass-throughs of the
    // canonical computeTodayNumbers fields (tallyBots/tallyBlend), not
    // independently derived. New surfaces should read the canonical
    // fields below (or call GET /api/admin/count/:day directly) instead.
    botsProjected: nums.tallyBots,
    submissionsTotal: nums.tallyBlend,
    // The full canonical breakdown, straight from computeTodayNumbers, so
    // the Dashboard can show BOTH blends side by side ("Lobby count" vs.
    // "At tally tonight") without a second round trip to
    // GET /api/admin/count/:day.
    lobbyBots: nums.lobbyBots,
    lobbyCount: nums.lobbyCount,
    tallyBots: nums.tallyBots,
    tallyBlend: nums.tallyBlend,
    botFloor: nums.floor,
    botsEnabled: nums.botsEnabled,
    newPlayers,
    returning,
    d1RetentionPct,
    dailyTotals,
    todayClosed: config.closed_day === today,
    hasResults: !!resultsRow,
    sharesToday,
    sharesTotal: sharesTotalRow ? sharesTotalRow.c : 0,
    shareRatePct: realCount ? Math.round((sharesToday / realCount) * 100) : 0,
    cron: cronRow
      ? {
          ok: !!cronRow.ok,
          day: cronRow.day,
          ranAt: cronRow.ran_at,
          durationMs: cronRow.duration_ms,
          players: cronRow.players,
          bots: cronRow.bots,
          error: cronRow.error,
        }
      : null,
  });
}

/* ---------- GET /api/admin/cron ---------- */
async function handleAdminCron(env) {
  const [runsResult, answersCount, resultsCount, resultsPlayersCount, cronRunsCount] = await Promise.all([
    env.DB.prepare("SELECT * FROM cron_runs ORDER BY ran_at DESC LIMIT 14").all(),
    env.DB.prepare("SELECT COUNT(*) as c FROM answers").first(),
    env.DB.prepare("SELECT COUNT(*) as c FROM results").first(),
    env.DB.prepare("SELECT COUNT(*) as c FROM results_players").first(),
    env.DB.prepare("SELECT COUNT(*) as c FROM cron_runs").first(),
  ]);
  const runs = runsResult.results || [];
  // "Error rate" here specifically means cron-run failure rate — there's
  // no per-request error log table, so this doesn't claim to be a
  // general API error rate. Labelled that way in the System tab too.
  const failCount = runs.filter((r) => !r.ok).length;
  const errorRatePct = runs.length ? Math.round((failCount / runs.length) * 100) : 0;
  return json({
    runs,
    errorRatePct,
    errorRateWindow: runs.length,
    rowCounts: {
      answers: answersCount.c,
      results: resultsCount.c,
      results_players: resultsPlayersCount.c,
      cron_runs: cronRunsCount.c,
    },
  });
}

/* ---------- GET /api/admin/config ---------- */
async function handleAdminGetConfig(env) {
  const config = await loadConfig(env);
  return json({
    botFloor: Number(config.bot_floor) || 0,
    botsEnabled: config.bots_enabled === "1",
    closedDay: config.closed_day || null,
  });
}

/* ---------- POST /api/admin/config ---------- */
async function handleAdminSetConfig(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json({ error: "invalid JSON body" }, 400);
  }

  const statements = [];
  if (typeof body.botFloor === "number" && Number.isFinite(body.botFloor)) {
    // 20000 ceiling gives headroom above the Bots tab's 10,000 max —
    // the server clamp is a safety rail, not the UI's actual limit.
    const floor = Math.max(0, Math.min(20000, Math.round(body.botFloor)));
    statements.push(
      env.DB
        .prepare("INSERT INTO config (key, value) VALUES ('bot_floor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(String(floor))
    );
  }
  if (typeof body.botsEnabled === "boolean") {
    statements.push(
      env.DB
        .prepare("INSERT INTO config (key, value) VALUES ('bots_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(body.botsEnabled ? "1" : "0")
    );
  }
  if (!statements.length) {
    return json({ error: "nothing to update — expected botFloor (number) and/or botsEnabled (boolean)" }, 400);
  }

  await env.DB.batch(statements);
  const config = await loadConfig(env);
  return json({ botFloor: Number(config.bot_floor) || 0, botsEnabled: config.bots_enabled === "1" });
}

/* ---------- GET /api/admin/live/:day ----------
   The spoiler-shield's real data source. Computed live from raw
   `answers` using the exact same bot-blending + tally math as the real
   cron (runDailyTally below) — a faithful "what would tonight's tally
   look like right now" preview — but nothing here is written to
   `results`. A day only gets a real results row from the actual tally;
   this is read-only, admin-eyes-only, and safe for *any* day including
   today specifically because it's gated behind the admin key rather
   than the public golden-rule-2 gate that GET /api/results/:day
   enforces. */
async function handleAdminLive(day, env) {
  if (!DAY_RE.test(day)) return json({ error: "invalid day" }, 400);

  const challenge = CHALLENGES[day];
  if (!challenge) return json({ error: "no challenge scheduled for that day" }, 404);

  const { results: rows } = await env.DB
    .prepare("SELECT player_id, answer FROM answers WHERE day = ? ORDER BY player_id")
    .bind(day)
    .all();
  const realAnswers = rows.map((r) => JSON.parse(r.answer));

  // Bot count comes from computeTodayNumbers's tallyBots — the FULL
  // floor projection, unramped — not a separately-derived number, so
  // this preview's own blob.bots/blob.players always exactly match
  // whatever the System/Dashboard/Bots pages show for "at tally
  // tonight" at that same moment (see that helper's doc comment).
  const nums = await computeTodayNumbers(day, env);
  const randBots = mulberry32(challenge.number);
  const botAnswers = sampleBotAnswers(challenge, nums.tallyBots, randBots);

  const blob = computeResultsBlob(challenge, realAnswers, botAnswers);
  blob.roast = renderRoast(challenge.roast, roastVars(blob));
  return json(blob);
}

/* ---------- GET /api/admin/count/:day ----------
   The full canonical breakdown from computeTodayNumbers — the real/bot
   split (and both blends) the public endpoint deliberately withholds.
   The admin is allowed to know how much of a number is real. */
async function handleAdminCount(day, env) {
  if (!DAY_RE.test(day)) return json({ error: "invalid day" }, 400);
  return json(await computeTodayNumbers(day, env));
}

/* ---------- GET /api/admin/challenges ----------
   The full deck, secrets included (crowd/target/roast) — this is what
   Calendar and Challenges need to edit and preview correctly, and the
   only place that data is allowed to leave the Worker. Export still
   downloads this same full object for committing back to
   src/challenges.json. */
async function handleAdminChallenges() {
  return json(CHALLENGES);
}

/* ---------- POST /api/admin/retally/:day ---------- */
async function handleAdminRetally(day, env) {
  if (!DAY_RE.test(day)) return json({ error: "invalid day" }, 400);
  const result = await runDailyTally(env, day);
  return json(result);
}

/* ---------- force-close state machine ----------
   Closing a day means two things happen together: submissions stop AND
   results exist — a force-closed day is a *finished* day, not just a
   locked door. Reopen undoes both; reset additionally wipes the raw
   answers so the day genuinely restarts from zero. All three return the
   resulting {closedDay, answers, hasResults} so the UI can render the
   new state without a second round-trip. */
async function getTodayState(env) {
  const today = utcDayKey();
  const [config, answersRow, resultsRow] = await Promise.all([
    loadConfig(env),
    env.DB.prepare("SELECT COUNT(*) as c FROM answers WHERE day = ?").bind(today).first(),
    env.DB.prepare("SELECT 1 as x FROM results WHERE day = ?").bind(today).first(),
  ]);
  return {
    closedDay: config.closed_day === today ? today : null,
    answers: answersRow ? answersRow.c : 0,
    hasResults: !!resultsRow,
  };
}

/* ---------- POST /api/admin/close-today ----------
   Emergency-only manual close, per ADMIN-PANEL-PLAN.md's System
   section. Stamps closed_day (so handleSubmit starts rejecting new
   answers immediately) THEN runs the real idempotent tally for today
   right away, so "closed" always means results actually exist — no
   window where submissions have stopped but there's nothing to show
   yet. The normal 00:03 UTC cron still fires on schedule later and
   re-tallies the same (now frozen) answers — harmless, since the tally
   is idempotent. */
async function handleAdminCloseToday(env) {
  const today = utcDayKey();
  await env.DB
    .prepare("INSERT INTO config (key, value) VALUES ('closed_day', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(today)
    .run();
  await runDailyTally(env, today);
  return json(await getTodayState(env));
}

/* ---------- POST /api/admin/reopen-today ----------
   Undoes close-today: clears closed_day and deletes today's published
   results — submissions resume immediately, the day is live again as
   if it was never closed. Raw answers are untouched. */
async function handleAdminReopenToday(env) {
  const today = utcDayKey();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM config WHERE key = 'closed_day'"),
    env.DB.prepare("DELETE FROM results WHERE day = ?").bind(today),
    env.DB.prepare("DELETE FROM results_players WHERE day = ?").bind(today),
  ]);
  return json(await getTodayState(env));
}

/* ---------- POST /api/admin/reset-today ----------
   Everything reopen does, plus deletes today's raw answers — the
   challenge restarts from zero. The destructive one; the response
   reports exactly what was deleted so the UI isn't guessing. */
async function handleAdminResetToday(env) {
  const today = utcDayKey();
  const beforeAnswers = await env.DB.prepare("SELECT COUNT(*) as c FROM answers WHERE day = ?").bind(today).first();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM config WHERE key = 'closed_day'"),
    env.DB.prepare("DELETE FROM results WHERE day = ?").bind(today),
    env.DB.prepare("DELETE FROM results_players WHERE day = ?").bind(today),
    env.DB.prepare("DELETE FROM answers WHERE day = ?").bind(today),
  ]);
  const state = await getTodayState(env);
  state.deleted = { answers: beforeAnswers ? beforeAnswers.c : 0 };
  return json(state);
}

/* ---------- Players tab (admin-key gated) ----------
   Players are anonymous IDs — nothing here ever claims to know who
   anyone is. No IP is stored anywhere in this codebase and that stays
   true; the flagged list below is deliberately player-ID-only. */

/* ---------- GET /api/admin/players ----------
   Summary tiles + a flagged list: players with >5 rejections today, and
   players sitting in the config-backed blocklist (see
   parseBlockedPlayers above and CLAUDE.md's blocklist section). */
async function handleAdminPlayers(env) {
  const today = utcDayKey();
  const sevenDaysAgo = shiftDayKey(today, -6);
  const fourteenDaysAgo = shiftDayKey(today, -13);

  const [totalRow, dauRow, wauRow, cohortResult, rejectionRows, config] = await Promise.all([
    env.DB.prepare("SELECT COUNT(DISTINCT player_id) as c FROM answers").first(),
    env.DB.prepare("SELECT COUNT(DISTINCT player_id) as c FROM answers WHERE day = ?").bind(today).first(),
    env.DB.prepare("SELECT COUNT(DISTINCT player_id) as c FROM answers WHERE day >= ?").bind(sevenDaysAgo).first(),
    env.DB
      .prepare(
        `SELECT day, COUNT(*) as c FROM (SELECT player_id, MIN(day) as day FROM answers GROUP BY player_id)
         WHERE day >= ? GROUP BY day`
      )
      .bind(fourteenDaysAgo)
      .all(),
    env.DB
      .prepare("SELECT player_id, SUM(count) as c FROM submit_rejections WHERE day = ? GROUP BY player_id HAVING SUM(count) > 5")
      .bind(today)
      .all(),
    loadConfig(env),
  ]);

  const cohortMap = {};
  (cohortResult.results || []).forEach((r) => {
    cohortMap[r.day] = r.c;
  });
  const cohort = [];
  for (let i = 13; i >= 0; i--) {
    const day = shiftDayKey(today, -i);
    cohort.push({ day, newPlayers: cohortMap[day] || 0 });
  }

  const blockedPlayers = parseBlockedPlayers(config);
  const flaggedMap = {};
  (rejectionRows.results || []).forEach((r) => {
    flaggedMap[r.player_id] = { playerId: r.player_id, rejectionsToday: r.c, blocked: false };
  });
  blockedPlayers.forEach((id) => {
    if (flaggedMap[id]) flaggedMap[id].blocked = true;
    else flaggedMap[id] = { playerId: id, rejectionsToday: 0, blocked: true };
  });

  return json({
    totalPlayers: totalRow ? totalRow.c : 0,
    dau: dauRow ? dauRow.c : 0,
    wau: wauRow ? wauRow.c : 0,
    cohort,
    flagged: Object.values(flaggedMap),
    ipFlaggingNote: "IP-level flagging is deliberately not built — no IPs are stored anywhere in this codebase, and that stays true.",
  });
}

/* ---------- GET /api/admin/players/:playerId ----------
   Day-by-day participation for one player. Today's own pick is never
   included, even here — the day is still open and golden rule 2's
   blind-answering rule doesn't bend for an admin looking up a specific
   player either. Closed-day picks are fine to show. */
async function handleAdminPlayerDetail(playerId, env) {
  if (!PLAYER_ID_RE.test(playerId)) return json({ error: "invalid playerId" }, 400);
  const today = utcDayKey();
  const [answersResult, sharesResult, rejectionsResult, config] = await Promise.all([
    env.DB.prepare("SELECT day, answer FROM answers WHERE player_id = ? ORDER BY day").bind(playerId).all(),
    env.DB.prepare("SELECT day FROM shares WHERE player_id = ? ORDER BY day").bind(playerId).all(),
    env.DB.prepare("SELECT day, reason, count FROM submit_rejections WHERE player_id = ? ORDER BY day").bind(playerId).all(),
    loadConfig(env),
  ]);

  const answers = answersResult.results || [];
  if (!answers.length) return json({ error: "not found" }, 404);

  const days = answers.map((r) => ({
    day: r.day,
    answer: r.day === today ? undefined : JSON.parse(r.answer),
  }));

  return json({
    playerId,
    firstSeen: answers[0].day,
    daysPlayed: answers.length,
    days,
    shares: (sharesResult.results || []).map((r) => r.day),
    rejections: (rejectionsResult.results || []).map((r) => ({ day: r.day, reason: r.reason, count: r.count })),
    blocked: parseBlockedPlayers(config).includes(playerId),
  });
}

/* ---------- POST /api/admin/players/:id/invalidate-day {day} ----------
   Deletes that player's answer for a CLOSED day and re-runs the tally —
   rejected for today, since today self-corrects at the 00:03 UTC tally
   anyway (nothing to invalidate yet, the day isn't scored). */
async function handleAdminInvalidateDay(playerId, request, env) {
  if (!PLAYER_ID_RE.test(playerId)) return json({ error: "invalid playerId" }, 400);
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json({ error: "invalid JSON body" }, 400);
  }
  const { day } = body || {};
  const today = utcDayKey();
  if (!DAY_RE.test(day)) return json({ error: "invalid day" }, 400);
  if (day >= today) return json({ error: "today self-corrects at tally — invalidate closed days only" }, 400);

  await env.DB.prepare("DELETE FROM answers WHERE day = ? AND player_id = ?").bind(day, playerId).run();
  const result = await runDailyTally(env, day);
  return json({ ok: true, day, retally: result });
}

/* ---------- POST /api/admin/players/:id/block and /unblock ----------
   Shadow-block (see handleSubmit and CLAUDE.md): a blocked player keeps
   playing and never sees any sign of it. */
async function handleAdminSetBlocked(playerId, env, blocked) {
  if (!PLAYER_ID_RE.test(playerId)) return json({ error: "invalid playerId" }, 400);
  const config = await loadConfig(env);
  const list = new Set(parseBlockedPlayers(config));
  if (blocked) list.add(playerId);
  else list.delete(playerId);
  await env.DB
    .prepare("INSERT INTO config (key, value) VALUES ('blocked_players', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify([...list]))
    .run();
  return json({ ok: true, playerId, blocked });
}

/* ---------- DELETE /api/admin/players/:id ----------
   The privacy button: full removal from answers/results_players/shares/
   submit_rejections. `results` blobs are left untouched — aggregates
   aren't personal data — but any CLOSED day this player participated in
   within the last 7 days gets re-tallied so those numbers stay honest
   without recomputing all of history. The day list has to be captured
   BEFORE the delete, since the delete removes the evidence of which
   days to re-tally. */
async function handleAdminDeletePlayer(playerId, env) {
  if (!PLAYER_ID_RE.test(playerId)) return json({ error: "invalid playerId" }, 400);
  const today = utcDayKey();
  const sevenDaysAgo = shiftDayKey(today, -7);

  const daysResult = await env.DB.prepare("SELECT DISTINCT day FROM answers WHERE player_id = ?").bind(playerId).all();
  const allDays = (daysResult.results || []).map((r) => r.day);
  const daysToRetally = allDays.filter((d) => d !== today && d >= sevenDaysAgo);

  await env.DB.batch([
    env.DB.prepare("DELETE FROM answers WHERE player_id = ?").bind(playerId),
    env.DB.prepare("DELETE FROM results_players WHERE player_id = ?").bind(playerId),
    env.DB.prepare("DELETE FROM shares WHERE player_id = ?").bind(playerId),
    env.DB.prepare("DELETE FROM submit_rejections WHERE player_id = ?").bind(playerId),
  ]);

  for (const day of daysToRetally) {
    await runDailyTally(env, day);
  }

  return json({ ok: true, playerId, deletedDays: allDays.length, retalliedDays: daysToRetally });
}

/* ---------- GET /api/admin/players.csv ---------- */
async function handleAdminPlayersCsv(env) {
  const [answersResult, sharesResult, rejectionsResult, config] = await Promise.all([
    env.DB.prepare("SELECT player_id, MIN(day) as first_seen, COUNT(*) as days_played FROM answers GROUP BY player_id").all(),
    env.DB.prepare("SELECT player_id, COUNT(*) as c FROM shares GROUP BY player_id").all(),
    env.DB.prepare("SELECT player_id, SUM(count) as c FROM submit_rejections GROUP BY player_id").all(),
    loadConfig(env),
  ]);
  const sharesMap = {};
  (sharesResult.results || []).forEach((r) => {
    sharesMap[r.player_id] = r.c;
  });
  const rejectionsMap = {};
  (rejectionsResult.results || []).forEach((r) => {
    rejectionsMap[r.player_id] = r.c;
  });
  const blocked = new Set(parseBlockedPlayers(config));

  // player_id always matches PLAYER_ID_RE (p_[a-z0-9]+) — no CSV
  // escaping needed, there's no comma or quote that can ever appear in it.
  const rows = ["player_id,first_seen,days_played,shares,rejections,blocked"];
  (answersResult.results || []).forEach((r) => {
    rows.push(
      [r.player_id, r.first_seen, r.days_played, sharesMap[r.player_id] || 0, rejectionsMap[r.player_id] || 0, blocked.has(r.player_id)].join(",")
    );
  });
  return new Response(rows.join("\n"), {
    status: 200,
    headers: { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=players.csv" },
  });
}

/* ---------- deterministic randomness ----------
   Bots and Split-or-Steal pairing both need randomness that reproduces
   byte-identically on a re-tally of the same day, so neither is allowed
   to touch Math.random(). mulberry32 is a small, fast, well-distributed
   PRNG — good enough for sampling a crowd shape, not cryptographic. */
function mulberry32(seed) {
  let s = seed >>> 0;
  return function rand() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Weighted pick over an array of non-negative weights (counts or
// percentages — the scale doesn't matter, only the ratios do).
function weightedIndex(weights, rand) {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let r = rand() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

// Sample `count` bot answers from the challenge's authored crowd shape
// (never from anything derived from real players — bots exist purely to
// keep small-crowd days looking like the shape the admin designed, per
// CLAUDE.md's Bot blending section). Bots are never written to
// `answers`; they only ever exist inside a single tally computation.
function sampleBotAnswers(challenge, count, rand) {
  const bots = [];
  if (challenge.format === "crunch" || challenge.format === "herdmeter") {
    for (let i = 0; i < count; i++) {
      const bucket = weightedIndex(challenge.crowd, rand);
      bots.push(Math.min(100, bucket * 5 + Math.floor(rand() * 5)));
    }
  } else if (challenge.format === "oddonein" || challenge.format === "splitsteal") {
    for (let i = 0; i < count; i++) {
      bots.push(weightedIndex(challenge.crowd, rand));
    }
  }
  return bots;
}

/* ---------- percentile math (mirrors public/formats.js) ----------
   The client currently scores every pick against *simulated* crowd
   data using these exact formulas. Once the reveal flip lands (next
   session) it'll score against these *real* precomputed percentile
   lookups instead — so the math has to match formats.js exactly, or a
   player's percentile would visibly change the day the switch flips.
   Keep both copies in sync by hand if the scoring model ever changes. */
function bucketIndex(v) {
  return Math.min(19, Math.max(0, Math.floor(v / 5)));
}
function indexOfMax(arr) {
  return arr.indexOf(Math.max(...arr));
}
function indexOfMin(arr) {
  return arr.indexOf(Math.min(...arr));
}
function percentileFromTargetDistance(crowd, target, pick) {
  const total = crowd.reduce((a, b) => a + b, 0) || 1;
  const myDist = Math.abs(pick - target);
  const lo = target - myDist;
  const hi = target + myDist;
  let betterOrEqual = 0;
  crowd.forEach((count, i) => {
    const bucketLo = i * 5;
    const bucketHi = i * 5 + 5;
    const overlap = Math.max(0, Math.min(bucketHi, hi) - Math.max(bucketLo, lo));
    betterOrEqual += count * (overlap / 5);
  });
  return Math.max(1, Math.min(100, Math.round((betterOrEqual / total) * 100)));
}
function percentileFromShare(crowd, pick) {
  const total = crowd.reduce((a, b) => a + b, 0) || 1;
  const myShare = crowd[pick];
  let betterOrEqual = 0;
  crowd.forEach((v) => {
    if (v <= myShare) betterOrEqual += v;
  });
  return Math.max(1, Math.min(100, Math.round((betterOrEqual / total) * 100)));
}

/* ---------- roast-copy templating (CLAUDE.md "Roast copy is a template") ---------- */
function renderRoast(template, vars) {
  if (!template) return template;
  return template.replace(/\{(\w+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

/* ---------- results blob per format ----------
   `combined` is real answers + sampled bot answers, already merged —
   every stat here reflects the full blended crowd. realAnswers/bots
   are passed separately only so the blob can report the real/bot split
   for admin visibility (CLAUDE.md's cron_runs `players`/`bots`
   columns mirror this at the run level too). */
// blobVersion 2: realCrowd/botCrowd are RAW COUNTS for every format (never
// a percentage) — v1 blobs stored realCrowd as a percentage-of-blended-total
// for oddonein/splitsteal, which meant a handful of real answers against a
// large bot floor could round to "0% real" even though real answers existed
// ("0 real + 300 bots" bug). crowdCounts is the blended total in raw counts
// too, added for oddonein/splitsteal where `crowd` itself stays a percentage
// share — so nothing ever has to derive counts by dividing a percentage back
// out. Old rows in `results` keep the v1 shape until re-tallied; the client
// (formats.js/reveal.js) and admin chart both tolerate either.
const BLOB_VERSION = 2;

function computeResultsBlob(challenge, realAnswers, botAnswers) {
  const combined = realAnswers.concat(botAnswers);
  const total = combined.length;
  const base = {
    format: challenge.format,
    players: total,
    realPlayers: realAnswers.length,
    bots: botAnswers.length,
    blobVersion: BLOB_VERSION,
  };

  if (challenge.format === "crunch" || challenge.format === "herdmeter") {
    const buckets = new Array(20).fill(0);
    const realBuckets = new Array(20).fill(0);
    let sum = 0;
    combined.forEach((a) => {
      buckets[bucketIndex(a)]++;
      sum += a;
    });
    realAnswers.forEach((a) => {
      realBuckets[bucketIndex(a)]++;
    });
    const avg = total ? +(sum / total).toFixed(1) : 0;
    // Crunch's target is derived live from the real crowd (2/3 of the
    // average, per the challenge's own rule); Herd Meter's target is an
    // authored ground truth (what the underlying poll actually said),
    // never computed from guesses.
    const target =
      challenge.format === "crunch" ? Math.max(0, Math.min(100, Math.round((2 / 3) * avg))) : challenge.target;
    const peakIndex = indexOfMax(buckets);
    const percentiles = [];
    for (let pick = 0; pick <= 100; pick++) {
      percentiles.push(percentileFromTargetDistance(buckets, target, pick));
    }
    // botCrowd is raw counts too, buckets minus realBuckets — added so no
    // client ever has to derive it by subtracting mixed-unit arrays.
    const botBuckets = buckets.map((v, i) => Math.max(0, v - realBuckets[i]));
    return Object.assign(base, {
      crowd: buckets,
      realCrowd: realBuckets,
      botCrowd: botBuckets,
      avg,
      target,
      winIndexes: [bucketIndex(target)],
      peakIndex,
      peakLabel: `${peakIndex * 5}–${peakIndex * 5 + 5}`,
      peakPct: total ? Math.round((buckets[peakIndex] / total) * 100) : 0,
      percentiles,
    });
  }

  if (challenge.format === "oddonein") {
    const counts = new Array(challenge.options.length).fill(0);
    const realCounts = new Array(challenge.options.length).fill(0);
    combined.forEach((a) => {
      if (counts[a] !== undefined) counts[a]++;
    });
    realAnswers.forEach((a) => {
      if (realCounts[a] !== undefined) realCounts[a]++;
    });
    const pct = counts.map((c) => (total ? Math.round((c / total) * 100) : 0));
    // realCrowd/botCrowd are RAW COUNTS (blobVersion 2) — a percentage
    // share rounds to 0 for a handful of real answers against a large bot
    // floor even though real answers exist, which is exactly the "0 real +
    // 300 bots" display bug this version fixes. crowdCounts is the same
    // blended total as `crowd`, just in counts instead of percentage, so
    // nothing needs to divide a percentage back out to get a count.
    const botCounts = counts.map((c, i) => Math.max(0, c - realCounts[i]));
    const winnerIndex = indexOfMin(pct);
    const peakIndex = indexOfMax(pct);
    const percentiles = pct.map((_, i) => percentileFromShare(pct, i));
    return Object.assign(base, {
      crowd: pct,
      crowdCounts: counts,
      realCrowd: realCounts,
      botCrowd: botCounts,
      winIndexes: [winnerIndex],
      winnerLabel: challenge.options[winnerIndex].label,
      winnerPct: pct[winnerIndex],
      peakIndex,
      peakLabel: challenge.options[peakIndex].label,
      peakPct: pct[peakIndex],
      percentiles,
    });
  }

  if (challenge.format === "splitsteal") {
    const splitCount = combined.filter((a) => a === 0).length;
    const stealCount = total - splitCount;
    const realSplitCount = realAnswers.filter((a) => a === 0).length;
    const realStealCount = realAnswers.length - realSplitCount;
    const splitPct = total ? Math.round((splitCount / total) * 100) : 0;
    // Same blobVersion 2 fix as oddonein above: realCrowd/botCrowd are raw
    // counts, crowdCounts is the blended total in counts.
    return Object.assign(base, {
      crowd: [splitPct, 100 - splitPct],
      crowdCounts: [splitCount, stealCount],
      realCrowd: [realSplitCount, realStealCount],
      botCrowd: [Math.max(0, splitCount - realSplitCount), Math.max(0, stealCount - realStealCount)],
      splitPct,
    });
  }

  return Object.assign(base, { crowd: [], realCrowd: [], botCrowd: [] });
}

// Pairs every REAL player with a uniformly sampled OTHER answer from the
// combined (real+bot) pool and derives their outcome. `combined` must be
// realAnswers.concat(botAnswers) — the same array computeResultsBlob was
// given — so index i < realRows.length lines up 1:1 with realRows[i].
function computeSplitStealOutcomes(realRows, combined, randPairing) {
  const n = combined.length;
  if (n < 2) return []; // nobody else in the pool to pair against
  return realRows.map((row, i) => {
    let partnerIdx = Math.floor(randPairing() * (n - 1));
    if (partnerIdx >= i) partnerIdx++; // draw from everyone but yourself
    const mine = row.answer;
    const partner = combined[partnerIdx];
    let outcome;
    if (mine === 0 && partner === 0) outcome = "mutual_split";
    else if (mine === 0 && partner === 1) outcome = "betrayed";
    else if (mine === 1 && partner === 0) outcome = "clean_steal";
    else outcome = "mutual_steal";
    return { player_id: row.player_id, outcome };
  });
}

function roastVars(blob) {
  if (blob.format === "crunch" || blob.format === "herdmeter") {
    return { avg: blob.avg, target: blob.target, peakLabel: blob.peakLabel, peakPct: blob.peakPct };
  }
  if (blob.format === "oddonein") {
    return { winnerLabel: blob.winnerLabel, winnerPct: blob.winnerPct, peakLabel: blob.peakLabel, peakPct: blob.peakPct };
  }
  if (blob.format === "splitsteal") {
    return { splitPct: blob.splitPct };
  }
  return {};
}

/* ---------- daily tally (00:03 UTC cron) ----------
   Idempotent: re-running it for the same day recomputes fresh from
   `answers` (raw, append-only, the source of truth) and overwrites that
   day's `results` + `results_players` rows. Nothing here is randomness
   that varies run to run — bot sampling and partner pairing are both
   seeded off the challenge's own daily number, so two runs against the
   same `answers` produce byte-identical blobs. This is the "cron failed
   at 3am" fix from ADMIN-PANEL-PLAN.md: re-run the tally, never
   hand-edit `results`. */
async function runDailyTally(env, forDay) {
  const start = Date.now();
  // The cron fires at 00:03 UTC for the day that JUST closed, i.e.
  // "yesterday" relative to the moment it runs — unless a day is passed
  // explicitly (used by the manual re-run path / local testing).
  const day = forDay || utcDayKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
  let ok = 1;
  let error = null;
  let players = 0;
  let bots = 0;

  try {
    const challenge = CHALLENGES[day];
    if (!challenge) throw new Error(`no challenge scheduled for ${day}`);

    // ORDER BY player_id: a stable read order matters here, because the
    // bot/pairing RNG streams are consumed in the order rows arrive —
    // an unordered SELECT would make a "deterministic" re-tally not
    // actually deterministic across runs.
    const { results: rows } = await env.DB
      .prepare("SELECT player_id, answer FROM answers WHERE day = ? ORDER BY player_id")
      .bind(day)
      .all();
    const realRows = rows.map((r) => ({ player_id: r.player_id, answer: JSON.parse(r.answer) }));
    players = realRows.length;

    const config = await loadConfig(env);
    const botFloor = config.bots_enabled === "1" ? Number(config.bot_floor) || 0 : 0;
    const botCount = Math.max(0, botFloor - players);
    bots = botCount;

    const randBots = mulberry32(challenge.number);
    const botAnswers = sampleBotAnswers(challenge, botCount, randBots);
    const realAnswers = realRows.map((r) => r.answer);
    const combined = realAnswers.concat(botAnswers);

    const blob = computeResultsBlob(challenge, realAnswers, botAnswers);
    blob.roast = renderRoast(challenge.roast, roastVars(blob));

    let outcomes = [];
    if (challenge.format === "splitsteal") {
      // Seed offset by one from the bots stream so bot sampling and
      // partner pairing don't share a PRNG sequence — changing the bot
      // count would otherwise shift every pairing draw that comes after
      // it in a single shared stream.
      const randPairing = mulberry32(challenge.number + 1);
      outcomes = computeSplitStealOutcomes(realRows, combined, randPairing);
    }

    const statements = [
      env.DB
        .prepare(
          `INSERT INTO results (day, blob, computed_at) VALUES (?, ?, ?)
           ON CONFLICT(day) DO UPDATE SET blob = excluded.blob, computed_at = excluded.computed_at`
        )
        .bind(day, JSON.stringify(blob), Date.now()),
      env.DB.prepare("DELETE FROM results_players WHERE day = ?").bind(day),
    ];
    outcomes.forEach((o) => {
      statements.push(
        env.DB.prepare("INSERT INTO results_players (day, player_id, outcome) VALUES (?, ?, ?)").bind(
          day,
          o.player_id,
          o.outcome
        )
      );
    });
    // batch() runs the whole array as one transaction — results and
    // results_players either both land or neither does.
    await env.DB.batch(statements);
  } catch (err) {
    ok = 0;
    error = String((err && err.message) || err);
  }

  const duration = Date.now() - start;
  await env.DB.prepare(
    "INSERT INTO cron_runs (day, ran_at, duration_ms, players, bots, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(day, Date.now(), duration, players, bots, ok, error)
    .run();

  return { day, ok: !!ok, error, players, bots, duration };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // /api/* errors come back as {error} JSON instead of a bare 500 —
    // an unhandled-exception page is useless to an API caller, and
    // this doubles as the fastest way to see what actually broke
    // without digging through dashboard logs.
    try {
      if (url.pathname === "/api/submit" && request.method === "POST") {
        return await handleSubmit(request, env);
      }

      if (url.pathname === "/api/share" && request.method === "POST") {
        return await handleShare(request, env);
      }

      const resultsMatch = url.pathname.match(/^\/api\/results\/([^/]+)$/);
      if (resultsMatch && request.method === "GET") {
        const playerId = url.searchParams.get("playerId");
        return await handleResults(decodeURIComponent(resultsMatch[1]), env, playerId);
      }

      const countMatch = url.pathname.match(/^\/api\/count\/([^/]+)$/);
      if (countMatch && request.method === "GET") {
        return await handleCount(decodeURIComponent(countMatch[1]), env);
      }

      const challengeMatch = url.pathname.match(/^\/api\/challenge\/([^/]+)$/);
      if (challengeMatch && request.method === "GET") {
        return await handleChallenge(decodeURIComponent(challengeMatch[1]));
      }

      if (url.pathname.startsWith("/api/admin/")) {
        const auth = checkAdminAuth(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);

        if (url.pathname === "/api/admin/stats" && request.method === "GET") {
          return await handleAdminStats(env);
        }
        if (url.pathname === "/api/admin/cron" && request.method === "GET") {
          return await handleAdminCron(env);
        }
        if (url.pathname === "/api/admin/config" && request.method === "GET") {
          return await handleAdminGetConfig(env);
        }
        if (url.pathname === "/api/admin/config" && request.method === "POST") {
          return await handleAdminSetConfig(request, env);
        }
        if (url.pathname === "/api/admin/challenges" && request.method === "GET") {
          return await handleAdminChallenges();
        }
        const liveMatch = url.pathname.match(/^\/api\/admin\/live\/([^/]+)$/);
        if (liveMatch && request.method === "GET") {
          return await handleAdminLive(decodeURIComponent(liveMatch[1]), env);
        }
        const adminCountMatch = url.pathname.match(/^\/api\/admin\/count\/([^/]+)$/);
        if (adminCountMatch && request.method === "GET") {
          return await handleAdminCount(decodeURIComponent(adminCountMatch[1]), env);
        }
        const retallyMatch = url.pathname.match(/^\/api\/admin\/retally\/([^/]+)$/);
        if (retallyMatch && request.method === "POST") {
          return await handleAdminRetally(decodeURIComponent(retallyMatch[1]), env);
        }
        if (url.pathname === "/api/admin/close-today" && request.method === "POST") {
          return await handleAdminCloseToday(env);
        }
        if (url.pathname === "/api/admin/reopen-today" && request.method === "POST") {
          return await handleAdminReopenToday(env);
        }
        if (url.pathname === "/api/admin/reset-today" && request.method === "POST") {
          return await handleAdminResetToday(env);
        }
        if (url.pathname === "/api/admin/players" && request.method === "GET") {
          return await handleAdminPlayers(env);
        }
        if (url.pathname === "/api/admin/players.csv" && request.method === "GET") {
          return await handleAdminPlayersCsv(env);
        }
        const invalidateMatch = url.pathname.match(/^\/api\/admin\/players\/([^/]+)\/invalidate-day$/);
        if (invalidateMatch && request.method === "POST") {
          return await handleAdminInvalidateDay(decodeURIComponent(invalidateMatch[1]), request, env);
        }
        const blockMatch = url.pathname.match(/^\/api\/admin\/players\/([^/]+)\/block$/);
        if (blockMatch && request.method === "POST") {
          return await handleAdminSetBlocked(decodeURIComponent(blockMatch[1]), env, true);
        }
        const unblockMatch = url.pathname.match(/^\/api\/admin\/players\/([^/]+)\/unblock$/);
        if (unblockMatch && request.method === "POST") {
          return await handleAdminSetBlocked(decodeURIComponent(unblockMatch[1]), env, false);
        }
        const playerDetailMatch = url.pathname.match(/^\/api\/admin\/players\/([^/]+)$/);
        if (playerDetailMatch && request.method === "GET") {
          return await handleAdminPlayerDetail(decodeURIComponent(playerDetailMatch[1]), env);
        }
        if (playerDetailMatch && request.method === "DELETE") {
          return await handleAdminDeletePlayer(decodeURIComponent(playerDetailMatch[1]), env);
        }
        return json({ error: "not found" }, 404);
      }
    } catch (err) {
      if (url.pathname.startsWith("/api/")) {
        return json({ error: String((err && err.message) || err) }, 500);
      }
      throw err;
    }

    // Everything else is the static site (game + admin).
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyTally(env));
  },
};

// Exported for local testing only (not part of the Worker's public API).
export const _internal = {
  utcDayKey,
  shiftDayKey,
  validateAnswer,
  mulberry32,
  weightedIndex,
  sampleBotAnswers,
  percentileFromTargetDistance,
  percentileFromShare,
  computeResultsBlob,
  computeSplitStealOutcomes,
  renderRoast,
  roastVars,
  runDailyTally,
  checkAdminAuth,
  utcDayFraction,
  computeTodayNumbers,
  pickPublicChallengeFields,
  handleShare,
  getTodayState,
  CHALLENGES,
};
