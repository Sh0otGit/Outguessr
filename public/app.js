/* =====================================================
   OUTGUESSR — the real-data game.

   Lock-in no longer computes a verdict or awards points — it just
   records the pick (plus the fire-and-forget POST /api/submit) and
   updates the streak. Payoff happens later, once the day has actually
   closed and the backend has real crowd data: automatically for
   yesterday on next load ("payoff-then-hook"), or on demand for older
   entries from the History screen. See CLAUDE.md's "og_history is a
   persistence schema" golden rule and Phase 2 architecture section.

   USE_SIMULATED (default false) keeps the OLD instant-simulated-reveal
   flow fully wired but dormant, for the admin preview and any future
   practice mode — see formats.js's resolve() (kept) vs resolveReal()
   (new).
===================================================== */
const $ = (id) => document.getElementById(id);

const USE_SIMULATED = false;

const KEYS = {
  playerId: "og_player_id",
  streak: "og_streak",
  lastPlayed: "og_last_played",
  points: "og_points",
  history: "og_history",
  pendingSubmit: "og_pending_submit",
};

/* ---------- date helpers (UTC day — see CLAUDE.md "The day is UTC") ---------- */
function pad2(n) {
  return String(n).padStart(2, "0");
}
function dateKeyFromDate(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
function todayKey() {
  return dateKeyFromDate(new Date());
}
function shiftDateKey(key, deltaDays) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dateKeyFromDate(dt);
}
function prettyDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d))
    .toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    .toUpperCase();
}

