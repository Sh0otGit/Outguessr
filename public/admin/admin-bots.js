/* =====================================================
   admin-bots.js — Bots section (cold-start blending controls).

   Reads/writes /api/admin/config (bot_floor, bots_enabled) through
   admin-api.js's getBotConfig/setBotConfig. Per-format bot *profiles*
   aren't a separate control here — CLAUDE.md's Bot blending section is
   explicit that bots always sample from each challenge's own authored
   crowd distribution (the same array the Calendar/Challenges editor
   already writes), so there's nothing extra to configure per format —
   this section just says so.
===================================================== */

async function renderBotsSection() {
  await renderBotsData();
}
SECTION_ACTIVATORS["s-bots"] = renderBotsSection;

async function renderBotsData() {
  try {
    const [config, stats] = await Promise.all([getBotConfig(), getTodayStats()]);
    $("bots-body").innerHTML = `
      <div class="card">
        <h3>Bot floor</h3>
        <div class="sub" style="margin-bottom:14px">bots = max(0, floor − real players) — they retire themselves automatically as the game grows.</div>
        <div class="bot-slider-row">
          <input type="range" min="0" max="500" step="10" value="${config.botFloor}" id="bots-floor-slider">
          <div class="bot-slider-value" id="bots-floor-value">${config.botFloor}</div>
        </div>
        <button class="btn sm" id="bots-floor-save" style="margin-top:12px" disabled>Save floor</button>
      </div>

      <div class="card">
        <h3>Kill switch</h3>
        <div class="sub" style="margin-bottom:14px">Turns off bot blending entirely — every day's tally reflects real submitted answers only, however few.</div>
        <label class="toggle-switch">
          <input type="checkbox" id="bots-enabled-toggle" ${config.botsEnabled ? "checked" : ""}>
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
          <span class="toggle-label">${config.botsEnabled ? "Bots ON" : "Bots OFF"}</span>
        </label>
      </div>

      <div class="card">
        <h3>Today's projected blend</h3>
        <div class="blend-line">${stats.realPlayers.toLocaleString()} real + ${stats.bots.toLocaleString()} bots = ${stats.submissionsTotal.toLocaleString()} total${config.botsEnabled ? "" : " <span style=\"color:var(--coral)\">(bots OFF)</span>"}</div>
      </div>

      <div class="card">
        <h3>Per-format bot profiles</h3>
        <div class="note" style="margin-top:0">There's nothing to configure here — bots always sample from that day's own authored <b>crowd</b> distribution (the same field the Calendar/Challenges editor writes), so a cold-start day keeps exactly the shape you designed for it. Edit a challenge's crowd distribution in the Calendar tab to change what its bots answer with.</div>
      </div>`;

    wireBotsControls(config);
  } catch (err) {
    if (!(err instanceof AdminAuthError)) throw err;
    $("bots-body").innerHTML = unauthorizedCardHtml("Bot settings");
    wireUnauthorizedRetry(renderBotsData);
  }
}

function wireBotsControls(config) {
  const slider = $("bots-floor-slider");
  const value = $("bots-floor-value");
  const saveBtn = $("bots-floor-save");
  slider.oninput = () => {
    value.textContent = slider.value;
    saveBtn.disabled = Number(slider.value) === config.botFloor;
  };
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try {
      await setBotConfig({ botFloor: Number(slider.value) });
      toast(`Bot floor set to ${slider.value}.`);
      await renderBotsData();
    } catch (err) {
      toast(err instanceof AdminAuthError ? "Admin key required." : "Couldn't save bot floor.");
      saveBtn.disabled = false;
    }
  };

  const toggle = $("bots-enabled-toggle");
  toggle.onchange = () => {
    const goingTo = toggle.checked;
    // Revert immediately — the actual flip only happens after
    // confirmation, so the checkbox never visually lies about the
    // saved state while the modal is open.
    toggle.checked = !goingTo;
    openModal(`
      <div class="modal-head">
        <h2>${goingTo ? "Turn bots ON?" : "Turn bots OFF?"}</h2>
        <button class="modal-close" id="modal-close-btn">×</button>
      </div>
      <div class="modal-sub">${
        goingTo
          ? "Every tally from now on blends bot answers up to the floor again."
          : "Every tally from now on reflects real submitted answers only — a quiet day could ship a results blob with only a handful of players in it."
      }</div>
      <div class="modal-actions">
        <button class="btn ghost" id="modal-cancel-btn">Cancel</button>
        <button class="btn ${goingTo ? "" : "danger"}" id="modal-confirm-toggle-btn">${goingTo ? "Turn bots ON" : "Turn bots OFF"}</button>
      </div>`);
    $("modal-close-btn").onclick = closeModal;
    $("modal-cancel-btn").onclick = closeModal;
    $("modal-confirm-toggle-btn").onclick = async () => {
      try {
        await setBotConfig({ botsEnabled: goingTo });
        closeModal();
        toast(`Bots turned ${goingTo ? "ON" : "OFF"}.`);
        await renderBotsData();
      } catch (err) {
        closeModal();
        toast(err instanceof AdminAuthError ? "Admin key required." : "Couldn't update the kill switch.");
      }
    };
  };
}
