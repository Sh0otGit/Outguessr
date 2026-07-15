/* =====================================================
   OUTGUESSR — Phase 1 game, now wired to the Phase 2 backend.

   The backend submit is fire-and-forget: play always continues on the
   simulated data path (formats.js resolve() + reveal.js verdict), the
   POST to /api/submit is a best-effort side channel that never blocks
   or changes what a player sees. See CLAUDE.md's "The day is UTC" rule.
===================================================== */
const $ = (id) => document.getElementById(id);

const KEYS = {
  playerId: "og_player_id",
  streak: "og_streak",
  lastPlayed: "og_last_played",
  points: "og_points",
  history: "og_history",
  pendingSubmit: "og_pending_submit",
};

/* ---------- date helpers (UTC day — see CLAUDE.md "The day is UTC") ----------
   Was local-date through Phase 1; switched to match the backend, which
   validates submissions against the UTC calendar day. All date-key
   construction below stays in UTC space end to end (Date.UTC in,
   getUTC* out) — mixing in the local Date constructor anywhere here
   would silently shift the key by a day for players outside UTC. */
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
function loadState() {
  let playerId = localStorage.getItem(KEYS.playerId);
  if (!playerId) {
    playerId = uid();
    localStorage.setItem(KEYS.playerId, playerId);
  }
  return {
    playerId,
    streak: parseInt(localStorage.getItem(KEYS.streak) || "0", 10),
    lastPlayed: localStorage.getItem(KEYS.lastPlayed) || null,
    points: parseInt(localStorage.getItem(KEYS.points) || "0", 10),
    history: JSON.parse(localStorage.getItem(KEYS.history) || "{}"),
  };
}
function saveState(state) {
  localStorage.setItem(KEYS.streak, String(state.streak));
  localStorage.setItem(KEYS.lastPlayed, state.lastPlayed || "");
  localStorage.setItem(KEYS.points, String(state.points));
  localStorage.setItem(KEYS.history, JSON.stringify(state.history));
}
// Computed once, before mutation, so both the payout calc (streak
// multiplier) and the actual state update agree on the same number.
function computeNextStreak(state, dateKey) {
  const yesterday = shiftDateKey(dateKey, -1);
  if (state.lastPlayed === yesterday) return state.streak + 1;
  if (state.lastPlayed !== dateKey) return 1;
  return state.streak;
}
function recordPlay(state, dateKey, entry, nextStreak) {
  state.streak = nextStreak;
  state.lastPlayed = dateKey;
  state.points += entry.verdict.amount;
  state.history[dateKey] = entry;
  saveState(state);
}

/* ---------- pick a challenge for the current UTC day ---------- */
function resolveChallengeKey(challenges, key) {
  if (challenges[key]) return key;
  const past = Object.keys(challenges).filter((k) => k <= key).sort();
  if (past.length) return past[past.length - 1];
  return Object.keys(challenges).sort()[0];
}

/* ---------- history migration (schema repairs) ----------
   og_history is a persistence schema (see CLAUDE.md golden rules) —
   any change to what lockIn() stores must repair old entries here in
   the same commit. This one targets entries written before the tier
   redesign: {format, pick, result:<old shape>} with no verdict and no
   result.chart, which crash Reveal.render (verdict.tierKey on
   undefined). Display repair only — never re-awards points, since the
   player already banked whatever the old entry paid out at the time.

   The local→UTC day-key switch in this same commit does NOT need a
   destructive migration here: every entry is (and always was) keyed by
   whatever resolveChallengeKey() resolved to, which is always a real
   challenges.json date regardless of which clock computed "today." An
   entry keyed by a date that no longer matches "today" under the new
   UTC basis isn't broken — it's just history now, exactly as it would
   be the day after any other calendar rollover. Nothing to repair or
   delete. The one accepted, undoable consequence: a streak computed
   right at the transition may read as reset for players near a
   timezone boundary, since state.lastPlayed was recorded under the
   old local-date basis and there's no way to recover which UTC day
   that corresponded to after the fact. */
