/* =====================================================
   Outguessr Worker — Phase 2 backend.

   Serves the static site (public/) and three endpoints:
     POST /api/submit          record an answer for today (UTC)
     GET  /api/results/:day    tallied blob for a CLOSED day only
     GET  /api/count/:day      submission count only (safe to expose)

   Plus a 00:03 UTC cron that tallies the day that just closed: bot
   blending, per-format results blob, Split or Steal pairing, and
   roast-copy templating all happen here. The reveal screen doesn't
   consume any of this yet (that's next session) — this is purely the
   compute-and-store half.

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

/* ---------- GET /api/results/:day[?playerId=] ---------- */
async function handleResults(day, env, playerId) {
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

  // Results are immutable once tallied — cache forever. Still true with
  // a playerId attached: the query string makes it a distinct cache key,
  // and a given player's own outcome for a finished day never changes
  // either.
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

/* ---------- GET /api/count/:day ---------- */
async function handleCount(day, env) {
  if (!DAY_RE.test(day)) {
    return json({ error: "invalid day" }, 400);
  }
  const row = await env.DB.prepare("SELECT COUNT(*) as count FROM answers WHERE day = ?").bind(day).first();
  return json({ count: row ? row.count : 0 });
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
function computeResultsBlob(challenge, realAnswers, botAnswers) {
  const combined = realAnswers.concat(botAnswers);
  const total = combined.length;
  const base = { format: challenge.format, players: total, realPlayers: realAnswers.length, bots: botAnswers.length };

  if (challenge.format === "crunch" || challenge.format === "herdmeter") {
    const buckets = new Array(20).fill(0);
    let sum = 0;
    combined.forEach((a) => {
      buckets[bucketIndex(a)]++;
      sum += a;
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
    return Object.assign(base, {
      crowd: buckets,
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
    combined.forEach((a) => {
      if (counts[a] !== undefined) counts[a]++;
    });
    const pct = counts.map((c) => (total ? Math.round((c / total) * 100) : 0));
    const winnerIndex = indexOfMin(pct);
    const peakIndex = indexOfMax(pct);
    const percentiles = pct.map((_, i) => percentileFromShare(pct, i));
    return Object.assign(base, {
      crowd: pct,
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
    const splitPct = total ? Math.round((splitCount / total) * 100) : 0;
    return Object.assign(base, { crowd: [splitPct, 100 - splitPct], splitPct });
  }

  return Object.assign(base, { crowd: [] });
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
    const challenges = await getChallenges(env);
    const challenge = challenges[day];
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

      const resultsMatch = url.pathname.match(/^\/api\/results\/([^/]+)$/);
      if (resultsMatch && request.method === "GET") {
        const playerId = url.searchParams.get("playerId");
        return await handleResults(decodeURIComponent(resultsMatch[1]), env, playerId);
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
export const _internal = {
  utcDayKey,
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
};
