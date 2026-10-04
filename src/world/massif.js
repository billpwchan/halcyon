// The mountain's relief (scripts/massif.mjs), on the heightfield's own texel grid: the generator (heightfield.js) reads
// it texel for texel. G holds it blurred, for the smooth surface pads and paths are pulled toward.
import * as THREE from 'three';

export async function loadMassif() {
  const [meta, buf] = await Promise.all([
    fetch('./assets/models/massif_h.json').then((r) => r.json()),
    fetch('./assets/models/massif_h.bin').then((r) => r.arrayBuffer()),
  ]);
  const { w, h, scale } = meta;
  const src = new Uint16Array(buf);
  const full = new Float32Array(w * h);
  for (let k = 0; k < w * h; k++) full[k] = src[k] * scale;
  // three box passes of 9 texels (~16 m): about the reach of the generator's own smooth surface
  let a = Float32Array.from(full), b = new Float32Array(w * h);
  const R = 4;
  for (let p = 0; p < 3; p++) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      let acc = 0;
      for (let d = -R; d <= R; d++) acc += a[j * w + Math.min(w - 1, Math.max(0, i + d))];
      b[j * w + i] = acc / (2 * R + 1);
    }
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      let acc = 0;
      for (let d = -R; d <= R; d++) acc += b[Math.min(h - 1, Math.max(0, j + d)) * w + i];
      a[j * w + i] = acc / (2 * R + 1);
    }
  }
  const rg = new Float32Array(w * h * 2);
  for (let k = 0; k < w * h; k++) { rg[k * 2] = full[k]; rg[k * 2 + 1] = a[k]; }
  const tex = new THREE.DataTexture(rg, w, h, THREE.RGFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return { ...meta, tex };
}
