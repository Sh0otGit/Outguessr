/* =====================================================
   formats.js — the challenge format registry.

   Shared source of truth for how each format renders its input and
   scores a pick. Used by the public game (app.js) and by the admin
   panel's calendar preview — both load this file directly so there
   is exactly one implementation of "what a player sees."

   resolve() only computes the percentile (topPct) and chart data —
   it does NOT pick a tier, badge, headline, jab, or payout. That
   pipeline is centralized in reveal.js (percentile → tier lookup),
   per CLAUDE.md's design system: tier presentation is uniform across
   every format, only the underlying percentile computation differs.

   resolve(challenge, pick) scores against the challenge's *authored*
   simulated crowd — still used behind app.js's USE_SIMULATED flag and
   by the admin preview. resolveReal(challenge, pick, blob) scores
   against a real GET /api/results/:day blob instead (see src/index.js's
   computeResultsBlob, which is built to match this scoring model
   exactly — same bucket math, same percentile definitions — so a
   player's percentile doesn't visibly shift the day a challenge's data
   source flips from simulated to real). Both return the same result
   shape Reveal.render() expects.
===================================================== */

/* ---------- scoring helpers shared across formats ---------- */
function bucketIndex(v) {
  return Math.min(19, Math.max(0, Math.floor(v / 5)));
}
function peakBucketIndex(crowd) {
  return crowd.indexOf(Math.max(...crowd));
}
// Percentile against the actual stored distribution (not a fixed lookup
// table): what share of the simulated crowd is at least as close to the
// target as this pick is. Each bucket's count is treated as uniformly
// spread across its 5-point range (we only know aggregate counts, not
// individual picks), and "as good or better than me" is the population
// inside the window [target-myDist, target+myDist] — a continuous overlap,
// not a bucket-vs-bucket tie. That's what makes a dead-on pick (myDist=0)
// able to reach the low single digits even when its own bucket holds a
// big chunk of the crowd: a whole bucket sharing your *range* isn't the
// same as a whole bucket sharing your *exact* pick.
function percentileFromTargetDistance(crowd, target, pick) {
  const total = crowd.reduce((a, b) => a + b, 0) || 1;
  const myDist = Math.abs(pick - target);
  const lo = target - myDist;
  const hi = target + myDist;
  let betterOrEqual = 0;
  crowd.forEach((count, i) => {
    const bucketLo = i * 5;
    const bucketHi = i * 5 + 5;
    const overlap = Math.max(0, Math.min(bucketHi, hi) - Math.max(bucketLo, lo));
    betterOrEqual += count * (overlap / 5);
  });
  return Math.max(1, Math.min(100, Math.round((betterOrEqual / total) * 100)));
}
// Same idea for Odd One In: "distance" is just the option's own crowd
// share (lower = rarer = better), so the percentile is the cumulative
// share of every option at least as rare as the one picked.
function percentileFromShare(crowd, pick) {
  const total = crowd.reduce((a, b) => a + b, 0) || 1;
  const myShare = crowd[pick];
  let betterOrEqual = 0;
  crowd.forEach((v) => {
    if (v <= myShare) betterOrEqual += v;
  });
  return Math.max(1, Math.min(100, Math.round((betterOrEqual / total) * 100)));
}

/* ---------- shared real-data adapter (crunch/herdmeter) ----------
   Both formats score picks identically (distance-from-target over a
   20-bucket 0-100 range); the only difference is the axis label suffix.
   The blob already carries a precomputed percentiles[0..100] lookup
   (src/index.js's computeResultsBlob), so scoring a real pick is just
   an array read — no recomputation needed client-side. */
function resolveRealNumeric(challenge, pick, blob, axis) {
  return {
    topPct: blob.percentiles[Math.max(0, Math.min(100, pick))],
    chart: {
      buckets: blob.crowd,
      youIndex: bucketIndex(pick),
      winIndexes: blob.winIndexes,
      peakIndex: blob.peakIndex,
    },
    axis,
    targetPosition: blob.target,
    story: blob.roast,
  };
}