/* ---------- localStorage state ---------- */
function uid() {
  return "p_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
// Guards against a corrupted numeric field (garbage string, not just a
// missing key) resolving to NaN and silently poisoning every downstream
// calculation (streak math, points totals, the header display).
function safeInt(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}
function loadState() {
  let playerId = localStorage.getItem(KEYS.playerId);
  if (!playerId) {
    playerId = uid();
    localStorage.setItem(KEYS.playerId, playerId);
  }
  // og_history is a persistence schema (golden rule 7) but it's still
  // just a string in localStorage — a corrupted value (quota eviction
  // mid-write, manual tampering, a bug in an old version) must not throw
  // here, since this runs synchronously in init() with nothing catching
  // it: one bad key would otherwise permanently brick the whole app for
  // that player until they manually clear storage. Falling back to {}
  // is the same "delete what can't be repaired" spirit migrateHistory
  // already uses for individual entries.
  let history;
  try {
    history = JSON.parse(localStorage.getItem(KEYS.history) || "{}");
  } catch (err) {
    history = {};
  }
  return {
    playerId,
    streak: safeInt(localStorage.getItem(KEYS.streak), 0),
    lastPlayed: localStorage.getItem(KEYS.lastPlayed) || null,
    points: safeInt(localStorage.getItem(KEYS.points), 0),
    history,
  };
}
function saveState(state) {
  localStorage.setItem(KEYS.streak, String(state.streak));
  localStorage.setItem(KEYS.lastPlayed, state.lastPlayed || "");
  localStorage.setItem(KEYS.points, String(state.points));
  localStorage.setItem(KEYS.history, JSON.stringify(state.history));
}
// Computed once, before mutation, so callers agree on the same number.
function computeNextStreak(state, dateKey) {
  const yesterday = shiftDateKey(dateKey, -1);
  if (state.lastPlayed === yesterday) return state.streak + 1;
  if (state.lastPlayed !== dateKey) return 1;
  return state.streak;
}
// Real-data path: playing = streak, full stop. No points yet — those
// only exist once a day pays off (recordPayoff, below).
function recordLockIn(state, dateKey, entry, nextStreak) {
  state.streak = nextStreak;
  state.lastPlayed = dateKey;
  state.history[dateKey] = entry;
  saveState(state);
}
// USE_SIMULATED legacy path only: verdict (and its points) exist the
// instant you lock in, same as every Phase 1 session before this one.
function recordPlay(state, dateKey, entry, nextStreak) {
  state.streak = nextStreak;
  state.lastPlayed = dateKey;
  state.points += entry.verdict.amount;
  state.history[dateKey] = entry;
  saveState(state);
}

/* ---------- per-day challenge fetch (never a bulk file) ----------
   challenges.json no longer ships to the browser at all — crowd/target/
   roast are cheat-relevant secrets (see CLAUDE.md's challenge-data
   privacy rule), so the client only ever gets one day's *safe* fields
   at a time from GET /api/challenge/:day, fetched and cached per day as
   it's actually needed (today, yesterday's payoff, History entries) —
   never the whole deck up front. null means "no challenge that day or
   the fetch failed," cached the same as a real result so a bad day
   doesn't get re-requested every render. */
const challengeCache = {};
async function getChallenge(dateKey) {
  if (dateKey in challengeCache) return challengeCache[dateKey];
  try {
    const res = await fetch(`/api/challenge/${dateKey}`);
    challengeCache[dateKey] = res.ok ? await res.json() : null;
  } catch (err) {
    challengeCache[dateKey] = null;
  }
  return challengeCache[dateKey];
}

/* ---------- history migration (schema repairs) ----------
   og_history is a persistence schema (see CLAUDE.md golden rules) —
   any change to what lockIn() stores must repair old entries here in
   the same commit.

   One repair lives here now:

   Every entry that already has a full verdict+result already had its
   points awarded under the old instant-simulated model. Under the
   payoff-then-hook / reveal-on-demand model, "does this entry have a
   verdict yet" is no longer a safe signal for "has this been paid out"
   — a pending real-flow entry legitimately has no verdict either, until
   its day closes. So every already-verdicted entry gets stamped
   viewed:true, which IS the authoritative "already paid out" signal
   going forward. Brand-new pending entries (format, pick, submittedAt,
   no verdict) are recognized by having submittedAt and are left alone.

   Entries broken in some OTHER way (predating even the tier redesign,
   with neither a verdict nor submittedAt) used to be repairable via the
   simulated fmt.resolve() path, which needed challenge.crowd/target —
   both are server-only secrets now, not fetchable client-side at all.
   Any real returning player would already have been repaired-or-deleted
   by this same check on their first load after the tier redesign
   shipped, long before challenge data was locked down — this just
   closes out anything too old to be worth chasing. */
function migrateHistory(state) {
  let changed = false;
  Object.keys(state.history).forEach((dateKey) => {
    const entry = state.history[dateKey];
    const broken = !entry.verdict || !entry.result || !entry.result.chart;

    if (broken) {
      if (entry.submittedAt === undefined) {
        delete state.history[dateKey];
        changed = true;
      }
      return;
    }

    if (!entry.viewed) {
      entry.viewed = true;
      changed = true;
    }
  });
  if (changed) saveState(state);
}

/* ---------- toast ---------- */
let toastTimer;
function toast(msg) {
  const t = $("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

/* ---------- backend submit (fire-and-forget, never blocks play) ---------- */
function loadPendingSubmit() {
  try {
    return JSON.parse(localStorage.getItem(KEYS.pendingSubmit) || "null");
  } catch (err) {
    return null;
  }
}
function savePendingSubmit(payload) {
  localStorage.setItem(KEYS.pendingSubmit, JSON.stringify(payload));
}
function clearPendingSubmit() {
  localStorage.removeItem(KEYS.pendingSubmit);
}

function postSubmit(payload) {
  return fetch("/api/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then((res) => {
    if (!res.ok) throw new Error("submit failed: " + res.status);
    return res;
  });
}

function submitToBackend(day, playerId, answer) {
  const payload = { day, playerId, answer };
  postSubmit(payload)
    .then(() => clearPendingSubmit())
    .catch(() => {
      setTimeout(() => {
        postSubmit(payload)
          .then(() => clearPendingSubmit())
          .catch(() => savePendingSubmit(payload));
      }, 5000);
    });
}

/* ---------- app state ---------- */
let state, activeKey, activeChallenge, currentPick;
// Set by showReveal() whenever a reveal is actually on screen — copyShare()
// needs to know which day's share card it's copying, since the button
// itself carries no date. Fire-and-forget only (no retry/queue like
// submit): a missed share ping just undercounts a vanity admin tile,
// never anything a player-facing flow depends on.
let revealedDayKey = null;

function postShare(day, playerId) {
  fetch("/api/share", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ day, playerId }),
  }).catch(() => {});
}

function renderNoChallengeCard() {
  $("challenge-mount").innerHTML = `
    <div class="card">
      <div class="prompt">Couldn't load today's challenge.</div>
      <div class="subprompt">If you're running this locally, serve the folder with a local web server — fetch needs http://, not file://. Otherwise, check your connection and try refreshing.</div>
    </div>`;
}