function migrateHistory(state) {
  let changed = false;
  Object.keys(state.history).forEach((dateKey) => {
    const entry = state.history[dateKey];
    const broken = !entry.verdict || !entry.result || !entry.result.chart;
    if (!broken) return;

    const challenge = challenges[dateKey];
    const fmt = FORMATS[entry.format];
    if (challenge && fmt && entry.pick !== undefined && entry.pick !== null) {
      const result = fmt.resolve(challenge, entry.pick);
      const verdict = Reveal.computeVerdict(result.topPct, 0);
      state.history[dateKey] = { format: entry.format, pick: entry.pick, result, verdict };
    } else {
      delete state.history[dateKey];
    }
    changed = true;
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

/* ---------- backend submit (fire-and-forget, never blocks play) ----------
   Attempt once; on any failure (network error or non-ok response), wait
   5s and try exactly one more time; if that also fails, queue the
   payload in localStorage and let the next page load retry it. The
   simulated-data game flow (formats.js resolve, recordPlay, the reveal)
   already ran and saved before this is ever called — nothing here can
   change what the player sees, win or lose. */
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

/* ---------- app state ----------
   FORMATS registry lives in formats.js, tier/payout pipeline in reveal.js
   (both shared with the admin panel / reused across the design system). */
let state, challenges, activeKey, activeChallenge, currentPick;

async function init() {
  state = loadState();
  updateHeader();
  renderCountdown();
  setInterval(renderCountdown, 30000);

  try {
    const res = await fetch("challenges.json");
    challenges = await res.json();
  } catch (err) {
    $("challenge-mount").innerHTML = `
      <div class="card">
        <div class="prompt">Couldn't load today's challenge.</div>
        <div class="subprompt">If you're running this locally, serve the folder with a local web server (fetch of challenges.json needs http://, not file://).</div>
      </div>`;
    return;
  }

  migrateHistory(state);

  const pending = loadPendingSubmit();
  if (pending) submitToBackend(pending.day, pending.playerId, pending.answer);

  activeKey = resolveChallengeKey(challenges, todayKey());
  activeChallenge = challenges[activeKey];

  $("daynum").textContent = `DAILY #${activeChallenge.number} · ${prettyDate(activeKey)}`;

  renderHomeArea();
  show("screen-home");

  $("backFromReveal").onclick = goHome;
  $("tryAgainBtn").onclick = goHome;
  $("copyBtn").onclick = copyShare;
}

function updateHeader() {
  $("streak").textContent = state.streak;
  $("brainpts").textContent = state.points.toLocaleString();
}

function renderCountdown() {
  const now = new Date();
  const nextUTCMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  const diffMins = Math.max(0, Math.floor((nextUTCMidnight - now.getTime()) / 60000));
  const text = `${Math.floor(diffMins / 60)}h ${diffMins % 60}m`;
  $("cd").textContent = text;
  const slipCd = document.getElementById("slip-cd");
  if (slipCd) slipCd.textContent = text;
}

function show(id) {
  ["screen-home", "screen-reveal"].forEach((s) => $(s).classList.add("hidden"));
  $(id).classList.remove("hidden");
  window.scrollTo({ top: 0 });
}

// GET /api/count is safe to expose (submission count, never the shape
// of answers — golden rule 2). Fails silently: if it errors, the line
// just never appears, no different from a slow/offline connection.
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
  const mount = $("challenge-mount");
  const entry = state.history[activeKey];
  const fmt = FORMATS[activeChallenge.format];

  // Already played: the card stays put but its body becomes a "betting
  // slip" — full prompt still visible, pick shown as a ticket stub under
  // a one-time LOCKED stamp, so returning later shows exactly what
  // challenge this was before jumping into the reveal.
  const bodyHtml = entry
    ? `
      <div class="betting-slip">
        <div class="stamp">Locked</div>
        <div class="ticket-stub">
          <span class="stub-label">Your ticket</span>
          <span class="stub-pick">${fmt.pickLabel(entry.pick, activeChallenge)}</span>
        </div>
        <div class="factoid">${activeChallenge.factoid || "Come back tomorrow for a new dilemma."}</div>
        <div class="slip-countdown">Full crowd reveals in <b id="slip-cd">—</b> — or peek now below.</div>
        <button class="btn" id="viewRevealBtn">See your reveal</button>
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
    $("viewRevealBtn").onclick = () => showReveal(entry);
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
  const fmt = FORMATS[activeChallenge.format];
  const result = fmt.resolve(activeChallenge, currentPick);
  const nextStreak = computeNextStreak(state, activeKey);
  const verdict = Reveal.computeVerdict(result.topPct, nextStreak);
  const entry = { format: activeChallenge.format, pick: currentPick, result, verdict };
  recordPlay(state, activeKey, entry, nextStreak);
  updateHeader();

  // Only the real, currently-open UTC day is ever worth sending — a
  // stale fallback day (content missing for today) would just bounce
  // off the backend's "day is not open" check forever and sit in the
  // retry queue for nothing.
  if (activeKey === todayKey()) {
    submitToBackend(activeKey, state.playerId, currentPick);
  }

  renderHomeArea();
}

async function showReveal(entry) {
  // migrateHistory() repairs every entry it can at load time, but this
  // stays as a backstop — a bad entry should never take down the app,
  // it should just fail to open and say so.
  try {
    const fmt = FORMATS[entry.format];
    if (!fmt || !entry.verdict || !entry.result || !entry.result.chart) {
      throw new Error("unrenderable history entry");
    }
    await Reveal.render($("reveal-mount"), entry.result, entry.verdict, {
      viewerLabel: "YOU",
      dayNumber: activeChallenge.number,
      formatIcon: fmt.icon,
      formatLabel: fmt.label,
    });
    const shareText = Reveal.shareCard(entry.verdict, entry.result, {
      number: activeChallenge.number,
      icon: fmt.icon,
      streak: state.streak,
    });
    $("sharecard").textContent = shareText;
    $("copied").textContent = "";
    show("screen-reveal");
  } catch (err) {
    toast("Couldn't load that reveal — sorry about that.");
  }
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
}

document.addEventListener("DOMContentLoaded", init);
