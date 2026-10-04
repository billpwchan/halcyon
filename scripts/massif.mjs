// The island's mountains from a real one: Ōlomana, on O'ahu's windward side, from the USGS 3DEP 1 m lidar DEM
// (HI_NOAAMauiOahu_2020, public domain), its western foot where that survey has a gap from the 1/3 arc-second DEM.
// The relief is scaled down uniformly (slopes stay true), turned so the face that rises as one clean pyramid looks
// at the harbour and the village, and baked onto the heightfield's own texel grid (layout.js HF) for the generator
// (heightfield.js), which lays it over the island's beaches and plain. Below the mountain the survey shows a town,
// roads and a golf course: the lowest relief is blurred to its broad shape, and the island supplies its own ground.
// Inputs:  .cache/dem/x62y237.tif, x63y237.tif (USGS_1M_4_*_HI_NOAAMauiOahu_2020_B20), n22w158_13.tif (USGS_13_n22w158)
// Output:  public/assets/models/massif_h.bin (uint16 relief, metres = value * scale) and massif_h.json
// usage: node scripts/massif.mjs
import { fromFile } from 'geotiff';
import { writeFileSync } from 'node:fs';
import { HF, MASSIF, LOOKOUT } from '../src/world/layout.js';

const DEM = '.cache/dem/';
const SUMMIT = [629520, 2362644]; // UTM 4N, the highest lidar return on Ōlomana (493 m)
const BASE = 14; // real metres taken as the island's plain
const LOW = [40, 85]; // real relief below which the survey's lowland is blurred, fading to full detail above

// WGS84 / NAD83 (the same to a metre here) to and from UTM zone 4N
const A = 6378137, F = 1 / 298.257223563, K0 = 0.9996, E2 = F * (2 - F), EP2 = E2 / (1 - E2), L0 = -159 * Math.PI / 180;
function toLatLon(E, N) {
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const M = N / K0, mu = M / (A * (1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256));
  const p = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) + (151 * e1 ** 3 / 96) * Math.sin(6 * mu);
  const C1 = EP2 * Math.cos(p) ** 2, T1 = Math.tan(p) ** 2, N1 = A / Math.sqrt(1 - E2 * Math.sin(p) ** 2), R1 = A * (1 - E2) / (1 - E2 * Math.sin(p) ** 2) ** 1.5;
  const D = (E - 500000) / (N1 * K0);
  const lat = p - (N1 * Math.tan(p) / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4 / 24 + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6 / 720);
  const lon = L0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5 / 120) / Math.cos(p);
  return [lat * 180 / Math.PI, lon * 180 / Math.PI];
}

// the output grid: heightfield texels over the island
const T = HF.texel;
const i0 = Math.floor((MASSIF.x0 - HF.origin) / T), j0 = Math.floor((MASSIF.z0 - HF.origin) / T);
const W = Math.ceil((MASSIF.x1 - MASSIF.x0) / T), H = Math.ceil((MASSIF.z1 - MASSIF.z0) / T);
// world (x, z) -> real metres east and north of the summit: undo the turn, then the scale (north is -z unturned)
const c = Math.cos(MASSIF.theta), s = Math.sin(MASSIF.theta);
const toReal = (x, z) => {
  const dx = x - MASSIF.x, dz = z - MASSIF.z;
  const u = dx * c + dz * s, v = -dx * s + dz * c;
  return [SUMMIT[0] + u / MASSIF.scale, SUMMIT[1] - v / MASSIF.scale];
};

