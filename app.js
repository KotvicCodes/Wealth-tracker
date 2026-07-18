/* Wealth Tracker frontend – plain JS, no framework. */
"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  people: [],        // full dataset with derived metrics
  filtered: [],      // current table slice (after search/filters/scope/sort)
  scope: "all",      // "all" | "top500"
  sortKey: "rank",
  sortDir: 1,        // 1 asc, -1 desc
  rendered: 0,       // rows currently in the DOM
  charts: {},
  dashboardDirty: true,  // charts can't size in a hidden tab – render on show
  perfDirty: true,
  oddsDirty: true,
  period: loadPeriod(),
  history: {},           // local daily snapshots {date: {asOf, people: [[name, worth]]}}
};

const CHUNK = 80;

// last selected performance period, kept across visits; defaults to 1 year
function loadPeriod() {
  try {
    const p = localStorage.getItem("wt.period");
    if (p && ["day", "m1", "m3", "ytd", "y1", "y3", "y5"].includes(p)) return p;
  } catch (_) {}
  return "y1";
}

/* ---------- formatting ---------- */
const fmtMoney = (m) => {
  // m is $ millions
  if (m == null || isNaN(m)) return "–";
  const abs = Math.abs(m);
  const sign = m < 0 ? "-" : "";
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}T`;
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(abs >= 100000 ? 0 : 1)}B`;
  return `${sign}$${abs.toFixed(0)}M`;
};
const fmtDelta = (m) => (m == null || isNaN(m) ? "–" : (m >= 0 ? "+" : "") + fmtMoney(m).replace("$-", "-$"));
const fmtPct = (p) => (p == null || isNaN(p) ? "–" : `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`);
const cls = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");

/* ---------- data ---------- */
async function loadData() {
  const [resp, histResp] = await Promise.all([
    fetch("/api/billionaires"),
    fetch("/api/history").catch(() => null),
  ]);
  if (!resp.ok) {
    let msg = `Server error (${resp.status})`;
    try { msg = (await resp.json()).error || msg; } catch (_) {}
    throw new Error(msg);
  }
  const data = await resp.json();
  if (histResp && histResp.ok) {
    try { state.history = await histResp.json(); } catch (_) { state.history = {}; }
  }
  const now = Date.now();
  state.people = data.people.map((p) => {
    const dailyChange = p.prevWorth != null ? p.worth - p.prevWorth : null;
    const dailyPct = p.prevWorth ? (dailyChange / p.prevWorth) * 100 : null;
    const ytdChange = p.archivedWorth != null && p.archivedWorth > 0 ? p.worth - p.archivedWorth : null;
    const ytdPct = p.archivedWorth > 0 ? (ytdChange / p.archivedWorth) * 100 : null;
    const w1y = (p.annual || {})["2025"];
    const chg1y = w1y > 0 ? p.worth - w1y : null;
    const pct1y = w1y > 0 ? (chg1y / w1y) * 100 : null;
    const age = p.birthDate ? Math.floor((now - p.birthDate) / (365.25 * 24 * 3600e3)) : null;
    return { ...p, dailyChange, dailyPct, ytdChange, ytdPct, chg1y, pct1y, age };
  });
  // days since the latest annual list, used to date archivedWorth for estimates
  state.archivedAgeDays = data.archivedAsOf
    ? (now - new Date(data.archivedAsOf).getTime()) / 86400e3
    : null;
  // 3-month returns need the history/estimate helpers above, so a second pass
  state.people.forEach((p) => {
    const { chg, pct, est } = periodChange(p, "m3");
    p.chg90 = chg;
    p.pct90 = pct;
    p.est90 = est;
  });
  $("asof").textContent = `As of ${new Date(data.asOf).toLocaleString()} · ${data.count.toLocaleString()} billionaires · source: Forbes real-time list`;
  $("asof").classList.add("live");
}

/* ---------- period returns ----------
   Baselines per period: day and YTD come from the live feed, 1Y/3Y/5Y from
   past annual Forbes lists. 1M/3M prefer this app's own daily snapshots
   (data/history.json), and until ~90 days of those accumulate they fall back
   to an estimate interpolated from the latest annual list (see estimateBaseline). */
const PERIODS = {
  day: { label: "today" },
  m1: { label: "past month", days: 30 },
  m3: { label: "past 3 months", days: 90 },
  ytd: { label: "since the latest annual list" },
  y1: { label: "since the 2025 list", year: "2025" },
  y3: { label: "since the 2023 list", year: "2023" },
  y5: { label: "since the 2021 list", year: "2021" },
};

const normName = (n) => (n || "").toLowerCase().replace(/\s*&\s*family/, "").replace(/[^a-z ]/g, "").trim();

// Find a local snapshot closest to `days` ago (within a third of the span).
function snapshotBaseline(days) {
  const target = Date.now() - days * 86400e3;
  const tolerance = days * 86400e3 / 3;
  let best = null, bestDist = Infinity;
  for (const [d, snap] of Object.entries(state.history)) {
    const t = snap.asOf || new Date(d).getTime();
    const dist = Math.abs(t - target);
    if (dist < bestDist) { bestDist = dist; best = snap; }
  }
  if (!best || bestDist > tolerance) return null;
  return new Map(best.people.map(([n, w]) => [normName(n), w]));
}

const snapshotCache = {};

// Temporary estimate of a past net worth for a short window (1M/3M): interpolate
// linearly between the latest annual list (archivedWorth, dated archivedAgeDays
// ago) and the live value. Replaced by real snapshots as daily history builds up.
function estimateBaseline(p, days) {
  const D = state.archivedAgeDays;
  if (!(p.archivedWorth > 0) || !(p.worth > 0) || !(D > 0)) return null;
  const frac = Math.min(days / D, 1);
  return p.worth + (p.archivedWorth - p.worth) * frac;
}

// Returns { base, est }: the baseline net worth for the period and whether it is
// an estimate (true only for 1M/3M served from the annual-list fallback).
function baselineWorth(p, period) {
  const def = PERIODS[period];
  if (period === "day") return { base: p.prevWorth, est: false };
  if (period === "ytd") return { base: p.archivedWorth > 0 ? p.archivedWorth : null, est: false };
  if (def.year) { const w = (p.annual || {})[def.year]; return { base: w > 0 ? w : null, est: false }; }
  if (!(period in snapshotCache)) snapshotCache[period] = snapshotBaseline(def.days);
  const map = snapshotCache[period];
  const real = map ? map.get(normName(p.name)) ?? null : null;
  if (real != null) return { base: real, est: false };
  return { base: estimateBaseline(p, def.days), est: true };
}

