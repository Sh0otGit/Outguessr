/* =====================================================
   formats.js — the challenge format registry.

   Shared source of truth for how each format renders its
   input and scores a pick. Used by the public game (app.js)
   and by the admin panel's calendar preview — both load this
   file directly so there is exactly one implementation of
   "what a player sees and how it scores."
===================================================== */

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