// the real area those texels cover, read at 1 m
let E0 = Infinity, E1 = -Infinity, N0 = Infinity, N1 = -Infinity;
for (const [x, z] of [[MASSIF.x0, MASSIF.z0], [MASSIF.x1, MASSIF.z0], [MASSIF.x0, MASSIF.z1], [MASSIF.x1, MASSIF.z1]]) {
  const [e, n] = toReal(x, z);
  E0 = Math.min(E0, e); E1 = Math.max(E1, e); N0 = Math.min(N0, n); N1 = Math.max(N1, n);
}
E0 = Math.floor(E0) - 4; E1 = Math.ceil(E1) + 4; N0 = Math.floor(N0) - 4; N1 = Math.ceil(N1) + 4;
const RW = E1 - E0, RH = N1 - N0;
const real = new Float32Array(RW * RH).fill(NaN);
for (const [t, ox, oy] of [['x62y237', 619994, 2370006], ['x63y237', 629994, 2370006]]) {
  const im = await (await fromFile(DEM + t + '.tif')).getImage();
  const x0 = Math.max(0, E0 - ox), x1 = Math.min(im.getWidth(), E1 - ox), y0 = Math.max(0, oy - N1), y1 = Math.min(im.getHeight(), oy - N0);
  if (x1 <= x0 || y1 <= y0) continue;
  const r = await im.readRasters({ window: [x0, y0, x1, y1], interleave: true });
  const w = x1 - x0;
  for (let j = 0; j < y1 - y0; j++) for (let i = 0; i < w; i++) {
    const v = r[j * w + i];
    if (v > -100) real[(N1 - (oy - (y0 + j))) * RW + (ox + x0 + i - E0)] = v;
  }
}
// the gap, from the 10 m DEM (geographic), feathered in over 40 m so the two surveys meet without a step
const im13 = await (await fromFile(DEM + 'n22w158_13.tif')).getImage();
const [lo0, la0] = im13.getOrigin(), [rx, ry] = im13.getResolution();
const corners = [[E0, N0], [E1, N0], [E0, N1], [E1, N1]].map(([e, n]) => toLatLon(e, n));
const ci0 = Math.floor((Math.min(...corners.map((q) => q[1])) - lo0) / rx) - 2, ci1 = Math.ceil((Math.max(...corners.map((q) => q[1])) - lo0) / rx) + 2;
const cj0 = Math.floor((Math.max(...corners.map((q) => q[0])) - la0) / ry) - 2, cj1 = Math.ceil((Math.min(...corners.map((q) => q[0])) - la0) / ry) + 2;
const coarse = await im13.readRasters({ window: [ci0, cj0, ci1, cj1], interleave: true });
const cw = ci1 - ci0;
const coarseAt = (e, n) => {
  const [la, lo] = toLatLon(e, n);
  const fx = (lo - lo0) / rx - ci0 - 0.5, fy = (la - la0) / ry - cj0 - 0.5;
  const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j, k = j * cw + i;
  return (coarse[k] * (1 - u) + coarse[k + 1] * u) * (1 - v) + (coarse[k + cw] * (1 - u) + coarse[k + cw + 1] * u) * v;
};
const valid = new Float32Array(RW * RH);
for (let k = 0; k < RW * RH; k++) valid[k] = Number.isNaN(real[k]) ? 0 : 1;
const boxBlur = (src, w, h, r, passes = 3) => {
  let a = Float32Array.from(src), b = new Float32Array(a.length);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < h; j++) { let acc = 0; const row = j * w; for (let i = -r; i <= r; i++) acc += a[row + Math.min(w - 1, Math.max(0, i))]; for (let i = 0; i < w; i++) { b[row + i] = acc / (2 * r + 1); acc += a[row + Math.min(w - 1, i + r + 1)] - a[row + Math.max(0, i - r)]; } }
    for (let i = 0; i < w; i++) { let acc = 0; for (let j = -r; j <= r; j++) acc += b[Math.min(h - 1, Math.max(0, j)) * w + i]; for (let j = 0; j < h; j++) { a[j * w + i] = acc / (2 * r + 1); acc += b[Math.min(h - 1, j + r + 1) * w + i] - b[Math.max(0, j - r) * w + i]; } }
  }
  return a;
};
// weight of the lidar: 0 in the gap, 1 a few tens of metres inside the surveyed ground
const wl = boxBlur(valid, RW, RH, 8);
let gap = 0;
for (let j = 0; j < RH; j++) for (let i = 0; i < RW; i++) {
  const k = j * RW + i, w = Math.min(1, Math.max(0, (wl[k] - 0.5) * 2)) * valid[k];
  if (w < 1) { gap++; const h10 = coarseAt(E0 + i + 0.5, N1 - j - 0.5); real[k] = w > 0 ? real[k] * w + h10 * (1 - w) : h10; }
}
// relief above the plain; the lowland's built ground blurred away
const rel = new Float32Array(RW * RH);
for (let k = 0; k < RW * RH; k++) rel[k] = Math.max(0, real[k] - BASE);
const soft = boxBlur(rel, RW, RH, 9);
for (let k = 0; k < RW * RH; k++) { const t = Math.min(1, Math.max(0, (rel[k] - LOW[0]) / (LOW[1] - LOW[0]))); const w = t * t * (3 - 2 * t); rel[k] = soft[k] * (1 - w) + rel[k] * w; }

