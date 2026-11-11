import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as S from '../src/sora.js';
import { CORRIDOR, TRINITY_PRO } from '../scripts/corridor.mjs';
import { scenarios, plan } from '../scripts/evaluate.mjs';

const pop = JSON.parse(readFileSync(new URL('../data/population.json', import.meta.url)));
const results = JSON.parse(readFileSync(new URL('../data/results.json', import.meta.url)));
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

test('EPSG:3035 forward matches the EPSG Guidance Note 7-2 worked example', () => {
  const [x, y] = S.laeaForward(50, 5);
  assert.ok(Math.abs(x - 3962799.45) < 0.01 && Math.abs(y - 2999718.85) < 0.01, `${x} ${y}`);
  assert.deepEqual(S.laeaForward(52, 10).map((v) => Math.round(v)), [4321000, 3210000]);
});

test('property: LAEA inverse(forward(p)) = p to < 1 mm over Germany', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let k = 0; k < 2000; k++) {
    const lat = 47 + rnd() * 8, lon = 5.5 + rnd() * 9.5;
    const [x, y] = S.laeaForward(lat, lon);
    const [la, lo] = S.laeaInverse(x, y);
    const [x2, y2] = S.laeaForward(la, lo);
    assert.ok(Math.hypot(x2 - x, y2 - y) < 1e-3);
    assert.ok(Math.abs(la - lat) < 1e-8 && Math.abs(lo - lon) < 1e-8);
  }
});

test('iGRC follows the SORA 2.5 table (3 m / 35 m/s column) at every band edge', () => {
  assert.equal(S.igrc(0), 3); assert.equal(S.igrc(4.99), 3); assert.equal(S.igrc(5), 4);
  assert.equal(S.igrc(49.9), 4); assert.equal(S.igrc(50), 5); assert.equal(S.igrc(499), 5);
  assert.equal(S.igrc(500), 6); assert.equal(S.igrc(4999), 6); assert.equal(S.igrc(5000), 7);
  assert.equal(S.igrc(49999), 7); assert.equal(S.igrc(50000), 8);
});

test('SAIL matrix for ARC-b and M1(A) floor', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(S.sailArcB), [2, 2, 2, 3, 4, 5, 6, 0]);
  assert.equal(S.finalGrc(3, true), 2);
  assert.equal(S.finalGrc(1, true), 1);
});

test('resample keeps 100 m spacing and the full corridor length', () => {
  const poly = S.project(CORRIDOR.waypoints);
  const sm = S.resample(poly, 100);
  let L = 0; for (let i = 1; i < poly.length; i++) L += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
  assert.ok(Math.abs(sm.at(-1).s - L) < 1e-6);
  for (let i = 1; i < sm.length - 1; i++) assert.ok(Math.abs(sm[i].s - sm[i - 1].s - 100) < 1e-6);
});

test('maxDensityWithin agrees with a brute-force scan of all cells', () => {
  const idx = S.indexCells(pop);
  const sm = S.resample(S.project(CORRIDOR.waypoints), 1000);
  for (const p of sm) {
    const r = 320, c = pop.cell, lim = (r + c * Math.SQRT1_2) ** 2;
    let best = 0;
    for (const [i, j, n] of pop.cells) if (((i + 0.5) * c - p.x) ** 2 + ((j + 0.5) * c - p.y) ** 2 <= lim) best = Math.max(best, n / 0.04);
    assert.equal(S.maxDensityWithin(idx, p.x, p.y, r).density, best);
  }
});

test('population extract is consistent (200 m sums, people total)', () => {
  assert.equal(pop.cell, 200);
  assert.equal(pop.cells.reduce((s, c) => s + c[2], 0), pop.people);
  assert.ok(pop.cells.every(([, , p]) => p > 0 && Number.isInteger(p)));
});

test('max segment: C2 range binds for Trinity Pro defaults', () => {
  const L = S.maxSegment(TRINITY_PRO, S.DEFAULTS);
  assert.equal(L.byC2, 15000);
  assert.ok(L.byEndurance > L.byC2);
  assert.equal(L.metres, 15000);
});

// small random profiles: DP must equal brute-force enumeration of all splits
function randomProfile(rnd, n) {
  return Array.from({ length: n }, (_, k) => ({ s: k * 500, density: [0, 3, 30, 300, 3000, 30000][Math.floor(rnd() * 6)], site: rnd() < 0.5 }));
}
test('property: DP split is exactly optimal (vs brute force) on 300 random profiles', () => {
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let checked = 0;
  for (let t = 0; t < 300; t++) {
    const prof = randomProfile(rnd, 6 + Math.floor(rnd() * 8));
    const P = { ...S.DEFAULTS, minLen: rnd() < 0.5 ? 0 : 1000, m1a: rnd() < 0.3 };
    const Lmax = 1500 + Math.floor(rnd() * 3) * 500;
    const dp = S.optimalSplit(prof, Lmax, P);
    const all = S.allSplits(prof, Lmax, P.minLen);
    if (!all.length) { assert.equal(dp, null); continue; }
    const bestBF = all.map((sp) => S.planCost(sp.map(([i, j]) => S.flight(prof, i, j, P)))).sort(S.cmpCost)[0];
    assert.deepEqual(S.planCost(dp), bestBF);
    checked++;
  }
  assert.ok(checked > 100);
});

test('optimal split is never lexicographically worse than the max-length split', () => {
  for (const s of results.scenarios) {
    const { opt, greedy } = plan(pop, { ...S.DEFAULTS, heightAgl: s.heightAgl, m1a: s.m1a });
    assert.ok(S.cmpCost(S.planCost(opt), S.planCost(greedy)) <= 0);
    for (const f of opt) assert.ok(f.len <= 15000 + 1e-6 && f.len >= S.DEFAULTS.minLen - 1e-6);
  }
});

test('every flight starts and ends at an open-ground site (or a corridor end)', () => {
  const { prof, opt } = plan(pop, S.DEFAULTS);
  for (const f of opt) {
    assert.ok(f.i === 0 || prof[f.i].site);
    assert.ok(f.j === prof.length - 1 || prof[f.j].site);
  }
  assert.equal(opt[0].from, 0);
  assert.equal(opt.at(-1).to, prof.at(-1).s);
});

test('headline numbers in results.json reproduce from the committed grid', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(scenarios(pop))), results.scenarios);
  const h = results.headline;
  assert.equal(h.greedyKmAtWorst, 14.1);
  assert.equal(h.optimalKmAtWorst, 8.8);
  assert.equal(h.worstSail, 'VI');
});

test('app.js uses the same corridor waypoints as scripts/corridor.mjs', () => {
  for (const [la, lo] of CORRIDOR.waypoints) assert.ok(app.includes(`[${la.toFixed(4)}, ${lo.toFixed(4)}]`), `${la},${lo}`);
});