function periodChange(p, period) {
  const { base, est } = baselineWorth(p, period);
  if (base == null || !(base > 0)) return { chg: null, pct: null, est: false };
  const chg = p.worth - base;
  return { chg, pct: (chg / base) * 100, est };
}

/* ---------- filtering & sorting ---------- */
function scoped() {
  return state.scope === "top500" ? state.people.filter((p) => p.rank != null && p.rank <= 500) : state.people;
}

function applyFilters() {
  const q = $("search").value.trim().toLowerCase();
  const country = $("countryFilter").value;
  const industry = $("industryFilter").value;
  let rows = scoped();
  if (country) rows = rows.filter((p) => p.country === country);
  if (industry) rows = rows.filter((p) => p.industry === industry);
  if (q) {
    rows = rows.filter((p) =>
      (p.name || "").toLowerCase().includes(q) ||
      (p.country || "").toLowerCase().includes(q) ||
      (p.industry || "").toLowerCase().includes(q) ||
      (p.source || "").toLowerCase().includes(q));
  }
  const k = state.sortKey, d = state.sortDir;
  rows = rows.slice().sort((a, b) => {
    const av = a[k], bv = b[k];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (typeof av === "string" ? av.localeCompare(bv) : av - bv) * d;
  });
  state.filtered = rows;
  resetTable();
}

/* ---------- table rendering (chunked) ---------- */
function resetTable() {
  $("tbody").innerHTML = "";
  state.rendered = 0;
  renderChunk();
  $("rowCount").textContent = `${state.filtered.length.toLocaleString()} people`;
}

function renderChunk() {
  const rows = state.filtered;
  const end = Math.min(state.rendered + CHUNK, rows.length);
  const frag = document.createDocumentFragment();
  for (let i = state.rendered; i < end; i++) frag.appendChild(buildRow(rows[i]));
  $("tbody").appendChild(frag);
  state.rendered = end;
}

function buildRow(p) {
  const tr = document.createElement("tr");

  const tdRank = document.createElement("td");
  tdRank.className = "num"; tdRank.textContent = p.rank ?? "–";

  const tdName = document.createElement("td");
  tdName.className = "name";
  const wrap = document.createElement("div"); wrap.className = "person";
  if (p.image) {
    const img = document.createElement("img");
    img.className = "avatar"; img.loading = "lazy"; img.alt = "";
    img.src = p.image.startsWith("//") ? "https:" + p.image : p.image;
    img.onerror = () => { img.replaceWith(avatarFallback(p.name)); };
    wrap.appendChild(img);
  } else {
    wrap.appendChild(avatarFallback(p.name));
  }
  const nameBox = document.createElement("div");
  const nm = document.createElement("div"); nm.textContent = p.name || "–";
  const src = document.createElement("div"); src.className = "src"; src.textContent = p.source || "";
  nameBox.append(nm, src);
  wrap.appendChild(nameBox);
  tdName.appendChild(wrap);

  const tdCountry = document.createElement("td"); tdCountry.textContent = p.country || "–";
  const tdInd = document.createElement("td"); tdInd.textContent = p.industry || "–";

  const tdWorth = document.createElement("td"); tdWorth.className = "num name"; tdWorth.textContent = fmtMoney(p.worth);
  const tdDay = document.createElement("td"); tdDay.className = `num ${cls(p.dailyChange)}`; tdDay.textContent = fmtDelta(p.dailyChange);
  const tdDayP = document.createElement("td"); tdDayP.className = `num ${cls(p.dailyPct)}`; tdDayP.textContent = fmtPct(p.dailyPct);
  const est = p.est90 ? "*" : "";
  const estTitle = p.est90 ? "Estimated from the latest annual Forbes list" : "";
  const td90 = document.createElement("td"); td90.className = `num ${cls(p.chg90)}`; td90.textContent = fmtDelta(p.chg90) + est; td90.title = estTitle;
  const td90P = document.createElement("td"); td90P.className = `num ${cls(p.pct90)}`; td90P.textContent = fmtPct(p.pct90) + est; td90P.title = estTitle;
  const td1y = document.createElement("td"); td1y.className = `num ${cls(p.chg1y)}`; td1y.textContent = fmtDelta(p.chg1y);
  const td1yP = document.createElement("td"); td1yP.className = `num ${cls(p.pct1y)}`; td1yP.textContent = fmtPct(p.pct1y);

  const tdSpark = document.createElement("td");
  const trend = yearlySeries(p);
  if (trend.length > 1) tdSpark.appendChild(sparkline(trend));

  tr.append(tdRank, tdName, tdCountry, tdInd, tdWorth, tdDay, tdDayP, td90, td90P, td1y, td1yP, tdSpark);
  tr.addEventListener("click", () => openPersonModal(p));
  return tr;
}

function avatarFallback(name) {
  const el = document.createElement("span");
  el.className = "avatar fallback";
  el.textContent = (name || "?").split(" ").map((w) => w[0]).slice(0, 2).join("");
  return el;
}

// annual list values 2021-2025 + latest list + live value, nulls skipped
function yearlySeries(p) {
  const vals = ["2021", "2022", "2023", "2024", "2025"].map((y) => (p.annual || {})[y]);
  vals.push(p.archivedWorth, p.worth);
  return vals.filter((v) => v > 0);
}

function sparkline(values) {
  const w = 96, h = 26, pad = 2;
  const canvas = document.createElement("canvas");
  canvas.className = "spark";
  canvas.width = w * devicePixelRatio; canvas.height = h * devicePixelRatio;
  canvas.style.width = w + "px"; canvas.style.height = h + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const up = values[values.length - 1] >= values[0];
  ctx.strokeStyle = up ? "#0ca30c" : "#d03b3b";
  ctx.lineWidth = 1.5; ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - 2 * pad);
    const y = h - pad - ((v - min) / span) * (h - 2 * pad);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
  return canvas;
}

/* ---------- analysis dashboard ---------- */
const C = {
  blue: "#3987e5", up: "#0ca30c", down: "#d03b3b",
  ink2: "#c3c2b7", muted: "#898781", grid: "#2c2c2a", surface: "#1a1a19",
  aqua: "#199e70", violet: "#9085e9",
};

