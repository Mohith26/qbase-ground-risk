// Ground risk planner for corridor-mapping missions (SORA 2.5 Step #2/#3).
// Core logic, no DOM. Runs in the browser and in Node.
//
// Problem. A BVLOS corridor-mapping job (power line, rail, road) has to be
// flown as several A/B flights: each flight is limited by endurance and by the
// command-and-control (C2) range from the ground station, and must take off
// and land in open ground. Under SORA 2.5 the intrinsic ground risk class
// (iGRC) of a flight is set by the MAXIMUM population density in its
// operational volume plus ground risk buffer. So where you cut the corridor
// decides how many kilometres are flown at a higher SAIL: a cut placed badly
// drags a long rural stretch into the SAIL of the one town it touches.
//
// Method.
//   1. Real population: Zensus 2022 100 m grid (Destatis), aggregated to the
//      200 m grid SORA 2.5 suggests for <= 500 ft AGL; density = people/km2.
//   2. Footprint: for every 100 m of corridor chainage, the max density of any
//      200 m cell within (flight-geography half-width + contingency volume +
//      ground risk buffer) of the centreline. Ground risk buffer by the SORA
//      1:1 rule (= flight height AGL).
//   3. iGRC from the SORA 2.5 table (column: max dimension 3 m, max speed
//      35 m/s, which covers a 2.4 m wingspan VTOL), optional M1(A) sheltering
//      (-1), SAIL from the SORA 2.5 matrix for ARC-b.
//   4. Exact optimal split by dynamic programming over candidate A/B points
//      (open ground: no inhabited 200 m cell within 300 m), each flight
//      between a minimum length and the endurance/C2 limit: minimise
//      lexicographically the km flown at SAIL VI, then V, IV, III, II, then
//      the number of flights. O(n^2) with incremental segment maxima; exact
//      because a flight's cost depends only on its own endpoints.

// ---------------------------------------------------------------- EPSG:3035
// ETRS89 / LAEA Europe on GRS80 (Snyder, Map Projections - A Working Manual, pp. 187-190).
const A_ = 6378137, E2 = 0.0066943800229, E = Math.sqrt(E2);
const LAT0 = 52 * Math.PI / 180, LON0 = 10 * Math.PI / 180, FE = 4321000, FN = 3210000;
const qf = (phi) => { const s = Math.sin(phi); return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s))); };
const QP = qf(Math.PI / 2), RQ = A_ * Math.sqrt(QP / 2);
const B1 = Math.asin(qf(LAT0) / QP);
const M1 = Math.cos(LAT0) / Math.sqrt(1 - E2 * Math.sin(LAT0) ** 2);
const DD = (A_ * M1) / (RQ * Math.cos(B1));
export function laeaForward(lat, lon) {
  const phi = lat * Math.PI / 180, lam = lon * Math.PI / 180 - LON0;
  const beta = Math.asin(qf(phi) / QP);
  const B = RQ * Math.sqrt(2 / (1 + Math.sin(B1) * Math.sin(beta) + Math.cos(B1) * Math.cos(beta) * Math.cos(lam)));
  return [FE + B * DD * Math.cos(beta) * Math.sin(lam), FN + (B / DD) * (Math.cos(B1) * Math.sin(beta) - Math.sin(B1) * Math.cos(beta) * Math.cos(lam))];
}
export function laeaInverse(x, y) {
  const X = x - FE, Y = y - FN;
  const rho = Math.hypot(X / DD, DD * Y);
  if (rho < 1e-9) return [LAT0 * 180 / Math.PI, LON0 * 180 / Math.PI];
  const C = 2 * Math.asin(rho / (2 * RQ));
  const bp = Math.asin(Math.cos(C) * Math.sin(B1) + (DD * Y * Math.sin(C) * Math.cos(B1)) / rho);
  const lam = LON0 + Math.atan2(X * Math.sin(C), DD * rho * Math.cos(B1) * Math.cos(C) - DD * DD * Y * Math.sin(B1) * Math.sin(C));
  const e4 = E2 * E2, e6 = e4 * E2;
  const phi = bp + (E2 / 3 + 31 * e4 / 180 + 517 * e6 / 5040) * Math.sin(2 * bp) + (23 * e4 / 360 + 251 * e6 / 3780) * Math.sin(4 * bp) + (761 * e6 / 45360) * Math.sin(6 * bp);
  return [phi * 180 / Math.PI, lam * 180 / Math.PI];
}

