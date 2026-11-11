// Extract the Zensus 2022 100 m population grid around the corridor and
// aggregate it to the 200 m grid that SORA 2.5 suggests for flights at
// 500 ft AGL and below (JARUS SORA 2.5 main body, Table "optimal grid size").
//
// Source (open data, "Datenlizenz Deutschland - Namensnennung - 2.0"):
//   https://www.destatis.de/static/DE/zensus/gitterdaten/Zensus2022_Bevoelkerungszahl.zip
//   -> Zensus2022_Bevoelkerungszahl_100m-Gitter.csv  (EPSG:3035 cell centres)
// Usage: node scripts/extract.mjs /path/to/Zensus2022_Bevoelkerungszahl_100m-Gitter.csv
import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { laeaForward } from '../src/sora.js';
import { CORRIDOR } from './corridor.mjs';

export const MARGIN = 4000; // metres around the corridor bounding box

async function main(csv) {
  const pts = CORRIDOR.waypoints.map(([lat, lon]) => laeaForward(lat, lon));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const box = [Math.min(...xs) - MARGIN, Math.min(...ys) - MARGIN, Math.max(...xs) + MARGIN, Math.max(...ys) + MARGIN];
  const agg = new Map();
  let rows = 0, kept = 0, people = 0;
  const rl = createInterface({ input: createReadStream(csv), crlfDelay: Infinity });
  for await (const line of rl) {
    if (rows++ === 0) continue; // header GITTER_ID_100m;x_mp_100m;y_mp_100m;Einwohner
    const [, xs_, ys_, ps] = line.split(';');
    const x = +xs_, y = +ys_, p = +ps;
    if (!(x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3])) continue;
    if (!(p > 0)) continue; // empty cells are not listed; '-' marks suppressed values
    const k = `${Math.floor(x / 200)},${Math.floor(y / 200)}`;
    agg.set(k, (agg.get(k) || 0) + p);
    kept++; people += p;
  }
  const cells = [...agg.entries()].map(([k, p]) => { const [i, j] = k.split(',').map(Number); return [i, j, p]; })
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out = {
    source: 'Zensus 2022, Statistisches Bundesamt (Destatis), 100 m population grid, aggregated to 200 m; dl-de/by-2-0',
    url: 'https://www.destatis.de/static/DE/zensus/gitterdaten/Zensus2022_Bevoelkerungszahl.zip',
    crs: 'EPSG:3035', cell: 200, box, cells, people, cells100: kept,
  };
  writeFileSync(new URL('../data/population.json', import.meta.url), JSON.stringify(out));
  console.log({ rows, kept, cells200: cells.length, people, box });
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv[2]);
