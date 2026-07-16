/* =====================================================
   admin-bots.js — Bots section (cold-start blending controls).

   Reads/writes /api/admin/config (bot_floor, bots_enabled) through
   admin-api.js's getBotConfig/setBotConfig. Per-format bot *profiles*
   aren't a separate control here — CLAUDE.md's Bot blending section is
   explicit that bots always sample from each challenge's own authored
   crowd distribution (the same array the Calendar/Challenges editor
   already writes), so there's nothing extra to configure per format —
   this section just says so.

   AdminAuthError isn't caught here — activateSection() is the single
   place that drops back to the login gate.
===================================================== */

const BOT_FLOOR_MAX = 10000;
const BOT_FLOOR_PRESETS = [0, 300, 1000, 10000];

async function renderBotsSection() {
  await renderBotsData();
}
SECTION_ACTIVATORS["s-bots"] = renderBotsSection;

async function renderBotsData() {
  const [config, count] = await Promise.all([getBotConfig(), getAdminCount(utcTodayKey())]);
  $("bots-body").innerHTML = `
    <div class="card">
      <h3>Bot floor</h3>
      <div class="sub" style="margin-bottom:14px">bots = max(0, floor − real players) — they retire themselves automatically as the game grows.</div>
      <div class="bot-slider-row">
        <input type="range" min="0" max="${BOT_FLOOR_MAX}" step="50" value="${config.botFloor}" id="bots-floor-slider">
        <input type="number" min="0" max="${BOT_FLOOR_MAX}" step="50" value="${config.botFloor}" id="bots-floor-number">
      </div>
      <div class="bot-presets">
        ${BOT_FLOOR_PRESETS.map((p) => `<button class="btn ghost sm" data-preset="${p}">${p.toLocaleString()}</button>`).join("")}
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
      <div class="sub" style="margin-bottom:10px">Both blends from the one canonical source ${infoMarker({
        what: "Lobby vs. tally blend",
        where: "src/index.js's computeTodayNumbers — the single place bot math is computed, everywhere in the admin panel reads these same two numbers.",
        example: "Lobby count ramps smoothly from 0 to the floor over the UTC day (what players see). At tally tonight is the full, unramped floor projection — what the 00:03 UTC cron will actually blend in.",
      })}</div>
      <div class="blend-line">${count.real.toLocaleString()} real + ${count.lobbyBots.toLocaleString()} bots = ${count.lobbyCount.toLocaleString()}<span style="color:var(--muted)"> · Lobby count (what players see)</span></div>
      <div class="blend-line">${count.real.toLocaleString()} real + ${count.tallyBots.toLocaleString()} bots = ${count.tallyBlend.toLocaleString()}<span style="color:var(--muted)"> · At tally tonight</span>${config.botsEnabled ? "" : " <span style=\"color:var(--coral)\">(bots OFF)</span>"}</div>
    </div>

    <div class="card">
      <h3>Per-format bot profiles</h3>
      <div class="note" style="margin-top:0">There's nothing to configure here — bots always sample from that day's own authored <b>crowd</b> distribution (the same field the Calendar/Challenges editor writes), so a cold-start day keeps exactly the shape you designed for it. Edit a challenge's crowd distribution in the Calendar tab to change what its bots answer with.</div>
    </div>`;

  wireBotsControls(config);
}

function wireBotsControls(config) {
  const slider = $("bots-floor-slider");
  const number = $("bots-floor-number");
  const saveBtn = $("bots-floor-save");

  function syncFrom(source, value) {
    const clamped = Math.max(0, Math.min(BOT_FLOOR_MAX, Math.round(Number(value) || 0)));
    slider.value = clamped;
    number.value = clamped;
    saveBtn.disabled = clamped === config.botFloor;
  }

  slider.oninput = () => syncFrom("slider", slider.value);
  number.oninput = () => syncFrom("number", number.value);

  document.querySelectorAll("[data-preset]").forEach((btn) => {
    btn.onclick = () => syncFrom("preset", btn.dataset.preset);
  });

  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try {
      await setBotConfig({ botFloor: Number(slider.value) });
      toast(`Bot floor set to ${Number(slider.value).toLocaleString()}.`);
      await renderBotsData();
    } catch (err) {
      toast("Couldn't save bot floor.");
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
        toast("Couldn't update the kill switch.");
      }
    };
  };
}