// ---------------------------------------------------------------- SORA 2.5 tables
// iGRC, JARUS SORA 2.5 main body Table 2 (Annex F Table 2), column for max
// characteristic dimension 3 m and max speed 35 m/s.
export const DENSITY_BANDS = [5, 50, 500, 5000, 50000];
export const IGRC_3M = [3, 4, 5, 6, 7, 8]; // <5, <50, <500, <5000, <50000, >50000
export function igrc(density) {
  for (let i = 0; i < DENSITY_BANDS.length; i++) if (density < DENSITY_BANDS[i]) return IGRC_3M[i];
  return IGRC_3M[5];
}
export function bandLabel(density) {
  const b = DENSITY_BANDS.findIndex((t) => density < t);
  return b < 0 ? '> 50,000' : `< ${DENSITY_BANDS[b].toLocaleString('en-US')}`;
}
// final GRC after M1(A) sheltering (-1 at low robustness); the column's floor is 1
export function finalGrc(g, m1a) { return Math.max(1, g - (m1a ? 1 : 0)); }
// SAIL for ARC-b, SORA 2.5 Table 7: GRC <=2 II, 3 II, 4 III, 5 IV, 6 V, 7 VI, >7 out of scope (0)
export function sailArcB(grc) {
  if (grc <= 3) return 2;
  if (grc <= 7) return grc - 1;
  return 0;
}
export const ROMAN = ['-', 'I', 'II', 'III', 'IV', 'V', 'VI'];

// ---------------------------------------------------------------- geometry
export function project(waypoints) { return waypoints.map(([la, lo]) => laeaForward(la, lo)); }
// resample a polyline (EPSG:3035 metres) every `step` metres; returns [{x,y,s}]
export function resample(poly, step = 100) {
  const out = [{ x: poly[0][0], y: poly[0][1], s: 0 }];
  let s = 0, carry = 0;
  for (let i = 1; i < poly.length; i++) {
    const [x0, y0] = poly[i - 1], [x1, y1] = poly[i];
    const L = Math.hypot(x1 - x0, y1 - y0);
    let t = step - carry;
    while (t <= L + 1e-9) { out.push({ x: x0 + (x1 - x0) * t / L, y: y0 + (y1 - y0) * t / L, s: s + t }); t += step; }
    carry = L - (t - step);
    s += L;
  }
  const last = poly[poly.length - 1];
  if (Math.hypot(last[0] - out.at(-1).x, last[1] - out.at(-1).y) > 1) out.push({ x: last[0], y: last[1], s });
  return out;
}

// Spatial index over 200 m cells: Map "i,j" -> people
export function indexCells(pop) {
  const m = new Map();
  for (const [i, j, p] of pop.cells) m.set(i * 100000 + j, p);
  return { map: m, cell: pop.cell };
}
// max density (people/km2) of any cell whose centre lies within r metres of (x,y)
export function maxDensityWithin(idx, x, y, r) {
  const c = idx.cell, area = (c * c) / 1e6;
  const r2 = (r + c * Math.SQRT1_2) ** 2; // any cell that the disc touches
  const i0 = Math.floor((x - r - c) / c), i1 = Math.floor((x + r + c) / c);
  const j0 = Math.floor((y - r - c) / c), j1 = Math.floor((y + r + c) / c);
  let best = 0, at = null;
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const p = idx.map.get(i * 100000 + j);
    if (!p) continue;
    const cx = (i + 0.5) * c, cy = (j + 0.5) * c;
    if ((cx - x) ** 2 + (cy - y) ** 2 > r2) continue;
    const d = p / area;
    if (d > best) { best = d; at = [i, j, p]; }
  }
  return { density: best, cell: at };
}

export const DEFAULTS = { heightAgl: 120, fgHalf: 150, cv: 50, m1a: false, passes: 2, reserve: 0.25, overheadMin: 4, siteRadius: 300, minLen: 2000 };
export function halfWidth(p) { return p.fgHalf + p.cv + p.heightAgl; } // GRB 1:1 rule

export function profile(idx, samples, params = DEFAULTS) {
  const r = halfWidth(params);
  return samples.map((s) => {
    const fp = maxDensityWithin(idx, s.x, s.y, r);
    const site = maxDensityWithin(idx, s.x, s.y, params.siteRadius).density === 0;
    const g = igrc(fp.density);
    return { s: s.s, x: s.x, y: s.y, density: fp.density, cell: fp.cell, igrc: g, site };
  });
}

