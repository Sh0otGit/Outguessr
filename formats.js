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
// Named pickRandom (not pick) because every resolve(challenge, pick) below
// already uses "pick" for the player's chosen index — same-scope collision.
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/* Escalating tone from elite to brutal — several variants per tier so the
   same result doesn't read the same way twice. Picked once per resolve()
   and frozen into the stored result, so it never changes on revisit. */
const RESULT_TIERS = [
  {
    max: 3,
    tier: "elite",
    badges: ["🐐", "👑", "🔮", "🏆"],
    headlines: ["Absolute mind reader.", "You ARE the crowd.", "Certified galaxy brain.", "This should be illegal."],
  },
  {
    max: 10,
    tier: "great",
    badges: ["🧠"],
    headlines: ["Mastermind.", "Scary good.", "Big brain energy.", "You saw it coming."],
  },
  {
    max: 25,
    tier: "good",
    badges: ["⚡"],
    headlines: ["Sharp read.", "Solid instincts.", "Better than most.", "Respectable."],
  },
  {
    max: 50,
    tier: "mid",
    badges: ["🐑"],
    headlines: ["Mid-herd.", "Perfectly average.", "You blended right in.", "Comfortably unremarkable."],
  },
  {
    max: 75,
    tier: "rough",
    badges: ["🙈"],
    headlines: ["The herd got you.", "Not your day.", "Read the room wrong.", "Swing and a miss."],
  },
  {
    max: Infinity,
    tier: "brutal",
    badges: ["💀", "🤡", "🚨"],
    headlines: [
      "Statistically impressive, actually.",
      "How did you even pick that?",
      "The crowd thanks you for your sacrifice.",
      "Reverse galaxy brain.",
    ],
  },
];

function badgeForTop(top) {
  const t = RESULT_TIERS.find((tier) => top <= tier.max);
  return { badge: pickRandom(t.badges), headline: pickRandom(t.headlines), tier: t.tier };
}

