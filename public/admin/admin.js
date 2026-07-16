/* =====================================================
   admin.js — shell (nav, status bar) + Dashboard.
   All data comes from admin-api.js — nothing here computes
   stats itself.

   Admin-key auth is a whole-panel login gate, not per-section prompts:
   on load, checkAuthAndRender() shows ONLY the centered login card
   (#login-view) until the stored key verifies against a real call
   (GET /api/admin/config) — no nav, no status bar, no tab content, no
   data leaks out before that. A successful verify swaps straight to
   the full panel (#app-view), no reload. Every section's data calls
   still go through adminFetch and can still throw AdminAuthError (e.g.
   the key gets revoked mid-session) — activateSection() is the single
   place that catches it and drops back to the login view, so no
   individual render function needs its own auth handling anymore.
===================================================== */
const $ = (id) => document.getElementById(id);

/* ---------- login gate ---------- */
function showLoginView(errorMsg) {
  $("app-view").classList.add("hidden");
  $("login-view").classList.remove("hidden");
  $("login-error").textContent = errorMsg || "";
  $("login-key-input").value = "";
  $("login-key-input").focus();
}

async function showAppView() {
  $("login-view").classList.add("hidden");
  $("app-view").classList.remove("hidden");
  try {
    await renderStatusBar();
    await activateSection(currentSection || "s-dash");
  } catch (err) {
    if (err instanceof AdminAuthError) {
      showLoginView("Session expired — enter your key again.");
      return;
    }
    throw err;
  }
}

async function attemptLogin() {
  const val = $("login-key-input").value.trim();
  if (!val) return;
  $("login-unlock-btn").disabled = true;
  setAdminKey(val);
  try {
    await adminFetch("/api/admin/config"); // verification call — throws AdminAuthError on a wrong key
    await showAppView();
  } catch (err) {
    if (!(err instanceof AdminAuthError)) throw err;
    clearAdminKey();
    showLoginView("Wrong key — try again.");
  } finally {
    $("login-unlock-btn").disabled = false;
  }
}

// Runs once on load: a stored key still has to prove itself with a real
// call (a key that verified last week could've been rotated since) —
// "logged in" here always means "verified just now," never "a key
// exists in localStorage."
async function checkAuthAndRender() {
  if (!getAdminKey()) {
    showLoginView();
    return;
  }
  try {
    await adminFetch("/api/admin/config");
    await showAppView();
  } catch (err) {
    if (!(err instanceof AdminAuthError)) throw err;
    showLoginView();
  }
}

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

// Tracked so showAppView() can restore whatever tab was open before a
// session-expired bounce back to the login gate.
let currentSection = "s-dash";

