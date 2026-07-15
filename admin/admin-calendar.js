/* =====================================================
   admin-calendar.js — Challenge Calendar section.

   Reads/writes through admin-api.js (getAllChallenges,
   saveChallenge, deleteChallenge, getRunwayDays). Reuses
   FORMATS from formats.js for the preview-as-player modal,
   so a preview can never drift from what the game actually
   renders.
===================================================== */

const FORMAT_KEYS = ["crunch", "oddonein", "splitsteal", "herdmeter"];

let calViewYear, calViewMonth; // calViewMonth is 0-indexed

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function calTodayKey() {
  return dateKeyFromDate(new Date());
}

/* ---------- section entry point (registered with admin.js) ---------- */
async function renderCalendarSection() {
  if (calViewYear === undefined) {
    const now = new Date();
    calViewYear = now.getFullYear();
    calViewMonth = now.getMonth();
  }
  $("cal-prev").onclick = () => {
    calViewMonth--;
    if (calViewMonth < 0) {
      calViewMonth = 11;
      calViewYear--;
    }
    renderMonthGrid();
  };
  $("cal-next").onclick = () => {
    calViewMonth++;
    if (calViewMonth > 11) {
      calViewMonth = 0;
      calViewYear++;
    }
    renderMonthGrid();
  };
  await renderRunwayBanner();
  await renderMonthGrid();
}
SECTION_ACTIVATORS["s-cal"] = renderCalendarSection;

async function renderRunwayBanner() {
  const runway = await getRunwayDays();
  const el = $("cal-runway");
  el.className = "runway" + (runway.days >= 7 ? " ok" : "");
  const through = runway.lastScheduledDate
    ? `scheduled through ${prettyDate(runway.lastScheduledDate)}`
    : "nothing scheduled";
  el.innerHTML = `⚠️ <b>Content runway: ${runway.days} day${runway.days === 1 ? "" : "s"}</b> — ${through}.
    <span class="spacer"></span>
    <button class="btn sm" id="cal-add-btn">+ Add challenge</button>`;
  $("cal-add-btn").onclick = () => {
    const targetDate = runway.lastScheduledDate ? shiftDateKey(runway.lastScheduledDate, 1) : calTodayKey();
    openChallengeModal({ mode: "add", dateKey: targetDate });
  };
}

