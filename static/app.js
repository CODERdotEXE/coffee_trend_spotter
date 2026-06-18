/* Brewscope console — loads dataset, slices by region, renders views. */
const State = { data: null, region: "USUK", view: "overview", charts: [] };
const REGION_MATCH = {
  USUK: r => (r.regions || []).some(x => x === "US" || x === "GB"),
  US: r => (r.regions || []).includes("US"),
  GB: r => (r.regions || []).includes("GB"),
  IN: r => (r.regions || []).includes("IN"),
};
const regionLabel = r => r === "USUK" ? "US + UK" : (State.data?.meta?.regions?.[r] || r);
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : "" + n;
const esc = s => (s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const SENT = { positive: "#188038", neutral: "#80868b", negative: "#d93025" };
const STAGE = { emerging: "b-emerging", rising: "b-rising", peaking: "b-peaking", steady: "b-steady", fading: "b-fading", dormant: "b-dormant" };

const ourBrands = () => State.data?.meta?.our_brands || [];
const isOurs = n => ourBrands().includes(n);
const regionMarkets = () => (State.data?.meta?.region_groups?.[State.region]) || [State.region];
function ourInMarket() {
  const mk = regionMarkets(), m = State.data?.meta?.our_brand_markets || {};
  return ourBrands().filter(n => (m[n] || []).some(x => mk.includes(x)));
}
const IMPACT_CLASS = { High: "b-rising", Medium: "b-peaking", Low: "b-steady", Declining: "b-fading", "n/a": "b-dormant" };
// Brand-agnostic perception lenses — how coffee *itself* is talked about.
const PERCEPTION_META = {
  "Health & Wellness": { icon: "ecg_heart", blurb: "Benefits, nutrition, longevity — coffee framed as good for you." },
  "Side Effects & Concerns": { icon: "warning", blurb: "Jitters, sleep, acidity, addiction — the health-risk conversation." },
  "Energy & Productivity": { icon: "bolt", blurb: "Caffeine as fuel — focus, alertness, getting through the day." },
  "Taste & Quality": { icon: "local_cafe", blurb: "Flavour, aroma, craft and specialty — the sensory experience." },
  "Sustainability & Ethics": { icon: "eco", blurb: "Fair trade, organic, farmers, climate — conscience-driven talk." },
  "Price & Value": { icon: "payments", blurb: "Cost, worth, affordability — value-for-money perception." },
  "Convenience & Ritual": { icon: "schedule", blurb: "Instant, pods, on-the-go and the daily coffee habit." },
  "Culture & Lifestyle": { icon: "groups", blurb: "Café culture, aesthetics, trends and coffee as identity." },
};

// ---------- data helpers ----------
function records() {
  const all = State.data?.records || [];
  const f = REGION_MATCH[State.region];
  return f ? all.filter(f) : all;
}
const parseDate = s => { try { return s ? new Date(s) : null; } catch { return null; } };

function weeklyCounts(recs) {
  const counts = Array(12).fill(0), now = new Date();
  recs.forEach(r => { const d = parseDate(r.published); if (!d) return; const idx = 11 - Math.floor((now - d) / (7 * 864e5)); if (idx >= 0 && idx < 12) counts[idx]++; });
  return counts;
}
function momentum(recs) {
  const now = new Date(); let recent = 0, prior = 0, dated = 0;
  recs.forEach(r => { const d = parseDate(r.published); if (!d) return; dated++; const days = (now - d) / 864e5; if (days <= 28) recent++; else if (days <= 84) prior++; });
  const rr = recent / 28, pr = prior / 56;
  return { growth: pr > 0 ? (rr - pr) / pr : (recent > 0 ? 1 : 0), dated };
}
function stageOf(recs, vol, medVol) {
  if (!recs.length) return "dormant";
  const { growth, dated } = momentum(recs);
  if (dated < 2) return "steady";
  if (growth > 0.4 && vol < medVol) return "emerging";
  if (growth > 0.15) return "rising";
  if (growth < -0.2) return "fading";
  return vol >= medVol ? "peaking" : "steady";
}
function sentStats(recs) {
  if (!recs.length) return { avg: 0, pos: 0, neu: 0, neg: 0 };
  const avg = recs.reduce((a, r) => a + (r.sentiment || 0), 0) / recs.length;
  const c = k => Math.round(100 * recs.filter(r => r.sent === k).length / recs.length);
  return { avg: +avg.toFixed(3), pos: c("positive"), neu: c("neutral"), neg: c("negative") };
}
function aggregate(kind, keepZero = false) {
  const list = kind === "types" ? State.data.config.coffee_types : State.data.config.brands;
  const recs = records();
  const built = list.map(name => ({ name, sub: recs.filter(r => (kind === "types" ? r.types : r.brands).includes(name)) }));
  const posVols = built.map(b => b.sub.length).filter(v => v > 0).sort((a, b) => a - b);
  const med = posVols[Math.floor(posVols.length / 2)] || 0;
  let rows = built.map(({ name, sub }) => ({
    name, count: sub.length, sub,
    engagement: sub.reduce((a, r) => a + (r.engagement || 0), 0),
    sent: sentStats(sub), weekly: weeklyCounts(sub), stage: stageOf(sub, sub.length, med),
    launches: sub.filter(r => r.is_launch).length,
    topVideos: sub.filter(r => r.source === "youtube").sort((a, b) => b.engagement - a.engagement).slice(0, 6),
  }));
  if (!keepZero) rows = rows.filter(r => r.count > 0);
  return rows.sort((a, b) => b.count - a.count);
}

// ---------- charts ----------
const clearCharts = () => { State.charts.forEach(c => c.destroy()); State.charts = []; };
function lineChart(ctx, data, color = "#1a73e8", fill = true) {
  State.charts.push(new Chart(ctx, {
    type: "line",
    data: { labels: data.map((_, i) => i), datasets: [{ data, borderColor: color, backgroundColor: fill ? color + "1f" : "transparent", fill, tension: .4, borderWidth: 2, pointRadius: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false, beginAtZero: true } } }
  }));
}
function radarChart(ctx, labels, values, pointColors, max) {
  State.charts.push(new Chart(ctx, {
    type: "radar",
    data: {
      labels,
      datasets: [{
        label: "Share of conversation", data: values,
        borderColor: "#1a73e8", backgroundColor: "rgba(26,115,232,.13)", borderWidth: 2,
        pointRadius: 5, pointHoverRadius: 7, pointBackgroundColor: pointColors,
        pointBorderColor: "#fff", pointBorderWidth: 1.5,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => ` ${c.formattedValue}% of themed conversation` } }
      },
      scales: {
        r: {
          suggestedMin: 0, suggestedMax: max, beginAtZero: true,
          ticks: { display: true, stepSize: Math.max(5, Math.round(max / 4)), backdropColor: "transparent", color: "#bdc1c6", font: { size: 9 } },
          pointLabels: { font: { size: 11, family: "Inter", weight: "500" }, color: "#3c4043" },
          grid: { color: "#e8eaed" }, angleLines: { color: "#e8eaed" }
        }
      }
    }
  }));
}
function doughnut(ctx, labels, values, colors) {
  State.charts.push(new Chart(ctx, {
    type: "doughnut", data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: "64%", plugins: { legend: { position: "right", labels: { boxWidth: 11, font: { size: 11, family: "Inter" } } } } }
  }));
}