// Exposed so other modules can switch tabs programmatically — e.g. the
// Challenges tab's "Schedule again" jumps to Calendar and opens the
// modal. The single place that catches AdminAuthError from a section's
// data calls and drops back to the login gate — no individual render
// function needs its own try/catch for it anymore.
async function activateSection(id) {
  currentSection = id;
  document.querySelectorAll(".navitem").forEach((n) => n.classList.remove("active"));
  const navEl = document.querySelector(`.navitem[data-section="${id}"]`);
  if (navEl) navEl.classList.add("active");
  document.querySelectorAll("section").forEach((s) => s.classList.remove("active"));
  $(id).classList.add("active");
  if (!SECTION_ACTIVATORS[id]) return;
  try {
    await SECTION_ACTIVATORS[id]();
  } catch (err) {
    if (err instanceof AdminAuthError) {
      showLoginView("Session expired — enter your key again.");
      return;
    }
    throw err;
  }
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

/* ---------- stacked real/bot chart (shared infra; Dashboard shield + recap) ----------
   Real players solid purple at the base, bots a muted stripe stacked on
   top — real+bot heights are both fractions of the SAME blob.crowd[i]
   total (see src/index.js's computeResultsBlob comment on realCrowd),
   so they always sum back up to the full bar. Labels the story bars
   exactly like the game's own reveal chart: winner gets a ✓, the peak
   bucket gets called out, everything else is hover-only via title=. */
function buildAdminStackedChart(blob, opts) {
  opts = opts || {};
  const crowd = blob.crowd || [];
  const realCrowd = blob.realCrowd || crowd.map(() => 0);
  const max = Math.max(1, ...crowd);
  const winSet = new Set(blob.winIndexes || []);
  const axis = opts.axis || [];
  // crunch/herdmeter's crowd is raw bucket counts; oddonein/splitsteal's
  // is already a percentage share — the label/tooltip always wants a
  // percentage, so counts need one more division, shares don't.
  const isCountFormat = blob.format === "crunch" || blob.format === "herdmeter";
  const players = blob.players || 0;
  const toPct = (v) => (isCountFormat ? (players ? Math.round((v / players) * 100) : 0) : v);

  const bars = crowd
    .map((v, i) => {
      const real = realCrowd[i] || 0;
      const bots = Math.max(0, v - real);
      const pct = toPct(v);
      const realPct = toPct(real);
      const totalHeightPct = Math.max(3, (v / max) * 100);
      const realHeightPct = v ? (real / v) * totalHeightPct : 0;
      const botsHeightPct = Math.max(0, totalHeightPct - realHeightPct);
      const isWin = winSet.has(i);
      const isPeak = i === blob.peakIndex;

      let label = "";
      if (isWin) label = `<div class="admin-blabel win">WIN ✓ · ${pct}%</div>`;
      else if (isPeak) label = `<div class="admin-blabel peak">PEAK · ${pct}%</div>`;

      const title = `${pct}% total (${realPct}% real, rest bot-attributable)`;
      return `<div class="admin-bar${isWin ? " win" : ""}" style="height:${totalHeightPct}%" title="${title}">
        ${label}
        <div class="seg seg-bots" style="height:${botsHeightPct}%"></div>
        <div class="seg seg-real" style="height:${realHeightPct}%"></div>
      </div>`;
    })
    .join("");

  const axisHtml = axis.length ? `<div class="admin-chart-axis">${axis.map((a) => `<span>${a}</span>`).join("")}</div>` : "";

  return `
    <div class="admin-chart-subtitle">${(blob.realPlayers || 0).toLocaleString()} real + ${(blob.bots || 0).toLocaleString()} bots = ${(blob.players || 0).toLocaleString()}</div>
    <div class="admin-bars">${bars}</div>
    ${axisHtml}
    <div class="admin-legend">
      <span><span class="dot" style="background:var(--purple)"></span>Real</span>
      <span><span class="dot bots"></span>Bots</span>
      <span><span class="dot" style="background:var(--lime)"></span>Winning zone</span>
    </div>`;
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

// AdminAuthError from either call here is deliberately left uncaught —
// activateSection()/showAppView() are the callers, and they're the ones
// that know to drop back to the login gate.
async function renderStatusBar() {
  const [runway, today] = await Promise.all([getRunwayDays(), getTodayStats()]);

  const runwayEl = $("sb-runway");
  runwayEl.className = "sb-item" + (runway.days < 7 ? " warn" : "");
  runwayEl.textContent = `Runway ${runway.days}d`;

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

  // A red "CLOSED EARLY" chip everywhere, not just a status-bar aside —
  // this is the one piece of state an admin should never miss.
  $("sb-closed-chip").classList.toggle("hidden", !today.todayClosed);

  const cronEl = $("sb-cron");
  cronEl.className = "sb-item " + (today.cron.ok ? "ok" : "bad");
  cronEl.textContent = today.cron.label;
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
    tile("tile-real", "Real players today"),
    tile("tile-bots", "Bots blended", { label: t.botsNote, dir: "" }),
    tile("tile-newplayers", "New players today"),
    tile("tile-returning", "Returning players today"),
    tile("tile-retention", "D1 retention"),
    tile("tile-shares", "Shares yesterday"),
  ].join("");
  countUpTile($("tile-real"), t.realPlayers, (n) => n.toLocaleString());
  countUpTile($("tile-bots"), t.bots, (n) => n.toLocaleString());
  countUpTile($("tile-newplayers"), t.newPlayersToday, (n) => n.toLocaleString());
  countUpTile($("tile-returning"), t.returningToday, (n) => n.toLocaleString());
  if (t.d1RetentionPct === null) {
    $("tile-retention").innerHTML = `— ${infoMarker({ what: "D1 retention", where: "Dashboard", example: "Yesterday had no real players, so there's no baseline to measure retention against." })}`;
  } else {
    countUpTile($("tile-retention"), t.d1RetentionPct, (n) => n + "%");
  }
  $("tile-shares").innerHTML = `— ${infoMarker({
    what: "Share-card copy count",
    where: "Would show here if tracked.",
    example: "No analytics event exists for the share button yet — this isn't 0, it's simply not measured.",
  })}`;
}

async function renderSpark30() {
  const data = await getDailyPlayers30d();
  const max = Math.max(1, ...data.days);
  const el = $("spark30");
  el.innerHTML = "";
  data.days.forEach((v) => {
    const b = document.createElement("div");
    b.style.height = (v / max) * 100 + "%";
    if (v === data.bestDay && v > 0) b.classList.add("hl");
    el.appendChild(b);
  });
  $("spark30-note").innerHTML =
    `${data.note} <span style="color:var(--lime)">■</span> = best day: ${data.bestDay.toLocaleString()}`;
}

// Streaks live entirely in each player's own browser (og_streak in
// localStorage) — there's no backend number to fetch, real or fake.
async function renderStreaks() {
  $("streaks").innerHTML = `
    <div class="unavailable-stat">
      <div class="ua-value">—</div>
      <div class="ua-note">Not trackable server-side ${infoMarker({
        what: "Streak distribution",
        where: "Would show here if trackable.",
        example: "Streaks live in each player's own browser (localStorage), never sent to the backend — golden rule 5's zero-friction, no-accounts design means there's no player identity to attach a streak history to server-side.",
      })}</div>
    </div>`;
}

async function renderShield() {
  const dist = await getTodayLiveDistribution();
  $("sparkToday").innerHTML = buildAdminStackedChart(dist.blob, { axis: dist.axis });
  $("dropShieldBtn").onclick = () => {
    $("cover").style.display = "none";
    document.querySelector("#shield .blur").classList.remove("blur");
    toast("Shield dropped — no daily for you today 😅");
  };
}

async function renderRecap() {
  const recap = await getYesterdayRecap();
  if (recap.unavailable) {
    $("recap-title").textContent = "Yesterday's recap";
    $("recap-bars").innerHTML = "";
    $("recap-note").innerHTML = `<span style="color:var(--muted)">${recap.reason}</span>`;
    return;
  }
  $("recap-title").textContent = `Yesterday's recap — #${recap.number} · ${recap.formatIcon} ${recap.formatLabel}`;
  $("recap-bars").innerHTML = buildAdminStackedChart(recap.blob, { axis: recap.axis });
  $("recap-note").innerHTML = `${recap.playerCount.toLocaleString()} players · roast shipped: <b>"${recap.roast}"</b>`;
}

async function renderDashboard() {
  await Promise.all([renderTiles(), renderSpark30(), renderStreaks(), renderShield(), renderRecap()]);
}
SECTION_ACTIVATORS["s-dash"] = renderDashboard;

/* ---------- init ---------- */
async function init() {
  buildNav();
  renderCountdown();
  setInterval(renderCountdown, 30000);

  $("login-unlock-btn").onclick = attemptLogin;
  $("login-key-input").onkeydown = (e) => {
    if (e.key === "Enter") attemptLogin();
  };
  $("lock-btn").onclick = () => {
    clearAdminKey();
    showLoginView();
  };

  await checkAuthAndRender();
}

document.addEventListener("DOMContentLoaded", init);