async function renderMonthGrid() {
  const challenges = await getAllChallenges();
  const today = calTodayKey();

  $("cal-month-label").textContent = new Date(calViewYear, calViewMonth, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  const grid = $("cal-grid");
  grid.innerHTML = "";
  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach((d) => {
    const e = document.createElement("div");
    e.className = "dow";
    e.textContent = d;
    grid.appendChild(e);
  });

  const firstOfMonth = new Date(calViewYear, calViewMonth, 1);
  const daysInMonth = new Date(calViewYear, calViewMonth + 1, 0).getDate();
  const firstDow = firstOfMonth.getDay();

  for (let i = 0; i < firstDow; i++) {
    const e = document.createElement("div");
    e.className = "day blank";
    grid.appendChild(e);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateKey = dateKeyFromDate(new Date(calViewYear, calViewMonth, d));
    const challenge = challenges[dateKey];
    const isPast = dateKey < today;
    const isToday = dateKey === today;
    // Only flag *future* gaps red — a past day with no record isn't a runway
    // problem, it's just history you can't (and don't need to) backfill.
    const flagEmpty = !challenge && !isPast;

    const el = document.createElement("div");
    el.className = "day" + (isPast ? " past" : "") + (isToday ? " today" : "") + (flagEmpty ? " empty" : "");
    const fmtHtml = challenge
      ? `${FORMATS[challenge.format].icon} #${challenge.number}<br>${FORMATS[challenge.format].label}`
      : isPast
        ? "—"
        : "EMPTY";
    el.innerHTML = `<div class="num">${d}</div><div class="fmt">${fmtHtml}</div>`;
    el.onclick = () => onDayClick(dateKey, challenge, isPast, isToday);
    grid.appendChild(el);
  }
}

function onDayClick(dateKey, challenge, isPast, isToday) {
  const locked = isPast || isToday; // no editing today's live challenge or history — see ADMIN-PANEL-PLAN.md
  if (locked) {
    if (challenge) openPreviewModal(dateKey, challenge, { locked: true });
    else toast("Past days are locked — history is never editable.");
    return;
  }
  if (challenge) openChallengeModal({ mode: "edit", dateKey, existing: challenge });
  else openChallengeModal({ mode: "add", dateKey });
}

/* ---------- add / edit modal ---------- */
function formatFieldsHtml(format, existing) {
  const has = existing && existing.format === format;
  if (format === "crunch" || format === "herdmeter") {
    const target = has ? existing.target : 50;
    const crowd = has ? existing.crowd.join(",") : "2,3,4,6,8,14,11,7,5,9,12,6,4,3,2,1,1,1,0,1";
    return `
      <div class="field"><label>Target ${format === "herdmeter" ? "(truth %)" : "(0–100)"}</label><input type="number" id="f-target" min="0" max="100" value="${target}"></div>
      <div class="field"><label>Crowd distribution — 20 buckets, comma-separated</label><input type="text" id="f-crowd" value="${escapeHtml(crowd)}"><div class="hint">Bucket i = players who picked [i×5, i×5+5). Simulated — shape the story.</div></div>`;
  }
  if (format === "oddonein") {
    const opts = has
      ? existing.options.map((o) => `${o.icon} ${o.label}`).join("\n")
      : "🍕 Pepperoni\n🍍 Pineapple\n🍄 Mushroom\n🌶️ Jalapeño\n🧀 Plain Cheese";
    const crowd = has ? existing.crowd.join(",") : "29,18,21,23,9";
    return `
      <div class="field"><label>Options — one "icon label" per line</label><textarea id="f-options">${escapeHtml(opts)}</textarea></div>
      <div class="field"><label>Crowd % per option, comma-separated, same order</label><input type="text" id="f-crowd" value="${escapeHtml(crowd)}"></div>`;
  }
  if (format === "splitsteal") {
    const crowd = has ? existing.crowd.join(",") : "58,42";
    return `<div class="field"><label>Crowd split — SPLIT%,STEAL%</label><input type="text" id="f-crowd" value="${escapeHtml(crowd)}"></div>`;
  }
  return "";
}

function collectFormatFields(format) {
  const nums = (id) =>
    $(id)
      .value.split(",")
      .map((s) => parseInt(s.trim(), 10) || 0);
  if (format === "crunch" || format === "herdmeter") {
    return { target: +$("f-target").value, crowd: nums("f-crowd") };
  }
  if (format === "oddonein") {
    const options = $("f-options")
      .value.split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [icon, ...rest] = line.split(" ");
        return { icon, label: rest.join(" ") };
      });
    return { options, crowd: nums("f-crowd") };
  }
  if (format === "splitsteal") {
    return { crowd: nums("f-crowd") };
  }
  return {};
}

function buildChallengeFromForm() {
  const format = $("f-format").value;
  const base = {
    format,
    number: parseInt($("f-number").value, 10) || 0,
    prompt: $("f-prompt").value.trim(),
    sub: $("f-sub").value.trim(),
    roast: $("f-roast").value.trim(),
  };
  const factoid = $("f-factoid").value.trim();
  if (factoid) base.factoid = factoid;
  return Object.assign(base, collectFormatFields(format));
}

