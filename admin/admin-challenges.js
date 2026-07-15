/* =====================================================
   admin-challenges.js — Challenges tab. Read + navigate only.

   Rule for this whole admin panel: openChallengeModal (in
   admin-calendar.js) is the ONE challenge editor. This tab never
   creates or fully edits a challenge — it browses, expands a row
   into a dossier, allows a roast-copy-typo fix on shipped days
   (the one retroactive edit CLAUDE.md allows), and can jump to
   the Calendar to reschedule a copy of a past challenge.
===================================================== */

let chalSearchQuery = "";
let chalFormatFilter = "all";
const chalExpanded = new Set();

async function renderChallengesSection() {
  wireChallengesControls();
  await renderChallengesTable();
}
SECTION_ACTIVATORS["s-chal"] = renderChallengesSection;

function wireChallengesControls() {
  const search = $("chal-search");
  const filter = $("chal-format-filter");
  if (!filter.dataset.wired) {
    filter.innerHTML =
      `<option value="all">All formats</option>` +
      FORMAT_KEYS.map((k) => `<option value="${k}">${FORMATS[k].icon} ${FORMATS[k].label}</option>`).join("");
    filter.dataset.wired = "1";
  }
  search.value = chalSearchQuery;
  filter.value = chalFormatFilter;
  search.oninput = () => {
    chalSearchQuery = search.value.trim().toLowerCase();
    renderChallengesTable();
  };
  filter.onchange = () => {
    chalFormatFilter = filter.value;
    renderChallengesTable();
  };
}

function statusChip(dateKey, today) {
  if (dateKey < today) return `<span class="tag ok">SHIPPED</span>`;
  if (dateKey === today) return `<span class="tag warn">TODAY</span>`;
  return `<span class="tag" style="background:#20263a;color:var(--purple)">SCHEDULED</span>`;
}

async function renderChallengesTable() {
  const challenges = await getAllChallenges();
  const today = calTodayKey();

  let rows = Object.entries(challenges).sort((a, b) => (a[0] < b[0] ? 1 : -1)); // newest first

  if (chalFormatFilter !== "all") {
    rows = rows.filter(([, c]) => c.format === chalFormatFilter);
  }
  if (chalSearchQuery) {
    rows = rows.filter(
      ([, c]) =>
        c.prompt.toLowerCase().includes(chalSearchQuery) ||
        c.roast.toLowerCase().includes(chalSearchQuery) ||
        String(c.number).includes(chalSearchQuery) ||
        FORMATS[c.format].label.toLowerCase().includes(chalSearchQuery)
    );
  }

  const tbody = $("chal-tbody");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="note" style="padding:20px 10px">No challenges match.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map(([dateKey, c]) => {
      const fmt = FORMATS[c.format];
      const truncatedPrompt = c.prompt.length > 60 ? c.prompt.slice(0, 57) + "…" : c.prompt;
      const isExpanded = chalExpanded.has(dateKey);
      let html = `
      <tr class="chal-row${isExpanded ? " expanded" : ""}" data-date-key="${dateKey}">
        <td>${prettyDate(dateKey)}</td>
        <td>#${c.number}</td>
        <td>${fmt.icon} ${fmt.label}</td>
        <td>${escapeHtml(truncatedPrompt)}</td>
        <td>${statusChip(dateKey, today)}</td>
        <td>—</td>
        <td>—</td>
      </tr>`;
      if (isExpanded) {
        html += `<tr class="chal-detail-row" data-detail-for="${dateKey}"><td colspan="7">${dossierHtml(dateKey, c, today)}</td></tr>`;
      }
      return html;
    })
    .join("");

  tbody.querySelectorAll(".chal-row").forEach((tr) => {
    tr.onclick = (e) => {
      if (e.target.closest("button, textarea, input")) return;
      const dk = tr.dataset.dateKey;
      if (chalExpanded.has(dk)) chalExpanded.delete(dk);
      else chalExpanded.add(dk);
      renderChallengesTable();
    };
  });

  tbody.querySelectorAll("[data-schedule-again]").forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const dk = btn.dataset.scheduleAgain;
      const challenge = (await getAllChallenges())[dk];
      const runway = await getRunwayDays();
      const targetDate = runway.lastScheduledDate ? shiftDateKey(runway.lastScheduledDate, 1) : calTodayKey();
      activateSection("s-cal");
      openChallengeModal({ mode: "add", dateKey: targetDate, existing: challenge });
    };
  });

  tbody.querySelectorAll("[data-save-roast]").forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const dk = btn.dataset.saveRoast;
      const textarea = tbody.querySelector(`textarea[data-roast-for="${dk}"]`);
      const challenge = (await getAllChallenges())[dk];
      await saveChallenge(dk, Object.assign({}, challenge, { roast: textarea.value.trim() }));
      toast(`Roast copy updated for #${challenge.number}.`);
      renderChallengesTable();
    };
  });
}

function dossierHtml(dateKey, c, today) {
  const isShipped = dateKey < today;
  const maxBar = Math.max(...c.crowd, 1);
  const barsHtml = c.crowd.map((v) => `<div style="height:${Math.max(3, (v / maxBar) * 100)}%"></div>`).join("");

  let specificHtml = "";
  if (c.format === "crunch" || c.format === "herdmeter") {
    specificHtml = `<div class="note"><b>Target:</b> ${c.target}</div>`;
  } else if (c.format === "oddonein") {
    specificHtml = `<div class="note"><b>Options:</b> ${c.options.map((o, i) => `${o.icon} ${escapeHtml(o.label)} (${c.crowd[i]}%)`).join(" · ")}</div>`;
  } else if (c.format === "splitsteal") {
    specificHtml = `<div class="note"><b>Split / Steal:</b> ${c.crowd[0]}% / ${c.crowd[1]}%</div>`;
  }

  const roastBlock = isShipped
    ? `<div class="field" style="margin-top:10px">
         <label>Roast copy — the one retroactive edit allowed</label>
         <textarea data-roast-for="${dateKey}">${escapeHtml(c.roast)}</textarea>
         <button class="btn sm" style="margin-top:8px" data-save-roast="${dateKey}">Save roast copy</button>
       </div>`
    : `<div class="note"><b>Roast:</b> ${escapeHtml(c.roast)}</div>`;

  return `
    <div class="chal-dossier">
      <div class="note"><b>Prompt:</b> ${escapeHtml(c.prompt)}</div>
      <div class="note"><b>Sub:</b> ${c.sub || "—"}</div>
      ${c.factoid ? `<div class="note"><b>Factoid:</b> ${c.factoid}</div>` : ""}
      ${specificHtml}
      <div class="spark" style="height:60px;margin:12px 0">${barsHtml}</div>
      ${roastBlock}
      <div class="modal-actions" style="margin-top:14px">
        <button class="btn ghost sm" data-schedule-again="${dateKey}">↻ Schedule again</button>
      </div>
    </div>`;
}
