/* =====================================================
   OUTGUESSR — Phase 1 (static, simulated crowd data)
===================================================== */
const $ = (id) => document.getElementById(id);

const KEYS = {
  playerId: "og_player_id",
  streak: "og_streak",
  lastPlayed: "og_last_played",
  points: "og_points",
  history: "og_history",
};

/* ---------- date helpers (player's local date) ---------- */
function pad2(n) {
  return String(n).padStart(2, "0");
}
function dateKeyFromDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function todayKey() {
  return dateKeyFromDate(new Date());
}
function shiftDateKey(key, deltaDays) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  return dateKeyFromDate(dt);
}
function prettyDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d)
    .toLocaleDateString("en-US", { month: "short", day: "numeric" })
    .toUpperCase();
}

/* ---------- localStorage state ---------- */
function uid() {
  return "p_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
function loadState() {
  let playerId = localStorage.getItem(KEYS.playerId);
  if (!playerId) {
    playerId = uid();
    localStorage.setItem(KEYS.playerId, playerId);
  }
  return {
    playerId,
    streak: parseInt(localStorage.getItem(KEYS.streak) || "0", 10),
    lastPlayed: localStorage.getItem(KEYS.lastPlayed) || null,
    points: parseInt(localStorage.getItem(KEYS.points) || "0", 10),
    history: JSON.parse(localStorage.getItem(KEYS.history) || "{}"),
  };
}
function saveState(state) {
  localStorage.setItem(KEYS.streak, String(state.streak));
  localStorage.setItem(KEYS.lastPlayed, state.lastPlayed || "");
  localStorage.setItem(KEYS.points, String(state.points));
  localStorage.setItem(KEYS.history, JSON.stringify(state.history));
}
function recordPlay(state, dateKey, entry) {
  const yesterday = shiftDateKey(dateKey, -1);
  if (state.lastPlayed === yesterday) state.streak += 1;
  else if (state.lastPlayed !== dateKey) state.streak = 1;
  state.lastPlayed = dateKey;
  state.points += entry.result.pts;
  state.history[dateKey] = entry;
  saveState(state);
}

/* ---------- pick a challenge for the player's local date ---------- */
function resolveChallengeKey(challenges, key) {
  if (challenges[key]) return key;
  const past = Object.keys(challenges).filter((k) => k <= key).sort();
  if (past.length) return past[past.length - 1];
  return Object.keys(challenges).sort()[0];
}

/* ---------- scoring helpers shared across formats ---------- */
function bucketIndex(v) {
  return Math.min(19, Math.max(0, Math.floor(v / 5)));
}
function weightedAvg(buckets) {
  let total = 0;
  let count = 0;
  buckets.forEach((c, i) => {
    const center = i * 5 + 2.5;
    total += center * c;
    count += c;
  });
  return count ? total / count : 0;
}
function topPercentileFromDist(dist) {
  if (dist <= 2) return 5;
  if (dist <= 5) return 13;
  if (dist <= 10) return 28;
  if (dist <= 20) return 55;
  return 90;
}
function badgeForTop(top) {
  if (top <= 5) return { badge: "🧠", headline: "Mastermind." };
  if (top <= 25) return { badge: "⚡", headline: "Sharp read." };
  if (top <= 60) return { badge: "🐑", headline: "Mid-herd." };
  return { badge: "🙈", headline: "The herd got you." };
}
function ptsFromTop(top) {
  return Math.max(5, 100 - top);
}

/* ---------- format handlers ---------- */
const FORMATS = {
  crunch: {
    label: "Crowd Crunch",
    icon: "🎯",
    buildInput(mount, challenge, onChange) {
      mount.innerHTML = `
        <div class="num-display" id="numval">50</div>
        <input type="range" min="0" max="100" value="50" id="slider">
        <div class="range-labels"><span>0</span><span>50</span><span>100</span></div>`;
      const slider = mount.querySelector("#slider");
      slider.oninput = () => {
        mount.querySelector("#numval").textContent = slider.value;
        onChange(+slider.value);
      };
    },
    pickLabel(pick) {
      return String(pick);
    },
    resolve(challenge, pick) {
      const dist = Math.abs(pick - challenge.target);
      const top = topPercentileFromDist(dist);
      const { badge, headline } = badgeForTop(top);
      return {
        badge,
        headline,
        topPct: top,
        pts: ptsFromTop(top),
        chart: {
          buckets: challenge.crowd,
          youIndex: bucketIndex(pick),
          winIndexes: [bucketIndex(challenge.target)],
        },
        axis: ["0", "25", "50", "75", "100"],
        stats: [
          ["Target", challenge.target],
          ["Your pick", pick],
          ["Crowd avg", weightedAvg(challenge.crowd).toFixed(1)],
        ],
        story: challenge.roast,
        shareLine: `Top ${top}% · picked ${pick}, target ${challenge.target}`,
      };
    },
  },

  herdmeter: {
    label: "Herd Meter",
    icon: "📊",
    buildInput(mount, challenge, onChange) {
      mount.innerHTML = `
        <div class="num-display" id="numval">50%</div>
        <input type="range" min="0" max="100" value="50" id="slider">
        <div class="range-labels"><span>0%</span><span>50%</span><span>100%</span></div>`;
      const slider = mount.querySelector("#slider");
      slider.oninput = () => {
        mount.querySelector("#numval").textContent = slider.value + "%";
        onChange(+slider.value);
      };
    },
    pickLabel(pick) {
      return pick + "%";
    },
    resolve(challenge, pick) {
      const dist = Math.abs(pick - challenge.target);
      const top = topPercentileFromDist(dist);
      const { badge, headline } = badgeForTop(top);
      return {
        badge,
        headline,
        topPct: top,
        pts: ptsFromTop(top),
        chart: {
          buckets: challenge.crowd,
          youIndex: bucketIndex(pick),
          winIndexes: [bucketIndex(challenge.target)],
        },
        axis: ["0%", "25%", "50%", "75%", "100%"],
        stats: [
          ["Truth", challenge.target + "%"],
          ["Your guess", pick + "%"],
          ["Off by", dist + " pts"],
        ],
        story: challenge.roast,
        shareLine: `guessed ${pick}% · truth ${challenge.target}% · top ${top}%`,
      };
    },
  },

  oddonein: {
    label: "Odd One In",
    icon: "🚪",
    buildInput(mount, challenge, onChange) {
      mount.innerHTML = `<div class="choices row" id="ch"></div>`;
      const ch = mount.querySelector("#ch");
      challenge.options.forEach((o, i) => {
        const b = document.createElement("div");
        b.className = "choice";
        b.innerHTML = `<span class="big">${o.icon}</span><span style="font-size:12px">${o.label}</span>`;
        b.onclick = () => {
          ch.querySelectorAll(".choice").forEach((c) => c.classList.remove("sel"));
          b.classList.add("sel");
          onChange(i);
        };
        ch.appendChild(b);
      });
    },
    pickLabel(pick, challenge) {
      const o = challenge.options[pick];
      return `${o.icon} ${o.label}`;
    },
    resolve(challenge, pick) {
      const crowd = challenge.crowd;
      const n = crowd.length;
      const winIndex = crowd.indexOf(Math.min(...crowd));
      const mostIndex = crowd.indexOf(Math.max(...crowd));
      const ranked = crowd.map((_, i) => i).sort((a, b) => crowd[a] - crowd[b]);
      const rank = ranked.indexOf(pick);
      const top = Math.round(5 + (rank / (n - 1)) * 85);
      const win = pick === winIndex;
      const badge = win ? "🧠" : top <= 30 ? "⚡" : "🙈";
      const headline = win ? "Odd one in!" : top <= 30 ? "So close." : "Right through the popular door.";
      return {
        badge,
        headline,
        topPct: top,
        pts: ptsFromTop(top),
        chart: { buckets: crowd, youIndex: pick, winIndexes: [winIndex] },
        axis: challenge.options.map((o) => o.label),
        stats: [
          ["Winner", `${challenge.options[winIndex].label} ${crowd[winIndex]}%`],
          ["Your pick", challenge.options[pick].label],
          ["Most picked", `${challenge.options[mostIndex].label} ${crowd[mostIndex]}%`],
        ],
        story: challenge.roast,
        shareLine: win ? `ODD ONE IN · top ${top}%` : `Herded · top ${top}%`,
      };
    },
  },

  splitsteal: {
    label: "Split or Steal",
    icon: "🤝",
    buildInput(mount, challenge, onChange) {
      mount.innerHTML = `<div class="choices" id="ch"></div>`;
      const ch = mount.querySelector("#ch");
      const opts = [
        { icon: "🤝", label: "SPLIT", small: "Both split → 50 pts each" },
        { icon: "🗡️", label: "STEAL", small: "They split → you take 100" },
      ];
      opts.forEach((o, i) => {
        const b = document.createElement("div");
        b.className = "choice";
        b.innerHTML = `<span class="big">${o.icon}</span>${o.label}<small>${o.small}</small>`;
        b.onclick = () => {
          ch.querySelectorAll(".choice").forEach((c) => c.classList.remove("sel"));
          b.classList.add("sel");
          onChange(i);
        };
        ch.appendChild(b);
      });
    },
    pickLabel(pick) {
      return pick === 0 ? "🤝 SPLIT" : "🗡️ STEAL";
    },
    resolve(challenge, pick) {
      const splitPct = challenge.crowd[0];
      const partnerSplits = Math.random() * 100 < splitPct;
      const split = pick === 0;
      let pts, badge, headline;
      if (split && partnerSplits) {
        pts = 50;
        badge = "🤝";
        headline = "Both split. Honor intact.";
      } else if (!split && partnerSplits) {
        pts = 100;
        badge = "🗡️";
        headline = "You stole from a splitter.";
      } else if (split && !partnerSplits) {
        pts = 0;
        badge = "😬";
        headline = "You got played.";
      } else {
        pts = 0;
        badge = "💀";
        headline = "Mutual destruction.";
      }
      const top = split ? (partnerSplits ? 38 : 70) : partnerSplits ? 12 : 70;
      return {
        badge,
        headline,
        topPct: top,
        pts,
        chart: { buckets: challenge.crowd, youIndex: pick, winIndexes: [] },
        axis: [`SPLIT ${challenge.crowd[0]}%`, `STEAL ${challenge.crowd[1]}%`],
        stats: [
          ["You", split ? "SPLIT" : "STEAL"],
          ["Partner", partnerSplits ? "SPLIT" : "STEAL"],
          ["Payout", pts + " pts"],
        ],
        story: challenge.roast,
        shareLine: `${split && partnerSplits ? "both split" : partnerSplits ? "clean steal" : "mutual steal"} +${pts} pts`,
      };
    },
  },
};

/* ---------- app state ---------- */
let state, challenges, activeKey, activeChallenge, currentPick;

async function init() {
  state = loadState();
  updateHeader();
  renderCountdown();
  setInterval(renderCountdown, 30000);

  try {
    const res = await fetch("challenges.json");
    challenges = await res.json();
  } catch (err) {
    $("challenge-mount").innerHTML = `
      <div class="card">
        <div class="prompt">Couldn't load today's challenge.</div>
        <div class="subprompt">If you're running this locally, serve the folder with a local web server (fetch of challenges.json needs http://, not file://).</div>
      </div>`;
    return;
  }

  activeKey = resolveChallengeKey(challenges, todayKey());
  activeChallenge = challenges[activeKey];

  $("daynum").textContent = `DAILY #${activeChallenge.number} · ${prettyDate(activeKey)}`;

  renderHomeArea();
  show("screen-home");

  $("backFromSealed").onclick = goHome;
  $("backFromReveal").onclick = goHome;
  $("tryAgainBtn").onclick = goHome;
  $("copyBtn").onclick = copyShare;
}

function updateHeader() {
  $("streak").textContent = state.streak;
  $("brainpts").textContent = state.points.toLocaleString();
}

function renderCountdown() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  const diffMins = Math.max(0, Math.floor((next - now) / 60000));
  $("cd").textContent = `${Math.floor(diffMins / 60)}h ${diffMins % 60}m`;
}