const ODDONEIN_WIN_BADGES = ["🧠", "🎯", "👑"];
const ODDONEIN_WIN_HEADLINES = ["Odd one in!", "You found the crack in the crowd.", "Nobody saw that coming — except you."];

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
      const { badge, headline, tier } = badgeForTop(top);
      return {
        badge,
        headline,
        tier,
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
    editorFields: [
      {
        id: "target",
        label: "Target",
        type: "number",
        min: 0,
        max: 100,
        tooltip: {
          what: "The winning number — the pick closest to two-thirds of today's crowd average wins.",
          where: "Shown in the reveal's stats grid as \"Target\", and used to score every player's percentile.",
          example: "Expect players to average around 40? Set target to about 27 (two-thirds of 40).",
        },
        getValue: (e) => (e ? e.target : 50),
        parse: (raw) => parseInt(raw, 10) || 0,
      },
      {
        id: "crowd",
        label: "Crowd distribution",
        type: "text",
        tooltip: {
          what: "20 comma-separated counts, one per 5-point bucket from 0–100, describing how many simulated players landed in each range.",
          where: "Drawn as the bar chart on the reveal screen — the shape players see and screenshot.",
          example: '"2,3,4,6,8,14,11,7,5,9,12,6,4,3,2,1,1,1,0,1" clusters the crowd around 25–30.',
        },
        getValue: (e) => (e ? e.crowd.join(",") : "2,3,4,6,8,14,11,7,5,9,12,6,4,3,2,1,1,1,0,1"),
        parse: (raw) => raw.split(",").map((s) => parseInt(s.trim(), 10) || 0),
      },
    ],
    validate(data) {
      const warnings = [];
      if (data.crowd.length !== 20) {
        warnings.push(`Crowd distribution has ${data.crowd.length} buckets — Crowd Crunch needs exactly 20.`);
      }
      if (data.target < 0 || data.target > 100) warnings.push("Target should be between 0 and 100.");
      return warnings;
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
      const { badge, headline, tier } = badgeForTop(top);
      return {
        badge,
        headline,
        tier,
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
    editorFields: [
      {
        id: "target",
        label: "Truth percentage",
        type: "number",
        min: 0,
        max: 100,
        tooltip: {
          what: "The real percentage of simulated players who answered the poll a certain way — what players are trying to predict.",
          where: "Shown in the reveal's stats grid as \"Truth\", next to the player's own guess.",
          example: "If 68% of the simulated crowd would pick pizza for life, set this to 68.",
        },
        getValue: (e) => (e ? e.target : 50),
        parse: (raw) => parseInt(raw, 10) || 0,
      },
      {
        id: "crowd",
        label: "Crowd distribution",
        type: "text",
        tooltip: {
          what: "20 comma-separated counts, one per 5-point bucket from 0–100%, describing how many simulated players guessed in each range.",
          where: "Drawn as the bar chart on the reveal screen.",
          example: '"1,1,2,3,5,7,9,11,12,11,10,8,6,5,3,2,1,1,1,1" clusters guesses around 55–65%.',
        },
        getValue: (e) => (e ? e.crowd.join(",") : "1,1,2,3,5,7,9,11,12,11,10,8,6,5,3,2,1,1,1,1"),
        parse: (raw) => raw.split(",").map((s) => parseInt(s.trim(), 10) || 0),
      },
    ],
    validate(data) {
      const warnings = [];
      if (data.crowd.length !== 20) {
        warnings.push(`Crowd distribution has ${data.crowd.length} buckets — Herd Meter needs exactly 20.`);
      }
      if (data.target < 0 || data.target > 100) warnings.push("Truth percentage should be between 0 and 100.");
      return warnings;
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
      let badge, headline, tier;
      if (win) {
        badge = pickRandom(ODDONEIN_WIN_BADGES);
        headline = pickRandom(ODDONEIN_WIN_HEADLINES);
        tier = "elite";
      } else {
        ({ badge, headline, tier } = badgeForTop(top));
      }
      return {
        badge,
        headline,
        tier,
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
    editorFields: [
      {
        id: "options",
        label: "Options",
        type: "textarea",
        tooltip: {
          what: "The choices players pick between, one per line as an emoji icon followed by a label.",
          where: "Rendered as the row of tappable cards on the challenge screen, and as the axis labels on the reveal chart.",
          example: '"🍕 Pepperoni" on its own line becomes one card showing a pizza slice and the word Pepperoni.',
        },
        getValue: (e) =>
          e ? e.options.map((o) => `${o.icon} ${o.label}`).join("\n") : "🍕 Pepperoni\n🍍 Pineapple\n🍄 Mushroom\n🌶️ Jalapeño\n🧀 Plain Cheese",
        parse: (raw) =>
          raw
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const [icon, ...rest] = line.split(" ");
              return { icon, label: rest.join(" ") };
            }),
      },
      {
        id: "crowd",
        label: "Crowd percentages",
        type: "text",
        tooltip: {
          what: "One percentage per option, same order as above, showing how many simulated players picked each one. The lowest number wins.",
          where: "Drawn as the reveal bar chart, and used to decide which option gets flagged the winner.",
          example: '"29,18,21,23,9" makes the 5th option (9%) the winner — the least-picked door.',
        },
        getValue: (e) => (e ? e.crowd.join(",") : "29,18,21,23,9"),
        parse: (raw) => raw.split(",").map((s) => parseInt(s.trim(), 10) || 0),
      },
    ],
    validate(data) {
      const warnings = [];
      if (data.crowd.length !== data.options.length) {
        warnings.push(`${data.crowd.length} crowd percentages but ${data.options.length} options — these must match.`);
      }
      const sum = data.crowd.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 100) > 3) warnings.push(`Crowd percentages sum to ${sum}%, not 100%.`);
      return warnings;
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
      let pts, badge, headline, tier;
      if (split && partnerSplits) {
        pts = 50;
        tier = "good";
        badge = pickRandom(["🤝", "😇", "🕊️"]);
        headline = pickRandom(["Both split. Honor intact.", "Mutual trust, mutual reward.", "Wholesome — and a little boring."]);
      } else if (!split && partnerSplits) {
        pts = 100;
        tier = "elite";
        badge = pickRandom(["🗡️", "😈", "💰"]);
        headline = pickRandom(["You stole from a splitter.", "Cold-blooded and correct.", "They trusted you. Rookie mistake — theirs."]);
      } else if (split && !partnerSplits) {
        pts = 0;
        tier = "brutal";
        badge = pickRandom(["😬", "🙃", "😭"]);
        headline = pickRandom(["You got played.", "Trusted a stranger. Bold strategy.", "Betrayed in cold blood."]);
      } else {
        pts = 0;
        tier = "rough";
        badge = pickRandom(["💀", "🔥", "🤷"]);
        headline = pickRandom(["Mutual destruction.", "Nobody wins. Everybody loses. Beautiful.", "Two cynics walk into a bar…"]);
      }
      const top = split ? (partnerSplits ? 38 : 70) : partnerSplits ? 12 : 70;
      return {
        badge,
        headline,
        tier,
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
    editorFields: [
      {
        id: "crowd",
        label: "Crowd split",
        type: "text",
        tooltip: {
          what: "Two comma-separated percentages: how many simulated players chose SPLIT, then STEAL. Also sets the odds a player's random partner splits.",
          where: "Drawn as the two-bar reveal chart, and used to weight the simulated partner's choice when a player locks in.",
          example: '"58,42" means 58% of the crowd splits — a player has a 58% chance their random partner splits too.',
        },
        getValue: (e) => (e ? e.crowd.join(",") : "58,42"),
        parse: (raw) => raw.split(",").map((s) => parseInt(s.trim(), 10) || 0),
      },
    ],
    validate(data) {
      const warnings = [];
      if (data.crowd.length !== 2) {
        warnings.push(`Crowd split has ${data.crowd.length} numbers — Split or Steal needs exactly 2 (SPLIT%, STEAL%).`);
      }
      const sum = data.crowd.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 100) > 3) warnings.push(`Crowd split sums to ${sum}%, not 100%.`);
      return warnings;
    },
  },
};
