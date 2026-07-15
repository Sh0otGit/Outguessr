/* =====================================================
   OUTGUESSR — Phase 1 (static, simulated crowd data)
===================================================== */
const $ = (id) => document.getElementById(id);

const KEYS = {
  playerId: "og_player_id",
  streak: "og_streak",
  lastPlayed: "og_last_played",
  points: "og_points",
  history: "og_history",
};

/* ---------- date helpers (player's local date) ---------- */
function pad2(n) {
  return String(n).padStart(2, "0");
}
function dateKeyFromDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function todayKey() {
  return dateKeyFromDate(new Date());
}
function shiftDateKey(key, deltaDays) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  return dateKeyFromDate(dt);
}
function prettyDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d)
    .toLocaleDateString("en-US", { month: "short", day: "numeric" })
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
function recordPlay(state, dateKey, entry) {
  const yesterday = shiftDateKey(dateKey, -1);
  if (state.lastPlayed === yesterday) state.streak += 1;
  else if (state.lastPlayed !== dateKey) state.streak = 1;
  state.lastPlayed = dateKey;
  state.points += entry.result.pts;
  state.history[dateKey] = entry;
  saveState(state);
}

/* ---------- pick a challenge for the player's local date ---------- */
function resolveChallengeKey(challenges, key) {
  if (challenges[key]) return key;
  const past = Object.keys(challenges).filter((k) => k <= key).sort();
  if (past.length) return past[past.length - 1];
  return Object.keys(challenges).sort()[0];
}

/* ---------- app state ----------
   FORMATS registry lives in formats.js (shared with the admin panel). */
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

  activeKey = resolveChallengeKey(challenges, todayKey());
  activeChallenge = challenges[activeKey];

  $("daynum").textContent = `DAILY #${activeChallenge.number} · ${prettyDate(activeKey)}`;

  renderHomeArea();
  show("screen-home");

  $("backFromSealed").onclick = goHome;
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
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  const diffMins = Math.max(0, Math.floor((next - now) / 60000));
  $("cd").textContent = `${Math.floor(diffMins / 60)}h ${diffMins % 60}m`;
}

function show(id) {
  ["screen-home", "screen-sealed", "screen-reveal"].forEach((s) => $(s).classList.add("hidden"));
  $(id).classList.remove("hidden");
  window.scrollTo({ top: 0 });
}

function renderHomeArea() {
  const mount = $("challenge-mount");
  const entry = state.history[activeKey];
  const fmt = FORMATS[activeChallenge.format];

  const bodyHtml = entry
    ? `
      <div class="locked-row">
        <span class="icon">🔒</span>
        <span class="txt">Locked in — you picked <b>${fmt.pickLabel(entry.pick, activeChallenge)}</b><span class="sub">Come back tomorrow for a new one.</span></span>
      </div>
      <button class="btn" id="viewRevealBtn">See your reveal</button>`
    : `
      <div id="input-zone"></div>
      <button class="btn" id="lockbtn" disabled>Lock it in 🔒</button>`;

  mount.innerHTML = `
    <div class="card">
      <span class="mode-tag">${fmt.icon} ${fmt.label} · TODAY</span>
      <div class="prompt">${activeChallenge.prompt}</div>
      <div class="subprompt">${activeChallenge.sub}</div>
      ${bodyHtml}
    </div>`;

  if (entry) {
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
  const entry = { format: activeChallenge.format, pick: currentPick, result };
  recordPlay(state, activeKey, entry);
  updateHeader();

  $("sealed-pick").textContent = "Your pick: " + fmt.pickLabel(currentPick, activeChallenge);
  $("sealed-factoid").innerHTML = activeChallenge.factoid || "";
  $("sealedViewReveal").onclick = () => showReveal(entry);
  show("screen-sealed");
}

function showReveal(entry) {
  const fmt = FORMATS[entry.format];
  Reveal.render($("reveal-mount"), entry.result, { viewerLabel: "YOU" });
  const shareText = Reveal.shareCard(entry.result, {
    number: activeChallenge.number,
    icon: fmt.icon,
    label: fmt.label,
    streak: state.streak,
  });
  $("sharecard").textContent = shareText;
  $("copied").textContent = "";
  show("screen-reveal");
}

function goHome() {
  renderHomeArea();
  show("screen-home");
}

function copyShare() {
  const txt = $("sharecard").textContent;
  if (navigator.clipboard) navigator.clipboard.writeText(txt).catch(() => {});
  $("copied").textContent = "Copied! Go start an argument in the group chat.";
}

document.addEventListener("DOMContentLoaded", init);
