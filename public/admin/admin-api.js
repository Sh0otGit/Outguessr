/* =====================================================
   admin-api.js — the ONLY place admin.js (and admin-system.js,
   admin-bots.js) get data from.

   Two data sources, kept deliberately separate:
   - challenges.json (getAllChallenges/saveChallenge/deleteChallenge/
     exportChallengesJson/getRunwayDays) — unchanged from Phase 1,
     still the Calendar + Challenges tabs' only source. Those two tabs
     don't need the admin key at all.
   - /api/admin/* (adminFetch) — real backend data for Dashboard,
     System, and Bots. Every call needs the admin key; a 401 throws
     AdminAuthError so callers can show a clean "enter your key" state
     instead of crashing or rendering garbage.

   Anything the backend genuinely can't know yet (streak distribution —
   lives in each player's own localStorage; share-card copy counts —
   no analytics event exists for that button) stays an honest "—"
   placeholder here rather than a fabricated number — see CLAUDE.md's
   no-fake-numbers lesson.
===================================================== */

function pad2(n) {
  return String(n).padStart(2, "0");
}
function dateKeyFromDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function shiftDateKey(key, deltaDays) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  return dateKeyFromDate(dt);
}
function prettyDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// The Calendar/Challenges tabs' grid and "today" concept stay local-date
// (unchanged from Phase 1 — out of scope this session). Real-data calls
// below need the UTC day instead, since that's how the server keys
// everything (answers/results/config) — a local-date mismatch here
// would point stats/actions at the wrong day for an admin outside UTC.
function utcTodayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/* ---------- admin key + gated fetch ---------- */
const ADMIN_KEY_STORAGE = "og_admin_key";

class AdminAuthError extends Error {}

function getAdminKey() {
  return localStorage.getItem(ADMIN_KEY_STORAGE) || "";
}
function setAdminKey(key) {
  localStorage.setItem(ADMIN_KEY_STORAGE, key);
}
function clearAdminKey() {
  localStorage.removeItem(ADMIN_KEY_STORAGE);
}

async function adminFetch(path, opts) {
  opts = opts || {};
  const headers = Object.assign({ "X-Admin-Key": getAdminKey() }, opts.headers);
  if (opts.body) headers["Content-Type"] = "application/json";
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  if (res.status === 401) {
    // The stored key is wrong (or was never set) — clear it so the next
    // prompt starts clean instead of silently retrying the same bad key.
    clearAdminKey();
    throw new AdminAuthError("unauthorized");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `request failed: ${res.status}`);
  return body;
}

/* ---------- dashboard: real stats ---------- */
async function getTodayStats() {
  const [challenges, stats] = await Promise.all([getAllChallenges(), adminFetch("/api/admin/stats")]);
  const todayChallenge = challenges[stats.today] || null;

  return {
    todayChallenge,
    challengeNumber: todayChallenge ? todayChallenge.number : null,
    formatIcon: todayChallenge ? FORMATS[todayChallenge.format].icon : null,
    formatLabel: todayChallenge ? FORMATS[todayChallenge.format].label : null,
    realPlayers: stats.realCount,
    bots: stats.botsProjected,
    botsNote: "auto-retiring toward the configured floor",
    submissionsTotal: stats.submissionsTotal,
    newPlayersToday: stats.newPlayers,
    returningToday: stats.returning,
    d1RetentionPct: stats.d1RetentionPct, // null when yesterday had no players to measure retention against
    todayClosed: stats.todayClosed,
    cron: stats.cron
      ? {
          ok: stats.cron.ok,
          label: stats.cron.ok
            ? `Cron OK · ${new Date(stats.cron.ranAt).toISOString().slice(11, 19)} UTC`
            : `Cron FAILED · ${stats.cron.error || "see System tab"}`,
        }
      : { ok: false, label: "No cron runs yet" },
  };
}

async function getDailyPlayers30d() {
  const stats = await adminFetch("/api/admin/stats");
  const days = stats.dailyTotals.map((d) => d.count);
  const bestDay = Math.max(0, ...days);
  return { days, bestDay, note: "Real players only (excludes bot blending)." };
}

// Streaks live entirely in each player's own browser (og_streak in
// localStorage) — the backend never sees them, so there's no honest
// number to show here. Kept as an async function so renderStreaks()
// doesn't need to know this differs from every other card.
async function getStreaks() {
  return null; // signals "untrackable" to admin.js's renderer
}

