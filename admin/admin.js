/* =====================================================
   admin.js — shell (nav, status bar) + Dashboard.
   All data comes from admin-api.js — nothing here computes
   stats itself, so swapping mock data for real fetch()
   calls later touches only that file.
===================================================== */
const $ = (id) => document.getElementById(id);

/* ---------- nav ---------- */
const NAV = [
  ["s-dash", "📊", "Dashboard"],
  ["s-cal", "🗓", "Calendar"],
  ["s-chal", "🃏", "Challenges"],
  ["s-bots", "🤖", "Bots"],
  ["s-players", "👥", "Players"],
  ["s-arena", "🎙", "Arena", "PHASE 3", true],
  ["s-system", "⚙️", "System"],
];

// Sections register a render callback here (keyed by section id), invoked
// each time their nav item is activated. Populated by that section's own
// script (e.g. admin-calendar.js), read here so admin.js doesn't need to
// know what other sections exist.
const SECTION_ACTIVATORS = {};

function buildNav() {
  const nav = $("nav");
  NAV.forEach(([id, icon, label, badge, disabled], i) => {
    const el = document.createElement("div");
    el.className = "navitem" + (i === 0 ? " active" : "") + (disabled ? " disabled" : "");
    el.innerHTML = icon + " " + label + (badge ? `<span class="badge">${badge}</span>` : "");
    if (!disabled) {
      el.onclick = () => {
        document.querySelectorAll(".navitem").forEach((n) => n.classList.remove("active"));
        el.classList.add("active");
        document.querySelectorAll("section").forEach((s) => s.classList.remove("active"));
        $(id).classList.add("active");
        if (SECTION_ACTIVATORS[id]) SECTION_ACTIVATORS[id]();
      };
    }
    nav.appendChild(el);
  });
}

/* ---------- modal (shared infra; calendar is the first consumer) ---------- */
function openModal(html) {
  $("modal").innerHTML = html;
  $("modal-overlay").classList.remove("hidden");
}
function closeModal() {
  $("modal-overlay").classList.add("hidden");
  $("modal").innerHTML = "";
}
document.addEventListener("DOMContentLoaded", () => {
  $("modal-overlay").addEventListener("click", (e) => {
    if (e.target.id === "modal-overlay") closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
});

/* ---------- toast ---------- */
let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

/* ---------- status bar ---------- */
function renderCountdown() {
  const now = new Date();
  const nextUTCMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  const diffMins = Math.max(0, Math.floor((nextUTCMidnight - now.getTime()) / 60000));
  $("sb-countdown").textContent = `${Math.floor(diffMins / 60)}h ${diffMins % 60}m`;
}

async function renderStatusBar() {
  const [today, runway] = await Promise.all([getTodayStats(), getRunwayDays()]);

  const sbToday = $("sb-today");
  if (today.todayChallenge) {
    sbToday.className = "sb-item";
    sbToday.innerHTML = `Today: <b>#${today.challengeNumber} · ${today.formatIcon} ${today.formatLabel}</b>`;
  } else {
    sbToday.className = "sb-item bad";
    sbToday.textContent = "NO CHALLENGE TODAY";
  }
  $("sb-submissions").innerHTML =
    `Submissions: <b>${today.submissionsTotal.toLocaleString()}</b> ` +
    `<span style="color:var(--muted)">(${today.realPlayers.toLocaleString()} real + ${today.bots.toLocaleString()} bots)</span>`;

  const cronEl = $("sb-cron");
  cronEl.className = "sb-item " + (today.cron.ok ? "ok" : "bad");
  cronEl.textContent = today.cron.label;

  const runwayEl = $("sb-runway");
  runwayEl.className = "sb-item" + (runway.days < 7 ? " warn" : "");
  runwayEl.textContent = `Runway ${runway.days}d`;
}

/* ---------- dashboard ---------- */
function tile(value, label, delta) {
  const deltaHtml = delta ? `<div class="delta ${delta.dir}">${delta.label}</div>` : "";
  return `<div class="tile"><div class="v">${value}</div><div class="k">${label}</div>${deltaHtml}</div>`;
}

async function renderTiles() {
  const t = await getTodayStats();
  $("tiles").innerHTML = [
    tile(t.realPlayers.toLocaleString(), "Real players today", t.realPlayersDelta),
    tile(t.bots.toLocaleString(), "Bots blended", { label: t.botsNote, dir: "" }),
    tile(t.d1RetentionPct + "%", "D1 retention", t.d1RetentionDelta),
    tile(t.sharesYesterday.toLocaleString(), "Shares yesterday", { label: t.shareRateNote, dir: "" }),
    tile(t.newPlayersToday.toLocaleString(), "New players today", t.newPlayersDelta),
  ].join("");
}

async function renderSpark30() {
  const data = await getDailyPlayers30d();
  const max = Math.max(...data.days);
  const el = $("spark30");
  el.innerHTML = "";
  data.days.forEach((v) => {
    const b = document.createElement("div");
    b.style.height = (v / max) * 100 + "%";
    if (v === data.bestDay) b.classList.add("hl");
    el.appendChild(b);
  });
  $("spark30-note").innerHTML =
    `${data.note} <span style="color:var(--lime)">■</span> = best day: ${data.bestDay.toLocaleString()}`;
}

async function renderStreaks() {
  const streaks = await getStreaks();
  $("streaks").innerHTML = streaks
    .map(
      (s) => `
      <div class="hbar">
        <div class="lbl"><span>${s.label}</span><span>${s.count.toLocaleString()} players</span></div>
        <div class="track"><div class="fill lime" style="width:${s.pct}%"></div></div>
      </div>`
    )
    .join("");
}

async function renderShield() {
  const dist = await getTodayLiveDistribution();
  const max = Math.max(...dist.buckets);
  const el = $("sparkToday");
  el.innerHTML = "";
  dist.buckets.forEach((v) => {
    const b = document.createElement("div");
    b.style.height = (v / max) * 100 + "%";
    el.appendChild(b);
  });
  $("dropShieldBtn").onclick = () => {
    $("cover").style.display = "none";
    document.querySelector("#shield .blur").classList.remove("blur");
    toast("Shield dropped — no daily for you today 😅");
  };
}

async function renderRecap() {
  const recap = await getYesterdayRecap();
  $("recap-title").textContent = `Yesterday's recap — #${recap.number} · ${recap.formatIcon} ${recap.formatLabel}`;
  $("recap-bars").innerHTML = recap.bars
    .map(
      (b) => `
      <div class="hbar">
        <div class="lbl"><span>${b.label}${b.winner ? " ✓ winner" : ""}</span><span>${b.pct}%</span></div>
        <div class="track"><div class="fill${b.winner ? " lime" : ""}" style="width:${b.pct}%"></div></div>
      </div>`
    )
    .join("");
  $("recap-note").innerHTML =
    `${recap.playerCount.toLocaleString()} players · roast shipped: <b>"${recap.roast}"</b>`;
}

async function renderDashboard() {
  await Promise.all([renderTiles(), renderSpark30(), renderStreaks(), renderShield(), renderRecap()]);
}

/* ---------- init ---------- */
async function init() {
  buildNav();
  renderCountdown();
  setInterval(renderCountdown, 30000);
  await renderStatusBar();
  await renderDashboard();
}

document.addEventListener("DOMContentLoaded", init);