async function init() {
  state = loadState();
  updateHeader();
  renderCountdown();
  setInterval(renderCountdown, 30000);

  migrateHistory(state);

  // A pending submit is only ever worth retrying while its day is still
  // the open one — once the UTC day rolls over, the backend will reject
  // it with "day is not open" forever, submitToBackend()'s own retry
  // would fail identically, and the failure handler would just re-save
  // the same doomed payload — a permanent, silently-repeating no-op on
  // every future page load. A stale pending entry is simply discarded;
  // the pick itself is still safe in state.history regardless.
  const pending = loadPendingSubmit();
  if (pending) {
    if (pending.day === todayKey()) {
      submitToBackend(pending.day, pending.playerId, pending.answer);
    } else {
      clearPendingSubmit();
    }
  }

  $("backFromReveal").onclick = goHome;
  $("tryAgainBtn").onclick = goHome;
  $("copyBtn").onclick = copyShare;
  $("historyBtn").onclick = openHistory;
  $("backFromHistory").onclick = goHome;

  // Payoff-then-hook: yesterday's un-viewed entry (if any) gets the full
  // ceremony BEFORE today's challenge is ever shown — see CLAUDE.md.
  // Anything older than yesterday that's still unviewed waits for the
  // player to open it from History (task 3's "on demand"). Runs before
  // today's own challenge resolves so a broken/missing today doesn't
  // block a player from still seeing yesterday's payoff.
  let showedPayoff = false;
  if (!USE_SIMULATED) {
    const yesterdayKey = shiftDateKey(todayKey(), -1);
    const yEntry = state.history[yesterdayKey];
    if (yEntry && !yEntry.viewed) {
      showedPayoff = await revealEntry(yesterdayKey, yEntry);
    }
  }

  activeKey = todayKey();
  activeChallenge = await getChallenge(activeKey);

  if (!activeChallenge) {
    if (!showedPayoff) {
      renderNoChallengeCard();
      show("screen-home");
    }
    return;
  }

  $("daynum").textContent = `DAILY #${activeChallenge.number} · ${prettyDate(activeKey)}`;

  if (!showedPayoff) {
    renderHomeArea();
    show("screen-home");
  }
}

function updateHeader() {
  $("streak").textContent = state.streak;
  $("brainpts").textContent = state.points.toLocaleString();
}

// Set once a stale-day toast has fired, so a tab left open past the UTC
// rollover doesn't get nagged every 30s — lockIn() has its own hard
// guard for the case that actually matters (submitting), this is just an
// early, passive heads-up for someone staring at an already-stale page.
let _staleDayWarned = false;
function renderCountdown() {
  const now = new Date();
  const nextUTCMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  const diffMins = Math.max(0, Math.floor((nextUTCMidnight - now.getTime()) / 60000));
  const text = `${Math.floor(diffMins / 60)}h ${diffMins % 60}m`;
  $("cd").textContent = text;
  const slipCd = document.getElementById("slip-cd");
  if (slipCd) slipCd.textContent = text;

  if (activeKey && !_staleDayWarned && activeKey !== todayKey()) {
    _staleDayWarned = true;
    toast("A new day has started — refresh to see today's challenge.");
  }
}

function show(id) {
  ["screen-home", "screen-reveal", "screen-history"].forEach((s) => $(s).classList.add("hidden"));
  $(id).classList.remove("hidden");
  window.scrollTo({ top: 0 });
}

// GET /api/count is safe to expose (submission count, never the shape
// of answers — golden rule 2). Fails silently.
async function renderLiveCount() {
  const el = document.getElementById("live-count");
  if (!el || activeKey !== todayKey()) return;
  try {
    const res = await fetch(`/api/count/${activeKey}`);
    if (!res.ok) return;
    const data = await res.json();
    if (typeof data.count === "number" && data.count > 0) {
      el.textContent = `🔒 ${data.count.toLocaleString()} players locked in so far`;
    }
  } catch (err) {
    // fail silent
  }
}