// Split or Steal has no crowd-distance percentile — the story is the
// paired outcome itself, so this mirrors resolve()'s fixed narrative
// mapping exactly (same five values), keyed by the outcome string
// src/index.js's computeSplitStealOutcomes wrote to results_players.
const SPLITSTEAL_TOPPCT_BY_OUTCOME = {
  clean_steal: 3, // you stole, they split — best outcome
  mutual_split: 20, // wholesome mutual split
  mutual_steal: 65, // mutual destruction
  betrayed: 95, // you split, they stole — worst outcome
};

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
      const topPct = percentileFromTargetDistance(challenge.crowd, challenge.target, pick);
      return {
        topPct,
        chart: {
          buckets: challenge.crowd,
          youIndex: bucketIndex(pick),
          winIndexes: [bucketIndex(challenge.target)],
          peakIndex: peakBucketIndex(challenge.crowd),
        },
        axis: ["0", "25", "50", "75", "100"],
        targetPosition: challenge.target,
        story: challenge.roast,
      };
    },
    resolveReal(challenge, pick, blob) {
      return resolveRealNumeric(challenge, pick, blob, ["0", "25", "50", "75", "100"]);
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
          where: "Drawn as the gold dashed target line on the reveal chart, and used to score every player's percentile.",
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
      const topPct = percentileFromTargetDistance(challenge.crowd, challenge.target, pick);
      return {
        topPct,
        chart: {
          buckets: challenge.crowd,
          youIndex: bucketIndex(pick),
          winIndexes: [bucketIndex(challenge.target)],
          peakIndex: peakBucketIndex(challenge.crowd),
        },
        axis: ["0%", "25%", "50%", "75%", "100%"],
        targetPosition: challenge.target,
        story: challenge.roast,
      };
    },
    resolveReal(challenge, pick, blob) {
      return resolveRealNumeric(challenge, pick, blob, ["0%", "25%", "50%", "75%", "100%"]);
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
          where: "Drawn as the gold dashed target line on the reveal chart, next to the player's own guess.",
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
      const winIndex = crowd.indexOf(Math.min(...crowd));
      const topPct = percentileFromShare(crowd, pick);
      return {
        topPct,
        chart: {
          buckets: crowd,
          youIndex: pick,
          winIndexes: [winIndex],
          peakIndex: peakBucketIndex(crowd),
        },
        axis: challenge.options.map((o) => o.label),
        targetPosition: null,
        story: challenge.roast,
      };
    },
    resolveReal(challenge, pick, blob) {
      return {
        topPct: blob.percentiles[pick],
        chart: {
          buckets: blob.crowd,
          youIndex: pick,
          winIndexes: blob.winIndexes,
          peakIndex: blob.peakIndex,
        },
        axis: challenge.options.map((o) => o.label),
        targetPosition: null,
        story: blob.roast,
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
      // No numeric target to rank against here — the story is entirely
      // about the paired outcome, so the percentile is a fixed narrative
      // mapping from best (clean steal) to worst (betrayed) spanning the
      // same 5-tier range every other format uses.
      let topPct;
      if (!split && partnerSplits) topPct = 3; // clean steal — best outcome
      else if (split && partnerSplits) topPct = 20; // wholesome mutual split
      else if (!split && !partnerSplits) topPct = 65; // mutual destruction
      else topPct = 95; // betrayed — worst outcome

      const partnerNote = partnerSplits ? "Your partner split. " : "Your partner stole. ";
      return {
        topPct,
        chart: {
          buckets: challenge.crowd,
          youIndex: pick,
          winIndexes: [],
          peakIndex: peakBucketIndex(challenge.crowd),
        },
        axis: [`SPLIT ${challenge.crowd[0]}%`, `STEAL ${challenge.crowd[1]}%`],
        targetPosition: null,
        story: partnerNote + challenge.roast,
      };
    },
    resolveReal(challenge, pick, blob) {
      const outcome = blob.yourOutcome;
      const topPct = SPLITSTEAL_TOPPCT_BY_OUTCOME[outcome] ?? 50;
      const partnerSplit = outcome === "mutual_split" || outcome === "clean_steal";
      const partnerNote = partnerSplit ? "Your partner split. " : "Your partner stole. ";
      return {
        topPct,
        chart: {
          buckets: blob.crowd,
          youIndex: pick,
          winIndexes: [],
          peakIndex: peakBucketIndex(blob.crowd),
        },
        axis: [`SPLIT ${blob.crowd[0]}%`, `STEAL ${blob.crowd[1]}%`],
        targetPosition: null,
        story: partnerNote + blob.roast,
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