function chartDefaults() {
  Chart.defaults.color = C.muted;
  Chart.defaults.borderColor = C.grid;
  Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  Chart.defaults.font.size = 12;
  Chart.defaults.plugins.legend.display = false; // single-series charts: title names it
  Chart.defaults.animation = false;
  Chart.defaults.maintainAspectRatio = false;
}

function makeChart(id, config) {
  if (state.charts[id]) state.charts[id].destroy();
  state.charts[id] = new Chart($(id), config);
}

const barOpts = (horizontal, unit) => ({
  indexAxis: horizontal ? "y" : "x",
  scales: {
    x: { grid: { display: !horizontal ? false : true, color: C.grid }, border: { display: false },
         ticks: { callback: (v) => (horizontal ? compact(v) : undefined) } },
    y: { grid: { display: horizontal ? false : true, color: C.grid }, border: { display: false },
         // category labels must never be skipped: a bar without a name is unreadable
         ticks: horizontal ? { autoSkip: false } : { callback: (v) => compact(v) } },
  },
  plugins: {
    tooltip: {
      backgroundColor: "#222221", borderColor: "rgba(255,255,255,.1)", borderWidth: 1,
      titleColor: "#fff", bodyColor: C.ink2, padding: 10,
      callbacks: { label: (c) => ` ${(horizontal ? c.parsed.x : c.parsed.y).toLocaleString(undefined, { maximumFractionDigits: 1 })}${unit || ""}` },
    },
  },
});

// bar options for $-valued charts: axis ticks and tooltips through fmtMoney
// (values stay in $ millions so "$820B" / "$1.53T" render naturally)
function moneyBarOpts(horizontal) {
  const o = barOpts(horizontal, "");
  const axis = horizontal ? o.scales.x : o.scales.y;
  axis.ticks = { callback: (v) => (v === 0 ? "$0" : fmtMoney(v)) };
  o.plugins.tooltip.callbacks = {
    label: (c) => ` ${fmtMoney(horizontal ? c.parsed.x : c.parsed.y)}`,
  };
  return o;
}

// horizontal-only x-tick fix helper
function compact(v) {
  if (Math.abs(v) >= 1000) return (v / 1000).toLocaleString() + "k";
  return v.toLocaleString();
}

const barData = (labels, values, color) => ({
  labels,
  datasets: [{
    data: values,
    backgroundColor: color,
    borderRadius: 4, borderSkipped: false,
    maxBarThickness: 18, categoryPercentage: 0.72,
  }],
});