function renderHomeArea() {
  if (!activeChallenge) {
    renderNoChallengeCard();
    return;
  }
  const mount = $("challenge-mount");
  const entry = state.history[activeKey];
  const fmt = FORMATS[activeChallenge.format];
  // The real-data flow never reveals the current day's own pick — the
  // day isn't closed yet, there's nothing real to show. USE_SIMULATED's
  // legacy path is the only case where an instant peek makes sense
  // (there's no "closed" concept for simulated data).
  const canReveal = USE_SIMULATED && entry;

  const bodyHtml = entry
    ? `
      <div class="betting-slip">
        <div class="stamp">Locked</div>
        <div class="ticket-stub">
          <span class="stub-label">Your ticket</span>
          <span class="stub-pick">${fmt.pickLabel(entry.pick, activeChallenge)}</span>
        </div>
        <div class="factoid">${activeChallenge.factoid || "Come back tomorrow for a new dilemma."}</div>
        <div class="slip-countdown">Full crowd reveals in <b id="slip-cd">—</b>.</div>
        ${canReveal ? `<button class="btn" id="viewRevealBtn">See your reveal</button>` : ""}
      </div>`
    : `
      <div id="input-zone"></div>
      <button class="btn" id="lockbtn" disabled>Lock it in 🔒</button>`;

  mount.innerHTML = `
    <div class="card">
      <span class="mode-tag">${fmt.icon} ${fmt.label} · TODAY</span>
      <div class="prompt">${activeChallenge.prompt}</div>
      <div class="subprompt">${activeChallenge.sub}</div>
      <div class="live-count" id="live-count"></div>
      ${bodyHtml}
    </div>`;

  renderLiveCount();

  if (entry) {
    renderCountdown();
    if (canReveal) $("viewRevealBtn").onclick = () => revealEntry(activeKey, entry);
    return;
  }

  currentPick = null;
  fmt.buildInput($("input-zone"), activeChallenge, (pick) => {
    currentPick = pick;
    $("lockbtn").disabled = false;
  });
  $("lockbtn").onclick = lockIn;
}

function lockIn() {
  if (currentPick === null) return;

  // activeKey/activeChallenge were fetched once at init() and never
  // rechecked — a tab left open across the UTC day rollover would still
  // be showing yesterday's (now-closed) prompt. Locking in against it
  // would both record the pick under the wrong date key locally AND
  // silently skip the backend submit (the day-mismatch check the old
  // version of this function had here) with no error shown anywhere —
  // exactly the "why does the admin panel say 0 players" bug this was
  // built to catch. Refuse and reload into the real current day instead
  // of recording anything under a stale key.
  if (activeKey !== todayKey()) {
    toast("A new day has started — refreshing…");
    setTimeout(() => location.reload(), 1200);
    return;
  }

  const nextStreak = computeNextStreak(state, activeKey);

  if (USE_SIMULATED) {
    const fmt = FORMATS[activeChallenge.format];
    const result = fmt.resolve(activeChallenge, currentPick);
    const verdict = Reveal.computeVerdict(result.topPct, nextStreak);
    const entry = { format: activeChallenge.format, pick: currentPick, result, verdict, viewed: true };
    recordPlay(state, activeKey, entry, nextStreak);
  } else {
    const entry = { format: activeChallenge.format, pick: currentPick, submittedAt: Date.now() };
    recordLockIn(state, activeKey, entry, nextStreak);
  }
  updateHeader();

  submitToBackend(activeKey, state.playerId, currentPick);

  renderHomeArea();
}

/* ---------- reveal on demand / payoff ----------
   The single entry point for turning a locked-in pick into a shown
   reveal, whether that's:
     - an already-viewed entry (just re-show the cached result), or
     - a real-data payoff (fetch real results, score the pick, award
       points, cache the result into the entry, mark it viewed), or
     - USE_SIMULATED's entries, which are always already "viewed".
   Returns true if a reveal was actually shown, false if it no-op'd
   (missing challenge, results not computed yet, or a fetch error) —
   callers use this to know whether to fall through to something else
   (init()'s payoff-hook falls through to showing today's challenge). */
// Days currently mid-payoff — a rapid double-click/tap on the same
// History row (or a slow network response combined with an impatient
// second tap) would otherwise start two overlapping calls that both pass
// the "not viewed yet" check below, both fetch, and both add
// verdict.amount to state.points: a real double-award bug, not just a
// cosmetic double-render.
const _revealingDays = new Set();

async function revealEntry(dateKey, entry) {
  if (entry.viewed && entry.verdict && entry.result) {
    await showReveal(dateKey, entry);
    return true;
  }

  if (_revealingDays.has(dateKey)) return false;
  _revealingDays.add(dateKey);
  try {
    return await payOffEntry(dateKey, entry);
  } finally {
    _revealingDays.delete(dateKey);
  }
}

