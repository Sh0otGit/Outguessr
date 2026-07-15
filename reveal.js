/* =====================================================
   Reveal — reusable reveal-screen component.

   Renders a crowd-distribution chart + stats + roast copy
   from a format-agnostic result shape. Solo daily uses
   viewerLabel "YOU"; Arena (Phase 3) reuses this unchanged
   with "CHAT" / "STREAMER" markers instead.

   result shape:
   {
     badge, headline, tier, topPct, pts,
     chart: { buckets:[...counts], youIndex, winIndexes:[...] },
     axis: [...labels],
     stats: [[label, value], ...],
     story, shareLine
   }

   "tier" (elite/great/good/mid/rough/brutal, from formats.js) drives how
   big and celebratory the points badge and result icon look — the score
   itself never changes, only how loudly it's presented.
===================================================== */
const Reveal = (function () {
  // Fewer than ~6 bars means each one is a named option (Odd One In,
  // Split or Steal) — label every bar with its share. More than that
  // (Crowd Crunch / Herd Meter's 20 buckets) would get too noisy, so
  // only the bars that matter — yours and the winning one — get labeled.
  const MANY_BUCKETS_THRESHOLD = 6;

  function render(mount, result, opts) {
    opts = Object.assign({ viewerLabel: "YOU" }, opts);
    const bars = result.chart.buckets;
    const max = Math.max(...bars, 1);
    const total = bars.reduce((a, b) => a + b, 0) || 1;
    const manyBuckets = bars.length > MANY_BUCKETS_THRESHOLD;

    const barsHtml = bars
      .map((v, i) => {
        const isWin = result.chart.winIndexes.includes(i);
        const isYou = result.chart.youIndex === i;
        const height = Math.max(3, (v / max) * 100);
        const pct = Math.round((v / total) * 100);

        let label = "";
        if (!manyBuckets) {
          label = isYou ? `${opts.viewerLabel} · ${pct}%` : `${pct}%`;
        } else if (isYou || isWin) {
          const parts = [];
          if (isYou) parts.push(opts.viewerLabel);
          if (isWin) parts.push("WIN");
          parts.push(pct + "%");
          label = parts.join(" · ");
        }
        const tag = label ? `<div class="bartag${isYou ? " you" : isWin ? " win" : ""}">${label}</div>` : "";
        return `<div class="bar${isWin ? " win" : ""}${isYou ? " you" : ""}" style="height:${height}%">${tag}</div>`;
      })
      .join("");

    const axisHtml = result.axis.map((a) => `<span>${a}</span>`).join("");
    const statsHtml = result.stats
      .map(([k, v]) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`)
      .join("");

    const outguessed = Math.max(0, 100 - result.topPct);
    const tier = result.tier || "mid";

    mount.innerHTML = `
      <div class="result-head tier-${tier}">
        <div class="badge">${result.badge}</div>
        <h2>${result.headline}</h2>
        <p>${opts.viewerLabel} outguessed <span class="pct">${outguessed}% of players</span></p>
        <div class="pts-badge"><span class="pts-num">0</span> <span class="pts-emoji">🧠</span></div>
      </div>
      <div class="chart">${barsHtml}</div>
      <div class="chart-labels">${axisHtml}</div>
      <div class="legend">
        <span><span class="dot" style="background:var(--lime)"></span>Winning zone</span>
        <span><span class="dot" style="background:var(--purple)"></span>${opts.viewerLabel}</span>
        <span><span class="dot" style="background:#333b4e"></span>The herd</span>
      </div>
      <div class="reveal-stats">${statsHtml}</div>
      <div class="story">${result.story}</div>`;

    animateCount(mount.querySelector(".pts-num"), result.pts, tier);
  }

  function animateCount(el, target, tier) {
    if (!el) return;
    const duration = tier === "elite" || tier === "great" ? 900 : tier === "brutal" ? 350 : 600;
    const start = performance.now();
    function step(now) {
      const p = Math.min(1, (now - start) / duration);
      el.textContent = Math.round(p * target);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function shareCard(result, meta) {
    return `OUTGUESSR #${meta.number} ${meta.icon} ${meta.label}\n${result.badge} ${result.shareLine}\n🔥 ${meta.streak} streak\noutguessr.com`;
  }

  return { render, shareCard };
})();