function renderDashboard() {
  const rows = scoped();
  const worthOf = (p) => p.worth || 0;
  const total = rows.reduce((s, p) => s + worthOf(p), 0);
  const sortedW = rows.map(worthOf).sort((a, b) => a - b);
  const median = sortedW.length ? sortedW[Math.floor(sortedW.length / 2)] : 0;
  const dayMove = rows.reduce((s, p) => s + (p.dailyChange || 0), 0);
  const withDaily = rows.filter((p) => p.dailyChange != null);
  const gainers = withDaily.slice().sort((a, b) => b.dailyChange - a.dailyChange).slice(0, 10);
  const losers = withDaily.slice().sort((a, b) => a.dailyChange - b.dailyChange).slice(0, 10);

  // inequality stats
  const desc = rows.map(worthOf).sort((a, b) => b - a);
  const top10Share = total ? (desc.slice(0, 10).reduce((s, v) => s + v, 0) / total) * 100 : null;
  // Gini over the billionaire set itself (0 = equal fortunes, 1 = one person holds all)
  let weighted = 0;
  sortedW.forEach((w, i) => { weighted += (i + 1) * w; });
  const gini = sortedW.length && total ? (2 * weighted) / (sortedW.length * total) - (sortedW.length + 1) / sortedW.length : null;
  const centi = rows.filter((p) => worthOf(p) >= 100000).length;
  const ages = rows.filter((p) => p.age != null && p.age > 10 && p.age < 110);
  const ageSorted = ages.map((p) => p.age).sort((a, b) => a - b);
  const medianAge = ageSorted.length ? ageSorted[Math.floor(ageSorted.length / 2)] : null;

  // stat tiles
  const tiles = [
    { label: "People", value: rows.length.toLocaleString() },
    { label: "Combined wealth", value: fmtMoney(total) },
    { label: "Average", value: fmtMoney(rows.length ? total / rows.length : 0) },
    { label: "Median", value: fmtMoney(median) },
    { label: "Today's aggregate move", value: fmtDelta(dayMove), cls: cls(dayMove) },
    { label: "$100B+ club", value: centi.toLocaleString() },
    top10Share != null && { label: "Top 10 hold", value: top10Share.toFixed(1) + "%" },
    gini != null && { label: "Gini coefficient", value: gini.toFixed(2) },
    medianAge != null && { label: "Median age", value: String(medianAge) },
    gainers[0] && { label: "Biggest gainer", value: gainers[0].name, delta: fmtDelta(gainers[0].dailyChange), cls: "pos" },
    losers[0] && { label: "Biggest loser", value: losers[0].name, delta: fmtDelta(losers[0].dailyChange), cls: "neg" },
  ].filter(Boolean);
  $("tiles").innerHTML = tiles.map((t) => `
    <div class="tile">
      <div class="label">${t.label}</div>
      <div class="value ${t.cls || ""}" style="font-size:${t.value.length > 12 ? 18 : 26}px">${t.value}</div>
      ${t.delta ? `<div class="delta ${t.cls || ""}">${t.delta} today</div>` : ""}
    </div>`).join("");

  // movers
  makeChart("chGainers", {
    type: "bar",
    data: barData(gainers.map((p) => p.name), gainers.map((p) => p.dailyChange / 1000), C.up),
    options: barOpts(true, " $B"),
  });
  makeChart("chLosers", {
    type: "bar",
    data: barData(losers.map((p) => p.name), losers.map((p) => p.dailyChange / 1000), C.down),
    options: barOpts(true, " $B"),
  });

  // people counts by country (top 12 + Other) and by industry
  const countBy = (key) => {
    const m = new Map();
    rows.forEach((p) => { const k = p[key] || "Unknown"; m.set(k, (m.get(k) || 0) + 1); });
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const countries = countBy("country");
  const top = countries.slice(0, 12);
  const other = countries.slice(12).reduce((s, [, v]) => s + v, 0);
  if (other > 0) top.push(["Other", other]);
  makeChart("chCountry", {
    type: "bar",
    data: barData(top.map(([k]) => k), top.map(([, v]) => v), C.blue),
    options: barOpts(true, " people"),
  });

  const industries = countBy("industry");
  makeChart("chIndustry", {
    type: "bar",
    data: barData(industries.map(([k]) => k), industries.map(([, v]) => v), C.blue),
    options: barOpts(true, " people"),
  });

  // combined wealth by country (top 12 + Other) and by industry, in aqua so
  // $-magnitude charts read differently from the blue people-count charts
  const sumBy = (key) => {
    const m = new Map();
    rows.forEach((p) => { const k = p[key] || "Unknown"; m.set(k, (m.get(k) || 0) + worthOf(p)); });
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const wCountries = sumBy("country");
  const wTop = wCountries.slice(0, 12);
  const wOther = wCountries.slice(12).reduce((s, [, v]) => s + v, 0);
  if (wOther > 0) wTop.push(["Other", wOther]);
  makeChart("chWealthCountry", {
    type: "bar",
    data: barData(wTop.map(([k]) => k), wTop.map(([, v]) => v), C.aqua),
    options: moneyBarOpts(true),
  });
  const wIndustries = sumBy("industry");
  makeChart("chWealthIndustry", {
    type: "bar",
    data: barData(wIndustries.map(([k]) => k), wIndustries.map(([, v]) => v), C.aqua),
    options: moneyBarOpts(true),
  });

  // net-worth distribution
  const bins = [
    ["$1–2B", 1000, 2000], ["$2–5B", 2000, 5000], ["$5–10B", 5000, 10000],
    ["$10–20B", 10000, 20000], ["$20–50B", 20000, 50000],
    ["$50–100B", 50000, 100000], ["$100B+", 100000, Infinity],
  ];
  const counts = bins.map(([, lo, hi]) => rows.filter((p) => worthOf(p) >= lo && worthOf(p) < hi).length);
  makeChart("chDist", {
    type: "bar",
    data: barData(bins.map(([l]) => l), counts, C.blue),
    options: barOpts(false, " people"),
  });

  // concentration: cumulative share held by top N
  const marks = [10, 25, 50, 100, 250, 500, 1000, desc.length].filter((n, i, a) => n <= desc.length && a.indexOf(n) === i);
  let cum = 0, ci = 0;
  const cumAt = [];
  marks.forEach((n) => { while (ci < n) cum += desc[ci++]; cumAt.push((cum / total) * 100); });
  makeChart("chConc", {
    type: "line",
    data: {
      labels: marks.map((n) => `Top ${n.toLocaleString()}`),
      datasets: [{
        data: cumAt, borderColor: C.blue, backgroundColor: "rgba(57,135,229,.10)",
        fill: true, borderWidth: 2, pointRadius: 4, pointBackgroundColor: C.blue,
        pointBorderColor: C.surface, pointBorderWidth: 2,
      }],
    },
    options: {
      scales: {
        x: { grid: { display: false }, border: { display: false } },
        y: { min: 0, max: 100, ticks: { callback: (v) => v + "%" }, grid: { color: C.grid }, border: { display: false } },
      },
      plugins: {
        tooltip: {
          backgroundColor: "#222221", borderColor: "rgba(255,255,255,.1)", borderWidth: 1,
          titleColor: "#fff", bodyColor: C.ink2, padding: 10,
          callbacks: { label: (c) => ` ${c.parsed.y.toFixed(1)}% of total wealth` },
        },
      },
    },
  });

  // combined wealth of the current list members across the annual lists
  const years = ["2021", "2022", "2023", "2024", "2025"];
  const timeLabels = [...years, "Latest list", "Now"];
  const timeSums = [];
  const timeCounts = [];
  years.forEach((y) => {
    let s = 0, n = 0;
    rows.forEach((p) => { const w = (p.annual || {})[y]; if (w > 0) { s += w; n++; } });
    timeSums.push(s); timeCounts.push(n);
  });
  const archived = rows.filter((p) => p.archivedWorth > 0);
  timeSums.push(archived.reduce((s, p) => s + p.archivedWorth, 0));
  timeCounts.push(archived.length);
  timeSums.push(total);
  timeCounts.push(rows.length);
  makeChart("chWealthTime", {
    type: "line",
    data: {
      labels: timeLabels,
      datasets: [{
        data: timeSums, borderColor: C.aqua, backgroundColor: "rgba(25,158,112,.10)",
        fill: true, borderWidth: 2, pointRadius: 4, pointBackgroundColor: C.aqua,
        pointBorderColor: C.surface, pointBorderWidth: 2,
      }],
    },
    options: {
      scales: {
        x: { grid: { display: false }, border: { display: false } },
        y: { grid: { color: C.grid }, border: { display: false }, ticks: { callback: (v) => fmtMoney(v) } },
      },
      plugins: {
        tooltip: {
          backgroundColor: "#222221", borderColor: "rgba(255,255,255,.1)", borderWidth: 1,
          titleColor: "#fff", bodyColor: C.ink2, padding: 10,
          callbacks: { label: (c) => ` ${fmtMoney(c.parsed.y)} across ${timeCounts[c.dataIndex].toLocaleString()} people` },
        },
      },
    },
  });

  // age distribution
  const decades = new Map();
  ages.forEach((p) => { const d = Math.floor(p.age / 10) * 10; decades.set(d, (decades.get(d) || 0) + 1); });
  const dkeys = [...decades.keys()].sort((a, b) => a - b);
  makeChart("chAge", {
    type: "bar",
    data: barData(dkeys.map((d) => `${d}s`), dkeys.map((d) => decades.get(d)), C.blue),
    options: barOpts(false, " people"),
  });

  // average net worth per age decade
  const decadeWorth = new Map();
  ages.forEach((p) => {
    const d = Math.floor(p.age / 10) * 10;
    if (!decadeWorth.has(d)) decadeWorth.set(d, []);
    decadeWorth.get(d).push(worthOf(p));
  });
  makeChart("chAvgAge", {
    type: "bar",
    data: barData(
      dkeys.map((d) => `${d}s`),
      dkeys.map((d) => {
        const ws = decadeWorth.get(d) || [];
        return ws.length ? ws.reduce((s, v) => s + v, 0) / ws.length : 0;
      }),
      C.aqua),
    options: moneyBarOpts(false),
  });

  // composition stacked bars (self-made, gender) – pure CSS
  const compBar = (label, segments) => {
    segments = segments.filter((s) => s.n > 0);
    const totalSeg = segments.reduce((s, x) => s + x.n, 0) || 1;
    return `<div class="comp">
      <div class="comp-label">${label}</div>
      <div class="bar">${segments.map((s) => `<span class="seg" style="width:${(s.n / totalSeg) * 100}%;background:${s.color}" title="${s.name}: ${s.n.toLocaleString()}"></span>`).join("")}</div>
      <div class="legend">${segments.map((s) => `<span><i class="swatch" style="background:${s.color}"></i>${s.name} · ${((s.n / totalSeg) * 100).toFixed(0)}% (${s.n.toLocaleString()})</span>`).join("")}</div>
    </div>`;
  };
  // Forbes only flags selfMade=true; the rest are inherited or unlabeled
  const selfMade = rows.filter((p) => p.selfMade === true).length;
  const men = rows.filter((p) => p.gender === "M").length;
  const women = rows.filter((p) => p.gender === "F").length;
  $("compBars").innerHTML =
    compBar("Self-made vs inherited", [
      { name: "Self-made", n: selfMade, color: C.blue },
      { name: "Inherited / not flagged", n: rows.length - selfMade, color: C.aqua },
    ]) +
    compBar("Gender", [
      { name: "Men", n: men, color: C.blue },
      { name: "Women", n: women, color: C.violet },
      { name: "Unknown", n: rows.length - men - women, color: "#52514e" },
    ]);
}

/* ---------- performance view ---------- */
function renderPerformance() {
  const period = state.period;
  const def = PERIODS[period];
  const rows = scoped()
    .map((p) => ({ p, ...periodChange(p, period) }))
    .filter((r) => r.chg != null);

  const note = $("periodNote");
  const nEst = rows.filter((r) => r.est).length;
  if (!rows.length) {
    note.textContent = `No data available ${def.label}.`;
  } else if (nEst) {
    note.textContent = `${rows.length.toLocaleString()} people · ${nEst.toLocaleString()} estimated from the latest annual list until daily history builds up`;
  } else {
    note.textContent = `${rows.length.toLocaleString()} people with data ${def.label}`;
  }

  const agg = rows.reduce((s, r) => s + r.chg, 0);
  const winners = rows.filter((r) => r.chg > 0).length;
  const losers = rows.filter((r) => r.chg < 0).length;
  const byChg = rows.slice().sort((a, b) => b.chg - a.chg);
  // % movers restricted to fortunes >= $2B so tiny bases don't dominate
  const byPct = rows.filter((r) => baselineWorth(r.p, period).base >= 2000).sort((a, b) => b.pct - a.pct);

  const median = (arr) => (arr.length ? arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)] : null);
  const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);
  const avgChg = mean(rows.map((r) => r.chg));
  const medChg = median(rows.map((r) => r.chg));
  const avgPct = mean(rows.map((r) => r.pct));
  const medPct = median(rows.map((r) => r.pct));

  const tiles = [
    { label: "Aggregate change", value: fmtDelta(agg), cls: cls(agg) },
    { label: "Average change", value: fmtDelta(avgChg), cls: cls(avgChg) },
    { label: "Median change", value: fmtDelta(medChg), cls: cls(medChg) },
    { label: "Average return", value: fmtPct(avgPct), cls: cls(avgPct) },
    { label: "Median return", value: fmtPct(medPct), cls: cls(medPct) },
    { label: "Gainers", value: winners.toLocaleString(), cls: "pos" },
    { label: "Losers", value: losers.toLocaleString(), cls: "neg" },
    byChg[0] && { label: "Best ($)", value: byChg[0].p.name, delta: fmtDelta(byChg[0].chg), cls: cls(byChg[0].chg) },
    byChg[0] && { label: "Worst ($)", value: byChg[byChg.length - 1].p.name, delta: fmtDelta(byChg[byChg.length - 1].chg), cls: cls(byChg[byChg.length - 1].chg) },
    byPct[0] && { label: "Best (%)", value: byPct[0].p.name, delta: fmtPct(byPct[0].pct), cls: cls(byPct[0].pct) },
    byPct[0] && { label: "Worst (%)", value: byPct[byPct.length - 1].p.name, delta: fmtPct(byPct[byPct.length - 1].pct), cls: cls(byPct[byPct.length - 1].pct) },
  ].filter(Boolean);
  $("perfTiles").innerHTML = tiles.map((t) => `
    <div class="tile">
      <div class="label">${t.label}</div>
      <div class="value ${t.cls || ""}" style="font-size:${String(t.value).length > 12 ? 18 : 26}px">${t.value}</div>
      ${t.delta ? `<div class="delta ${t.cls || ""}">${t.delta} ${def.label}</div>` : ""}
    </div>`).join("");

  const gainAbs = byChg.slice(0, 10);
  const lossAbs = byChg.slice(-10).reverse().filter((r) => r.chg < 0);
  const gainPct = byPct.slice(0, 10);
  const lossPct = byPct.slice(-10).reverse().filter((r) => r.pct < 0);

  makeChart("chPerfGainAbs", {
    type: "bar",
    data: barData(gainAbs.map((r) => r.p.name), gainAbs.map((r) => r.chg / 1000), C.up),
    options: barOpts(true, " $B"),
  });
  makeChart("chPerfLossAbs", {
    type: "bar",
    data: barData(lossAbs.map((r) => r.p.name), lossAbs.map((r) => r.chg / 1000), C.down),
    options: barOpts(true, " $B"),
  });
  makeChart("chPerfGainPct", {
    type: "bar",
    data: barData(gainPct.map((r) => r.p.name), gainPct.map((r) => r.pct), C.up),
    options: barOpts(true, "%"),
  });
  makeChart("chPerfLossPct", {
    type: "bar",
    data: barData(lossPct.map((r) => r.p.name), lossPct.map((r) => r.pct), C.down),
    options: barOpts(true, "%"),
  });

  // average return by industry and by country (top 12 by people), sign-colored
  const groupAvg = (key, limit) => {
    const groups = new Map();
    rows.forEach((r) => {
      const k = r.p[key];
      if (!k) return;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r.pct);
    });
    let entries = [...groups.entries()];
    if (limit) entries = entries.sort((a, b) => b[1].length - a[1].length).slice(0, limit);
    return entries
      .map(([k, pcts]) => [k, mean(pcts)])
      .sort((a, b) => b[1] - a[1]);
  };
  const signBar = (id, entries) => makeChart(id, {
    type: "bar",
    data: {
      labels: entries.map(([k]) => k),
      datasets: [{
        data: entries.map(([, v]) => v),
        backgroundColor: entries.map(([, v]) => (v < 0 ? C.down : C.up)),
        borderRadius: 4, borderSkipped: false, maxBarThickness: 18, categoryPercentage: 0.72,
      }],
    },
    options: barOpts(true, "%"),
  });
  signBar("chAvgIndustry", groupAvg("industry"));
  signBar("chAvgCountry", groupAvg("country", 12));

  // return distribution: % buckets, red below zero, green above
  const buckets = [
    ["< -50%", -Infinity, -50], ["-50 to -25%", -50, -25], ["-25 to -10%", -25, -10],
    ["-10 to 0%", -10, 0], ["0 to +10%", 0, 10], ["+10 to +25%", 10, 25],
    ["+25 to +50%", 25, 50], ["+50 to +100%", 50, 100], ["> +100%", 100, Infinity],
  ];
  const counts = buckets.map(([, lo, hi]) => rows.filter((r) => r.pct >= lo && r.pct < hi).length);
  makeChart("chPerfDist", {
    type: "bar",
    data: {
      labels: buckets.map(([l]) => l),
      datasets: [{
        data: counts,
        backgroundColor: buckets.map(([, , hi]) => (hi <= 0 ? C.down : C.up)),
        borderRadius: 4, borderSkipped: false, maxBarThickness: 24, categoryPercentage: 0.72,
      }],
    },
    options: barOpts(false, " people"),
  });

  renderTrajectories();
}

