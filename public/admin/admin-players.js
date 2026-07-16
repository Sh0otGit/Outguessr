/* =====================================================
   admin-players.js — Players section.

   Player IDs are anonymous, random localStorage strings — this tab is
   built to be useful without ever pretending to know who anyone is.
   No IP is stored anywhere in this codebase (see GET /api/admin/players'
   ipFlaggingNote) and that stays true.

   AdminAuthError isn't caught here — activateSection() is the single
   place that drops back to the login gate.
===================================================== */

async function renderPlayersSection() {
  await Promise.all([renderPlayersTiles(), renderFlaggedTable()]);
  wirePlayersLookup();
  wirePlayersExport();
}
SECTION_ACTIVATORS["s-players"] = renderPlayersSection;

let _playersSummaryCache = null;
async function getPlayersSummaryCached() {
  if (!_playersSummaryCache) _playersSummaryCache = await getPlayersSummary();
  return _playersSummaryCache;
}

async function renderPlayersTiles() {
  _playersSummaryCache = null; // fresh on every section activation
  const s = await getPlayersSummaryCached();
  const newToday = s.cohort.length ? s.cohort[s.cohort.length - 1].newPlayers : 0;

  $("players-tiles").innerHTML = [
    tile("players-tile-total", "Total players"),
    tile(
      "players-tile-dau",
      `DAU ${infoMarker({ what: "Daily active users — distinct real players who answered today.", where: "Players tab.", example: "Same real-player count the Dashboard shows, just framed as a player metric here." })}`
    ),
    tile(
      "players-tile-wau",
      `WAU ${infoMarker({ what: "Weekly active users — distinct real players who answered at least once in the last 7 days.", where: "Players tab.", example: "A player who only shows up once a week still counts." })}`
    ),
    tile(
      "players-tile-newtoday",
      `New players today ${infoMarker({ what: "First-ever answer was today.", where: "Players tab.", example: "Your own test browsers played before, so they count as returning — a 0 here with active testers is correct, not broken." })}`
    ),
  ].join("");
  countUpTile($("players-tile-total"), s.totalPlayers, (n) => n.toLocaleString());
  countUpTile($("players-tile-dau"), s.dau, (n) => n.toLocaleString());
  countUpTile($("players-tile-wau"), s.wau, (n) => n.toLocaleString());
  countUpTile($("players-tile-newtoday"), newToday, (n) => n.toLocaleString());

  const max = Math.max(1, ...s.cohort.map((d) => d.newPlayers));
  const el = $("players-cohort");
  el.innerHTML = "";
  s.cohort.forEach((d) => {
    const b = document.createElement("div");
    b.style.height = (d.newPlayers / max) * 100 + "%";
    el.appendChild(b);
    ChartTooltip.bind(
      b,
      `<div class="ctt-label">${prettyDate(d.day)}</div><div class="ctt-row"><span>New players</span><b>${d.newPlayers.toLocaleString()}</b></div>`
    );
  });
}

function truncateId(id) {
  return id.length > 14 ? id.slice(0, 10) + "…" + id.slice(-4) : id;
}

