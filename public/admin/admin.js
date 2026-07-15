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

// Exposed so other modules can switch tabs programmatically — e.g. the
// Challenges tab's "Schedule again" jumps to Calendar and opens the modal.
function activateSection(id) {
  document.querySelectorAll(".navitem").forEach((n) => n.classList.remove("active"));
  const navEl = document.querySelector(`.navitem[data-section="${id}"]`);
  if (navEl) navEl.classList.add("active");
  document.querySelectorAll("section").forEach((s) => s.classList.remove("active"));
  $(id).classList.add("active");
  if (SECTION_ACTIVATORS[id]) SECTION_ACTIVATORS[id]();
}

function buildNav() {
  const nav = $("nav");
  NAV.forEach(([id, icon, label, badge, disabled], i) => {
    const el = document.createElement("div");
    el.className = "navitem" + (i === 0 ? " active" : "") + (disabled ? " disabled" : "");
    el.dataset.section = id;
    el.innerHTML = icon + " " + label + (badge ? `<span class="badge">${badge}</span>` : "");
    if (!disabled) el.onclick = () => activateSection(id);
    nav.appendChild(el);
  });
}

/* ---------- info tooltip (shared infra) ----------
   Renders a hoverable ⓘ marker next to any field label. Content is
   registered by key and looked up on hover/focus — no title= attrs,
   so it can show structured what/where/example content. */
const TOOLTIP_REGISTRY = {};
let _tooltipSeq = 0;
function infoMarker(tooltip) {
  const id = "tt" + _tooltipSeq++;
  TOOLTIP_REGISTRY[id] = tooltip;
  return `<span class="info-marker" data-tooltip-id="${id}" tabindex="0">ⓘ</span>`;
}
function showTooltip(marker) {
  const t = TOOLTIP_REGISTRY[marker.dataset.tooltipId];
  if (!t) return;
  const el = $("field-tooltip");
  el.innerHTML = `
    <div class="tt-what">${t.what}</div>
    <div class="tt-row"><b>Where:</b> ${t.where}</div>
    <div class="tt-row"><b>Example:</b> ${t.example}</div>`;
  el.classList.remove("hidden");
  const rect = marker.getBoundingClientRect();
  const ttRect = el.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - ttRect.width - 8)) + "px";
  el.style.top = rect.bottom + 8 + "px";
}
function hideTooltip() {
  $("field-tooltip").classList.add("hidden");
}
document.addEventListener("DOMContentLoaded", () => {
  document.addEventListener("mouseover", (e) => {
    const marker = e.target.closest(".info-marker");
    if (marker) showTooltip(marker);
  });
  document.addEventListener("mouseout", (e) => {
    if (e.target.closest(".info-marker")) hideTooltip();
  });
  document.addEventListener("focusin", (e) => {
    const marker = e.target.closest(".info-marker");
    if (marker) showTooltip(marker);
  });
  document.addEventListener("focusout", (e) => {
    if (e.target.closest(".info-marker")) hideTooltip();
  });
});

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
function tile(id, label, delta) {
  const deltaHtml = delta ? `<div class="delta ${delta.dir}">${delta.label}</div>` : "";
  return `<div class="tile"><div class="v" id="${id}">0</div><div class="k">${label}</div>${deltaHtml}</div>`;
}
function countUpTile(el, target, format) {
  if (!el) return;
  const ms = 700;
  const start = performance.now();
  function tick(now) {
    const p = Math.min(1, (now - start) / ms);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = format(Math.round(target * eased));
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

async function renderTiles() {
  const t = await getTodayStats();
  $("tiles").innerHTML = [
    tile("tile-real", "Real players today", t.realPlayersDelta),
    tile("tile-bots", "Bots blended", { label: t.botsNote, dir: "" }),
    tile("tile-retention", "D1 retention", t.d1RetentionDelta),
    tile("tile-shares", "Shares yesterday", { label: t.shareRateNote, dir: "" }),
    tile("tile-newplayers", "New players today", t.newPlayersDelta),
  ].join("");
  countUpTile($("tile-real"), t.realPlayers, (n) => n.toLocaleString());
  countUpTile($("tile-bots"), t.bots, (n) => n.toLocaleString());
  countUpTile($("tile-retention"), t.d1RetentionPct, (n) => n + "%");
  countUpTile($("tile-shares"), t.sharesYesterday, (n) => n.toLocaleString());
  countUpTile($("tile-newplayers"), t.newPlayersToday, (n) => n.toLocaleString());
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