const TRAJ_COLORS = ["#3987e5", "#199e70", "#c98500", "#008300", "#9085e9", "#e66767", "#d55181", "#d95926"];

function renderTrajectories() {
  const top = scoped().slice().sort((a, b) => (b.worth || 0) - (a.worth || 0)).slice(0, 8);
  const years = ["2021", "2022", "2023", "2024", "2025"];
  const labels = [...years, "Latest list", "Now"];
  const datasets = top.map((p, i) => ({
    label: p.name,
    data: [
      ...years.map((y) => ((p.annual || {})[y] || null) && (p.annual[y] / 1000)),
      p.archivedWorth > 0 ? p.archivedWorth / 1000 : null,
      p.worth / 1000,
    ],
    borderColor: TRAJ_COLORS[i], backgroundColor: TRAJ_COLORS[i],
    borderWidth: 2, pointRadius: 3.5, pointBorderColor: C.surface, pointBorderWidth: 2,
    spanGaps: true, fill: false,
  }));
  makeChart("chTraject", {
    type: "line",
    data: { labels, datasets },
    options: {
      scales: {
        x: { grid: { display: false }, border: { display: false } },
        y: { grid: { color: C.grid }, border: { display: false }, ticks: { callback: (v) => "$" + v + "B" } },
      },
      plugins: {
        legend: { display: true, position: "bottom", labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, color: C.ink2 } },
        tooltip: {
          backgroundColor: "#222221", borderColor: "rgba(255,255,255,.1)", borderWidth: 1,
          titleColor: "#fff", bodyColor: C.ink2, padding: 10,
          callbacks: { label: (c) => ` ${c.dataset.label}: $${c.parsed.y.toFixed(1)}B` },
        },
      },
    },
  });
}

