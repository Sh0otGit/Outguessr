/* =====================================================
   chart-tooltip.js — one shared hover/tap tooltip for every chart in the
   codebase (admin live distribution, yesterday's recap, the 30-day
   players chart, the Bots page projection, and the public reveal chart).

   Loaded by both public/index.html and public/admin/index.html — this is
   the ONLY chart tooltip implementation; no chart should build its own
   native title= or a one-off floating div.

   Usage: build the tooltip's inner HTML for a bar/node, then
   ChartTooltip.bind(node, html) instead of setting a title attribute.
   The registry pattern (numeric id in a data attribute, real HTML kept
   in memory) avoids re-escaping arbitrary HTML into an attribute string.
===================================================== */
(function () {
  const REGISTRY = {};
  let seq = 0;
  let ttEl = null;

  function ensureEl() {
    if (ttEl) return ttEl;
    ttEl = document.createElement("div");
    ttEl.className = "chart-tooltip hidden";
    document.body.appendChild(ttEl);
    return ttEl;
  }

  function bind(node, html) {
    const id = "ct" + seq++;
    REGISTRY[id] = html;
    node.dataset.ctId = id;
    node.classList.add("has-chart-tooltip");
  }

  // Charts get fully rebuilt on every render (new bar elements each time)
  // — clear the registry so it doesn't grow unbounded across re-renders
  // (the Dashboard's 30-day chart, live shield, etc. all re-render on
  // every section activation).
  function reset() {
    for (const k in REGISTRY) delete REGISTRY[k];
    seq = 0;
  }

  function show(node) {
    const html = REGISTRY[node.dataset.ctId];
    if (html == null) return;
    const el = ensureEl();
    el.innerHTML = html;
    el.classList.remove("hidden");
    const rect = node.getBoundingClientRect();
    const ttRect = el.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - ttRect.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - ttRect.width - 8));
    let top = rect.top - ttRect.height - 10;
    if (top < 8) top = Math.min(rect.bottom + 10, window.innerHeight - ttRect.height - 8);
    el.style.left = left + "px";
    el.style.top = top + "px";
  }

  function hide() {
    if (ttEl) ttEl.classList.add("hidden");
  }

  document.addEventListener("mouseover", (e) => {
    const node = e.target.closest(".has-chart-tooltip");
    if (node) show(node);
  });
  document.addEventListener("mouseout", (e) => {
    if (e.target.closest(".has-chart-tooltip")) hide();
  });
  // Tap support: show on tap, hide on the next tap anywhere else — mirrors
  // hover behavior on touch devices without needing a second tap to
  // dismiss a *different* bar's tooltip.
  document.addEventListener(
    "touchstart",
    (e) => {
      const node = e.target.closest(".has-chart-tooltip");
      if (node) {
        show(node);
        e.stopPropagation();
      } else {
        hide();
      }
    },
    { passive: true }
  );
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".has-chart-tooltip")) hide();
  });

  window.ChartTooltip = { bind, hide, reset };
})();
