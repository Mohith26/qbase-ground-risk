// Ground Risk (SORA 2.5) panel for QBase 3D: UI. All numbers come from
// src/sora.js applied to data/population.json (Zensus 2022) in the browser.
import * as S from './src/sora.js';

const CORRIDOR = [
  [48.0950, 11.3000], [48.0830, 11.2500], [48.0730, 11.2050], [48.0720, 11.1500],
  [48.0650, 11.0850], [48.0650, 11.0300], [48.0700, 10.9800], [48.0500, 10.9000],
]; // same as scripts/corridor.mjs (checked by a unit test)
const AIRCRAFT = { wingspan: 2.394, cruise: 17, enduranceMin: 59, c2RangeKm: 7.5, maxSpeed: 35 };
const LS = 'qbase-ground-risk-v1';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const km = (m, d = 1) => (m / 1000).toFixed(d);
const int = (x) => Math.round(x).toLocaleString('en-US');
const BAND_COL = ['#5bd23a', '#b9e04a', '#f0b429', '#f57c32', '#e53935', '#8e24aa'];
const SAIL_COL = { 2: '#5bd23a', 3: '#b9e04a', 4: '#f0b429', 5: '#f57c32', 6: '#e53935', 0: '#8e24aa' };

let POP, IDX, SAMPLES, map, layers = {}, CUR = null;
let S0 = load();
function load() { try { return { applied: null, ...(JSON.parse(localStorage.getItem(LS)) || {}) }; } catch { return { applied: null }; } }
function save() { try { localStorage.setItem(LS, JSON.stringify(S0)); } catch { /* private mode */ } }

function params() {
  const p = new URLSearchParams(location.hash.slice(1));
  const h = [60, 90, 120].includes(+p.get('h')) ? +p.get('h') : 120;
  return { h, m1a: p.get('m1a') === '1', mode: p.get('mode') === 'greedy' ? 'greedy' : 'opt', f: Math.max(0, +p.get('f') || 0) };
}
function setParams(patch) {
  const q = { ...params(), ...patch };
  const p = new URLSearchParams();
  if (q.h !== 120) p.set('h', q.h);
  if (q.m1a) p.set('m1a', '1');
  if (q.mode !== 'opt') p.set('mode', q.mode);
  if (q.f) p.set('f', q.f);
  history.replaceState(null, '', p.toString() ? '#' + p : location.pathname + location.search);
  render();
}

async function boot() {
  $('#state').textContent = 'Loading Zensus 2022 population grid…';
  try {
    const r = await fetch('data/population.json');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    POP = await r.json();
    IDX = S.indexCells(POP);
    SAMPLES = S.resample(S.project(CORRIDOR), 100);
    initMap();
    $('#state').textContent = '';
    render(true);
  } catch (e) {
    $('#state').innerHTML = `<div style="text-align:center"><b style="color:#fff">Could not load the population grid.</b><br>${esc(e.message)}<br><br><button class="qb" onclick="location.reload()">Retry</button></div>`;
  }
  setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString('de-DE', { hour12: false }); }, 1000);
}

function initMap() {
  map = L.map('map', { zoomControl: false, preferCanvas: true, attributionControl: false });
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18 }).addTo(map);
  L.control.scale({ imperial: false, position: 'topleft' }).addTo(map);
  // population layer: 200 m cells, coloured by SORA density band
  const g = L.layerGroup();
  for (const [i, j, p] of POP.cells) {
    const d = p / ((POP.cell * POP.cell) / 1e6);
    const b = S.DENSITY_BANDS.findIndex((t) => d < t);
    const col = BAND_COL[b < 0 ? 5 : b];
    const sw = S.laeaInverse(i * POP.cell, j * POP.cell), ne = S.laeaInverse((i + 1) * POP.cell, (j + 1) * POP.cell);
    L.rectangle([sw, ne], { stroke: false, fillColor: col, fillOpacity: 0.45, interactive: false }).addTo(g);
  }
  layers.pop = g.addTo(map);
  layers.plan = L.layerGroup().addTo(map);
  fitAll();
  $('#legend').innerHTML = '<b style="color:#e8edf5">Population density (ppl/km²)</b>' +
    ['< 5', '< 50', '< 500', '< 5,000', '< 50,000', '> 50,000'].map((t, k) => `<div class="row"><i style="background:${BAND_COL[k]};opacity:.75"></i>${t}${k >= 1 ? ` · iGRC ${S.IGRC_3M[k]}` : ' · iGRC 3'}</div>`).join('') +
    '<div class="row" style="margin-top:6px"><i style="background:#5bd23a;height:3px"></i>Corridor flight line</div>';
}