function show(id) {
  ["screen-home", "screen-sealed", "screen-reveal"].forEach((s) => $(s).classList.add("hidden"));
  $(id).classList.remove("hidden");
  window.scrollTo({ top: 0 });
}

function renderHomeArea() {
  const mount = $("challenge-mount");
  const entry = state.history[activeKey];

  if (entry) {
    const fmt = FORMATS[entry.format];
    mount.innerHTML = `
      <div class="card sealed">
        <div class="lock">✅</div>
        <h2>Today's answer is locked in.</h2>
        <p>You picked <b>${fmt.pickLabel(entry.pick, activeChallenge)}</b>. Come back tomorrow for a new one.</p>
        <button class="btn" id="viewRevealBtn">See your reveal</button>
      </div>`;
    $("viewRevealBtn").onclick = () => showReveal(entry);
    return;
  }

  const fmt = FORMATS[activeChallenge.format];
  mount.innerHTML = `
    <div class="card">
      <span class="mode-tag">${fmt.icon} ${fmt.label} · TODAY</span>
      <div class="prompt">${activeChallenge.prompt}</div>
      <div class="subprompt">${activeChallenge.sub}</div>
      <div id="input-zone"></div>
      <button class="btn" id="lockbtn" disabled>Lock it in 🔒</button>
    </div>`;
  currentPick = null;
  fmt.buildInput($("input-zone"), activeChallenge, (pick) => {
    currentPick = pick;
    $("lockbtn").disabled = false;
  });
  $("lockbtn").onclick = lockIn;
}

