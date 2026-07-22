#!/usr/bin/env node
// tools/generate-zip-centroids.mjs
//
// Regenerates `lib/zipCentroids.data.ts` — the OFFLINE US ZIP→centroid table
// that distance-aware buyer routing reads at request time.
//
// WHY OFFLINE: matching/suggest runs on every qualified buyer. A live
// geocode call there would add a network hop (and a rate-limit failure mode)
// to the money path during exactly the traffic spike we want to survive.
// lib/geocode.ts (zippopotam/Nominatim) stays the RANCHER-signup geocoder —
// once per rancher, offline table for every buyer.
//
// SOURCE: the `zipcodes` npm package (MIT), which vendors the US Census /
// USPS ZIP centroid set. We do NOT add it as a dependency — the data is a
// static snapshot, so we vendor the derived table and keep this script for
// reproducibility.
//
// USAGE:
//   npm pack zipcodes@8.0.0 && tar xzf zipcodes-8.0.0.tgz
//   node tools/generate-zip-centroids.mjs ./package/lib/codes.js
//
// The emitted table is `ZIP,lat,lng,ST` lines, 3-decimal precision (~110 m —
// far tighter than the ~3-5 mi ZIP-centroid error the data itself carries).

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const src = process.argv[2] || './node_modules/zipcodes/lib/codes.js';
const { codes } = require(resolve(process.cwd(), src));
if (!codes) {
  console.error(`No \`codes\` export found in ${src}`);
  process.exit(1);
}

const round3 = (n) => Math.round(n * 1000) / 1000;
const lines = [];
for (const zip of Object.keys(codes).sort()) {
  const c = codes[zip];
  if (!c || c.country !== 'US') continue;
  if (!/^\d{5}$/.test(zip)) continue;
  const lat = Number(c.latitude);
  const lng = Number(c.longitude);
  const st = String(c.state || '').toUpperCase();
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
  if (!/^[A-Z]{2}$/.test(st)) continue;
  // A 0,0 centroid is the dataset's "unknown" marker, not the Gulf of Guinea.
  if (lat === 0 && lng === 0) continue;
  lines.push(`${zip},${round3(lat)},${round3(lng)},${st}`);
}

const header = `// lib/zipCentroids.data.ts — GENERATED, DO NOT EDIT BY HAND.
//
// Regenerate with \`node tools/generate-zip-centroids.mjs <path/to/codes.js>\`
// (see that script's header for provenance: the \`zipcodes\` npm package, MIT).
//
// Format: one \`ZIP,lat,lng,STATE\` record per line, sorted by ZIP, 3-decimal
// precision. Parsed lazily into a Map by lib/zipCentroids.ts — never import
// this file directly.
//
// Records: ${lines.length}

export const ZIP_CENTROID_TABLE = \`
`;

const out = `${header}${lines.join('\n')}\n\`;\n`;
writeFileSync(resolve(process.cwd(), 'lib/zipCentroids.data.ts'), out);
console.log(`wrote lib/zipCentroids.data.ts — ${lines.length} ZIPs, ${(out.length / 1e6).toFixed(2)} MB`);
