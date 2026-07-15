/* =====================================================
   admin-system.js — System section.

   Cron health (last 14 runs), manual re-tally (the "cron failed at
   3am" fix from ADMIN-PANEL-PLAN.md), D1 row counts, and the
   force-close emergency control. Everything here reads/writes through
   admin-api.js's getCronRuns/retallyDay/closeToday, all admin-key
   gated — see admin.js's unauthorizedCardHtml() for the degraded state.
===================================================== */

async function renderSystemSection() {
  wireSystemControls();
  await renderSystemData();
}
SECTION_ACTIVATORS["s-system"] = renderSystemSection;

function cronStatusTag(run) {
  return run.ok ? `<span class="tag ok">OK</span>` : `<span class="tag bad">FAILED</span>`;
}

async function renderSystemData() {
  try {
    const data = await getCronRuns();

    $("sys-tiles").innerHTML = [
      `<div class="tile"><div class="v">${data.errorRatePct}%</div><div class="k">Cron error rate (last ${data.errorRateWindow} runs)</div></div>`,
      `<div class="tile"><div class="v">${data.rowCounts.answers.toLocaleString()}</div><div class="k">answers rows</div></div>`,
      `<div class="tile"><div class="v">${data.rowCounts.results.toLocaleString()}</div><div class="k">results rows</div></div>`,
      `<div class="tile"><div class="v">${data.rowCounts.results_players.toLocaleString()}</div><div class="k">results_players rows</div></div>`,
      `<div class="tile"><div class="v">${data.rowCounts.cron_runs.toLocaleString()}</div><div class="k">cron_runs rows</div></div>`,
    ].join("");

    const tbody = $("sys-cron-tbody");
    if (!data.runs.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="note" style="padding:20px 10px">No cron runs yet.</td></tr>`;
    } else {
      tbody.innerHTML = data.runs
        .map(
          (r) => `
          <tr>
            <td>${r.day}</td>
            <td>${new Date(r.ran_at).toISOString().slice(11, 19)} UTC</td>
            <td>${r.duration_ms}ms</td>
            <td>${r.players}</td>
            <td>${r.bots}</td>
            <td>${cronStatusTag(r)}${r.error ? ` <span class="note" style="display:inline;color:var(--coral)">${escapeHtml(r.error)}</span>` : ""}</td>
          </tr>`
        )
        .join("");
    }
  } catch (err) {
    if (!(err instanceof AdminAuthError)) throw err;
    $("sys-body").innerHTML = unauthorizedCardHtml("System data");
    wireUnauthorizedRetry(renderSystemData);
  }
}

function wireSystemControls() {
  const btn = $("sys-retally-btn");
  if (btn.dataset.wired) return;
  btn.dataset.wired = "1";

  btn.onclick = async () => {
    const day = $("sys-retally-day").value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      toast("Enter a date as YYYY-MM-DD.");
      return;
    }
    btn.disabled = true;
    try {
      const result = await retallyDay(day);
      if (result.ok) {
        toast(`Re-tallied ${day} — ${result.players} players, ${result.bots} bots.`);
      } else {
        toast(`Re-tally failed for ${day}: ${result.error}`);
      }
      await renderSystemData();
    } catch (err) {
      if (err instanceof AdminAuthError) {
        toast("Admin key required — enter it and try again.");
      } else {
        toast("Re-tally request failed.");
      }
    } finally {
      btn.disabled = false;
    }
  };

  $("sys-close-btn").onclick = () => {
    openModal(`
      <div class="modal-head">
        <h2>Force-close today?</h2>
        <button class="modal-close" id="modal-close-btn">×</button>
      </div>
      <div class="modal-sub">Emergency only. Stops new submissions immediately — the normal 00:03 UTC cron still tallies today on schedule, just with fewer answers than it might otherwise have collected. This cannot be undone for today.</div>
      <div class="modal-actions">
        <button class="btn ghost" id="modal-cancel-btn">Cancel</button>
        <button class="btn danger" id="modal-confirm-close-btn">Force-close today</button>
      </div>`);
    $("modal-close-btn").onclick = closeModal;
    $("modal-cancel-btn").onclick = closeModal;
    $("modal-confirm-close-btn").onclick = async () => {
      try {
        const result = await closeToday();
        closeModal();
        toast(`Today (${result.closedDay}) is force-closed. New submissions will be rejected.`);
        renderStatusBar();
      } catch (err) {
        closeModal();
        toast(err instanceof AdminAuthError ? "Admin key required." : "Force-close failed.");
      }
    };
  };
}
