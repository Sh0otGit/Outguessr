/* =====================================================
   Outguessr Worker — Phase 2 backend skeleton.

   Serves the static site (public/) and three endpoints:
     POST /api/submit          record an answer for today (UTC)
     GET  /api/results/:day    tallied blob for a CLOSED day only
     GET  /api/count/:day      submission count only (safe to expose)

   Plus a 00:03 UTC cron that tallies the day that just closed.

   Golden rule 2 (CLAUDE.md): today's distribution is never exposed.
   /api/count is the only thing safe to reveal about a live day.

   /api/admin/* (X-Admin-Key gated) is not implemented yet — future
   session, per CLAUDE.md's Phase 2 architecture section.
===================================================== */

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

// A warm Worker instance can stay alive for hours, so an unconditional
// cache means a late-day content push (e.g. filling an empty day)
// wouldn't be seen until the instance recycles — submits would keep
// bouncing off "no challenge scheduled today" long after the admin
// fixed it. A short TTL bounds that staleness without refetching on
// every request.
const CHALLENGES_CACHE_TTL_MS = 5 * 60 * 1000;
let _challengesCache = null;
let _challengesCacheAt = 0;
async function getChallenges(env) {
  const fresh = _challengesCache && Date.now() - _challengesCacheAt < CHALLENGES_CACHE_TTL_MS;
  if (fresh) return _challengesCache;
  const res = await env.ASSETS.fetch("https://assets.internal/challenges.json");
  if (!res.ok) throw new Error("couldn't load challenges.json from static assets");
  _challengesCache = await res.json();
  _challengesCacheAt = Date.now();
  return _challengesCache;
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

  if (day !== today) {
    return json({ ok: false, error: "day is not open" }, 400);
  }
  if (typeof playerId !== "string" || playerId.length > 40 || !PLAYER_ID_RE.test(playerId)) {
    return json({ ok: false, error: "invalid playerId" }, 400);
  }

  let challenges;
  try {
    challenges = await getChallenges(env);
  } catch (err) {
    return json({ ok: false, error: "couldn't load today's challenge" }, 500);
  }
  const challenge = challenges[day];
  if (!challenge) {
    return json({ ok: false, error: "no challenge scheduled today" }, 400);
  }
  if (!validateAnswer(challenge, answer)) {
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
  return json({ ok: true, accepted });
}

/* ---------- GET /api/results/:day ---------- */
async function handleResults(day, env) {
  if (!DAY_RE.test(day)) {
    return json({ error: "invalid day" }, 400);
  }
  const today = utcDayKey();
  if (day >= today) {
    // Golden rule 2 — never expose today's (or a future) distribution.
    return json({ error: "day not closed" }, 403);
  }

  const row = await env.DB.prepare("SELECT blob FROM results WHERE day = ?").bind(day).first();
  if (!row) {
    return json({ error: "not computed yet" }, 404);
  }

  // Results are immutable once tallied — cache forever.
  return new Response(row.blob, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

/* ---------- GET /api/count/:day ---------- */
async function handleCount(day, env) {
  if (!DAY_RE.test(day)) {
    return json({ error: "invalid day" }, 400);
  }
  const row = await env.DB.prepare("SELECT COUNT(*) as count FROM answers WHERE day = ?").bind(day).first();
  return json({ count: row ? row.count : 0 });
}

/* ---------- daily tally (00:00 UTC cron) ----------
   Real answers only in this skeleton — bot blending and roast-copy
   templating (CLAUDE.md's Phase 2 architecture section) are future
   work layered on top of this same table shape. */
function tallyAnswers(challenge, answers) {
  if (challenge.format === "crunch" || challenge.format === "herdmeter") {
    const buckets = new Array(20).fill(0);
    let sum = 0;
    answers.forEach((a) => {
      buckets[Math.min(19, Math.max(0, Math.floor(a / 5)))]++;
      sum += a;
    });
    return {
      format: challenge.format,
      count: answers.length,
      crowd: buckets,
      avg: answers.length ? +(sum / answers.length).toFixed(1) : 0,
    };
  }
  if (challenge.format === "oddonein") {
    const counts = new Array(challenge.options.length).fill(0);
    answers.forEach((a) => {
      if (counts[a] !== undefined) counts[a]++;
    });
    const total = answers.length || 1;
    return { format: "oddonein", count: answers.length, crowd: counts.map((c) => Math.round((c / total) * 100)) };
  }
  if (challenge.format === "splitsteal") {
    const split = answers.filter((a) => a === 0).length;
    const total = answers.length || 1;
    const splitPct = Math.round((split / total) * 100);
    return { format: "splitsteal", count: answers.length, crowd: [splitPct, 100 - splitPct] };
  }
  return { format: challenge.format, count: answers.length, crowd: [] };
}

async function runDailyTally(env, forDay) {
  const start = Date.now();
  // The cron fires at 00:03 UTC for the day that JUST closed, i.e.
  // "yesterday" relative to the moment it runs — unless a day is passed
  // explicitly (used by the manual re-run path / local testing).
  const day = forDay || utcDayKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
  let ok = 1;
  let error = null;
  let players = 0;
  const bots = 0; // bot blending not implemented in this skeleton

  try {
    const challenges = await getChallenges(env);
    const challenge = challenges[day];
    if (!challenge) throw new Error(`no authored challenge for ${day}`);

    const { results: rows } = await env.DB.prepare("SELECT answer FROM answers WHERE day = ?").bind(day).all();
    players = rows.length;
    const answers = rows.map((r) => JSON.parse(r.answer));
    const blob = tallyAnswers(challenge, answers);

    await env.DB.prepare(
      `INSERT INTO results (day, blob, computed_at) VALUES (?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET blob = excluded.blob, computed_at = excluded.computed_at`
    )
      .bind(day, JSON.stringify(blob), Date.now())
      .run();
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

      const resultsMatch = url.pathname.match(/^\/api\/results\/([^/]+)$/);
      if (resultsMatch && request.method === "GET") {
        return await handleResults(decodeURIComponent(resultsMatch[1]), env);
      }

      const countMatch = url.pathname.match(/^\/api\/count\/([^/]+)$/);
      if (countMatch && request.method === "GET") {
        return await handleCount(decodeURIComponent(countMatch[1]), env);
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
export const _internal = { utcDayKey, validateAnswer, tallyAnswers, runDailyTally };