/* ---------- "your odds" view ----------
   Chance that a person with the selected profile is on today's Forbes list.
   Each factor becomes a multiplier vs the world-average adult:
     country:  billionaires-per-adult in that country vs worldwide
     industry: billionaires-per-worker in that industry vs the world baseline
     gender:   share of billionaires of that gender vs a 50/50 split
     age:      billionaires-per-adult in that age band vs worldwide
   Multipliers are combined as if independent, which they are not; the page
   says so. All reference figures are rough public estimates, in millions. */

const WORLD_ADULTS_M = 5700;

// adults (18+) per country, millions, rough 2025 estimates
const COUNTRY_ADULTS_M = {
  "Afghanistan": 21, "Albania": 2.2, "Algeria": 30, "Argentina": 33, "Armenia": 2.2,
  "Australia": 20.5, "Austria": 7.5, "Barbados": 0.22, "Belgium": 9.2, "Belize": 0.26,
  "Brazil": 160, "Bulgaria": 5.5, "Canada": 32, "Chile": 15, "China": 1130,
  "Colombia": 39, "Croatia": 3.3, "Cyprus": 0.95, "Czech Republic": 8.6, "Denmark": 4.7,
  "Egypt": 68, "Estonia": 1.06, "Eswatini (Swaziland)": 0.7, "Finland": 4.5, "France": 52,
  "Georgia": 3, "Germany": 69, "Greece": 8.7, "Guernsey": 0.05, "Hong Kong": 6.4,
  "Hungary": 7.9, "Iceland": 0.29, "India": 1000, "Indonesia": 200, "Ireland": 3.9,
  "Israel": 6.7, "Italy": 50, "Japan": 105, "Kazakhstan": 13, "Lebanon": 4,
  "Liechtenstein": 0.031, "Luxembourg": 0.52, "Malaysia": 24, "Mexico": 92, "Monaco": 0.032,
  "Morocco": 27, "Nepal": 20, "Netherlands": 14.3, "New Zealand": 4, "Nigeria": 110,
  "Norway": 4.4, "Oman": 3.6, "Pakistan": 140, "Peru": 24, "Philippines": 75,
  "Poland": 31, "Portugal": 8.7, "Qatar": 2.6, "Romania": 15.5, "Russia": 115,
  "Saudi Arabia": 26, "Singapore": 4.9, "Slovakia": 4.4, "South Africa": 42,
  "South Korea": 44, "Spain": 39, "St. Kitts and Nevis": 0.04, "Sweden": 8.4,
  "Switzerland": 7.3, "Taiwan": 20, "Tanzania": 32, "Thailand": 57, "Turkey": 63,
  "Ukraine": 30, "United Arab Emirates": 8.5, "United Kingdom": 54, "United States": 262,
  "Uruguay": 2.7, "Venezuela": 21, "Vietnam": 74, "Zimbabwe": 8.5,
};

// global workforce per Forbes industry, millions, rough estimates
const INDUSTRY_WORKERS_M = {
  "Technology": 70, "Finance & Investments": 65, "Fashion & Retail": 420,
  "Manufacturing": 430, "Food & Beverage": 220, "Healthcare": 220,
  "Real Estate": 55, "Energy": 55, "Media & Entertainment": 45,
  "Metals & Mining": 35, "Automotive": 60, "Logistics": 140, "Telecom": 25,
  "Service": 500, "Construction & Engineering": 280, "Sports": 15,
  "Gambling & Casinos": 12, "Diversified": null, // no meaningful workforce
};

