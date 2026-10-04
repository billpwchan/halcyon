// Vegetation and ground-cover density, computed once on the CPU from the heightfield.
// The same map drives tree placement and the terrain shader, so canopies and the ground beneath them agree.
import * as THREE from 'three';
import { HF, LIGHTHOUSE, LOOKOUT } from './layout.js';
import { PLAN } from './plan.js';

const hash = (x, z) => {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
export function vnoise(x, z) {
  const i = Math.floor(x), j = Math.floor(z);
  const fx = x - i, fz = z - j;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
export const fbm = (x, z) => vnoise(x, z) * 0.5 + vnoise(x * 2.03 + 7.1, z * 2.03 - 3.3) * 0.3 + vnoise(x * 4.1 + 1.7, z * 4.1 + 9.2) * 0.2;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export const VEG_RES = 1024;

export function buildVegMap(hf) {
  const M = VEG_RES;
  const data = new Uint8Array(M * M * 4);
  const forest = new Float32Array(M * M), palm = new Float32Array(M * M), grass = new Float32Array(M * M), rock = new Float32Array(M * M);
  const nrm = new THREE.Vector3();
  const c = { d: 0, dx: 0, dz: 0, lag: 0 };
  for (let j = 0; j < M; j++) {
    for (let i = 0; i < M; i++) {
      const x = HF.origin + ((i + 0.5) / M) * HF.size, z = HF.origin + ((j + 0.5) / M) * HF.size;
      const h = hf.heightAt(x, z);
      const k = j * M + i;
      if (h < 0.4) continue;
      hf.normalAt(x, z, nrm);
      const s = 1 - nrm.y;
      const path = hf.sampleField(hf.path, x, z);
      const pad = hf.sampleField(hf.pad, x, z);
      hf.coastAt(x, z, c);
      const inland = -c.d; // metres inland of the break line
      const n1 = fbm(x * 0.006, z * 0.006), n2 = vnoise(x * 0.03, z * 0.03);
      // glades tens of metres across, not whole hillsides, and rarer up the steep heights
      const clearing = smooth(0.2, 0.3, fbm(x * 0.011 + 5.3, z * 0.011 - 2.1) + 0.12 * smooth(15, 45, h));
      let r = Math.max(smooth(0.5, 0.68, s), smooth(285, 320, h) * smooth(0.25, 0.45, s));
      // the light's stack: basalt cliffs and a boulder apron under a grassy cap
      const dl = Math.hypot(x - LIGHTHOUSE.x, z - LIGHTHOUSE.z);
      if (dl < 40) r = Math.max(r, smooth(12, 16, dl) * smooth(36, 28, dl));
      // littoral forest closes in behind the palm fringe; in places the coconut groves run deeper
      const deep = vnoise(x * 0.008 + 2.7, z * 0.008 - 6.1);
      let f = smooth(1.6, 4.5, h) * smooth(0.76, 0.54, s) * smooth(14 + 50 * deep, 40 + 80 * deep, inland) * (1 - pad) * (1 - path) * clearing * (0.8 + 0.2 * n2);
      // the lookout keeps its view down to the harbour: no trees in the fan below it
      const lx = x - LOOKOUT.x, lz = z - LOOKOUT.z, ld = Math.hypot(lx, lz);
      if (ld < 70) f *= 1 - smooth(70, 45, ld) * smooth(0.6, 0.8, (lx * LOOKOUT.dx + lz * LOOKOUT.dz) / Math.max(ld, 1)) * 0.92;
      f *= 1 - r;
      // palms: the coastal band and the motus, thinning uphill
      let p = smooth(0.8, 1.8, h) * smooth(28, 10, h) * smooth(0.45, 0.25, s) * (1 - path * 0.9) * (1 - pad * 0.55) * (0.5 + 0.5 * vnoise(x * 0.02 + 3, z * 0.02));
      // the motus sit on the reef ring, where the lagoon mask falls away (the main island is all lagoon)
      p = Math.max(p, smooth(0.8, 1.6, h) * smooth(0.6, 0.15, c.lag) * 0.9);
      p *= 1 - r;
      const g = smooth(1.6, 3.5, h) * smooth(0.55, 0.3, s) * (1 - f * 0.85) * (1 - path) * (1 - r);
      forest[k] = f; palm[k] = p; grass[k] = g; rock[k] = r;
      data[k * 4] = Math.round(f * 255);
      data[k * 4 + 1] = Math.round(p * 255);
      data[k * 4 + 2] = Math.round(g * 255);
      data[k * 4 + 3] = Math.round(r * 255);
    }
  }
  // built footprints: bare inside, trees held back so crowns do not grow through roofs, a trodden yard around
  for (const fp of PLAN.footprints) {
    const reach = fp.r + 9;
    const i0 = Math.max(0, Math.floor(((fp.x - reach - HF.origin) / HF.size) * M)), i1 = Math.min(M - 1, Math.ceil(((fp.x + reach - HF.origin) / HF.size) * M));
    const j0 = Math.max(0, Math.floor(((fp.z - reach - HF.origin) / HF.size) * M)), j1 = Math.min(M - 1, Math.ceil(((fp.z + reach - HF.origin) / HF.size) * M));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = HF.origin + ((i + 0.5) / M) * HF.size, z = HF.origin + ((j + 0.5) / M) * HF.size;
      const d = Math.hypot(x - fp.x, z - fp.z);
      if (d > reach) continue;
      const k = j * M + i;
      forest[k] *= smooth(fp.r + 1, fp.r + 9, d);
      palm[k] *= smooth(fp.r, fp.r + 2, d);
      grass[k] *= 0.15 + 0.85 * smooth(fp.r, fp.r + 4, d);
      data[k * 4] = Math.round(forest[k] * 255);
      data[k * 4 + 1] = Math.round(palm[k] * 255);
      data[k * 4 + 2] = Math.round(grass[k] * 255);
    }
  }
  const tex = new THREE.DataTexture(data, M, M, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  const at = (arr, x, z) => {
    const i = Math.min(M - 1, Math.max(0, Math.floor(((x - HF.origin) / HF.size) * M)));
    const j = Math.min(M - 1, Math.max(0, Math.floor(((z - HF.origin) / HF.size) * M)));
    return arr[j * M + i];
  };
  return { tex, forest, palm, grass, rock, at };
}
