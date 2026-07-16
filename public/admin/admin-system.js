/* =====================================================
   admin-system.js — System section.

   Cron health (last 14 runs), manual re-tally (the "cron failed at
   3am" fix from ADMIN-PANEL-PLAN.md), D1 row counts, and today's
   open/closed state machine (force-close / reopen / reset). Everything
   here reads/writes through admin-api.js, all admin-key gated.
   AdminAuthError isn't caught here — activateSection() is the single
   place that drops back to the login gate.
===================================================== */

async function renderSystemSection() {
  await Promise.all([renderTodayStateCard(), renderSystemData()]);
  wireRetallyControl();
}
SECTION_ACTIVATORS["s-system"] = renderSystemSection;

function cronStatusTag(run) {
  return run.ok ? `<span class="tag ok">OK</span>` : `<span class="tag bad">FAILED</span>`;
}

async function renderSystemData() {
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
}

/* ---------- today's OPEN/CLOSED EARLY state ----------
   One card, two possible bodies. Every action (close/reopen/reset)
   renders straight from its own response — {closedDay, answers,
   hasResults} — rather than re-fetching, per CLAUDE.md's force-close
   state machine section. */
async function renderTodayStateCard() {
  const stats = await getTodayStats();
  renderTodayStateFrom({ closedDay: stats.todayClosed ? stats.today : null, answers: stats.realPlayers, hasResults: stats.hasResults });
}

function renderTodayStateFrom(state) {
  const el = $("sys-today-state");
  if (state.closedDay) {
    el.innerHTML = `
      <div class="state-chip closed">🔒 CLOSED EARLY</div>
      <div class="sub" style="margin:10px 0 14px">${state.answers.toLocaleString()} real answers${state.hasResults ? " · results are live" : " · results not yet computed"}.</div>
      <div class="modal-actions">
        <button class="btn ghost" id="sys-reopen-btn">Reopen today</button>
        <button class="btn danger" id="sys-reset-btn">Reset today</button>
      </div>`;
    wireReopenReset();
  } else {
    el.innerHTML = `
      <div class="state-chip open">🟢 OPEN</div>
      <div class="sub" style="margin:10px 0 14px">Accepting submissions normally — ${state.answers.toLocaleString()} so far today.</div>
      <button class="btn danger" id="sys-close-btn">Force-close today</button>`;
    wireForceClose();
  }
  // The status bar's own chip is driven by getTodayStats() independently
  // (it polls today's state on every renderStatusBar call) — refresh it
  // here too so it doesn't wait for the next full status-bar cycle. Not
  // part of the activateSection() call stack, so it needs its own
  // AdminAuthError handling to still honor "any 401 anywhere → login".
  renderStatusBar().catch((err) => {
    if (err instanceof AdminAuthError) showLoginView("Session expired — enter your key again.");
  });
}

function wireForceClose() {
  $("sys-close-btn").onclick = () => {
    openModal(`
      <div class="modal-head">
        <h2>Force-close today?</h2>
        <button class="modal-close" id="modal-close-btn">×</button>
      </div>
      <div class="modal-sub">Stops submissions AND publishes results immediately — today becomes a finished day right now, not just a locked one. The normal 00:03 UTC cron still fires later; re-tallying an already-closed day is harmless.</div>
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
        toast(`Closed — ${result.answers.toLocaleString()} real answers, results are live.`);
        renderTodayStateFrom(result);
      } catch (err) {
        closeModal();
        toast("Force-close failed.");
      }
    };
  };
}

function wireReopenReset() {
  $("sys-reopen-btn").onclick = () => {
    openModal(`
      <div class="modal-head">
        <h2>Reopen today?</h2>
        <button class="modal-close" id="modal-close-btn">×</button>
      </div>
      <div class="modal-sub">Deletes today's published results — submissions resume immediately. Raw answers are untouched.</div>
      <div class="modal-actions">
        <button class="btn ghost" id="modal-cancel-btn">Cancel</button>
        <button class="btn danger" id="modal-confirm-reopen-btn">Reopen today</button>
      </div>`);
    $("modal-close-btn").onclick = closeModal;
    $("modal-cancel-btn").onclick = closeModal;
    $("modal-confirm-reopen-btn").onclick = async () => {
      try {
        const result = await reopenToday();
        closeModal();
        toast("Reopened — submissions resumed, results taken down.");
        renderTodayStateFrom(result);
      } catch (err) {
        closeModal();
        toast("Reopen failed.");
      }
    };
  };

  $("sys-reset-btn").onclick = () => {
    openModal(`
      <div class="modal-head">
        <h2>Reset today?</h2>
        <button class="modal-close" id="modal-close-btn">×</button>
      </div>
      <div class="modal-sub">Deletes today's answers AND results — the day starts over from zero. This cannot be undone.</div>
      <div class="reset-confirm-field">
        <label style="display:block;font-size:12px;font-weight:700;color:var(--muted);letter-spacing:0.05em;text-transform:uppercase;margin-bottom:6px">Type RESET to confirm</label>
        <input type="text" id="reset-confirm-input" autocomplete="off">
      </div>
      <div class="modal-actions">
        <button class="btn ghost" id="modal-cancel-btn">Cancel</button>
        <button class="btn danger" id="modal-confirm-reset-btn" disabled>Reset today</button>
      </div>`);
    $("modal-close-btn").onclick = closeModal;
    $("modal-cancel-btn").onclick = closeModal;
    const input = $("reset-confirm-input");
    const confirmBtn = $("modal-confirm-reset-btn");
    input.oninput = () => {
      confirmBtn.disabled = input.value.trim() !== "RESET";
    };
    confirmBtn.onclick = async () => {
      try {
        const result = await resetToday();
        closeModal();
        toast(`Reset — deleted ${result.deleted.answers.toLocaleString()} answers.`);
        renderTodayStateFrom(result);
      } catch (err) {
        closeModal();
        toast("Reset failed.");
      }
    };
  };
}

function wireRetallyControl() {
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
      toast("Re-tally request failed.");
    } finally {
      btn.disabled = false;
    }
  };
}