// world adult age structure, approximate shares
const AGE_BANDS = [
  { key: "u30", label: "Under 30", min: 18, max: 29, share: 0.27 },
  { key: "30s", label: "30s", min: 30, max: 39, share: 0.21 },
  { key: "40s", label: "40s", min: 40, max: 49, share: 0.17 },
  { key: "50s", label: "50s", min: 50, max: 59, share: 0.14 },
  { key: "60s", label: "60s", min: 60, max: 69, share: 0.11 },
  { key: "70s", label: "70s", min: 70, max: 79, share: 0.07 },
  { key: "80p", label: "80+", min: 80, max: 200, share: 0.03 },
];

const fmtOneIn = (n) => {
  if (!isFinite(n) || n <= 0) return "–";
  if (n >= 1e9) return `1 in ${(n / 1e9).toFixed(1)} billion`;
  if (n >= 1e6) return `1 in ${(n / 1e6).toFixed(1)} million`;
  return `1 in ${Math.round(n).toLocaleString()}`;
};

const fmtTimes = (x) => (x >= 10 ? Math.round(x).toLocaleString() : x >= 1 ? x.toFixed(1) : x.toFixed(2));

function renderOdds() {
  const people = state.people;
  const total = people.length;
  const baseline = total / (WORLD_ADULTS_M * 1e6); // P(billionaire) for the average adult

  const country = $("oddsCountry").value;
  const industry = $("oddsIndustry").value;
  const gender = $("oddsGender").value;
  const ageKey = $("oddsAge").value;

  const factors = [];
  let noData = false;

  if (country) {
    const n = people.filter((p) => p.country === country).length;
    const adults = COUNTRY_ADULTS_M[country];
    if (adults) {
      const mult = (n / (adults * 1e6)) / baseline;
      factors.push({ label: country, detail: `${n.toLocaleString()} billionaires`, mult });
    } else {
      factors.push({ label: country, detail: `${n.toLocaleString()} billionaires · no population data`, mult: 1 });
      noData = true;
    }
  }
  if (industry) {
    const n = people.filter((p) => p.industry === industry).length;
    const workers = INDUSTRY_WORKERS_M[industry];
    if (workers) {
      const mult = (n / (workers * 1e6)) / baseline;
      factors.push({ label: industry, detail: `${n.toLocaleString()} billionaires`, mult });
    } else {
      factors.push({ label: industry, detail: `${n.toLocaleString()} billionaires · no workforce data`, mult: 1 });
      noData = true;
    }
  }
  if (gender) {
    const n = people.filter((p) => p.gender === gender).length;
    const mult = (n / total) / 0.5;
    factors.push({ label: gender === "M" ? "Man" : "Woman", detail: `${n.toLocaleString()} billionaires`, mult });
  }
  if (ageKey) {
    const band = AGE_BANDS.find((b) => b.key === ageKey);
    const n = people.filter((p) => p.age != null && p.age >= band.min && p.age <= band.max).length;
    const mult = (n / total) / band.share;
    factors.push({ label: band.label, detail: `${n.toLocaleString()} billionaires`, mult });
  }

  const rel = factors.reduce((s, f) => s * f.mult, 1);
  const odds = baseline * rel;
  const oneIn = 1 / odds;
  const avgOneIn = 1 / baseline;

  const factorRows = factors.map((f) => {
    // log-scaled bar: ×1 sits at the center, ×100 fills right, ×0.01 empties left
    const w = Math.max(3, Math.min(100, 50 + 25 * Math.log10(f.mult || 1e-4)));
    return `<div class="ofactor">
      <div class="ofactor-head">
        <span class="ofactor-label">${f.label}</span>
        <span class="ofactor-mult ${f.mult >= 1 ? "pos" : "neg"}">×${fmtTimes(f.mult)}</span>
      </div>
      <div class="ofactor-bar"><span style="width:${w}%"></span></div>
      <div class="ofactor-detail">${f.detail}</div>
    </div>`;
  }).join("");

  $("oddsResult").innerHTML = `
    <div class="odds-big">${fmtOneIn(oneIn)}</div>
    <div class="odds-sub">chance that a person with this profile is on today's list of
      ${total.toLocaleString()} billionaires</div>
    <div class="odds-compare ${rel >= 1 ? "pos" : "neg"}">
      ${factors.length
        ? `×${fmtTimes(rel)} ${rel >= 1 ? "more" : "as"} likely ${rel >= 1 ? "than" : "as"} the average person (${fmtOneIn(avgOneIn)})`
        : `this is the world-average adult's odds`}
    </div>
    ${factorRows ? `<div class="odds-factors"><div class="odds-factors-title">Factor breakdown</div>${factorRows}</div>` : ""}
    ${noData ? `<div class="odds-warn">Factors without reference data count as ×1.</div>` : ""}`;
}

function populateOdds() {
  const fillCounted = (sel, key) => {
    const counts = new Map();
    state.people.forEach((p) => { const k = p[key]; if (k) counts.set(k, (counts.get(k) || 0) + 1); });
    [...counts.keys()].sort().forEach((v) => {
      const o = document.createElement("option");
      o.value = v; o.textContent = v;
      sel.appendChild(o);
    });
  };
  fillCounted($("oddsCountry"), "country");
  fillCounted($("oddsIndustry"), "industry");
  AGE_BANDS.forEach((b) => {
    const o = document.createElement("option");
    o.value = b.key; o.textContent = b.label;
    $("oddsAge").appendChild(o);
  });
  ["oddsCountry", "oddsIndustry", "oddsGender", "oddsAge"].forEach((id) =>
    $(id).addEventListener("change", renderOdds));
}

/* ---------- person detail modal ---------- */
function openPersonModal(p) {
  const overlay = $("personModal");
  overlay.hidden = false;

  const head = $("modalHead");
  head.innerHTML = "";
  if (p.image) {
    const img = document.createElement("img");
    img.className = "avatar";
    img.src = p.image.startsWith("//") ? "https:" + p.image : p.image;
    img.alt = "";
    img.onerror = () => img.replaceWith(avatarFallback(p.name));
    head.appendChild(img);
  } else head.appendChild(avatarFallback(p.name));
  const info = document.createElement("div");
  info.innerHTML = `<h3></h3><div class="meta"></div>`;
  info.querySelector("h3").textContent = `#${p.rank ?? "?"} ${p.name}`;
  info.querySelector(".meta").textContent =
    [p.source, p.country, p.industry, p.age != null ? `age ${p.age}` : null].filter(Boolean).join(" · ");
  head.appendChild(info);
  const now = document.createElement("div");
  now.className = "worth-now";
  now.innerHTML = `<div class="big">${fmtMoney(p.worth)}</div><div class="sub2">net worth now</div>`;
  head.appendChild(now);

  const statDefs = [["day", "Today"], ["m1", "1M"], ["m3", "3M"], ["ytd", "YTD"], ["y1", "1Y"], ["y3", "3Y"], ["y5", "5Y"]];
  $("modalStats").innerHTML = statDefs.map(([key, label]) => {
    const { chg, pct, est } = periodChange(p, key);
    const mark = est ? "*" : "";
    return `<div class="mstat">
      <div class="label">${label}</div>
      <div class="val ${cls(chg)}">${fmtDelta(chg)}${mark}</div>
      <div class="pct ${cls(pct)}">${fmtPct(pct)}${mark}</div>
    </div>`;
  }).join("");

  const years = ["2021", "2022", "2023", "2024", "2025"];
  makeChart("chPerson", {
    type: "line",
    data: {
      labels: [...years, "Latest list", "Now"],
      datasets: [{
        data: [
          ...years.map((y) => ((p.annual || {})[y] || null) && (p.annual[y] / 1000)),
          p.archivedWorth > 0 ? p.archivedWorth / 1000 : null,
          p.worth / 1000,
        ],
        borderColor: C.blue, backgroundColor: "rgba(57,135,229,.10)", fill: true,
        borderWidth: 2, pointRadius: 4, pointBackgroundColor: C.blue,
        pointBorderColor: C.surface, pointBorderWidth: 2, spanGaps: true,
      }],
    },
    options: {
      scales: {
        x: { grid: { display: false }, border: { display: false } },
        y: { grid: { color: C.grid }, border: { display: false }, ticks: { callback: (v) => "$" + v + "B" } },
      },
      plugins: {
        tooltip: {
          backgroundColor: "#222221", borderColor: "rgba(255,255,255,.1)", borderWidth: 1,
          titleColor: "#fff", bodyColor: C.ink2, padding: 10,
          callbacks: { label: (c) => ` $${c.parsed.y.toFixed(1)}B` },
        },
      },
    },
  });
}

