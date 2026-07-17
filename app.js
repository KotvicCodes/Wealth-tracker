/* Wealth Tracker frontend — plain JS, no framework. */
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
  dashboardDirty: true,  // charts can't size in a hidden tab — render on show
};

const CHUNK = 80;

/* ---------- formatting ---------- */
const fmtMoney = (m) => {
  // m is $ millions
  if (m == null || isNaN(m)) return "—";
  const abs = Math.abs(m);
  const sign = m < 0 ? "-" : "";
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}T`;
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(abs >= 100000 ? 0 : 1)}B`;
  return `${sign}$${abs.toFixed(0)}M`;
};
const fmtDelta = (m) => (m == null || isNaN(m) ? "—" : (m >= 0 ? "+" : "") + fmtMoney(m).replace("$-", "-$"));
const fmtPct = (p) => (p == null || isNaN(p) ? "—" : `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`);
const cls = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");

/* ---------- data ---------- */
async function loadData() {
  const resp = await fetch("/api/billionaires");
  if (!resp.ok) {
    let msg = `Server error (${resp.status})`;
    try { msg = (await resp.json()).error || msg; } catch (_) {}
    throw new Error(msg);
  }
  const data = await resp.json();
  const now = Date.now();
  state.people = data.people.map((p) => {
    const dailyChange = p.prevWorth != null ? p.worth - p.prevWorth : null;
    const dailyPct = p.prevWorth ? (dailyChange / p.prevWorth) * 100 : null;
    const ytdChange = p.archivedWorth != null && p.archivedWorth > 0 ? p.worth - p.archivedWorth : null;
    const ytdPct = p.archivedWorth > 0 ? (ytdChange / p.archivedWorth) * 100 : null;
    const age = p.birthDate ? Math.floor((now - p.birthDate) / (365.25 * 24 * 3600e3)) : null;
    return { ...p, dailyChange, dailyPct, ytdChange, ytdPct, age };
  });
  $("asof").textContent = `As of ${new Date(data.asOf).toLocaleString()} · ${data.count.toLocaleString()} billionaires · source: Forbes real-time list`;
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
  tdRank.className = "num"; tdRank.textContent = p.rank ?? "—";

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
  const nm = document.createElement("div"); nm.textContent = p.name || "—";
  const src = document.createElement("div"); src.className = "src"; src.textContent = p.source || "";
  nameBox.append(nm, src);
  wrap.appendChild(nameBox);
  tdName.appendChild(wrap);

  const tdCountry = document.createElement("td"); tdCountry.textContent = p.country || "—";
  const tdInd = document.createElement("td"); tdInd.textContent = p.industry || "—";

  const tdWorth = document.createElement("td"); tdWorth.className = "num name"; tdWorth.textContent = fmtMoney(p.worth);
  const tdDay = document.createElement("td"); tdDay.className = `num ${cls(p.dailyChange)}`; tdDay.textContent = fmtDelta(p.dailyChange);
  const tdDayP = document.createElement("td"); tdDayP.className = `num ${cls(p.dailyPct)}`; tdDayP.textContent = fmtPct(p.dailyPct);
  const tdYtd = document.createElement("td"); tdYtd.className = `num ${cls(p.ytdChange)}`; tdYtd.textContent = fmtDelta(p.ytdChange);
  const tdYtdP = document.createElement("td"); tdYtdP.className = `num ${cls(p.ytdPct)}`; tdYtdP.textContent = fmtPct(p.ytdPct);

  const tdSpark = document.createElement("td");
  if (p.spark && p.spark.length > 1) tdSpark.appendChild(sparkline(p.spark));

  tr.append(tdRank, tdName, tdCountry, tdInd, tdWorth, tdDay, tdDayP, tdYtd, tdYtdP, tdSpark);
  return tr;
}

function avatarFallback(name) {
  const el = document.createElement("span");
  el.className = "avatar fallback";
  el.textContent = (name || "?").split(" ").map((w) => w[0]).slice(0, 2).join("");
  return el;
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
         ticks: horizontal ? {} : { callback: (v) => compact(v) } },
  },
  plugins: {
    tooltip: {
      backgroundColor: "#222221", borderColor: "rgba(255,255,255,.1)", borderWidth: 1,
      titleColor: "#fff", bodyColor: C.ink2, padding: 10,
      callbacks: { label: (c) => ` ${(horizontal ? c.parsed.x : c.parsed.y).toLocaleString(undefined, { maximumFractionDigits: 1 })}${unit || ""}` },
    },
  },
});

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

  // stat tiles
  const tiles = [
    { label: "People", value: rows.length.toLocaleString() },
    { label: "Combined wealth", value: fmtMoney(total) },
    { label: "Average", value: fmtMoney(rows.length ? total / rows.length : 0) },
    { label: "Median", value: fmtMoney(median) },
    { label: "Today's aggregate move", value: fmtDelta(dayMove), cls: cls(dayMove) },
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

  // wealth by country (top 12 + Other)
  const byKey = (key) => {
    const m = new Map();
    rows.forEach((p) => { const k = p[key] || "Unknown"; m.set(k, (m.get(k) || 0) + worthOf(p)); });
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const countries = byKey("country");
  const top = countries.slice(0, 12);
  const other = countries.slice(12).reduce((s, [, v]) => s + v, 0);
  if (other > 0) top.push(["Other", other]);
  makeChart("chCountry", {
    type: "bar",
    data: barData(top.map(([k]) => k), top.map(([, v]) => v / 1000), C.blue),
    options: barOpts(true, " $B"),
  });

  const industries = byKey("industry");
  makeChart("chIndustry", {
    type: "bar",
    data: barData(industries.map(([k]) => k), industries.map(([, v]) => v / 1000), C.blue),
    options: barOpts(true, " $B"),
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
  const desc = rows.map(worthOf).sort((a, b) => b - a);
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

  // age distribution
  const ages = rows.filter((p) => p.age != null && p.age > 10 && p.age < 110);
  const decades = new Map();
  ages.forEach((p) => { const d = Math.floor(p.age / 10) * 10; decades.set(d, (decades.get(d) || 0) + 1); });
  const dkeys = [...decades.keys()].sort((a, b) => a - b);
  makeChart("chAge", {
    type: "bar",
    data: barData(dkeys.map((d) => `${d}s`), dkeys.map((d) => decades.get(d)), C.blue),
    options: barOpts(false, " people"),
  });

  // composition stacked bars (self-made, gender) — pure CSS
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
      // search/dropdown filters only affect the table; hide them on the analysis view
      const isRankings = tab.dataset.view === "rankings";
      $("search").style.display = isRankings ? "" : "none";
      $("countryFilter").style.display = isRankings ? "" : "none";
      $("industryFilter").style.display = isRankings ? "" : "none";
      if (!isRankings && state.dashboardDirty) {
        renderDashboard();
        state.dashboardDirty = false;
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
  applyFilters();
  // dashboard renders lazily on first switch to the Analysis tab
})();