async function getYesterdayRecap() {
  const challenges = await getAllChallenges();
  const today = utcTodayKey();
  const yesterday = shiftUtcDay(today, -1);
  const challenge = challenges[yesterday];
  if (!challenge) return { unavailable: true, reason: "No challenge was scheduled yesterday." };

  let blob;
  try {
    // Same public endpoint the game itself reads — already real,
    // already safe to show (yesterday is closed), no admin key needed.
    const res = await fetch(`/api/results/${yesterday}`);
    if (res.status === 404) return { unavailable: true, reason: "Cron hasn't tallied yesterday yet." };
    if (!res.ok) return { unavailable: true, reason: "Couldn't load yesterday's results." };
    blob = await res.json();
  } catch (err) {
    return { unavailable: true, reason: "Couldn't load yesterday's results." };
  }

  const fmt = FORMATS[challenge.format];
  const base = { number: challenge.number, formatIcon: fmt.icon, formatLabel: fmt.label, playerCount: blob.players, roast: blob.roast };

  if (challenge.format === "oddonein") {
    return Object.assign(base, {
      kind: "bars",
      bars: challenge.options.map((o, i) => ({ label: o.label, pct: blob.crowd[i], winner: blob.winIndexes.includes(i) })),
    });
  }
  if (challenge.format === "splitsteal") {
    return Object.assign(base, {
      kind: "bars",
      bars: [
        { label: "SPLIT", pct: blob.crowd[0] },
        { label: "STEAL", pct: blob.crowd[1] },
      ],
    });
  }
  // crunch / herdmeter: 20 numeric buckets don't fit the admin's
  // labeled-hbar layout (that's the game's own chart component's job)
  // — a compact summary line says just as much for a QA glance.
  return Object.assign(base, {
    kind: "summary",
    summary: `Average: <b>${blob.avg}</b> · Target: <b>${blob.target}</b> · Peak cluster: <b>${blob.peakLabel}</b> (${blob.peakPct}%)`,
  });
}

// Never shown by default — the spoiler shield gates this. See
// CLAUDE.md golden rule 2: distributions stay hidden until the day is
// over, even from the admin, unless they explicitly forfeit today.
async function getTodayLiveDistribution() {
  const today = utcTodayKey();
  const blob = await adminFetch(`/api/admin/live/${today}`);
  return { buckets: blob.crowd };
}

function shiftUtcDay(key, deltaDays) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/* ---------- System tab ---------- */
async function getCronRuns() {
  return adminFetch("/api/admin/cron");
}
async function retallyDay(dateKey) {
  return adminFetch(`/api/admin/retally/${dateKey}`, { method: "POST" });
}
async function closeToday() {
  return adminFetch("/api/admin/close-today", { method: "POST" });
}

/* ---------- Bots tab ---------- */
async function getBotConfig() {
  return adminFetch("/api/admin/config");
}
async function setBotConfig(patch) {
  return adminFetch("/api/admin/config", { method: "POST", body: JSON.stringify(patch) });
}

/* ---------- challenges (backed by challenges.json today, D1 in Phase 2) ----------
   Fetched once and cached in memory so calendar edits made this session
   are reflected immediately without a real write API to persist them to.
   Until Phase 2 ships a real write endpoint, "Export challenges.json"
   below is the escape hatch that turns in-memory edits into something
   you can actually commit. */
let _challengesCache = null;
let _hasUnexportedChanges = false;

async function getAllChallenges() {
  if (!_challengesCache) {
    const res = await fetch("../challenges.json");
    _challengesCache = await res.json();
  }
  return _challengesCache;
}

async function saveChallenge(dateKey, data) {
  const challenges = await getAllChallenges();
  challenges[dateKey] = data;
  _hasUnexportedChanges = true;
  return challenges[dateKey];
}

async function deleteChallenge(dateKey) {
  const challenges = await getAllChallenges();
  delete challenges[dateKey];
  _hasUnexportedChanges = true;
  return true;
}

function hasUnexportedChanges() {
  return _hasUnexportedChanges;
}

async function exportChallengesJson() {
  const challenges = await getAllChallenges();
  const sorted = {};
  Object.keys(challenges)
    .sort()
    .forEach((k) => (sorted[k] = challenges[k]));
  const json = JSON.stringify(sorted, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "challenges.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  _hasUnexportedChanges = false;
}

window.addEventListener("beforeunload", (e) => {
  if (!_hasUnexportedChanges) return;
  e.preventDefault();
  e.returnValue = "";
});

async function getRunwayDays() {
  const challenges = await getAllChallenges();
  let key = dateKeyFromDate(new Date());
  let days = 0;
  while (challenges[key]) {
    days++;
    key = shiftDateKey(key, 1);
  }
  const lastScheduledDate = days > 0 ? shiftDateKey(key, -1) : null;
  return { days, lastScheduledDate };
}