// ---------- shared bits ----------
const sentBar = ss => `<div class="sent-bar"><i style="width:${ss.pos}%;background:${SENT.positive}"></i><i style="width:${ss.neu}%;background:${SENT.neutral}"></i><i style="width:${ss.neg}%;background:${SENT.negative}"></i></div>`;
const badge = st => `<span class="badge ${STAGE[st]}">${st}</span>`;
const portTag = n => isOurs(n) ? ' <span class="tag-port">Portfolio</span>' : "";

// ---------- overview ----------
function renderOverview() {
  const recs = records();
  const types = aggregate("types"), brands = aggregate("brands");
  const totalBrand = brands.reduce((a, b) => a + b.count, 0) || 1;
  const portfolioN = brands.filter(b => isOurs(b.name)).reduce((a, b) => a + b.count, 0);
  const launches = recs.filter(r => r.is_launch).length;
  const ov = sentStats(recs), s = State.data.summary;

  const kpis = [
    ["Conversations", fmt(recs.length), "videos + articles in view"],
    ["Avg sentiment", ov.avg.toFixed(2), `${ov.pos}% positive`],
    ["Top format", types[0]?.name || "—", types[0] ? badge(types[0].stage) : ""],
    ["Our share of voice", `${(100 * portfolioN / totalBrand).toFixed(1)}%`, `${portfolioN} portfolio mentions`],
  ].map(([l, v, sub]) => `<div class="card kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`).join("");

  const leaders = types.slice(0, 6).map((t, i) => `
    <div class="card tcard" data-kind="types" data-name="${esc(t.name)}">
      <div class="top"><div><div class="name">${esc(t.name)}</div><div class="sub">${t.count} mentions · ${fmt(t.engagement)} reach</div></div>${badge(t.stage)}</div>
      <div class="spark"><canvas id="ov_${i}"></canvas></div>${sentBar(t.sent)}</div>`).join("");

  const sov = brands.slice(0, 8).map(b => `
    <tr class="brow ${isOurs(b.name) ? "our" : ""}" data-kind="brands" data-name="${esc(b.name)}">
      <td>${esc(b.name)}${portTag(b.name)}</td><td>${b.count}</td>
      <td><div class="sov-bar ${isOurs(b.name) ? "port" : ""}"><i style="width:${Math.round(100 * b.count / totalBrand)}%"></i></div></td>
      <td>${badge(b.stage)}</td></tr>`).join("");

  $("#content").innerHTML = `
    <div class="summary"><div class="eyebrow">Executive summary · ${regionLabel(State.region)}</div>
      <h2>${esc(s.headline)}</h2><ul>${s.insights.map(i => `<li>${i}</li>`).join("")}</ul></div>
    <div class="grid cols-4" style="margin-top:16px">${kpis}</div>
    <div class="section-title">Trend leaders — coffee formats</div>
    <div class="grid cols-3">${leaders}</div>
    <div class="grid cols-2" style="margin-top:20px">
      <div class="card"><h3>Brand share of voice</h3><table><thead><tr><th>Brand</th><th>Mentions</th><th>Share of voice</th><th>Momentum</th></tr></thead><tbody>${sov}</tbody></table></div>
      <div class="card"><h3>Conversation sentiment</h3><div style="height:220px"><canvas id="ovSent"></canvas></div></div>
    </div>`;
  types.slice(0, 6).forEach((t, i) => lineChart($(`#ov_${i}`), t.weekly));
  doughnut($("#ovSent"), ["Positive", "Neutral", "Negative"], [ov.pos, ov.neu, ov.neg], [SENT.positive, SENT.neutral, SENT.negative]);
  bindCards();
}