function closePersonModal() {
  $("personModal").hidden = true;
  if (state.charts.chPerson) { state.charts.chPerson.destroy(); delete state.charts.chPerson; }
}

/* ---------- filters UI ---------- */
function populateFilters() {
  const fill = (sel, values) => {
    values.forEach((v) => {
      const o = document.createElement("option");
      o.value = v; o.textContent = v;
      sel.appendChild(o);
    });
  };
  const uniq = (key) => [...new Set(state.people.map((p) => p[key]).filter(Boolean))].sort();
  fill($("countryFilter"), uniq("country"));
  fill($("industryFilter"), uniq("industry"));
}

/* ---------- events ---------- */
function bindEvents() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + tab.dataset.view));
      // search/dropdown filters only affect the table; hide them elsewhere.
      // the odds view ignores scope too, so it hides the whole filter bar.
      const view = tab.dataset.view;
      const isRankings = view === "rankings";
      $("search").style.display = isRankings ? "" : "none";
      $("countryFilter").style.display = isRankings ? "" : "none";
      $("industryFilter").style.display = isRankings ? "" : "none";
      $("filterbar").style.display = view === "odds" ? "none" : "";
      if (view === "analysis" && state.dashboardDirty) {
        renderDashboard();
        state.dashboardDirty = false;
      }
      if (view === "performance" && state.perfDirty) {
        renderPerformance();
        state.perfDirty = false;
      }
      if (view === "odds" && state.oddsDirty) {
        renderOdds();
        state.oddsDirty = false;
      }
    });
  });

  let debounce;
  $("search").addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(applyFilters, 150);
  });
  $("countryFilter").addEventListener("change", applyFilters);
  $("industryFilter").addEventListener("change", applyFilters);

  $("scopeAll").addEventListener("click", () => setScope("all"));
  $("scope500").addEventListener("click", () => setScope("top500"));

  document.querySelectorAll("thead th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) state.sortDir *= -1;
      else {
        state.sortKey = key;
        state.sortDir = ["name", "country", "industry", "rank"].includes(key) ? 1 : -1;
      }
      document.querySelectorAll("thead th").forEach((h) => h.classList.remove("sorted-asc", "sorted-desc"));
      th.classList.add(state.sortDir === 1 ? "sorted-asc" : "sorted-desc");
      applyFilters();
    });
  });

  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && state.rendered < state.filtered.length) renderChunk();
  }, { rootMargin: "600px" }).observe($("sentinel"));

  document.querySelectorAll("#periodbar .chip").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.period === state.period);
    chip.addEventListener("click", () => {
      state.period = chip.dataset.period;
      try { localStorage.setItem("wt.period", state.period); } catch (_) {}
      document.querySelectorAll("#periodbar .chip").forEach((c) => c.classList.toggle("active", c === chip));
      renderPerformance();
    });
  });

  $("modalClose").addEventListener("click", closePersonModal);
  $("personModal").addEventListener("click", (e) => { if (e.target === $("personModal")) closePersonModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("personModal").hidden) closePersonModal(); });
}

function setScope(scope) {
  state.scope = scope;
  $("scopeAll").classList.toggle("active", scope === "all");
  $("scope500").classList.toggle("active", scope === "top500");
  applyFilters();
  if ($("view-analysis").classList.contains("active")) {
    renderDashboard();
    state.dashboardDirty = false;
  } else {
    state.dashboardDirty = true;
  }
  if ($("view-performance").classList.contains("active")) {
    renderPerformance();
    state.perfDirty = false;
  } else {
    state.perfDirty = true;
  }
}

/* ---------- init ---------- */
(async function init() {
  bindEvents();
  try {
    await loadData();
  } catch (e) {
    const el = $("error");
    el.textContent = `Failed to load data: ${e.message}`;
    el.hidden = false;
    $("asof").textContent = "Data unavailable";
    return;
  }
  chartDefaults();
  populateFilters();
  populateOdds();
  applyFilters();
  if (state.people.some((p) => p.est90)) {
    $("tableNote").textContent =
      "* 3M change is estimated from the latest annual Forbes list; it is replaced by measured values as ~90 days of daily history accumulate.";
  }
  // dashboard renders lazily on first switch to the Analysis tab
})();