async function openChallengeModal({ mode, dateKey, existing }) {
  const challenges = await getAllChallenges();
  const nextNumber = Math.max(0, ...Object.values(challenges).map((c) => c.number)) + 1;
  const format = (existing && existing.format) || "crunch";
  const number = existing ? existing.number : nextNumber;

  const html = `
    <div class="modal-head">
      <h2>${mode === "edit" ? "Edit" : "Add"} challenge — ${prettyDate(dateKey)}</h2>
      <button class="modal-close" id="modal-close-btn">×</button>
    </div>
    <div class="modal-sub">${mode === "edit" ? "Only future days are editable." : "Scheduling a new day."}</div>
    <div class="form-row">
      <div class="field"><label>Number</label><input type="number" id="f-number" value="${number}"></div>
      <div class="field"><label>Format</label>
        <select id="f-format">
          ${FORMAT_KEYS.map((k) => `<option value="${k}" ${k === format ? "selected" : ""}>${FORMATS[k].icon} ${FORMATS[k].label}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="field"><label>Prompt (one sentence — hard rule)</label><input type="text" id="f-prompt" value="${escapeHtml(existing ? existing.prompt : "")}"></div>
    <div class="field"><label>Sub (explanation, &lt;b&gt; ok)</label><textarea id="f-sub">${escapeHtml(existing ? existing.sub : "")}</textarea></div>
    <div class="field"><label>Roast copy (written before reveal, sports-commentator tone)</label><textarea id="f-roast">${escapeHtml(existing ? existing.roast : "")}</textarea></div>
    <div class="field"><label>Factoid (optional — shown on the sealed screen)</label><textarea id="f-factoid">${escapeHtml(existing && existing.factoid ? existing.factoid : "")}</textarea></div>
    <div id="modal-format-fields">${formatFieldsHtml(format, existing)}</div>
    <div class="modal-actions">
      <button class="btn ghost" id="modal-preview-btn">👁 Preview as player</button>
      <button class="btn" id="modal-save-btn">${mode === "edit" ? "Save changes" : "Schedule it"}</button>
    </div>
    ${mode === "edit" ? `<div class="modal-actions"><button class="btn danger" id="modal-delete-btn" style="width:100%">Delete this day</button></div>` : ""}
  `;
  openModal(html);

  $("modal-close-btn").onclick = closeModal;
  $("f-format").onchange = () => {
    $("modal-format-fields").innerHTML = formatFieldsHtml($("f-format").value, null);
  };
  $("modal-preview-btn").onclick = () => {
    const draft = buildChallengeFromForm();
    openPreviewModal(dateKey, draft, {
      locked: false,
      fromDraft: true,
      onBack: () => openChallengeModal({ mode, dateKey, existing: draft }),
    });
  };
  $("modal-save-btn").onclick = async () => {
    const data = buildChallengeFromForm();
    if (!data.prompt || !data.roast) {
      toast("Prompt and roast copy are required.");
      return;
    }
    await saveChallenge(dateKey, data);
    closeModal();
    toast(`${mode === "edit" ? "Updated" : "Scheduled"} #${data.number} for ${prettyDate(dateKey)}.`);
    renderRunwayBanner();
    renderMonthGrid();
  };
  if (mode === "edit") {
    $("modal-delete-btn").onclick = async () => {
      if (!confirm(`Delete the challenge scheduled for ${prettyDate(dateKey)}? This cannot be undone.`)) return;
      await deleteChallenge(dateKey);
      closeModal();
      toast(`Deleted — ${prettyDate(dateKey)} is empty again.`);
      renderRunwayBanner();
      renderMonthGrid();
    };
  }
}

/* ---------- preview-as-player modal ---------- */
function openPreviewModal(dateKey, challenge, opts) {
  opts = opts || {};
  const fmt = FORMATS[challenge.format];
  const html = `
    <div class="modal-head">
      <h2>Preview — ${prettyDate(dateKey)}</h2>
      <button class="modal-close" id="modal-close-btn">×</button>
    </div>
    <div class="modal-sub">${opts.locked ? "Read-only — past days and the live challenge are never editable." : "This is exactly what a player opens. Nothing here is saved."}</div>
    <div class="preview-frame">
      <span class="mode-tag">${fmt.icon} ${fmt.label} · #${challenge.number}</span>
      <div class="prompt">${challenge.prompt}</div>
      <div class="subprompt">${challenge.sub || ""}</div>
      <div id="preview-input-zone"></div>
      <button class="btn" id="preview-lock-btn" disabled>Lock it in 🔒</button>
    </div>
    <div class="modal-actions">
      ${opts.fromDraft ? `<button class="btn ghost" id="modal-back-btn">← Back to editor</button>` : `<button class="btn ghost" id="modal-close-btn2">Close</button>`}
    </div>
  `;
  openModal(html);

  $("modal-close-btn").onclick = closeModal;
  const closeBtn2 = document.getElementById("modal-close-btn2");
  if (closeBtn2) closeBtn2.onclick = closeModal;
  const backBtn = document.getElementById("modal-back-btn");
  if (backBtn) backBtn.onclick = opts.onBack;

  fmt.buildInput($("preview-input-zone"), challenge, () => {
    $("preview-lock-btn").disabled = false;
  });
  $("preview-lock-btn").onclick = () => toast("Preview only — nothing is saved.");
}