// ---------- coffee types ----------
function searchInterest(name) {
  const si = (State.data.search_interest || {})[name];
  if (!si) return "";
  const up = si.growth >= 0;
  return ` · <span title="Google Trends search interest">🔍 ${si.interest}<span style="color:${up ? "#188038" : "#c0392b"}">${up ? "▲" : "▼"}</span></span>`;
}
function renderTypes() {
  const types = aggregate("types");
  $("#content").innerHTML = `<div class="section-title">${types.length} coffee formats in conversation — select a card for detail</div>
    <div class="grid cols-3">${types.map((t, i) => `
      <div class="card tcard" data-kind="types" data-name="${esc(t.name)}">
        <div class="top"><div><div class="name">${esc(t.name)}</div><div class="sub">${t.count} mentions · ${fmt(t.engagement)} reach${t.launches ? ` · ${t.launches} launches` : ""}</div></div>${badge(t.stage)}</div>
        <div class="spark"><canvas id="ty_${i}"></canvas></div>${sentBar(t.sent)}
        <div class="muted" style="margin-top:6px">${t.sent.pos}% positive · avg ${t.sent.avg.toFixed(2)}${searchInterest(t.name)}</div></div>`).join("")}</div>`;
  types.forEach((t, i) => lineChart($(`#ty_${i}`), t.weekly));
  bindCards();
}

// ---------- brands ----------
function brandTable(rows, total) {
  return `<table><thead><tr><th>Brand</th><th>Mentions</th><th>Share of voice</th><th>Sentiment</th><th>Trend (12 wk)</th><th>Momentum</th><th>Launches</th></tr></thead><tbody>
    ${rows.map((b, i) => `<tr class="brow ${isOurs(b.name) ? "our" : ""}" data-kind="brands" data-name="${esc(b.name)}">
      <td><b>${esc(b.name)}</b>${portTag(b.name)}</td><td>${b.count}</td>
      <td><div class="row"><div class="sov-bar ${isOurs(b.name) ? "port" : ""}"><i style="width:${Math.round(100 * b.count / total)}%"></i></div>${Math.round(100 * b.count / total)}%</div></td>
      <td>${b.count ? `${b.sent.pos}%▲ / ${b.sent.neg}%▼` : "—"}</td>
      <td><div style="width:118px;height:32px"><canvas id="${b._id}"></canvas></div></td>
      <td>${badge(b.stage)}</td><td>${b.launches || "—"}</td></tr>`).join("")}</tbody></table>`;
}
function renderBrands() {
  const all = aggregate("brands", true);
  const total = all.reduce((a, b) => a + b.count, 0) || 1;
  const present = all.filter(b => b.count > 0);
  const inMarket = ourInMarket();
  const ourMissing = all.filter(b => inMarket.includes(b.name) && b.count === 0);
  let idx = 0; [...present, ...ourMissing].forEach(b => b._id = "br_" + (idx++));
  const emerging = (State.data.emerging_brands || []);

  $("#content").innerHTML = `<div class="section-title">${present.length} brands detected · knowledge base + portfolio (highlighted)</div>
    <div class="card">${brandTable(present, total)}</div>
    ${ourMissing.length ? `<div class="section-title">Portfolio brands with no current conversation</div>
      <div class="note">These ${esc(State.data.meta.company)} brands have no detected chatter in this market this period — a category whitespace to act on.</div>
      <div class="card" style="margin-top:10px">${brandTable(ourMissing, total)}</div>` : ""}
    ${emerging.length ? `<div class="section-title">Emerging brands — auto-detected, not yet in the knowledge base</div>
      <div class="card"><table><thead><tr><th>Candidate brand</th><th>Mentions</th><th>Distinct creators</th></tr></thead><tbody>
      ${emerging.map(e => `<tr><td><b>${esc(e.name)}</b></td><td>${e.count}</td><td>${e.channels}</td></tr>`).join("")}</tbody></table>
      <div class="muted" style="margin-top:8px">Review these and add genuine brands to <code>brands_reference.json</code> to track them precisely.</div></div>` : ""}`;
  [...present, ...ourMissing].forEach(b => lineChart($("#" + b._id), b.weekly, isOurs(b.name) ? "#6b3fa0" : "#80868b", false));
  bindCards();
}

