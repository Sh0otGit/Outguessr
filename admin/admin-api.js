/* =====================================================
   admin-api.js — the ONLY place admin.js gets data from.

   Every function is async and returns realistic mock data today.
   Phase 2 swaps each body for a fetch() to /api/admin/* — nothing
   in admin.js needs to change when that happens.
===================================================== */

function pad2(n) {
  return String(n).padStart(2, "0");
}
function dateKeyFromDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function shiftDateKey(key, deltaDays) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  return dateKeyFromDate(dt);
}

async function getTodayStats() {
  return {
    challengeNumber: 214,
    formatIcon: "🎯",
    formatLabel: "Crowd Crunch",
    realPlayers: 924,
    realPlayersDelta: { label: "▲ 12% vs last Wed", dir: "up" },
    bots: 283,
    botsNote: "floor 300 · auto-retiring",
    submissionsTotal: 1207,
    d1RetentionPct: 61,
    d1RetentionDelta: { label: "▲ 3pts this week", dir: "up" },
    sharesYesterday: 188,
    shareRateNote: "20% share rate",
    newPlayersToday: 74,
    newPlayersDelta: { label: "▼ 8% — post-Reddit fade", dir: "down" },
    cron: { ok: true, label: "Cron OK · 00:00:41 UTC" },
  };
}

async function getDailyPlayers30d() {
  return {
    days: [
      110, 124, 131, 120, 145, 160, 152, 171, 190, 540, 1431, 880, 610, 560,
      590, 640, 612, 700, 742, 690, 780, 820, 795, 860, 905, 940, 1010, 980,
      1090, 1148,
    ],
    bestDay: 1431,
    note: "Spike = r/WebGames post (Jul 2).",
  };
}

async function getStreaks() {
  return [
    { label: "🔥 3+ days", count: 412, pct: 80 },
    { label: "🔥 7+ days", count: 203, pct: 40 },
    { label: "🔥 14+ days", count: 88, pct: 17 },
    { label: "🔥 30+ days", count: 21, pct: 5 },
  ];
}

async function getYesterdayRecap() {
  return {
    number: 213,
    formatIcon: "🚪",
    formatLabel: "Odd One In",
    bars: [
      { label: "Red", pct: 31 },
      { label: "Blue", pct: 14 },
      { label: "Green", pct: 22 },
      { label: "Gold", pct: 24 },
      { label: "Plain", pct: 9, winner: true },
    ],
    playerCount: 1148,
    roast: "31% convinced themselves Red was too obvious to be obvious.",
  };
}

async function getTodayLiveDistribution() {
  // Never shown by default — the spoiler shield gates this. See CLAUDE.md
  // golden rule 2: distributions stay hidden until the day is over.
  return { buckets: [2, 4, 7, 12, 16, 13, 9, 6, 8, 11, 7, 4, 3, 2, 1, 1, 1, 0, 0, 1] };
}

async function getRunwayDays() {
  const res = await fetch("../challenges.json");
  const challenges = await res.json();
  let key = dateKeyFromDate(new Date());
  let days = 0;
  while (challenges[key]) {
    days++;
    key = shiftDateKey(key, 1);
  }
  const lastScheduledDate = days > 0 ? shiftDateKey(key, -1) : null;
  return { days, lastScheduledDate };
}
