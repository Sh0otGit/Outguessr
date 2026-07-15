/* =====================================================
   Reveal — reusable reveal-screen component.

   Renders the tier verdict, annotated chart, payout ceremony, and
   share card from a format-agnostic result shape. Solo daily uses
   viewerLabel "YOU"; Arena (Phase 3) reuses this unchanged with
   "CHAT" / "STREAMER" markers instead.

   Spec: outguessr-reveal-tiers-mockup.html. See CLAUDE.md's "Design
   system" section for the tier table and hard rules — this file is
   the one place that implements percentile → tier lookup, so every
   format (formats.js) shares one tier/payout/ceremony pipeline.

   result shape (from FORMATS[format].resolve()):
   {
     topPct,
     chart: { buckets:[...counts], youIndex, winIndexes:[...], peakIndex },
     axis: [...labels],
     targetPosition: <0-100 | null>,
     story
   }
===================================================== */
const Reveal = (function () {
  const TIERS = [
    {
      key: "mastermind",
      max: 5,
      label: "MASTERMIND",
      badge: "🧠",
      headline: "Read the whole room.",
      multiplier: 10,
      amtLabel: "J A C K P O T",
      mathLabel: "top 5%",
      rain: { emoji: "🧠", count: 26 },
    },
    {
      key: "sharp",
      max: 25,
      label: "SHARP",
      badge: "⚡",
      headline: "You saw the herd coming.",
      multiplier: 3,
      amtLabel: "brains earned",
      mathLabel: "top 25%",
      rain: { emoji: "🧠", count: 8 },
    },
    {
      key: "mid",
      max: 60,
      label: "CERTIFIED MID",
      badge: "🙂",
      headline: "Statistically, you ARE the crowd.",
      multiplier: 1,
      amtLabel: "brains earned",
      mathLabel: "mid-pack",
      rain: null,
    },
    {
      key: "sheep",
      max: 90,
      label: "SHEEP",
      badge: "🐑",
      headline: "The herd thanks you for your predictability.",
      multiplier: 0.3,
      amtLabel: "brains earned (barely)",
      mathLabel: "herd",
      rain: null,
    },
    {
      key: "npc",
      max: 100,
      label: "NPC OF THE DAY",
      badge: "🗿",
      headline: "What… happened here?",
      multiplier: null,
      amtLabel: "(participation)",
      mathLabel: null,
      rain: null,
    },
  ];
  const TIER_KEYS = TIERS.map((t) => t.key);
  const BASE_PAYOUT = 40;
  const NPC_PAYOUT = 3;

  function tierForTop(top) {
    return TIERS.find((t) => top <= t.max) || TIERS[TIERS.length - 1];
  }
  function streakMultiplier(streak) {
    return 1 + Math.min(0.5, streak * 0.02);
  }
  function mathLineFor(tier, amount, mult) {
    if (tier.key === "npc") {
      return `participation award = <b>+${amount}</b> · we're not doing the math`;
    }
    if (tier.key === "sheep") {
      return `herd payout <b>×${tier.multiplier}</b> · streak kept alive 🔥 = <b>+${amount}</b>`;
    }
    return `${tier.mathLabel} payout <b>×${tier.multiplier}</b> · streak ×${mult.toFixed(1)} = <b>+${amount}</b>`;
  }

  // Percentile → tier + payout. Pure and synchronous (no fetch), so
  // app.js can call this at lock-in time to know how many brains to
  // award before the reveal is ever opened.
  function computeVerdict(topPct, streak) {
    const tier = tierForTop(topPct);
    if (tier.key === "npc") {
      return { tierKey: tier.key, amount: NPC_PAYOUT, mult: null, mathLine: mathLineFor(tier, NPC_PAYOUT, null) };
    }
    const mult = streakMultiplier(streak);
    const amount = Math.max(1, Math.round(BASE_PAYOUT * tier.multiplier * mult));
    return { tierKey: tier.key, amount, mult, mathLine: mathLineFor(tier, amount, mult) };
  }

  function seededPlayerCount(dayNumber) {
    return 900 + ((dayNumber * 37) % 601);
  }

  let _verdictsCache = null;
  async function getJabPool() {
    if (!_verdictsCache) {
      const res = await fetch("verdicts.json");
      _verdictsCache = await res.json();
    }
    return _verdictsCache;
  }

  function countUp(el, to, ms, format) {
    if (!el) return;
    const start = performance.now();
    function tick(now) {
      const p = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = format(Math.round(to * eased));
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function buildChart(result, viewerLabel) {
    const buckets = result.chart.buckets;
    const total = buckets.reduce((a, b) => a + b, 0) || 1;
    const max = Math.max(...buckets, 1);

    const barsHtml = buckets
      .map((v, i) => {
        const isYou = i === result.chart.youIndex;
        const isWin = result.chart.winIndexes.includes(i);
        const isPeak = i === result.chart.peakIndex;
        const height = Math.max(3, (v / max) * 100);
        const pct = Math.round((v / total) * 100);

        const tags = [];
        if (isYou) tags.push(viewerLabel);
        if (isWin) tags.push("WIN");
        if (isPeak && !isYou && !isWin) tags.push("PEAK");

        let labelHtml = "";
        if (tags.length) {
          const cls = isYou ? " you" : isWin ? " win" : "";
          const check = isWin ? " ✓" : "";
          labelHtml = `<div class="blabel${cls}">${tags.join(" · ")} · ${pct}%${check}</div>`;
        }

        const titleWhat = result.targetPosition != null ? `${i * 5}–${i * 5 + 5}` : result.axis[i];
        const delay = isYou ? "0.8s" : `${(i * 0.03).toFixed(2)}s`;

        return `<div class="bar${isWin ? " win" : ""}${isYou ? " you" : ""}" style="height:${height}%;animation-delay:${delay}" title="${titleWhat}: ${pct}% of players">${labelHtml}</div>`;
      })
      .join("");

    const axisHtml = result.axis.map((a) => `<span>${a}</span>`).join("");

    let targetlineHtml = "";
    let targetLegendHtml = "";
    if (result.targetPosition != null) {
      targetlineHtml = `<div class="targetline" style="left:${result.targetPosition}%"></div>`;
      targetLegendHtml = `<span><span class="dot" style="background:var(--gold)"></span>Target ${result.targetPosition}</span>`;
    }

    return { barsHtml, axisHtml, targetlineHtml, targetLegendHtml };
  }

  async function render(mount, result, verdict, opts) {
    opts = Object.assign({ viewerLabel: "YOU", dayNumber: 0, streak: 0, formatIcon: "🎯", formatLabel: "" }, opts);
    const tier = TIERS.find((t) => t.key === verdict.tierKey);

    const jabPool = (await getJabPool())[tier.key] || [];
    const jab = jabPool.length ? jabPool[((opts.dayNumber % jabPool.length) + jabPool.length) % jabPool.length] : "";

    const { barsHtml, axisHtml, targetlineHtml, targetLegendHtml } = buildChart(result, opts.viewerLabel);
    const outguessed = Math.max(0, 100 - result.topPct);
    const playerCount = seededPlayerCount(opts.dayNumber);

    mount.innerHTML = `
      <div class="marquee" id="marquee"></div>
      <div class="result-head">
        <div class="badge" id="reveal-badge">${tier.badge}</div>
        <br>
        <span class="tier-label">${tier.label}</span>
        <h2 class="headline">${tier.headline}</h2>
        <div class="pctline">${opts.viewerLabel} outguessed <b>${outguessed}% of players</b> · finished top ${result.topPct}%</div>
      </div>

      <div class="jab">"${jab}"</div>

      <div class="vs">DAILY #${opts.dayNumber} · ${opts.formatIcon} ${opts.formatLabel.toUpperCase()} — you vs <b id="reveal-playercount">0</b> players</div>
      <div class="chartwrap">
        ${targetlineHtml}
        <div class="chart">${barsHtml}</div>
        <div class="chart-axis">${axisHtml}</div>
      </div>
      <div class="legend">
        <span><span class="dot" style="background:var(--lime)"></span>Winning zone</span>
        <span><span class="dot" style="background:var(--purple)"></span>${opts.viewerLabel}</span>
        <span><span class="dot" style="background:#333b4e"></span>The herd</span>
        ${targetLegendHtml}
      </div>

      <div class="story">${result.story}</div>

      <div class="payout">
        <span class="jackpot-tag">✦ JACKPOT ✦</span>
        <div class="amt"><span id="reveal-amt">0</span> <small>🧠</small></div>
        <div class="lbl">${tier.amtLabel}</div>
        <div class="math">${verdict.mathLine}</div>
      </div>`;

    document.body.classList.remove(...TIER_KEYS.map((k) => "tier-" + k));
    document.body.classList.add("tier-" + tier.key);

    countUp(document.getElementById("reveal-playercount"), playerCount, 1200, (n) => n.toLocaleString());
    const dur = 400 + Math.min(1800, verdict.amount * 3);
    countUp(document.getElementById("reveal-amt"), verdict.amount, dur, (n) => "+" + n);

    const rain = document.getElementById("rain");
    if (rain) {
      rain.innerHTML = "";
      if (tier.rain) {
        for (let i = 0; i < tier.rain.count; i++) {
          const s = document.createElement("span");
          s.textContent = tier.rain.emoji;
          s.style.left = Math.random() * 100 + "vw";
          s.style.fontSize = 14 + Math.random() * 22 + "px";
          s.style.animationDuration = 2.2 + Math.random() * 2.5 + "s";
          s.style.animationDelay = Math.random() * 1.2 + "s";
          rain.appendChild(s);
        }
      }
    }

    const marquee = mount.querySelector("#marquee");
    if (marquee && tier.key === "mastermind") {
      const N = 26;
      for (let i = 0; i < N; i++) {
        const b = document.createElement("i");
        const perim = i / N;
        let x, y;
        if (perim < 0.25) {
          x = perim * 4 * 100;
          y = 0;
        } else if (perim < 0.5) {
          x = 100;
          y = (perim - 0.25) * 4 * 100;
        } else if (perim < 0.75) {
          x = 100 - (perim - 0.5) * 4 * 100;
          y = 100;
        } else {
          x = 0;
          y = 100 - (perim - 0.75) * 4 * 100;
        }
        b.style.left = `calc(${x}% - 3px)`;
        b.style.top = `calc(${y}% - 3px)`;
        b.style.animationDelay = i * 0.08 + "s";
        marquee.appendChild(b);
      }
    }
  }

  function resetCeremony() {
    document.body.classList.remove(...TIER_KEYS.map((k) => "tier-" + k));
    const rain = document.getElementById("rain");
    if (rain) rain.innerHTML = "";
  }

  function shareCard(verdict, result, meta) {
    const tier = TIERS.find((t) => t.key === verdict.tierKey);
    return `OUTGUESSR #${meta.number} ${meta.icon}\n${tier.badge} ${tier.label} · top ${result.topPct}% · +${verdict.amount} 🧠\n🔥 ${meta.streak} streak\noutguessr.com`;
  }

  return { computeVerdict, render, shareCard, resetCeremony };
})();