// ---------- our portfolio ----------
function renderPortfolio() {
  const all = aggregate("brands", true);
  const total = all.reduce((a, b) => a + b.count, 0) || 1;
  const rows = ourInMarket().map(n => all.find(b => b.name === n)).filter(Boolean);
  const portN = rows.reduce((a, b) => a + b.count, 0);
  const portSent = sentStats(rows.flatMap(r => r.sub));
  const competitors = all.filter(b => !isOurs(b.name) && b.count > 0).sort((a, b) => b.count - a.count);
  const topComp = competitors[0];

  const kpis = [
    ["Portfolio mentions", portN, `${State.data.meta.company}`],
    ["Category share of voice", `${(100 * portN / total).toFixed(1)}%`, "of all brand mentions"],
    ["Portfolio sentiment", portN ? portSent.avg.toFixed(2) : "—", portN ? `${portSent.pos}% positive` : "no data"],
    ["Top competitor", topComp ? topComp.name : "—", topComp ? `${Math.round(100 * topComp.count / total)}% SoV` : ""],
  ].map(([l, v, s]) => `<div class="card kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${esc("" + s)}</div></div>`).join("");

  const cards = rows.map((b, i) => `
    <div class="card tcard our" data-kind="brands" data-name="${esc(b.name)}">
      <div class="top"><div><div class="name">${esc(b.name)}</div><div class="sub">${b.count ? `${b.count} mentions · ${Math.round(100 * b.count / total)}% SoV` : "No conversation detected"}</div></div>${badge(b.stage)}</div>
      <div class="spark"><canvas id="pf_${i}"></canvas></div>
      ${b.count ? sentBar(b.sent) + `<div class="muted" style="margin-top:6px">${b.sent.pos}% positive · ${b.launches} launches</div>` : `<div class="muted" style="margin-top:8px">Category whitespace — no US/UK chatter this period.</div>`}</div>`).join("");

  $("#content").innerHTML = `
    <div class="summary"><div class="eyebrow">${esc(State.data.meta.company)} · coffee portfolio</div>
      <h2>${portN ? `Our brands hold ${(100 * portN / total).toFixed(1)}% category share of voice across US &amp; UK.` : "Our coffee brands have near-zero presence in current US &amp; UK conversation — a clear whitespace."}</h2>
      <ul><li>Tracking ${rows.length} portfolio brands: ${rows.map(r => esc(r.name)).join(", ")}.</li>
      ${topComp ? `<li>Lead competitor <b>${esc(topComp.name)}</b> at ${Math.round(100 * topComp.count / total)}% SoV — our gap to close.</li>` : ""}</ul></div>
    <div class="grid cols-4" style="margin-top:16px">${kpis}</div>
    <div class="section-title">Portfolio brands</div>
    <div class="grid cols-3">${cards}</div>`;
  rows.forEach((b, i) => lineChart($(`#pf_${i}`), b.weekly, "#6b3fa0"));
  bindCards();
}

// ---------- launch radar ----------
function renderLaunches() {
  const recs = records().filter(r => r.is_launch).sort((a, b) => (parseDate(b.published) || 0) - (parseDate(a.published) || 0));
  const body = recs.length ? recs.map(r => {
    const d = parseDate(r.published), sc = r.sent === "positive" ? "s-pos" : r.sent === "negative" ? "s-neg" : "s-neu";
    return `<div class="launch"><div class="when">${d ? d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" }) : "—"}</div>
      <div style="flex:1"><div class="row" style="margin-bottom:5px">${r.brands.map(b => `<span class="chip brand">${esc(b)}${isOurs(b) ? " ★" : ""}</span>`).join("")}${r.types.map(t => `<span class="chip">${esc(t)}</span>`).join("")}</div>
      <div class="title"><a href="${esc(r.url)}" target="_blank">${esc(r.title)}</a></div>
      <div class="muted" style="margin-top:4px">${esc(r.channel)} · ${fmt(r.views)} views · reaction <span class="${sc}">${r.sent}</span></div></div></div>`;
  }).join("") : `<div class="note">No clear product-launch signals in the current window. Try Sync, or widen the window in config.json.</div>`;
  $("#content").innerHTML = `<div class="section-title">Launch Radar — new products &amp; audience reaction (${recs.length})</div>${body}`;
}

