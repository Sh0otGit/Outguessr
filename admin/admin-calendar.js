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
  const dirty = hasUnexportedChanges();
  el.innerHTML = `⚠️ <b>Content runway: ${runway.days} day${runway.days === 1 ? "" : "s"}</b> — ${through}.
    ${dirty ? `<span class="dirty-indicator">● changes not yet exported</span>` : ""}
    <span class="spacer"></span>
    <button class="btn ghost sm" id="cal-export-btn">⬇ Export challenges.json</button>
    <button class="btn sm" id="cal-add-btn">+ Add challenge</button>`;
  $("cal-add-btn").onclick = () => {
    const targetDate = runway.lastScheduledDate ? shiftDateKey(runway.lastScheduledDate, 1) : calTodayKey();
    openChallengeModal({ mode: "add", dateKey: targetDate });
  };
  $("cal-export-btn").onclick = async () => {
    await exportChallengesJson();
    toast("Downloaded challenges.json — commit it to make these changes stick.");
    renderRunwayBanner();
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
const COMMON_FIELD_TOOLTIPS = {
  format: {
    what: "Which of the four challenge types this day runs — determines the input widget players see and how picks are scored.",
    where: "Sets the input on the challenge screen and the chart/story shape on the reveal.",
    example: "Crowd Crunch shows a 0–100 slider; Odd One In shows five tappable option cards.",
  },
  prompt: {
    what: "The single sentence players see as the challenge's main question. Must be understandable with zero prior context — the one-sentence rule.",
    where: "Rendered as the large bold headline on the challenge screen, and reused as the headline in previews.",
    example: '"Pick a number from 0 to 100." — no explanation needed to know what to do.',
  },
  sub: {
    what: "A short explanation of how the winner is decided, shown right under the prompt. Basic <b> tags are allowed for emphasis.",
    where: "Rendered directly under the prompt on the challenge screen, in muted gray text.",
    example: '"Closest to <b>two-thirds of today\'s average</b> wins."',
  },
  roast: {
    what: "Sports-commentator-toned commentary on how the crowd behaved, written as if the day already happened. This is the screenshot-able story.",
    where: "Shown in the reveal screen's highlighted story box, right below the stats grid.",
    example: '"The crowd averaged 41. The galaxy-brains who picked 0 got burned again."',
  },
  factoid: {
    what: "An optional flavor fact shown while a player's answer is sealed, before they've seen the reveal. Builds anticipation.",
    where: 'Shown on the "Locked in" screen, between the player\'s pick and the reveal button.',
    example: '"The mind game: if everyone picked randomly, the target would be 33. But everyone knows that too…"',
  },
};

function validatePrompt(prompt) {
  const warnings = [];
  if (prompt.length > 100) warnings.push(`Prompt is ${prompt.length} characters — the one-sentence rule wants this short.`);
  const sentenceCount = prompt.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).filter((s) => s.trim().length > 0).length;
  if (sentenceCount > 1) warnings.push(`Prompt looks like ${sentenceCount} sentences — the deck rule wants exactly one.`);
  return warnings;
}

function formatFieldsHtml(format, existing) {
  const matchingExisting = existing && existing.format === format ? existing : null;
  const fields = FORMATS[format].editorFields || [];
  return fields
    .map((f) => {
      const value = f.getValue(matchingExisting);
      const marker = infoMarker(f.tooltip);
      if (f.type === "textarea") {
        return `<div class="field"><label>${f.label} ${marker}</label><textarea id="f-${f.id}">${escapeHtml(value)}</textarea></div>`;
      }
      if (f.type === "number") {
        return `<div class="field"><label>${f.label} ${marker}</label><input type="number" id="f-${f.id}" min="${f.min ?? ""}" max="${f.max ?? ""}" value="${escapeHtml(value)}"></div>`;
      }
      return `<div class="field"><label>${f.label} ${marker}</label><input type="text" id="f-${f.id}" value="${escapeHtml(value)}"></div>`;
    })
    .join("");
}

function collectFormatFields(format) {
  const data = {};
  (FORMATS[format].editorFields || []).forEach((f) => {
    data[f.id] = f.parse($(`f-${f.id}`).value);
  });
  return data;
}

