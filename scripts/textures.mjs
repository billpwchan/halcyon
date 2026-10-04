// Rebuilds the terrain and wood surfaces from Poly Haven (CC0): downloads each set and converts it to webp under
// public/assets/tex. `npm run assets` already ships these; this is for changing or adding one.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = new URL('../public/assets/tex/', import.meta.url).pathname;
const TMP = new URL('../.cache/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });

// [asset, source res, output size, maps]; c = colour, n = GL normal, r = roughness, a = AO
const LIST = [
  ['coast_sand_01', '2k', 2048, 'cn'],
  ['damp_beach_sand', '2k', 2048, 'cn'],
  ['coral_gravel', '2k', 2048, 'cn'],
  ['forrest_ground_01', '2k', 2048, 'cn'],
  ['dry_decay_leaves', '2k', 2048, 'cn'],
  ['park_dirt', '2k', 2048, 'cn'],
  ['dark_rock', '2k', 2048, 'cn'],
  ['rock_face', '2k', 2048, 'cn'],
  ['coast_land_rocks_01', '2k', 2048, 'cn'],
  ['mud_forest', '2k', 2048, 'cn'],
  ['weathered_planks', '2k', 2048, 'cn'],
];
const KEY = { c: 'Diffuse', n: 'nor_gl', r: 'Rough', a: 'AO' };

const get = async (url) => {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
    } catch {}
    await new Promise((res) => setTimeout(res, 800 * (i + 1)));
  }
  throw new Error('fetch failed ' + url);
};

for (const [id, res, size, maps] of LIST) {
  const meta = await (await get(`https://api.polyhaven.com/files/${id}`)).json();
  for (const m of maps) {
    const dst = join(OUT, `${id}_${m}.webp`);
    if (existsSync(dst)) continue;
    const entry = meta[KEY[m]];
    if (!entry) { console.log('missing', id, m); continue; }
    const url = (entry[res] || entry['1k']).jpg?.url || (entry[res] || entry['1k']).png.url;
    const tmp = join(TMP, `${id}_${m}${url.endsWith('.png') ? '.png' : '.jpg'}`);
    writeFileSync(tmp, Buffer.from(await (await get(url)).arrayBuffer()));
    const q = m === 'n' ? 90 : 84;
    execFileSync('cwebp', ['-quiet', '-q', String(q), '-resize', String(size), String(size), tmp, '-o', dst]);
    console.log('ok', dst.split('/').pop());
  }
}