function fitAll() {
  map.invalidateSize();
  map.fitBounds(L.latLngBounds(CORRIDOR), { paddingTopLeft: [60, 40], paddingBottomRight: [330, 200] });
}

function compute(q) {
  const P = { ...S.DEFAULTS, heightAgl: q.h, m1a: q.m1a };
  const key = JSON.stringify(P);
  if (CUR && CUR.key === key) return CUR;
  const prof = S.profile(IDX, SAMPLES, P);
  const Lmax = S.maxSegment(AIRCRAFT, P);
  const opt = S.optimalSplit(prof, Lmax.metres, P), greedy = S.greedySplit(prof, Lmax.metres, P);
  CUR = { key, P, prof, Lmax, opt, greedy };
  return CUR;
}

function flightMinutes(f, P) { return (P.passes * f.len) / AIRCRAFT.cruise / 60 + P.overheadMin; }

function render(fit) {
  if (!POP) return;
  const q = params();
  const C = compute(q);
  const plan = q.mode === 'opt' ? C.opt : C.greedy, other = q.mode === 'opt' ? C.greedy : C.opt;
  const sel = Math.min(q.f, plan.length) || 0;
  $('#h').value = String(q.h); $('#mode').value = q.mode; $('#m1a').checked = q.m1a;
  const worst = Math.max(...plan.map((f) => f.sail));
  const kmAt = (pl, s) => pl.filter((f) => f.sail === s).reduce((a, f) => a + f.len, 0);
  // mission elements
  $('#elements').innerHTML = plan.map((f, k) => `<li class="el ${sel === k + 1 ? 'sel' : ''}" data-k="${k + 1}" tabindex="0">
      <span class="t">${k + 1}&nbsp; Corridor A/B ${k + 1}</span><span class="r">${Math.floor(flightMinutes(f, C.P))}m ${String(Math.round((flightMinutes(f, C.P) % 1) * 60)).padStart(2, '0')}s</span>
      <span class="d">km ${km(f.from)}–${km(f.to)} · ${km(f.len)} km</span><span class="r"><span class="sail s${f.sail}">SAIL ${S.ROMAN[f.sail] || 'cert.'}</span></span></li>`).join('');
  const totalMin = plan.reduce((a, f) => a + flightMinutes(f, C.P), 0);
  $('#totals').innerHTML = `<span>Total Flight Time</span><b>${Math.floor(totalMin / 60)}h ${String(Math.round(totalMin % 60)).padStart(2, '0')}m</b>
    <span>Corridor Length</span><b>${km(C.prof.at(-1).s)} km</b><span>Flights (A/B)</span><b>${plan.length}</b>
    <span>Highest SAIL</span><b>${S.ROMAN[worst]} on ${km(kmAt(plan, worst))} km</b>
    <span>${q.mode === 'opt' ? 'Max-length split' : 'Optimal split'}</span><b>${S.ROMAN[worst]} on ${km(kmAt(other, worst))} km</b>`;
  $('#upload').innerHTML = S0.applied && S0.applied.key === C.key + q.mode ? 'Upload' : 'Upload <svg viewBox="0 0 24 24"><path d="M12 3 1 21h22zm-1 7h2v5h-2zm0 6h2v2h-2z" fill="#e53935"/></svg>';
  $('#apply').textContent = S0.applied && S0.applied.key === C.key + q.mode ? 'Split Applied ✓' : 'Apply Split to Mission';
  $('#apply').classList.toggle('on', !!(S0.applied && S0.applied.key === C.key + q.mode));
  drawPlan(C, plan, sel);
  drawChart(C, plan, sel);
  drawDetail(C, plan, sel, other);
  $('#pfsub').textContent = `${q.mode === 'opt' ? 'Ground-risk optimal' : 'Max length'} split · ${plan.length} flights · max ${km(C.Lmax.metres)} km per flight (C2 ${AIRCRAFT.c2RangeKm} km, ${AIRCRAFT.enduranceMin} min, 25% reserve) · ${C.prof.filter((p) => p.site).length} open-ground A/B points`;
  document.querySelectorAll('.el').forEach((el) => {
    el.onclick = () => setParams({ f: +el.dataset.k === sel ? 0 : +el.dataset.k });
    el.onkeydown = (e) => { if (e.key === 'Enter') el.click(); };
  });
  if (fit) fitAll();
}