function lockIn() {
  if (currentPick === null) return;
  const fmt = FORMATS[activeChallenge.format];
  const result = fmt.resolve(activeChallenge, currentPick);
  const entry = { format: activeChallenge.format, pick: currentPick, result };
  recordPlay(state, activeKey, entry);
  updateHeader();

  $("sealed-pick").textContent = "Your pick: " + fmt.pickLabel(currentPick, activeChallenge);
  $("sealed-factoid").innerHTML = activeChallenge.factoid || "";
  $("sealedViewReveal").onclick = () => showReveal(entry);
  show("screen-sealed");
}

function showReveal(entry) {
  const fmt = FORMATS[entry.format];
  Reveal.render($("reveal-mount"), entry.result, { viewerLabel: "YOU" });
  const shareText = Reveal.shareCard(entry.result, {
    number: activeChallenge.number,
    icon: fmt.icon,
    label: fmt.label,
    streak: state.streak,
  });
  $("sharecard").textContent = shareText;
  $("copied").textContent = "";
  show("screen-reveal");
}

function goHome() {
  renderHomeArea();
  show("screen-home");
}

function copyShare() {
  const txt = $("sharecard").textContent;
  if (navigator.clipboard) navigator.clipboard.writeText(txt).catch(() => {});
  $("copied").textContent = "Copied! Go start an argument in the group chat.";
}

document.addEventListener("DOMContentLoaded", init);