async function payOffEntry(dateKey, entry) {
  const challenge = await getChallenge(dateKey);
  const fmt = challenge ? FORMATS[entry.format] : null;
  if (!challenge || !fmt || !fmt.resolveReal) return false;

  let blob;
  try {
    const res = await fetch(`/api/results/${dateKey}?playerId=${encodeURIComponent(state.playerId)}`);
    if (res.status === 404) {
      toast("Results still cooking — check back soon.");
      return false;
    }
    if (!res.ok) throw new Error("results fetch failed: " + res.status);
    blob = await res.json();
  } catch (err) {
    toast("Couldn't load results — check back soon.");
    return false;
  }

  const result = fmt.resolveReal(challenge, entry.pick, blob);
  const verdict = Reveal.computeVerdict(result.topPct, state.streak);

  entry.result = result;
  entry.verdict = verdict;
  entry.viewed = true;
  entry.playerCount = blob.players;
  state.points += verdict.amount;
  state.history[dateKey] = entry;
  saveState(state);
  updateHeader();

  await showReveal(dateKey, entry);
  return true;
}

async function showReveal(dateKey, entry) {
  // revealEntry() only ever calls this with a fully-resolved entry, but
  // this stays as a backstop — a bad entry should never take down the
  // app, it should just fail to open and say so.
  try {
    const fmt = FORMATS[entry.format];
    const challenge = await getChallenge(dateKey);
    if (!fmt || !challenge || !entry.verdict || !entry.result || !entry.result.chart) {
      throw new Error("unrenderable history entry");
    }
    await Reveal.render($("reveal-mount"), entry.result, entry.verdict, {
      viewerLabel: "YOU",
      dayNumber: challenge.number,
      formatIcon: fmt.icon,
      formatLabel: fmt.label,
      playerCount: entry.playerCount,
    });
    const shareText = Reveal.shareCard(entry.verdict, entry.result, {
      number: challenge.number,
      icon: fmt.icon,
      streak: state.streak,
    });
    $("sharecard").textContent = shareText;
    $("copied").textContent = "";
    revealedDayKey = dateKey;
    show("screen-reveal");
  } catch (err) {
    toast("Couldn't load that reveal — sorry about that.");
  }
}

/* ---------- history screen (task 3: reveal on demand) ---------- */
async function renderHistoryScreen() {
  const list = $("history-list");
  const days = Object.keys(state.history)
    .filter((k) => k !== todayKey())
    .sort()
    .reverse();

  if (!days.length) {
    list.innerHTML = `<div class="card"><div class="subprompt" style="margin:0">No past days yet — come back tomorrow.</div></div>`;
    return;
  }

  // One fetch-or-cache-hit per day, in parallel, before building any
  // HTML — each is a per-day network call now (no more bulk file to
  // read synchronously), so the list needs everything in hand first.
  const challengesByDay = {};
  await Promise.all(
    days.map(async (dateKey) => {
      challengesByDay[dateKey] = await getChallenge(dateKey);
    })
  );

  const rows = days
    .map((dateKey) => {
      const entry = state.history[dateKey];
      const challenge = challengesByDay[dateKey];
      const fmt = challenge ? FORMATS[entry.format] : null;
      const resolved = entry.viewed && entry.verdict;
      const status = resolved ? `Revealed · +${entry.verdict.amount} 🧠` : "Tap to reveal";
      return `<div class="history-row" data-day="${dateKey}">
        <span class="hr-fmt">${fmt ? fmt.icon : "❓"}</span>
        <span class="hr-date">${prettyDate(dateKey)}</span>
        <span class="hr-status${resolved ? "" : " pending"}">${status}</span>
      </div>`;
    })
    .join("");

  list.innerHTML = `<div class="history-card">${rows}</div>`;
  list.querySelectorAll(".history-row").forEach((row) => {
    const dateKey = row.dataset.day;
    row.onclick = () => revealEntry(dateKey, state.history[dateKey]);
  });
}

async function openHistory() {
  show("screen-history");
  $("history-list").innerHTML = `<div class="card"><div class="subprompt" style="margin:0">Loading…</div></div>`;
  await renderHistoryScreen();
}

function goHome() {
  Reveal.resetCeremony();
  renderHomeArea();
  show("screen-home");
}

function copyShare() {
  const txt = $("sharecard").textContent;
  if (navigator.clipboard) navigator.clipboard.writeText(txt).catch(() => {});
  $("copied").textContent = "Copied! Go start an argument in the group chat.";
  if (revealedDayKey) postShare(revealedDayKey, state.playerId);
}

document.addEventListener("DOMContentLoaded", init);