async function renderFlaggedTable() {
  const s = await getPlayersSummaryCached();
  const tbody = $("players-flagged-tbody");
  if (!s.flagged.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="note" style="padding:20px 10px">No flags today — quiet is good.</td></tr>`;
    return;
  }
  tbody.innerHTML = s.flagged
    .map((f) => {
      const reasons = [];
      if (f.rejectionsToday > 5) reasons.push(`${f.rejectionsToday} rejections`);
      if (f.blocked) reasons.push("blocked");
      return `
      <tr>
        <td><a href="#" class="player-open-link" data-player="${escapeHtml(f.playerId)}" style="font-family:ui-monospace,monospace">${escapeHtml(truncateId(f.playerId))}</a></td>
        <td>${reasons.map((r) => `<span class="tag ${f.blocked ? "bad" : "warn"}">${escapeHtml(r)}</span>`).join(" ")}</td>
        <td>${f.rejectionsToday.toLocaleString()}</td>
        <td>${f.blocked ? "🚫 blocked" : "—"}</td>
        <td>
          ${f.blocked ? `<button class="btn ghost sm player-unblock-btn" data-player="${escapeHtml(f.playerId)}">Unblock</button>` : `<button class="btn ghost sm player-block-btn" data-player="${escapeHtml(f.playerId)}">Block</button>`}
        </td>
      </tr>`;
    })
    .join("");

  tbody.querySelectorAll(".player-open-link").forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      openPlayerDetail(a.dataset.player);
    };
  });
  tbody.querySelectorAll(".player-block-btn").forEach((btn) => {
    btn.onclick = () => confirmBlock(btn.dataset.player, true);
  });
  tbody.querySelectorAll(".player-unblock-btn").forEach((btn) => {
    btn.onclick = () => confirmBlock(btn.dataset.player, false);
  });
}

function wirePlayersLookup() {
  const btn = $("player-lookup-btn");
  const input = $("player-lookup-input");
  btn.onclick = () => {
    const id = input.value.trim();
    if (!id) return;
    openPlayerDetail(id);
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") btn.click();
  };
}

function wirePlayersExport() {
  $("players-export-btn").onclick = async () => {
    try {
      await exportPlayersCsv();
    } catch (err) {
      toast("Export failed.");
    }
  };
}

async function openPlayerDetail(playerId) {
  const mount = $("player-detail-mount");
  mount.innerHTML = `<div class="note" style="margin-top:10px">Loading…</div>`;
  let detail;
  try {
    detail = await getPlayerDetail(playerId);
  } catch (err) {
    if (err instanceof AdminAuthError) throw err;
    mount.innerHTML = `<div class="note" style="margin-top:10px;color:var(--coral)">No answers found for that player_id.</div>`;
    return;
  }
  renderPlayerDetailCard(mount, detail);
}

function renderPlayerDetailCard(mount, detail) {
  const today = utcTodayKey();
  const rows = detail.days
    .map((d) => {
      const isToday = d.day === today;
      const pick = isToday ? `<span class="note">open day — pick hidden</span>` : `<span style="font-family:ui-monospace,monospace">${escapeHtml(JSON.stringify(d.answer))}</span>`;
      const action = isToday ? "" : `<button class="btn ghost sm player-invalidate-btn" data-day="${d.day}">Invalidate</button>`;
      return `<tr><td>${d.day}</td><td>${pick}</td><td>${action}</td></tr>`;
    })
    .join("");

  mount.innerHTML = `
    <div class="card" style="margin-top:14px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
        <div>
          <div style="font-family:ui-monospace,monospace;font-weight:700">${escapeHtml(detail.playerId)}</div>
          <div class="sub" style="margin:4px 0 0">First seen ${detail.firstSeen} · ${detail.daysPlayed} days played · ${detail.shares.length} shares · ${detail.rejections.reduce((a, r) => a + r.count, 0)} rejections${detail.blocked ? " · 🚫 blocked" : ""}</div>
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0">
          ${detail.blocked ? `<button class="btn ghost sm" id="pd-unblock-btn">Unblock</button>` : `<button class="btn ghost sm" id="pd-block-btn">Block</button>`}
          <button class="btn danger sm" id="pd-delete-btn">Delete</button>
        </div>
      </div>
      <table style="margin-top:14px">
        <thead><tr><th>Day</th><th>Pick</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="3" class="note" style="padding:14px 0">No days played.</td></tr>`}</tbody>
      </table>
    </div>`;

  if (detail.blocked) {
    mount.querySelector("#pd-unblock-btn").onclick = () => confirmBlock(detail.playerId, false, () => openPlayerDetail(detail.playerId));
  } else {
    mount.querySelector("#pd-block-btn").onclick = () => confirmBlock(detail.playerId, true, () => openPlayerDetail(detail.playerId));
  }
  mount.querySelector("#pd-delete-btn").onclick = () => confirmDelete(detail.playerId);
  mount.querySelectorAll(".player-invalidate-btn").forEach((btn) => {
    btn.onclick = () => confirmInvalidate(detail.playerId, btn.dataset.day);
  });
}

function confirmBlock(playerId, blocking, onDone) {
  openModal(`
    <div class="modal-head">
      <h2>${blocking ? "Block" : "Unblock"} this player?</h2>
      <button class="modal-close" id="modal-close-btn">×</button>
    </div>
    <div class="modal-sub">${
      blocking
        ? "Shadow-block: their future submissions are silently rejected, but they get the exact same success response a real submission would — they never learn they're blocked. They can still view the site normally."
        : "Their submissions will be accepted again."
    }</div>
    <div class="modal-actions">
      <button class="btn ghost" id="modal-cancel-btn">Cancel</button>
      <button class="btn ${blocking ? "danger" : ""}" id="modal-confirm-btn">${blocking ? "Block" : "Unblock"}</button>
    </div>`);
  $("modal-close-btn").onclick = closeModal;
  $("modal-cancel-btn").onclick = closeModal;
  $("modal-confirm-btn").onclick = async () => {
    try {
      const result = blocking ? await blockPlayer(playerId) : await unblockPlayer(playerId);
      closeModal();
      toast(`${result.playerId} is now ${result.blocked ? "blocked" : "unblocked"}.`);
      await renderFlaggedTable();
      if (onDone) onDone();
    } catch (err) {
      closeModal();
      toast("Action failed.");
    }
  };
}

function confirmInvalidate(playerId, day) {
  openModal(`
    <div class="modal-head">
      <h2>Invalidate ${day}?</h2>
      <button class="modal-close" id="modal-close-btn">×</button>
    </div>
    <div class="modal-sub">Deletes this player's answer for ${day} and re-runs that day's tally immediately. Only closed days can be invalidated — today self-corrects at tonight's tally.</div>
    <div class="modal-actions">
      <button class="btn ghost" id="modal-cancel-btn">Cancel</button>
      <button class="btn danger" id="modal-confirm-btn">Invalidate</button>
    </div>`);
  $("modal-close-btn").onclick = closeModal;
  $("modal-cancel-btn").onclick = closeModal;
  $("modal-confirm-btn").onclick = async () => {
    try {
      const result = await invalidatePlayerDay(playerId, day);
      closeModal();
      toast(`Invalidated ${day} — retallied (${result.retally.players} players, ${result.retally.bots} bots).`);
      await openPlayerDetail(playerId);
    } catch (err) {
      closeModal();
      toast("Invalidate failed.");
    }
  };
}

function confirmDelete(playerId) {
  openModal(`
    <div class="modal-head">
      <h2>Delete all data for this player?</h2>
      <button class="modal-close" id="modal-close-btn">×</button>
    </div>
    <div class="modal-sub">Removes every answer, share, and rejection record for <span style="font-family:ui-monospace,monospace">${escapeHtml(playerId)}</span>. Closed days they played within the last 7 days are re-tallied afterward so totals stay honest. Aggregate results blobs are left untouched. This cannot be undone.</div>
    <div class="reset-confirm-field">
      <label style="display:block;font-size:12px;font-weight:700;color:var(--muted);letter-spacing:0.05em;text-transform:uppercase;margin-bottom:6px">Type DELETE to confirm</label>
      <input type="text" id="delete-confirm-input" autocomplete="off">
    </div>
    <div class="modal-actions">
      <button class="btn ghost" id="modal-cancel-btn">Cancel</button>
      <button class="btn danger" id="modal-confirm-btn" disabled>Delete</button>
    </div>`);
  $("modal-close-btn").onclick = closeModal;
  $("modal-cancel-btn").onclick = closeModal;
  const input = $("delete-confirm-input");
  const confirmBtn = $("modal-confirm-btn");
  input.oninput = () => {
    confirmBtn.disabled = input.value.trim() !== "DELETE";
  };
  confirmBtn.onclick = async () => {
    try {
      const result = await deletePlayer(playerId);
      closeModal();
      toast(`Deleted ${result.deletedDays} days of data for ${playerId}.`);
      $("player-detail-mount").innerHTML = "";
      await renderFlaggedTable();
    } catch (err) {
      closeModal();
      toast("Delete failed.");
    }
  };
}
