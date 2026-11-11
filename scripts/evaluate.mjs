// Scenario table + headline, from the committed population grid.
// Usage: node scripts/evaluate.mjs  (writes data/results.json)
import { readFileSync, writeFileSync } from 'node:fs';
import * as S from '../src/sora.js';
import { CORRIDOR, TRINITY_PRO } from './corridor.mjs';

export function plan(pop, params) {
  const idx = S.indexCells(pop);
  const samples = S.resample(S.project(CORRIDOR.waypoints), 100);
  const prof = S.profile(idx, samples, params);
  const L = S.maxSegment(TRINITY_PRO, params);
  const opt = S.optimalSplit(prof, L.metres, params), greedy = S.greedySplit(prof, L.metres, params);
  return { prof, L, opt, greedy };
}
const r1 = (x) => Math.round(x * 10) / 10;
const pack = (fl) => fl.map((f) => ({ from_km: r1(f.from / 1000), to_km: r1(f.to / 1000), km: r1(f.len / 1000), max_density: Math.round(f.maxDensity), igrc: f.igrc, grc: f.grc, sail: S.ROMAN[f.sail] }));
const kmAt = (fl, sail) => r1(fl.filter((f) => f.sail === sail).reduce((s, f) => s + f.len, 0) / 1000);

export function scenarios(pop) {
  const out = [];
  for (const heightAgl of [60, 90, 120]) for (const m1a of [false, true]) {
    const P = { ...S.DEFAULTS, heightAgl, m1a };
    const { prof, L, opt, greedy } = plan(pop, P);
    const worst = Math.max(...opt.map((f) => f.sail));
    out.push({ heightAgl, m1a, samples: prof.length, sites: prof.filter((p) => p.site).length, maxSegmentKm: r1(L.metres / 1000),
      worstSail: S.ROMAN[worst],
      optimal: { flights: opt.length, kmAtWorst: kmAt(opt, worst), kmAtSailII: kmAt(opt, 2), plan: pack(opt) },
      greedy: { flights: greedy.length, kmAtWorst: kmAt(greedy, worst), kmAtSailII: kmAt(greedy, 2), plan: pack(greedy) } });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pop = JSON.parse(readFileSync(new URL('../data/population.json', import.meta.url)));
  const sc = scenarios(pop);
  const d = sc.find((s) => s.heightAgl === 120 && !s.m1a);
  const headline = { heightAgl: 120, m1a: false, worstSail: d.worstSail, greedyKmAtWorst: d.greedy.kmAtWorst, optimalKmAtWorst: d.optimal.kmAtWorst,
    reduction: Math.round((1 - d.optimal.kmAtWorst / d.greedy.kmAtWorst) * 1000) / 1000, optimalFlights: d.optimal.flights, greedyFlights: d.greedy.flights, corridorKm: r1(d.samples > 0 ? plan(pop, S.DEFAULTS).prof.at(-1).s / 1000 : 0) };
  writeFileSync(new URL('../data/results.json', import.meta.url), JSON.stringify({ generated_by: 'scripts/evaluate.mjs', corridor: CORRIDOR.name, aircraft: TRINITY_PRO, scenarios: sc, headline }, null, 1));
  console.log(JSON.stringify(headline));
  for (const s of sc) console.log(s.heightAgl, s.m1a, s.worstSail, 'opt', s.optimal.flights, s.optimal.kmAtWorst, 'greedy', s.greedy.flights, s.greedy.kmAtWorst);
}