// ---------- forecast & impact ----------
function forecastChart(ctx, f) {
  const H = f.history.length, P = f.forecast.length;
  const labels = [];
  for (let i = H - 1; i >= 0; i--) labels.push(`-${i}w`);
  for (let i = 1; i <= P; i++) labels.push(`+${i}w`);
  const hist = [...f.history, ...Array(P).fill(null)];
  const join = i => i === H - 1 ? f.history[H - 1] : null;
  const fc = f.history.map((_, i) => join(i)).concat(f.forecast);
  const up = f.history.map((_, i) => join(i)).concat(f.upper);
  const lo = f.history.map((_, i) => join(i)).concat(f.lower);
  State.charts.push(new Chart(ctx, {
    type: "line",
    data: {
      labels, datasets: [
        { label: "Upper", data: up, borderColor: "transparent", backgroundColor: "rgba(26,115,232,.10)", fill: "+1", pointRadius: 0 },
        { label: "Lower", data: lo, borderColor: "transparent", fill: false, pointRadius: 0 },
        { label: "History", data: hist, borderColor: "#5f6368", backgroundColor: "transparent", borderWidth: 2, pointRadius: 0, tension: .3 },
        { label: "Forecast", data: fc, borderColor: "#1a73e8", borderDash: [5, 4], borderWidth: 2, pointRadius: 0, tension: .3 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { ticks: { maxTicksLimit: 8, font: { size: 9 } }, grid: { display: false } }, y: { beginAtZero: true, ticks: { font: { size: 9 } } } }
    }
  }));
}
function renderForecast() {
  const fs = State.data.forecasts || {};
  const withFc = Object.entries(fs).filter(([, f]) => f.forecast).sort((a, b) => b[1].impact_score - a[1].impact_score);
  const noFc = Object.entries(fs).filter(([, f]) => !f.forecast);
  const fw = State.data.meta.forecast_weeks;
  const cards = withFc.map(([t, f], i) => `
    <div class="card">
      <div class="top" style="display:flex;justify-content:space-between;align-items:start">
        <div><div class="name" style="font-weight:600">${esc(t)}</div>
          <div class="sub">proj. ${f.growth_pct >= 0 ? "+" : ""}${f.growth_pct}% next ${fw} wks · avg sent ${f.avg_sentiment}</div></div>
        <div style="text-align:right"><div style="font-size:24px;font-weight:700;color:#1a73e8">${f.impact_score}</div>
          <span class="badge ${IMPACT_CLASS[f.impact_label] || "b-steady"}">${f.impact_label}</span></div>
      </div>
      <div style="height:150px;margin-top:8px"><canvas id="fc_${i}"></canvas></div>
    </div>`).join("");
  $("#content").innerHTML = `
    <div class="summary"><div class="eyebrow">Forecast &amp; Impact · category-level (all tracked markets)</div>
      <h2>SARIMA projection of each coffee format's conversation volume over the next ${fw} weeks, ranked by Impact Factor.</h2>
      <ul><li><b>Impact Factor (0–100)</b> blends projected momentum, current reach and sentiment.</li>
      <li>Solid line = observed (26 wks); dashed = forecast; shaded = 80% confidence band.</li></ul></div>
    <div class="section-title">Formats by impact factor</div>
    <div class="grid cols-3">${cards}</div>
    ${noFc.length ? `<div class="section-title">Not enough history to forecast yet</div>
      <div class="note">${noFc.map(([t]) => esc(t)).join(", ")} — these will forecast once more data accumulates across syncs.</div>` : ""}`;
  withFc.forEach(([, f], i) => forecastChart($(`#fc_${i}`), f));
}

// ---------- perception radar ----------
function perceptionThemes() {
  const recs = records();
  return (State.data.config.perception_themes || []).map(name => {
    const sub = recs.filter(r => (r.perception || []).includes(name));
    return { name, sub, count: sub.length, sent: sentStats(sub),
             engagement: sub.reduce((a, r) => a + (r.engagement || 0), 0), ...PERCEPTION_META[name] };
  });
}
function repQuotes(sub, n = 2) {
  return [...sub].filter(r => r.title)
    .sort((a, b) => (b.engagement || 0) - (a.engagement || 0) || (parseDate(b.published) || 0) - (parseDate(a.published) || 0))
    .slice(0, n);
}
function themeInterest(name) {
  const si = (State.data.perception_interest || {})[name];
  if (!si) return "";
  const up = si.growth >= 0;
  return ` · <span title="Google Trends search interest, last 3 months">🔍 ${si.interest}<span style="color:${up ? "#188038" : "#c0392b"}">${up ? "▲" : "▼"}${Math.abs(Math.round(si.growth * 100))}%</span></span>`;
}
function netSentChip(ss, count) {
  if (!count) return `<span class="ps-chip neu">No data</span>`;
  const net = ss.pos - ss.neg;
  const cls = ss.avg >= 0.2 ? "pos" : ss.avg <= -0.05 ? "neg" : "neu";
  const word = ss.avg >= 0.2 ? "Positive" : ss.avg <= -0.05 ? "Negative" : "Mixed";
  return `<span class="ps-chip ${cls}">${word} · ${net >= 0 ? "+" : ""}${net}</span>`;
}
function renderPerception() {
  const recs = records();
  const themes = perceptionThemes();
  const themed = themes.filter(t => t.count > 0).sort((a, b) => b.count - a.count);
  const totalTags = themes.reduce((a, t) => a + t.count, 0) || 1;
  const themedRecs = recs.filter(r => (r.perception || []).length).length;
  const hasReddit = !!(State.data.meta.sources || {}).reddit;

  const ov = sentStats(recs);
  const index = Math.round((ov.avg + 1) / 2 * 100);
  const verdict = index >= 70 ? ["Strongly positive", "b-rising"] : index >= 60 ? ["Positive", "b-peaking"]
    : index >= 53 ? ["Mildly positive", "b-steady"] : index >= 47 ? ["Mixed / neutral", "b-steady"] : ["Negative-leaning", "b-fading"];

  const ranked = themed.filter(t => t.count >= 3);
  const loved = ranked.length ? [...ranked].sort((a, b) => b.sent.avg - a.sent.avg)[0] : null;
  const concern = ranked.length ? [...ranked].sort((a, b) => a.sent.avg - b.sent.avg)[0] : null;
  const pi = State.data.perception_interest || {};
  const rising = Object.entries(pi).filter(([, v]) => v).sort((a, b) => b[1].growth - a[1].growth)[0];

  const radarLabels = themes.map(t => t.name);
  const radarVals = themes.map(t => +(100 * t.count / totalTags).toFixed(1));
  const radarColors = themes.map(t => t.count ? (t.sent.avg >= 0.2 ? SENT.positive : t.sent.avg <= -0.05 ? SENT.negative : SENT.neutral) : "#dadce0");
  const radarMax = Math.max(20, Math.ceil(Math.max(...radarVals, 1) / 5) * 5);

  const cards = themed.map(t => {
    const share = Math.round(100 * t.count / totalTags);
    const quotes = repQuotes(t.sub, 2);
    return `<div class="card pcard">
      <div class="ptop"><span class="material-symbols-outlined pico">${t.icon || "category"}</span>
        <div style="flex:1"><div class="pname">${esc(t.name)}</div><div class="muted">${esc(t.blurb || "")}</div></div></div>
      <div class="pstat"><div><b>${t.count}</b> mentions · ${share}% share</div>${netSentChip(t.sent, t.count)}</div>
      ${sentBar(t.sent)}
      <div class="muted" style="margin:6px 0 2px">${t.sent.pos}% positive · ${t.sent.neg}% negative · avg ${t.sent.avg.toFixed(2)}${themeInterest(t.name)}</div>
      ${quotes.length ? `<div class="pquotes">${quotes.map(q => `
        <a class="pq" href="${esc(q.url)}" target="_blank" title="${esc(q.channel)} · ${q.sent}">
          <span class="pq-dot" style="background:${SENT[q.sent] || SENT.neutral}"></span><span class="pq-t">${esc(q.title)}</span></a>`).join("")}</div>` : ""}
    </div>`;
  }).join("");

  const empties = themes.filter(t => t.count === 0);
  $("#content").innerHTML = `
    <div class="summary"><div class="eyebrow">Coffee perception · ${regionLabel(State.region)} · brand-agnostic</div>
      <h2>How people frame coffee itself — beyond any brand or format.</h2>
      <ul><li>Distilled from <b>${fmt(themedRecs)}</b> conversations that express a clear point of view, across YouTube, news &amp; the coffee press${hasReddit ? " and Reddit" : ""}.</li>
      ${loved ? `<li><b>${esc(loved.name)}</b> is the most positively-viewed dimension (avg sentiment ${loved.sent.avg.toFixed(2)}).</li>` : ""}
      ${concern && concern !== loved ? `<li><b>${esc(concern.name)}</b> attracts the most critical sentiment (avg ${concern.sent.avg.toFixed(2)}) — the perception risk to watch.</li>` : ""}
      ${rising && rising[1].growth > 0.03 ? `<li>🔍 <b>Search demand</b> for <b>${esc(rising[0])}</b> is rising fastest (+${Math.round(rising[1].growth * 100)}% vs prior weeks on Google Trends) — a leading signal even where posts are still few.</li>` : ""}</ul></div>

    <div class="grid cols-3" style="margin-top:16px">
      <div class="card kpi pidx"><div class="l">Coffee Perception Index</div>
        <div class="v">${index}<span class="idx-100">/100</span></div>
        <div class="s"><span class="badge ${verdict[1]}">${verdict[0]}</span> · ${ov.pos}% of all chatter positive</div></div>
      <div class="card kpi"><div class="l">Most-loved lens</div><div class="v" style="font-size:20px">${loved ? esc(loved.name) : "—"}</div>
        <div class="s">${loved ? `avg sentiment ${loved.sent.avg.toFixed(2)}` : "need more data"}</div></div>
      <div class="card kpi"><div class="l">Biggest concern</div><div class="v" style="font-size:20px">${concern && concern !== loved ? esc(concern.name) : "—"}</div>
        <div class="s">${concern && concern !== loved ? `avg sentiment ${concern.sent.avg.toFixed(2)}` : "none flagged yet"}</div></div>
    </div>

    <div class="grid cols-2" style="margin-top:18px">
      <div class="card"><h3>Perception profile — what the coffee talk is about</h3>
        <div class="muted" style="margin:-2px 0 6px">Each spoke = a theme's share of opinionated conversation; dot colour = that theme's sentiment.</div>
        <div style="height:340px"><canvas id="percRadar"></canvas></div></div>
      <div class="card"><h3>Sentiment within each theme</h3>
        <div class="muted" style="margin:-2px 0 12px">Green = positive share, grey = neutral, red = negative — within that theme's mentions.</div>
        ${themed.map(t => `<div class="pbar-row"><div class="pbar-name">${esc(t.name)} <span class="muted">(${t.count})</span></div>${sentBar(t.sent)}</div>`).join("")}</div>
    </div>

    <div class="section-title">Perception lenses — detail &amp; real mentions</div>
    <div class="grid cols-3">${cards}</div>
    ${empties.length ? `<div class="note" style="margin-top:14px"><b>Quiet axes in this corpus:</b> ${empties.map(t => esc(t.name)).join(", ")}.
      Recipe videos &amp; news headlines under-index on health &amp; sustainability debate — that conversation lives more on social and in search.
      The 🔍 chips above add <b>Google Trends search demand</b> per lens (so these axes still register intent even with few posts).
      ${hasReddit ? "" : "Add a free Reddit key (see README) to pull r/Coffee discussion in too."}</div>` : ""}`;
  radarChart($("#percRadar"), radarLabels, radarVals, radarColors, radarMax);
}

// ---------- detail drawer ----------
function openDetail(kind, name) {
  const item = aggregate(kind, true).find(r => r.name === name); if (!item) return;
  const co = {}; if (kind === "brands") item.sub.forEach(r => r.types.forEach(t => co[t] = (co[t] || 0) + 1));
  const topCo = Object.entries(co).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const launches = item.sub.filter(r => r.is_launch).slice(0, 5);
  $("#drawer").innerHTML = `<button class="close-x" onclick="closeDrawer()">×</button>
    <div class="muted" style="text-transform:uppercase;letter-spacing:.5px">${kind === "types" ? "Coffee format" : "Brand"}${isOurs(name) ? " · Portfolio" : ""}</div>
    <h2>${esc(name)} ${badge(item.stage)}</h2>
    <div class="row" style="gap:22px;margin:12px 0 14px">
      ${[["v", item.count, "mentions"], ["v", fmt(item.engagement), "reach"], ["v", item.count ? item.sent.pos + "%" : "—", "positive"], ["v", item.launches, "launches"]].map(([, v, l]) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("")}</div>
    ${item.count ? sentBar(item.sent) : `<div class="note">No conversation detected for this ${kind === "types" ? "format" : "brand"} in the current view.</div>`}
    <div class="card" style="margin:16px 0"><h3>Conversation trend (12 weeks)</h3><div style="height:160px"><canvas id="dwTrend"></canvas></div></div>
    ${topCo.length ? `<h3 style="margin:6px 0">Associated formats</h3><div class="row" style="margin-bottom:12px">${topCo.map(([t, c]) => `<span class="chip">${esc(t)} · ${c}</span>`).join("")}</div>` : ""}
    ${launches.length ? `<h3 style="margin:10px 0 6px">Launch signals</h3>${launches.map(r => `<div class="vid"><div><a href="${esc(r.url)}" target="_blank">${esc(r.title)}</a><div class="meta">${esc(r.channel)} · ${r.sent}</div></div></div>`).join("")}` : ""}
    <h3 style="margin:14px 0 6px">Top videos</h3>
    ${item.topVideos.length ? item.topVideos.map(v => `<div class="vid"><div><a href="${esc(v.url)}" target="_blank">${esc(v.title)}</a><div class="meta">${esc(v.channel)} · ${fmt(v.views)} views · ${v.sent}</div></div></div>`).join("") : "<p class='muted'>No videos.</p>"}`;
  $("#drawer").classList.add("open"); $("#drawerBg").classList.add("open");
  lineChart($("#dwTrend"), item.weekly, isOurs(name) ? "#6b3fa0" : "#1a73e8");
}
window.closeDrawer = () => { $("#drawer").classList.remove("open"); $("#drawerBg").classList.remove("open"); };
function bindCards() { $$("[data-name][data-kind]").forEach(el => el.onclick = () => openDetail(el.dataset.kind, el.dataset.name)); }

// ---------- views / render ----------
const VIEWS = {
  overview: ["Overview", "Category signals across US & UK", renderOverview],
  types: ["Coffee Types", "Conversation, sentiment & momentum by format", renderTypes],
  perception: ["Perception Radar", "How coffee itself is perceived — health, energy, taste, ethics & more", renderPerception],
  brands: ["Brands", "Share of voice, sentiment & launches by brand", renderBrands],
  forecast: ["Forecast & Impact", "SARIMA projections and impact factor by format", renderForecast],
  portfolio: ["Our Portfolio", "Tata Consumer Products coffee brands vs the category", renderPortfolio],
  launches: ["Launch Radar", "New products and how the audience reacts", renderLaunches],
};
const fmtD = d => d ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";
function renderDataWindow() {
  const el = $("#dataWindow");
  if (!State.data || State.data.empty) { el.innerHTML = ""; return; }
  const dates = records().map(r => parseDate(r.published)).filter(Boolean).sort((a, b) => a - b);
  const synced = State.data.meta.generated ? new Date(State.data.meta.generated) : null;
  if (!dates.length) { el.innerHTML = `<span class="material-symbols-outlined">calendar_month</span> No dated items`; return; }
  el.innerHTML = `<span class="material-symbols-outlined">calendar_month</span>
    Conversation: <b>${fmtD(dates[0])}</b> &rarr; <b>${fmtD(dates[dates.length - 1])}</b>
    &nbsp;·&nbsp; synced ${fmtD(synced)}`;
}
function render() {
  clearCharts();
  if (!State.data || State.data.empty) { renderDataWindow(); return showEmpty(); }
  const [title, sub, fn] = VIEWS[State.view];
  $("#viewTitle").textContent = title; $("#viewSub").textContent = sub;
  renderDataWindow(); fn();
}
function showEmpty() {
  $("#content").innerHTML = `<div class="empty"><div class="empty-card"><span class="material-symbols-outlined ic">cloud_sync</span>
    <h2>No data yet</h2><p>Sync the latest coffee conversation from YouTube (US &amp; UK) and the coffee press. Takes about a minute.</p>
    <button class="btn-primary" onclick="startSync()">Run first sync</button></div></div>`;
}

// ---------- sync ----------
window.startSync = async function () {
  $("#syncToast").classList.add("show"); $("#syncLog").innerHTML = "Starting…";
  await fetch("/api/sync", { method: "POST" });
  const poll = setInterval(async () => {
    const st = await (await fetch("/api/sync/status")).json();
    $("#syncLog").innerHTML = (st.progress || []).slice(-12).map(esc).join("<br>");
    if (!st.running && st.done) { clearInterval(poll); setTimeout(() => $("#syncToast").classList.remove("show"), 2200); await loadData(); render(); }
  }, 1200);
};
const SRC_LABEL = { youtube: "YouTube", news: "Google News", reddit: "Reddit", press: "Coffee press" };
async function loadData() {
  State.data = await (await fetch("/api/data")).json();
  const m = State.data?.meta;
  if (m) {
    $("#lastSync").textContent = new Date(m.generated).toLocaleString();
    $("#markets").textContent = Object.values(m.regions || {}).join(" · ");
    const srcs = m.sources || {};
    $("#sources").innerHTML = Object.keys(srcs).length
      ? Object.entries(srcs).map(([k, v]) => `${SRC_LABEL[k] || k} ${v}`).join("<br>") : "—";
  }
}

// ---------- init ----------
function init() {
  $$(".rail-item").forEach(b => b.onclick = () => { $$(".rail-item").forEach(x => x.classList.remove("active")); b.classList.add("active"); State.view = b.dataset.view; render(); });
  $$("#regionToggle button").forEach(b => b.onclick = () => { $$("#regionToggle button").forEach(x => x.classList.remove("active")); b.classList.add("active"); State.region = b.dataset.region; render(); });
  $("#syncBtn").onclick = startSync;
  $("#drawerBg").onclick = closeDrawer;
  loadData().then(render);
}
init();
