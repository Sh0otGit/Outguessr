/* =====================================================
   Reveal — reusable reveal-screen component.

   Renders a crowd-distribution chart + stats + roast copy
   from a format-agnostic result shape. Solo daily uses
   viewerLabel "YOU"; Arena (Phase 3) reuses this unchanged
   with "CHAT" / "STREAMER" markers instead.

   result shape:
   {
     badge, headline, topPct, pts,
     chart: { buckets:[...counts], youIndex, winIndexes:[...] },
     axis: [...labels],
     stats: [[label, value], ...],
     story, shareLine
   }
===================================================== */
const Reveal = (function () {
  function render(mount, result, opts) {
    opts = Object.assign({ viewerLabel: "YOU" }, opts);
    const bars = result.chart.buckets;
    const max = Math.max(...bars, 1);

    const barsHtml = bars
      .map((v, i) => {
        const isWin = result.chart.winIndexes.includes(i);
        const isYou = result.chart.youIndex === i;
        const height = Math.max(3, (v / max) * 100);
        const tag = isYou ? `<div class="youtag">${opts.viewerLabel}</div>` : "";
        return `<div class="bar${isWin ? " win" : ""}${isYou ? " you" : ""}" style="height:${height}%">${tag}</div>`;
      })
      .join("");

    const axisHtml = result.axis.map((a) => `<span>${a}</span>`).join("");
    const statsHtml = result.stats
      .map(([k, v]) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`)
      .join("");

    const outguessed = Math.max(0, 100 - result.topPct);

    mount.innerHTML = `
      <div class="result-head">
        <div class="badge">${result.badge}</div>
        <h2>${result.headline}</h2>
        <p>${opts.viewerLabel} outguessed <span class="pct">${outguessed}% of players</span> · +${result.pts} 🧠</p>
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
  }

  function shareCard(result, meta) {
    return `OUTGUESSR #${meta.number} ${meta.icon} ${meta.label}\n${result.badge} ${result.shareLine}\n🔥 ${meta.streak} streak\noutguessr.com`;
  }

  return { render, shareCard };
})();
