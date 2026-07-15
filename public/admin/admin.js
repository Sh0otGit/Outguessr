/* =====================================================
   admin.js — shell (nav, status bar) + Dashboard.
   All data comes from admin-api.js — nothing here computes
   stats itself.

   Admin-key auth: the panel asks for the ADMIN_KEY once on load (a
   plain prompt() — this is a single-operator internal tool, not worth
   building custom modal UI for, per ADMIN-PANEL-PLAN.md's "simple and
   adequate" security philosophy) and keeps it in its OWN localStorage
   key (og_admin_key — see admin-api.js), separate from anything the
   public game stores. Calendar and Challenges don't need it at all
   (challenges.json is a public static file); Dashboard, System, and
   Bots do, and each independently catches AdminAuthError from its own
   data calls and renders unauthorizedCardHtml() with a retry button —
   so a wrong or missing key degrades gracefully section by section
   instead of taking down the whole panel.
===================================================== */
const $ = (id) => document.getElementById(id);

/* ---------- admin-key unauthorized state (shared across sections) ---------- */
function unauthorizedCardHtml(label) {
  return `
    <div class="unauth">
      <div class="unauth-icon">🔒</div>
      <div class="unauth-title">Admin key required</div>
      <div class="unauth-sub">${label} needs your ADMIN_KEY.</div>
      <button class="btn ghost sm" data-unauth-retry>Enter admin key</button>
    </div>`;
}
// Call after setting unauthorized HTML; onRetry re-runs the same
// section render once a key is entered (correct or not — a still-wrong
// key just throws AdminAuthError again and re-renders this same state).
function wireUnauthorizedRetry(onRetry) {
  document.querySelectorAll("[data-unauth-retry]").forEach((btn) => {
    btn.onclick = () => {
      const key = prompt("Enter your Outguessr ADMIN_KEY:");
      if (key) {
        setAdminKey(key.trim());
        onRetry();
      }
    };
  });
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
  // Runway doesn't need the admin key (challenges.json is public) — kept
  // independent of the try/catch below so it still renders even without
  // one.
  const runway = await getRunwayDays();
  const runwayEl = $("sb-runway");
  runwayEl.className = "sb-item" + (runway.days < 7 ? " warn" : "");
  runwayEl.textContent = `Runway ${runway.days}d`;

  try {
    const today = await getTodayStats();
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
      `<span style="color:var(--muted)">(${today.realPlayers.toLocaleString()} real + ${today.bots.toLocaleString()} bots)</span>` +
      (today.todayClosed ? ` <span class="sb-item warn" style="display:inline">· FORCE-CLOSED</span>` : "");

    const cronEl = $("sb-cron");
    cronEl.className = "sb-item " + (today.cron.ok ? "ok" : "bad");
    cronEl.textContent = today.cron.label;
  } catch (err) {
    if (!(err instanceof AdminAuthError)) throw err;
    $("sb-today").className = "sb-item";
    $("sb-today").textContent = "Today: —";
    $("sb-submissions").innerHTML = "Submissions: <b>—</b>";
    const cronEl = $("sb-cron");
    cronEl.className = "sb-item warn";
    cronEl.textContent = "🔒 admin key required";
  }
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
  try {
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
  } catch (err) {
    if (!(err instanceof AdminAuthError)) throw err;
    $("tiles").innerHTML = unauthorizedCardHtml("Live stats");
    wireUnauthorizedRetry(renderTiles);
  }
}

async function renderSpark30() {
  const card = $("spark30").closest(".card");
  try {
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
  } catch (err) {
    if (!(err instanceof AdminAuthError)) throw err;
    card.innerHTML = unauthorizedCardHtml("This chart");
    wireUnauthorizedRetry(renderSpark30);
  }
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
  const card = $("sparkToday").closest(".card");
  try {
    const dist = await getTodayLiveDistribution();
    const max = Math.max(1, ...dist.buckets);
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
  } catch (err) {
    if (!(err instanceof AdminAuthError)) throw err;
    $("cover").innerHTML = `<b>🔒 Admin key required</b><span>Live data needs your ADMIN_KEY.</span><button class="btn ghost sm" data-unauth-retry>Enter admin key</button>`;
    wireUnauthorizedRetry(renderShield);
  }
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
  if (recap.kind === "bars") {
    $("recap-bars").innerHTML = recap.bars
      .map(
        (b) => `
        <div class="hbar">
          <div class="lbl"><span>${b.label}${b.winner ? " ✓ winner" : ""}</span><span>${b.pct}%</span></div>
          <div class="track"><div class="fill${b.winner ? " lime" : ""}" style="width:${b.pct}%"></div></div>
        </div>`
      )
      .join("");
  } else {
    $("recap-bars").innerHTML = `<div class="note" style="margin-top:0">${recap.summary}</div>`;
  }
  $("recap-note").innerHTML = `${recap.playerCount.toLocaleString()} players · roast shipped: <b>"${recap.roast}"</b>`;
}

async function renderDashboard() {
  await Promise.all([renderTiles(), renderSpark30(), renderStreaks(), renderShield(), renderRecap()]);
}

/* ---------- init ---------- */
async function init() {
  buildNav();
  renderCountdown();
  setInterval(renderCountdown, 30000);

  // Ask once, up front, if nothing's stored yet — covers the common
  // case (open the panel, land on Dashboard) with a single prompt.
  // Declining leaves every key-gated section to show its own
  // unauthorizedCardHtml() with a retry button; Calendar/Challenges
  // work regardless since they never touch /api/admin/*.
  if (!getAdminKey()) {
    const key = prompt("Enter your Outguessr ADMIN_KEY (used for Dashboard, System, and Bots):");
    if (key) setAdminKey(key.trim());
  }

  await renderStatusBar();
  await renderDashboard();
}

document.addEventListener("DOMContentLoaded", init);