function buildChallengeFromForm(number) {
  const format = $("f-format").value;
  const base = {
    format,
    number,
    prompt: $("f-prompt").value.trim(),
    sub: $("f-sub").value.trim(),
    roast: $("f-roast").value.trim(),
  };
  const factoid = $("f-factoid").value.trim();
  if (factoid) base.factoid = factoid;
  return Object.assign(base, collectFormatFields(format));
}

function renderModalWarnings() {
  const panel = $("modal-warnings");
  if (!panel) return;
  let warnings = validatePrompt($("f-prompt").value.trim());
  try {
    const format = $("f-format").value;
    const data = collectFormatFields(format);
    if (FORMATS[format].validate) warnings = warnings.concat(FORMATS[format].validate(data));
  } catch (e) {
    // fields mid-rebuild (format just switched) — skip format-specific checks this pass
  }
  panel.innerHTML = warnings.map((w) => `<div class="warn-line">⚠ ${escapeHtml(w)}</div>`).join("");
}

function wireModalValidation() {
  $("f-prompt").oninput = renderModalWarnings;
  $("modal-format-fields")
    .querySelectorAll("input, textarea")
    .forEach((el) => {
      el.oninput = renderModalWarnings;
    });
  renderModalWarnings();
}

async function openChallengeModal({ mode, dateKey, existing }) {
  const challenges = await getAllChallenges();
  const nextNumber = Math.max(0, ...Object.values(challenges).map((c) => c.number)) + 1;
  const format = (existing && existing.format) || "crunch";
  const number = mode === "edit" ? existing.number : nextNumber;

  const html = `
    <div class="modal-head">
      <div>
        <h2>${mode === "edit" ? "Edit" : "Add"} challenge — ${prettyDate(dateKey)}</h2>
        <div class="modal-number">#${number} · assigned automatically</div>
      </div>
      <button class="modal-close" id="modal-close-btn">×</button>
    </div>
    <div class="modal-sub">${mode === "edit" ? "Only future days are editable." : "Scheduling a new day."}</div>
    <div class="field"><label>Format ${infoMarker(COMMON_FIELD_TOOLTIPS.format)}</label>
      <select id="f-format">
        ${FORMAT_KEYS.map((k) => `<option value="${k}" ${k === format ? "selected" : ""}>${FORMATS[k].icon} ${FORMATS[k].label}</option>`).join("")}
      </select>
    </div>
    <div class="field"><label>Prompt ${infoMarker(COMMON_FIELD_TOOLTIPS.prompt)}</label><input type="text" id="f-prompt" value="${escapeHtml(existing ? existing.prompt : "")}"></div>
    <div class="field"><label>Sub ${infoMarker(COMMON_FIELD_TOOLTIPS.sub)}</label><textarea id="f-sub">${escapeHtml(existing ? existing.sub : "")}</textarea></div>
    <div class="field"><label>Roast copy ${infoMarker(COMMON_FIELD_TOOLTIPS.roast)}</label><textarea id="f-roast">${escapeHtml(existing ? existing.roast : "")}</textarea></div>
    <div class="field"><label>Factoid ${infoMarker(COMMON_FIELD_TOOLTIPS.factoid)}</label><textarea id="f-factoid">${escapeHtml(existing && existing.factoid ? existing.factoid : "")}</textarea></div>
    <div id="modal-format-fields">${formatFieldsHtml(format, existing)}</div>
    <div class="modal-warnings" id="modal-warnings"></div>
    <div class="modal-actions">
      <button class="btn ghost" id="modal-preview-btn">👁 Preview as player</button>
      <button class="btn" id="modal-save-btn">${mode === "edit" ? "Save changes" : "Schedule it"}</button>
    </div>
    ${mode === "edit" ? `<div class="modal-actions"><button class="btn danger" id="modal-delete-btn" style="width:100%">Delete this day</button></div>` : ""}
  `;
  openModal(html);
  wireModalValidation();

  $("modal-close-btn").onclick = closeModal;
  $("f-format").onchange = () => {
    $("modal-format-fields").innerHTML = formatFieldsHtml($("f-format").value, null);
    wireModalValidation();
  };
  $("modal-preview-btn").onclick = () => {
    const draft = buildChallengeFromForm(number);
    openPreviewModal(dateKey, draft, {
      locked: false,
      fromDraft: true,
      onBack: () => openChallengeModal({ mode, dateKey, existing: draft }),
    });
  };
  $("modal-save-btn").onclick = async () => {
    const data = buildChallengeFromForm(number);
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