// the lookout: a level shelf some 20 m across cut into the shoulder, blending back into the slope by 26 m out
{
  const [le, ln] = toReal(LOOKOUT.x, LOOKOUT.z), R0 = 10 / MASSIF.scale, R1 = 26 / MASSIF.scale;
  let acc = 0, n = 0;
  for (let j = Math.floor(N1 - ln - R0); j <= N1 - ln + R0; j++) for (let i = Math.floor(le - E0 - R0); i <= le - E0 + R0; i++) if (Math.hypot(i - (le - E0), j - (N1 - ln)) <= R0) { acc += rel[j * RW + i]; n++; }
  const lev = acc / n;
  for (let j = Math.floor(N1 - ln - R1); j <= N1 - ln + R1; j++) for (let i = Math.floor(le - E0 - R1); i <= le - E0 + R1; i++) {
    const d = Math.hypot(i - (le - E0), j - (N1 - ln)); if (d > R1) continue;
    const t = Math.min(1, Math.max(0, (R1 - d) / (R1 - R0))), w = t * t * (3 - 2 * t);
    rel[j * RW + i] = rel[j * RW + i] * (1 - w) + lev * w;
  }
}

// onto the texels: each texel averages the real ground it covers (2-3 m of it), so nothing aliases
const out = new Uint16Array(W * H);
const SCALE = 1 / 128; // 0..512 m in 1/128 m steps
const sub = 3;
let top = 0, topX = 0, topZ = 0;
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
  let acc = 0;
  for (let b = 0; b < sub; b++) for (let a = 0; a < sub; a++) {
    const x = HF.origin + (i0 + i + (a + 0.5) / sub) * T, z = HF.origin + (j0 + j + (b + 0.5) / sub) * T;
    const [e, n] = toReal(x, z);
    const fx = e - E0 - 0.5, fy = N1 - n - 0.5, ii = Math.floor(fx), jj = Math.floor(fy), u = fx - ii, v = fy - jj, k = jj * RW + ii;
    acc += (rel[k] * (1 - u) + rel[k + 1] * u) * (1 - v) + (rel[k + RW] * (1 - u) + rel[k + RW + 1] * u) * v;
  }
  const hm = (acc / (sub * sub)) * MASSIF.scale;
  out[j * W + i] = Math.min(65535, Math.round(hm / SCALE));
  if (hm > top) { top = hm; topX = HF.origin + (i0 + i + 0.5) * T; topZ = HF.origin + (j0 + j + 0.5) * T; }
}
writeFileSync('public/assets/models/massif_h.bin', Buffer.from(out.buffer));
writeFileSync('public/assets/models/massif_h.json', JSON.stringify({ i0, j0, w: W, h: H, scale: SCALE, summit: [+topX.toFixed(1), +top.toFixed(1), +topZ.toFixed(1)], credit: 'Ōlomana, O\'ahu: USGS 3DEP 1 m lidar DEM (public domain)' }));
console.log(`massif ${W}x${H} texels at ${i0},${j0}; real ${RW}x${RH} m, ${(gap / (RW * RH) * 100).toFixed(1)}% from the 10 m DEM; summit ${top.toFixed(1)} m at ${topX.toFixed(0)}, ${topZ.toFixed(0)}`);