// Longest corridor segment one flight can cover: endurance (with reserve and
// VTOL overhead, `passes` mapping passes) and C2 range (GCS at the segment midpoint).
export function maxSegment(ac, params = DEFAULTS) {
  const usableS = (ac.enduranceMin * (1 - params.reserve) - params.overheadMin) * 60;
  const byEndurance = (usableS * ac.cruise) / params.passes;
  const byC2 = 2 * ac.c2RangeKm * 1000;
  return { metres: Math.min(byEndurance, byC2), byEndurance, byC2 };
}

// Lexicographic cost of a plan: km flown at SAIL VI, then V, IV, III, II, then
// number of flights. Additive per flight, so the DP below is exactly optimal
// for this order (lexicographic order is compatible with addition).
export const SAIL_ORDER = [6, 5, 4, 3, 2];
export function flightCost(len, sail) {
  return [...SAIL_ORDER.map((s) => (s === sail ? Math.round(len) : 0)), 1];
}
export function addCost(a, b) { return a.map((x, i) => x + b[i]); }
export function cmpCost(a, b) { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }
export function planCost(flights) { return flights.reduce((c, f) => addCost(c, flightCost(f.len, f.sail)), [0, 0, 0, 0, 0, 0]); }

// Exact DP over candidate endpoints. Flights must be between minLen and Lmax
// long and start/end in open ground. Returns flights or null if infeasible.
export function optimalSplit(prof, Lmax, params = DEFAULTS) {
  const n = prof.length, minLen = params.minLen ?? 0;
  const ok = prof.map((p, k) => k === 0 || k === n - 1 || p.site);
  const best = new Array(n).fill(null), prev = new Array(n).fill(-1);
  best[0] = [0, 0, 0, 0, 0, 0];
  for (let j = 1; j < n; j++) {
    if (!ok[j]) continue;
    let mx = prof[j].density;
    for (let i = j - 1; i >= 0; i--) {
      mx = Math.max(mx, prof[i].density);
      const len = prof[j].s - prof[i].s;
      if (len > Lmax + 1e-6) break;
      if (len < minLen - 1e-6 || !ok[i] || !best[i]) continue;
      const c = addCost(best[i], flightCost(len, sailArcB(finalGrc(igrc(mx), params.m1a))));
      if (!best[j] || cmpCost(c, best[j]) < 0) { best[j] = c; prev[j] = i; }
    }
  }
  if (!best[n - 1]) return null;
  const cuts = [];
  for (let k = n - 1; k > 0; k = prev[k]) cuts.push([prev[k], k]);
  return cuts.reverse().map(([i, j]) => flight(prof, i, j, params));
}

// Baseline: what a planner does without ground-risk awareness: fly each A/B
// leg as long as endurance/C2 allow, landing at the furthest open-ground point.
export function greedySplit(prof, Lmax, params = DEFAULTS) {
  const n = prof.length, out = [];
  let i = 0;
  while (i < n - 1) {
    let j = -1;
    for (let k = i + 1; k < n && prof[k].s - prof[i].s <= Lmax + 1e-6; k++) if (prof[k].site || k === n - 1) j = k;
    if (j < 0) return null;
    out.push(flight(prof, i, j, params));
    i = j;
  }
  return out;
}

export function flight(prof, i, j, params = DEFAULTS) {
  let mx = 0, at = i;
  for (let k = i; k <= j; k++) if (prof[k].density > mx) { mx = prof[k].density; at = k; }
  const g = igrc(mx), grc = finalGrc(g, params.m1a);
  return { i, j, from: prof[i].s, to: prof[j].s, len: prof[j].s - prof[i].s, maxDensity: mx, worstAt: at, igrc: g, grc, sail: sailArcB(grc) };
}

export function summarize(flights) {
  const bySail = {};
  let total = 0;
  for (const f of flights) { bySail[f.sail] = (bySail[f.sail] || 0) + f.len; total += f.len; }
  const worst = Math.max(...flights.map((f) => f.sail));
  return { flights: flights.length, totalKm: total / 1000, sailKm: Object.fromEntries(Object.entries(bySail).map(([k, v]) => [k, v / 1000])), worst, kmAtWorst: (bySail[worst] || 0) / 1000 };
}

// all feasible splits (for brute-force testing on small profiles)
export function allSplits(prof, Lmax, minLen = 0) {
  const n = prof.length, res = [];
  const ok = prof.map((p, k) => k === 0 || k === n - 1 || p.site);
  (function rec(i, path) {
    if (i === n - 1) { res.push(path.slice()); return; }
    for (let j = i + 1; j < n && prof[j].s - prof[i].s <= Lmax + 1e-6; j++) if (ok[j] && prof[j].s - prof[i].s >= minLen - 1e-6) { path.push([i, j]); rec(j, path); path.pop(); }
  })(0, []);
  return res;
}