function offsetRing(prof, i, j, r) {
  const L_ = [], R_ = [];
  for (let k = i; k <= j; k++) {
    const a = prof[Math.max(i, k - 1)], b = prof[Math.min(j, k + 1)];
    let dx = b.x - a.x, dy = b.y - a.y; const n = Math.hypot(dx, dy) || 1; dx /= n; dy /= n;
    L_.push(S.laeaInverse(prof[k].x - dy * r, prof[k].y + dx * r));
    R_.push(S.laeaInverse(prof[k].x + dy * r, prof[k].y - dx * r));
  }
  return [...L_, ...R_.reverse()];
}

function drawPlan(C, plan, sel) {
  const g = layers.plan; g.clearLayers();
  const r = S.halfWidth(C.P);
  plan.forEach((f, k) => {
    const on = sel === k + 1;
    L.polygon(offsetRing(C.prof, f.i, f.j, r), { color: SAIL_COL[f.sail], weight: on ? 2.5 : 1, fillColor: SAIL_COL[f.sail], fillOpacity: on ? 0.32 : 0.16, opacity: 0.9 })
      .on('click', () => setParams({ f: k + 1 })).addTo(g);
    const line = C.prof.slice(f.i, f.j + 1).map((p) => S.laeaInverse(p.x, p.y));
    L.polyline(line, { color: '#5bd23a', weight: on ? 4 : 2.5, opacity: 0.95 }).addTo(g);
  });
  const pts = [plan[0].i, ...plan.map((f) => f.j)];
  pts.forEach((pi, k) => {
    const p = C.prof[pi];
    L.marker(S.laeaInverse(p.x, p.y), { icon: L.divIcon({ className: '', html: `<div class="mk" title="A/B point km ${km(p.s)}">${k === 0 ? 'A' : k}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(g);
  });
  if (sel) {
    const f = plan[sel - 1], w = C.prof[f.worstAt];
    if (w.cell) {
      const [i, j] = w.cell;
      L.rectangle([S.laeaInverse(i * POP.cell, j * POP.cell), S.laeaInverse((i + 1) * POP.cell, (j + 1) * POP.cell)], { color: '#fff', weight: 2, fill: false, dashArray: '4 3' }).addTo(g);
    }
  }
}

function drawChart(C, plan, sel) {
  const W = 1000, H = 150, top = 22, bot = 18, Lc = C.prof.at(-1).s;
  const x = (s) => (s / Lc) * W;
  const y = (g) => top + (1 - (g - 2) / 6) * (H - top - bot); // iGRC 2..8
  let out = '';
  for (let g = 3; g <= 8; g++) out += `<line x1="0" x2="${W}" y1="${y(g)}" y2="${y(g)}" stroke="#22314a" stroke-width="1"/>`;
  // per-sample iGRC bars
  for (let k = 0; k < C.prof.length - 1; k++) {
    const p = C.prof[k], b = S.DENSITY_BANDS.findIndex((t) => p.density < t);
    out += `<rect x="${x(p.s)}" y="${y(p.igrc)}" width="${Math.max(1, x(C.prof[k + 1].s) - x(p.s) + 0.3)}" height="${H - bot - y(p.igrc)}" fill="${BAND_COL[b < 0 ? 5 : b]}" opacity=".75"/>`;
    if (p.site) out += `<rect x="${x(p.s)}" y="${H - bot + 3}" width="2" height="5" fill="#9cf27e"/>`;
  }
  // flights: SAIL ribbons + cut lines
  plan.forEach((f, k) => {
    out += `<rect x="${x(f.from)}" y="2" width="${x(f.to) - x(f.from)}" height="14" fill="${SAIL_COL[f.sail]}" opacity="${sel === k + 1 ? 1 : 0.8}" stroke="${sel === k + 1 ? '#fff' : '#0c1119'}" stroke-width="${sel === k + 1 ? 2 : 1}" data-k="${k + 1}"/>`;
    if (x(f.to) - x(f.from) > 34) out += `<text x="${(x(f.from) + x(f.to)) / 2}" y="12.5" font-size="10" text-anchor="middle" fill="#0b0f15" font-weight="700" pointer-events="none">${S.ROMAN[f.sail]}</text>`;
    out += `<line x1="${x(f.to)}" x2="${x(f.to)}" y1="2" y2="${H - bot}" stroke="#e8edf5" stroke-dasharray="3 3" opacity=".7"/>`;
  });
  for (let g = 3; g <= 8; g++) out += `<rect x="${W - 44}" y="${y(g) - 9}" width="42" height="11" fill="#0c1119" opacity=".75"/><text x="${W - 4}" y="${y(g)}" font-size="9" fill="#a9b6c9" text-anchor="end">iGRC ${g}</text>`;
  for (let s = 0; s <= Lc; s += 5000) out += `<text x="${Math.min(W - 18, x(s) + 2)}" y="${H - 2}" font-size="9.5" fill="#a9b6c9">${s / 1000} km</text>`;
  const svg = $('#chart'); svg.innerHTML = out;
  svg.onclick = (e) => {
    const rect = svg.getBoundingClientRect(), s = ((e.clientX - rect.left) / rect.width) * Lc;
    const k = plan.findIndex((f) => s >= f.from && s <= f.to);
    if (k >= 0) setParams({ f: k + 1 });
  };
}

function drawDetail(C, plan, sel, other) {
  const d = $('#detail');
  if (!sel) { d.hidden = true; return; }
  const f = plan[sel - 1], w = C.prof[f.worstAt], people = w.cell ? w.cell[2] : 0;
  const off = w.cell ? Math.hypot((w.cell[0] + 0.5) * POP.cell - w.x, (w.cell[1] + 0.5) * POP.cell - w.y) : 0;
  const before = sel > 1 ? plan[sel - 2] : null, after = sel < plan.length ? plan[sel] : null;
  let why = `The densest 200 m cell inside this flight's footprint holds <b>${int(people)} people</b> (${int(f.maxDensity)}/km², band ${S.bandLabel(f.maxDensity)}), ${int(off)} m from the line at km ${km(w.s)}. That sets iGRC ${f.igrc} for the whole flight.`;
  if (before && before.sail < f.sail) why += ` The cut at km ${km(f.from)} keeps the ${km(before.len)} km before it at SAIL ${S.ROMAN[before.sail]}.`;
  if (after && after.sail < f.sail) why += ` The cut at km ${km(f.to)} keeps the next ${km(after.len)} km at SAIL ${S.ROMAN[after.sail]}.`;
  d.innerHTML = `<h3>Corridor A/B ${sel}<button class="x" id="dx" aria-label="Close">✕</button></h3>
    <table>
      <tr><td>Chainage</td><td>km ${km(f.from)} – ${km(f.to)} (${km(f.len)} km)</td></tr>
      <tr><td>Est. flight time</td><td>${flightMinutes(f, C.P).toFixed(1)} min (${C.P.passes} passes)</td></tr>
      <tr><td>Footprint half-width</td><td>${S.halfWidth(C.P)} m (FG ${C.P.fgHalf} + CV ${C.P.cv} + GRB ${C.P.heightAgl})</td></tr>
      <tr><td>Max population density</td><td>${int(f.maxDensity)} /km²</td></tr>
      <tr><td>iGRC → final GRC</td><td>${f.igrc} → ${f.grc}${C.P.m1a ? ' (M1A −1)' : ''}</td></tr>
      <tr><td>SAIL (ARC-b)</td><td><span class="sail s${f.sail}">SAIL ${S.ROMAN[f.sail] || 'cert.'}</span></td></tr>
    </table><div class="why">${why}</div>`;
  d.hidden = false;
  $('#dx').onclick = () => setParams({ f: 0 });
}

function exportAs(kind) {
  const q = params(), C = compute(q), plan = q.mode === 'opt' ? C.opt : C.greedy;
  let data, name, type = 'application/json';
  const fl = plan.map((f, k) => ({ flight: k + 1, from_km: +km(f.from, 2), to_km: +km(f.to, 2), length_km: +km(f.len, 2), max_density_per_km2: Math.round(f.maxDensity), igrc: f.igrc, final_grc: f.grc, sail: S.ROMAN[f.sail], est_minutes: +flightMinutes(f, C.P).toFixed(1) }));
  if (kind === 'json') { data = JSON.stringify({ corridor: 'A96 Gilching-Landsberg (illustrative)', params: C.P, aircraft: AIRCRAFT, method: 'SORA 2.5 iGRC (3 m / 35 m/s), ARC-b SAIL, exact lexicographic DP split', flights: fl }, null, 1); name = 'ground-risk-plan.json'; }
  else if (kind === 'csv') { data = ['chainage_km,max_density_per_km2,igrc,open_ground_site', ...C.prof.map((p) => `${km(p.s, 2)},${Math.round(p.density)},${p.igrc},${p.site ? 1 : 0}`)].join('\n'); name = 'ground-risk-profile.csv'; type = 'text/csv'; }
  else { data = JSON.stringify({ type: 'FeatureCollection', features: plan.map((f, k) => ({ type: 'Feature', properties: fl[k], geometry: { type: 'LineString', coordinates: C.prof.slice(f.i, f.j + 1).map((p) => { const [la, lo] = S.laeaInverse(p.x, p.y); return [+lo.toFixed(6), +la.toFixed(6)]; }) } })) }); name = 'ground-risk-flights.geojson'; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Exported ${name}`);
}

let tt;
function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => (t.hidden = true), 3000); }

$('#h').onchange = (e) => setParams({ h: +e.target.value, f: 0 });
$('#mode').onchange = (e) => setParams({ mode: e.target.value, f: 0 });
$('#m1a').onchange = (e) => setParams({ m1a: e.target.checked });
$('#apply').onclick = () => { const q = params(); S0.applied = { key: compute(q).key + q.mode, at: Date.now() }; save(); render(); toast('Split applied to mission elements. Ready to upload.'); };
$('#clear').onclick = () => { S0 = { applied: null }; save(); setParams({ f: 0 }); toast('Mission cleared'); };
$('#reset').onclick = () => { S0 = { applied: null }; save(); history.replaceState(null, '', location.pathname); render(); toast('Reset to defaults'); };
$('#exportBtn').onclick = (e) => { e.stopPropagation(); $('#menu').hidden = !$('#menu').hidden; };
document.querySelectorAll('#menu [data-x]').forEach((b) => (b.onclick = () => { $('#menu').hidden = true; exportAs(b.dataset.x); }));
document.addEventListener('click', () => ($('#menu').hidden = true));
$('#fit').onclick = () => fitAll();
$('#zin').onclick = () => map.zoomIn();
$('#zout').onclick = () => map.zoomOut();
$('#pop').onclick = (e) => { const b = e.currentTarget, on = b.getAttribute('aria-pressed') === 'true'; b.setAttribute('aria-pressed', String(!on)); if (on) map.removeLayer(layers.pop); else layers.pop.addTo(map); };
document.querySelectorAll('[data-soon]').forEach((b) => (b.onclick = () => toast('Outside this concept demo')));
$('#upload').onclick = () => toast(S0.applied ? 'No aircraft connected (concept demo)' : 'Apply a split before uploading');
document.addEventListener('keydown', (e) => {
  if (/INPUT|SELECT/.test(document.activeElement.tagName) || e.metaKey || e.ctrlKey || !POP) return;
  const q = params(), n = (q.mode === 'opt' ? compute(q).opt : compute(q).greedy).length;
  if (e.key === ']') setParams({ f: Math.min(n, q.f + 1) });
  else if (e.key === '[') setParams({ f: Math.max(0, q.f - 1) });
  else if (/^[1-9]$/.test(e.key) && +e.key <= n) setParams({ f: +e.key });
  else if (e.key === 'm') setParams({ m1a: !q.m1a });
  else if (e.key === 'o') setParams({ mode: 'opt', f: 0 });
  else if (e.key === 'g') setParams({ mode: 'greedy', f: 0 });
  else if (e.key === 'e') exportAs('json');
  else if (e.key === 'Escape') setParams({ f: 0 });
});
addEventListener('resize', () => map && map.invalidateSize());
boot();
setTimeout(() => { document.body.dataset.errs = String((window.__errs || []).length); }, 3000); // read by the headless check
