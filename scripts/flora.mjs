// Plant models (.cache/sf_full, Sketchfab gltf archives packed as .glb) -> vegetation assets in public/assets/flora.
// Every plant becomes two parts in its own frame (root at the origin, +y up): wood (trunk, branches, stalks) and leaves
// (blades, leaflets, flowers), one draw each: all of a part's source maps are packed into one atlas, every vertex names
// its map's rectangle, and wrapped bark keeps its tiling through fract() in the shader.
// Attributes:  _AL (vec3) rectangle index, 0, occlusion by the plant's own foliage (rays through a leaf-area grid)
//              _AW (vec4) wind amplitudes in metres: trunk sway, branch/frond flex, leaf flutter; and a phase
// Files:       <name>.glb    desktop: LOD0 and LOD1 ('w0', 'l0', 'w1', 'l1'), UASTC atlases
//              <name>.m.glb  phones: LOD1 geometry for both levels' worth, half-size ETC1S atlases
// usage: node scripts/flora.mjs [name...]
//        FLORA_REUSE_TEX=1 rebuilds geometry only: a file's encoded atlases are kept when the atlas pixels, sizes and
//        encoder settings hash the same as when they were written
import { NodeIO, Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRMeshQuantization, KHRTextureBasisu } from '@gltf-transform/extensions';
import { metalRough, reorder, quantize } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const OUT = 'public/assets/flora';
const LEAF = /leaf|leaflet|leaves|flower|frond|petal|blossom|bud|foliage|blade|lf_stk|_lf|fern|grass|plant_a|_B0\d+a/i;
const TRUNK = /trunk|bark/i;

// height: metres to the top; lod0 / lod1: triangle budgets [wood, leaves]; drop: materials to leave out (fruit, hairs);
// nodes: node-name filter for packs holding several plants; leaf: overrides which materials are foliage;
// tint: material -> rgb multiplier; slim: trunk girth multiplier (a palm scaled up to coconut height stays slender);
// palm: fronds hang from one crown point (their flex grows with distance from it); thin: share of leaves kept at LOD1,
// the rest scaled up to cover; under: understory (short reach, no impostor)
const COCO = { slim: 0.62, palm: true, sink: 'auto', tint: { crownshaft: [0.62, 0.55, 0.42] }, lod0: [9000, 36000], lod1: [700, 4500] };
const SPECIES = {
  // Adonidia grown to coconut height: grey ringed trunk kept slender, the green crownshaft dulled toward fibre,
  // the root flare set into the sand
  palm_a: { src: 'pc_xmas19', height: 13, ...COCO },
  palm_b: { src: 'pc_xmas23', height: 11.5, ...COCO },
  palm_c: { src: 'pc_xmas25', height: 14.5, ...COCO },
  // Alexander palm: the tall straight ones standing among the curved
  palm_d: { src: 'pc_alex15', height: 15, palm: true, sink: 'auto', drop: /fruit/i, lod0: [3000, 26000], lod1: [400, 4000] },
  // broadleaf canopy: fig and Bauhinia grown to forest size, their leaves with them (as big as breadfruit's)
  fig: { src: 'pc_fig9', height: 8, sink: 0.1, drop: /fruit|y2a/i, lod0: [7000, 40000], lod1: [600, 6000], thin: 0.35 },
  fig_b: { src: 'pc_fig15', height: 9.5, sink: 0.1, drop: /fruit|y2a/i, lod0: [8000, 44000], lod1: [700, 6500], thin: 0.35 },
  orchid: { src: 'pc_orch14', height: 8.5, sink: 0.1, drop: /recept|organs|flw_stalk/i, lod0: [8000, 42000], lod1: [700, 6000], thin: 0.35 },
  poinciana: { src: 'pc_poin4', height: 9, sink: 0.1, drop: /stalk|bud_0[23]/i, lod0: [9000, 42000], lod1: [800, 6000], thin: 0.35 },
  poinciana_b: { src: 'pc_poin12', height: 7, sink: 0.1, drop: /stalk|bud_0[23]/i, lod0: [9000, 40000], lod1: [800, 5500], thin: 0.35 },
  frangipani: { src: 'pc_frang24', height: 5.5, sink: 0.1, drop: /recept|flower_stalk|^material$/i, lod0: [6000, 30000], lod1: [500, 4500], thin: 0.4 },
  // Cordyline in the place of pandanus: strap-leaf rosettes on forked stems
  cordyline: { src: 'pc_cab14', height: 5.5, sink: 0.1, drop: /bloom|flower_stalk/i, lod0: [4000, 30000], lod1: [400, 4000], thin: 0.4 },
  // understory
  banana: { src: 'banana_q', height: 4.4, under: true, leaf: /./, sink: 0.05, lod0: [0, 24000], lod1: [0, 3500] },
  banana_b: { src: 'v_tpack', nodes: /Banana_B092/, height: 3.6, under: true, sink: 0.05, lod0: [800, 2000], lod1: [300, 900] },
  // Alocasia: elephant-ear leaves on their own stalks, the stalks as wood
  taro: { src: 'alocasia', height: 1.9, under: true, leaf: /^texture(\.00[23])?$/, lod0: [2500, 18000], lod1: [500, 3000] },
  monstera: { src: 'v_tpack', nodes: /Monstera_B071/, height: 1.9, under: true, lod0: [2500, 3500], lod1: [500, 1200] },
  hibiscus: { src: 'pc_hib8', height: 2.4, under: true, drop: /genitals|style|flw_stalk|bud/i, lod0: [3000, 12000], lod1: [400, 2500], thin: 0.4 },
  hibiscus_b: { src: 'pc_hib5', height: 2.9, under: true, drop: /genitals|style|flw_stalk|bud/i, lod0: [3000, 12000], lod1: [400, 2500], thin: 0.4 },
  turkscap: { src: 'pc_turk8', height: 2.4, under: true, drop: /style|stalk|bud/i, lod0: [3000, 12000], lod1: [400, 2500], thin: 0.4 },
  sago: { src: 'pc_sago5', height: 2.1, under: true, lod0: [1000, 14000], lod1: [200, 2500] },
  sago_b: { src: 'pc_sago30', height: 3.0, under: true, lod0: [1500, 16000], lod1: [300, 3000] },
  butterfly: { src: 'pc_bfly24', height: 5.2, under: true, lod0: [3000, 18000], lod1: [400, 3500] },
  rhapis: { src: 'pc_bamboo12', height: 2.2, under: true, drop: /fur|dead_cut/i, lod0: [2000, 12000], lod1: [300, 2500] },
  fern: { src: 'pc_fern5', height: 1.1, under: true, leaf: /Polypodium_01/i, drop: /root/i, lod0: [0, 9000], lod1: [0, 1800] },
  fern_b: { src: 'v_tpack', nodes: /Fern_B051_MI/, height: 1.2, under: true, lod0: [0, 6000], lod1: [0, 1500] },
};

const only = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
await MeshoptSimplifier.ready;
await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

// ---------------------------------------------------------------- read: every primitive flattened into world space
function cofactor3(m) {
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  return [e * i - f * h, f * g - d * i, d * h - e * g, c * h - b * i, a * i - c * g, b * g - a * h, b * f - c * e, c * d - a * f, a * e - b * d];
}
function readPrims(doc, spec) {
  const prims = [];
  const e = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    if (spec.nodes && !spec.nodes.test(node.getName())) continue;
    const M = node.getWorldMatrix(), C = cofactor3(M);
    for (const p of mesh.listPrimitives()) {
      const mat = p.getMaterial(), name = mat?.getName() || '';
      if (spec.drop?.test(name)) continue;
      const pos = p.getAttribute('POSITION'), nor = p.getAttribute('NORMAL'), uv = p.getAttribute('TEXCOORD_0'), idx = p.getIndices();
      if (!uv || !mat?.getBaseColorTexture()) continue;
      const n = pos.getCount(), P = new Float32Array(n * 3), N = new Float32Array(n * 3), UV = new Float32Array(n * 2);
      for (let v = 0; v < n; v++) {
        pos.getElement(v, e);
        for (let k = 0; k < 3; k++) P[v * 3 + k] = M[k] * e[0] + M[4 + k] * e[1] + M[8 + k] * e[2] + M[12 + k];
        if (nor) {
          nor.getElement(v, e);
          const x = C[0] * e[0] + C[3] * e[1] + C[6] * e[2], y = C[1] * e[0] + C[4] * e[1] + C[7] * e[2], z = C[2] * e[0] + C[5] * e[1] + C[8] * e[2];
          const l = Math.hypot(x, y, z) || 1;
          N[v * 3] = x / l; N[v * 3 + 1] = y / l; N[v * 3 + 2] = z / l;
        } else N[v * 3 + 1] = 1;
        uv.getElement(v, e);
        UV[v * 2] = e[0]; UV[v * 2 + 1] = e[1];
      }
      const I = idx ? Uint32Array.from(idx.getArray()) : Uint32Array.from({ length: n }, (_, i) => i);
      const leaf = spec.leaf ? spec.leaf.test(name) : LEAF.test(name) || mat.getAlphaMode() !== 'OPAQUE';
      prims.push({ mat, name, leaf, trunk: TRUNK.test(name), P, N, UV, I });
    }
  }
  return prims;
}

// ---------------------------------------------------------------- shape: root at the origin, scaled to height
function place(prims, spec) {
  let y0 = Infinity, y1 = -Infinity;
  for (const p of prims) for (let i = 1; i < p.P.length; i += 3) { y0 = Math.min(y0, p.P[i]); y1 = Math.max(y1, p.P[i]); }
  // the root: where the lowest wood meets the ground
  let sx = 0, sz = 0, sn = 0;
  for (const p of prims) {
    if (p.leaf) continue;
    for (let i = 0; i < p.P.length; i += 3) if (p.P[i + 1] < y0 + (y1 - y0) * 0.02) { sx += p.P[i]; sz += p.P[i + 2]; sn++; }
  }
  if (!sn) for (const p of prims) for (let i = 0; i < p.P.length; i += 3) { sx += p.P[i]; sz += p.P[i + 2]; sn++; }
  // sink: metres of root flare that belong below the ground ('auto': a scanned root ball, found from the trunk's
  // girth, goes under but for a swollen foot)
  const rx = sx / sn, rz = sz / sn, k = spec.height / (y1 - y0);
  const sink = spec.sink === 'auto' ? rootBall(prims, y0, y1) * spec.height : spec.sink ?? 0;
  for (const p of prims) for (let i = 0; i < p.P.length; i += 3) {
    p.P[i] = (p.P[i] - rx) * k; p.P[i + 1] = (p.P[i + 1] - y0) * k - sink; p.P[i + 2] = (p.P[i + 2] - rz) * k;
  }
  if (spec.slim) slimTrunk(prims, spec.slim);
  cull(prims, 0.3);
}
// share of the height taken by a root ball: the lowest stretch of trunk much wider than the trunk above it
function rootBall(prims, y0, y1) {
  const pts = [];
  for (const p of prims) if (p.trunk) for (let i = 0; i < p.P.length; i += 3) pts.push(p.P[i], (p.P[i + 1] - y0) / (y1 - y0), p.P[i + 2]);
  const B = 40, r = new Float64Array(B);
  for (let b = 0; b < 14; b++) {
    let cx = 0, cz = 0, n = 0;
    for (let i = 0; i < pts.length; i += 3) if (pts[i + 1] >= b / B && pts[i + 1] < (b + 1) / B) { cx += pts[i]; cz += pts[i + 2]; n++; }
    if (!n) continue;
    cx /= n; cz /= n;
    for (let i = 0; i < pts.length; i += 3) if (pts[i + 1] >= b / B && pts[i + 1] < (b + 1) / B) r[b] = Math.max(r[b], Math.hypot(pts[i] - cx, pts[i + 2] - cz));
  }
  const ref = [...r.slice(6, 14)].filter((x) => x > 0).sort((a, b) => a - b)[2] || r[13];
  let top = 0;
  for (let b = 0; b < 10; b++) if (r[b] > ref * 1.6) top = (b + 1) / B;
  return top * 0.8;
}
// below-ground triangles cost and cast shadows for nothing
function cull(prims, depth) {
  for (const p of prims) {
    const I = [];
    for (let t = 0; t < p.I.length; t += 3) if (p.P[p.I[t] * 3 + 1] > -depth || p.P[p.I[t + 1] * 3 + 1] > -depth || p.P[p.I[t + 2] * 3 + 1] > -depth) I.push(p.I[t], p.I[t + 1], p.I[t + 2]);
    p.I = Uint32Array.from(I);
  }
}
// girth about the trunk's own centre line, slice by slice; whatever the trunk carries (crown, fronds) moves with
// the top slice's centre so it stays seated
function slimTrunk(prims, k) {
  const trunk = prims.filter((p) => p.trunk);
  if (!trunk.length) return;
  let top = 0;
  for (const p of trunk) for (let i = 1; i < p.P.length; i += 3) top = Math.max(top, p.P[i]);
  const B = 96, cx = new Float64Array(B), cz = new Float64Array(B), cn = new Float64Array(B);
  const bin = (y) => Math.min(B - 1, Math.max(0, Math.floor((y / top) * B)));
  for (const p of trunk) for (let i = 0; i < p.P.length; i += 3) { const b = bin(p.P[i + 1]); cx[b] += p.P[i]; cz[b] += p.P[i + 2]; cn[b]++; }
  for (let b = 0; b < B; b++) if (cn[b]) { cx[b] /= cn[b]; cz[b] /= cn[b]; } else if (b) { cx[b] = cx[b - 1]; cz[b] = cz[b - 1]; }
  for (const p of trunk) for (let i = 0; i < p.P.length; i += 3) {
    const b = bin(p.P[i + 1]);
    p.P[i] = cx[b] + (p.P[i] - cx[b]) * k; p.P[i + 2] = cz[b] + (p.P[i + 2] - cz[b]) * k;
  }
}

// ---------------------------------------------------------------- merge into the two parts
function merge(prims, leaf, slots) {
  const ps = prims.filter((p) => p.leaf === leaf);
  let nv = 0, ni = 0;
  for (const p of ps) { nv += p.P.length / 3; ni += p.I.length; }
  const out = { P: new Float32Array(nv * 3), N: new Float32Array(nv * 3), UV: new Float32Array(nv * 2), S: new Float32Array(nv), T: new Uint8Array(nv), I: new Uint32Array(ni) };
  let ov = 0, oi = 0;
  for (const p of ps) {
    const n = p.P.length / 3;
    out.P.set(p.P, ov * 3); out.N.set(p.N, ov * 3); out.UV.set(p.UV, ov * 2);
    out.S.fill(slots.get(p.mat), ov, ov + n);
    out.T.fill(p.trunk ? 1 : 0, ov, ov + n);
    for (let i = 0; i < p.I.length; i++) out.I[oi + i] = p.I[i] + ov;
    ov += n; oi += p.I.length;
  }
  return out;
}

// ---------------------------------------------------------------- foliage occlusion and wind
function attributes(wood, leaves, spec) {
  const parts = [wood, leaves];
  let xmin = Infinity, xmax = -Infinity, zmin = Infinity, zmax = -Infinity, H = 0;
  for (const g of parts) for (let i = 0; i < g.P.length; i += 3) {
    xmin = Math.min(xmin, g.P[i]); xmax = Math.max(xmax, g.P[i]); zmin = Math.min(zmin, g.P[i + 2]); zmax = Math.max(zmax, g.P[i + 2]); H = Math.max(H, g.P[i + 1]);
  }
  // leaf area per cell, scattered from triangle centres (big triangles in several samples)
  const ext = Math.max(xmax - xmin, zmax - zmin, H);
  const cell = Math.max(0.08, ext / 80);
  const gx = Math.ceil((xmax - xmin) / cell) + 3, gy = Math.ceil(H / cell) + 3, gz = Math.ceil((zmax - zmin) / cell) + 3;
  const ox = xmin - cell, oz = zmin - cell, oy = -cell;
  const dens = new Float32Array(gx * gy * gz);
  const at = (x, y, z) => {
    const i = Math.floor((x - ox) / cell), j = Math.floor((y - oy) / cell), k = Math.floor((z - oz) / cell);
    return i < 0 || j < 0 || k < 0 || i >= gx || j >= gy || k >= gz ? -1 : (k * gy + j) * gx + i;
  };
  {
    const { P, I } = leaves;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      const ns = Math.min(16, 1 + Math.floor(area / (cell * cell)));
      for (let s = 0; s < ns; s++) {
        let r1 = ((s * 0.618034 + t * 0.1234567) % 1), r2 = ((s * 0.754877 + t * 0.4567) % 1);
        if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
        const ci = at(P[a] + ux * r1 + vx * r2, P[a + 1] + uy * r1 + vy * r2, P[a + 2] + uz * r1 + vz * r2);
        if (ci >= 0) dens[ci] += area / ns;
      }
    }
  }
  // extinction: leaf area density times a projection factor of one half
  const vol = cell * cell * cell;
  for (let i = 0; i < dens.length; i++) dens[i] = (0.5 * dens[i]) / vol;
  // sky directions, cosine weighted over the upper hemisphere with a little below the horizon
  const dirs = [];
  const ND = 26;
  for (let k = 0; k < ND; k++) {
    const u = (k + 0.5) / ND, phi = k * 2.399963;
    const ct = Math.sqrt(1 - u) * 1.08 - 0.08, st = Math.sqrt(Math.max(0, 1 - ct * ct));
    dirs.push([Math.cos(phi) * st, ct, Math.sin(phi) * st]);
  }
  const occl = (P, N, i) => {
    let sum = 0;
    for (const d of dirs) {
      let x = P[i] + N[i] * cell * 0.6 + d[0] * cell, y = P[i + 1] + N[i + 1] * cell * 0.6 + d[1] * cell, z = P[i + 2] + N[i + 2] * cell * 0.6 + d[2] * cell;
      let tau = 0;
      for (let s = 0; s < 200 && tau < 6; s++) {
        const ci = at(x, y, z);
        if (ci < 0) break;
        tau += dens[ci] * cell;
        x += d[0] * cell; y += d[1] * cell; z += d[2] * cell;
      }
      sum += Math.exp(-tau);
    }
    return sum / dirs.length;
  };

  // wind: the whole plant sways with the trunk; branches and fronds flex more the farther they reach from where they
  // hang; a smooth phase over space keeps a frond, a branch and its leaves moving together
  const amp = (spec.palm ? 0.5 : spec.under ? 0.12 : 0.28) * (H / 12) * (spec.under ? 3 : 1);
  let crown = [0, H * 0.4, 0], reach = 1;
  if (spec.palm) {
    let ty = 0, tx = 0, tz = 0, tn = 0;
    for (let i = 0; i < wood.P.length; i += 3) if (wood.T[i / 3]) ty = Math.max(ty, wood.P[i + 1]);
    for (let i = 0; i < wood.P.length; i += 3) if (wood.T[i / 3] && wood.P[i + 1] > ty - 0.3) { tx += wood.P[i]; tz += wood.P[i + 2]; tn++; }
    crown = [tx / Math.max(tn, 1), ty, tz / Math.max(tn, 1)];
    for (let i = 0; i < leaves.P.length; i += 3) reach = Math.max(reach, Math.hypot(leaves.P[i] - crown[0], leaves.P[i + 1] - crown[1], leaves.P[i + 2] - crown[2]));
  } else {
    let lo = H;
    for (let i = 1; i < leaves.P.length; i += 3) lo = Math.min(lo, leaves.P[i]);
    crown = [0, lo, 0];
    for (let i = 0; i < leaves.P.length; i += 3) reach = Math.max(reach, Math.hypot(leaves.P[i], leaves.P[i + 2]));
  }
  for (const g of parts) {
    const leaf = g === leaves;
    const n = g.P.length / 3;
    g.AL = new Float32Array(n * 3);
    g.AW = new Float32Array(n * 4);
    for (let v = 0; v < n; v++) {
      const i = v * 3, x = g.P[i], y = g.P[i + 1], z = g.P[i + 2];
      const ao = occl(g.P, g.N, i);
      g.AL[i] = g.S[v]; g.AL[i + 1] = 0; g.AL[i + 2] = 0.2 + 0.8 * ao;
      let sway, flex, phase;
      if (spec.palm) {
        sway = amp * Math.pow(Math.min(y, crown[1]) / crown[1], 2);
        const s = Math.hypot(x - crown[0], y - crown[1], z - crown[2]) / reach;
        flex = g.T[v] ? 0 : amp * 1.4 * s * s;
        phase = ((x - crown[0]) * 0.8 + (z - crown[2]) * 0.6) / reach * 3 + (((z - crown[2]) * 0.8 - (x - crown[0]) * 0.6) / reach) ** 2 * 2;
      } else {
        sway = amp * (y / H) * (y / H);
        const r = Math.hypot(x, z) / reach, h = Math.max(0, (y - crown[1]) / Math.max(H - crown[1], 0.1));
        const t = Math.min(1, Math.max(r, h * 0.7));
        flex = g.T[v] ? 0 : amp * (spec.under ? 0.8 : 1.6) * t * t * (3 - 2 * t);
        phase = (x * 0.7 + z * 0.45) * 0.5 + y * 0.25;
      }
      g.AW[v * 4] = sway; g.AW[v * 4 + 1] = flex; g.AW[v * 4 + 2] = leaf ? (spec.palm ? 0.045 : 0.03) : 0; g.AW[v * 4 + 3] = phase;
    }
  }
  return { height: H, radius: Math.max(-xmin, xmax, -zmin, zmax) };
}

// ---------------------------------------------------------------- level of detail
function compact(g, I) {
  const remap = new Int32Array(g.P.length / 3).fill(-1);
  let n = 0;
  for (let i = 0; i < I.length; i++) if (remap[I[i]] < 0) remap[I[i]] = n++;
  const out = { P: new Float32Array(n * 3), N: new Float32Array(n * 3), UV: new Float32Array(n * 2), AL: new Float32Array(n * 3), AW: new Float32Array(n * 4), I: new Uint32Array(I.length) };
  for (let v = 0; v < remap.length; v++) {
    const r = remap[v];
    if (r < 0) continue;
    for (let k = 0; k < 3; k++) { out.P[r * 3 + k] = g.P[v * 3 + k]; out.N[r * 3 + k] = g.N[v * 3 + k]; out.AL[r * 3 + k] = g.AL[v * 3 + k]; }
    for (let k = 0; k < 2; k++) out.UV[r * 2 + k] = g.UV[v * 2 + k];
    for (let k = 0; k < 4; k++) out.AW[r * 4 + k] = g.AW[v * 4 + k];
  }
  for (let i = 0; i < I.length; i++) out.I[i] = remap[I[i]];
  return out;
}
function simplify(g, tris, error, permissive) {
  if (g.I.length / 3 <= tris) return compact(g, g.I);
  const n = g.P.length / 3, attr = new Float32Array(n * 6);
  for (let v = 0; v < n; v++) {
    attr[v * 6] = g.UV[v * 2]; attr[v * 6 + 1] = g.UV[v * 2 + 1];
    attr[v * 6 + 2] = g.N[v * 3]; attr[v * 6 + 3] = g.N[v * 3 + 1]; attr[v * 6 + 4] = g.N[v * 3 + 2];
    attr[v * 6 + 5] = g.AL[v * 3];
  }
  // the rectangle index is a hard seam: never collapse two maps into one triangle
  const w = [1, 1, 0.3, 0.3, 0.3, 100];
  const flags = permissive ? ['Permissive'] : [];
  let [I] = MeshoptSimplifier.simplifyWithAttributes(g.I, g.P, 3, attr, 6, w, null, tris * 3, error, flags);
  if (I.length / 3 > tris * 1.3) [I] = MeshoptSimplifier.simplifyWithAttributes(g.I, g.P, 3, attr, 6, w, null, tris * 3, error * 4, ['Permissive', 'Prune']);
  return compact(g, I);
}
// a far level keeps a share of the leaves, each scaled up about its own centre so the crown keeps its cover
function thinLeaves(g, keep) {
  const n = g.P.length / 3, parent = new Int32Array(n).map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  // some scans split a leaf into pieces that share only seam positions: join them, or half a leaf could be kept and
  // pulled away from the other by the scaling (millimetres, 17 bits a component: exact within +-65 m)
  const seen = new Map();
  for (let v = 0; v < n; v++) {
    const key = (Math.round(g.P[v * 3] * 1000) + 65536) + (Math.round(g.P[v * 3 + 1] * 1000) + 65536) * 131072 + (Math.round(g.P[v * 3 + 2] * 1000) + 65536) * 17179869184;
    const w = seen.get(key);
    if (w === undefined) seen.set(key, v); else parent[find(v)] = find(w);
  }
  for (let t = 0; t < g.I.length; t += 3) {
    const a = find(g.I[t]), b = find(g.I[t + 1]), c = find(g.I[t + 2]);
    parent[b] = a; parent[find(c)] = a;
  }
  const cx = new Float64Array(n), cy = new Float64Array(n), cz = new Float64Array(n), cn = new Float64Array(n);
  for (let v = 0; v < n; v++) { const r = find(v); cx[r] += g.P[v * 3]; cy[r] += g.P[v * 3 + 1]; cz[r] += g.P[v * 3 + 2]; cn[r]++; }
  const hash = (r) => { let h = Math.imul(r ^ 0x9e3779b9, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
  const s = 1 / Math.sqrt(keep);
  const I = [];
  for (let t = 0; t < g.I.length; t += 3) if (hash(find(g.I[t])) < keep) I.push(g.I[t], g.I[t + 1], g.I[t + 2]);
  const P = g.P.slice();
  for (let v = 0; v < n; v++) {
    const r = find(v);
    if (cn[r] < 2) continue;
    for (const [k, c] of [[0, cx], [1, cy], [2, cz]]) { const m = c[r] / cn[r]; P[v * 3 + k] = m + (g.P[v * 3 + k] - m) * s; }
  }
  return { ...g, P, I: Uint32Array.from(I) };
}

// ---------------------------------------------------------------- atlases
async function decode(tex, factor = [1, 1, 1, 1], tint = null) {
  const img = Buffer.from(tex.getImage());
  const { data, info } = await sharp(img).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const m = [factor[0] * (tint?.[0] ?? 1), factor[1] * (tint?.[1] ?? 1), factor[2] * (tint?.[2] ?? 1)];
  if (m.some((x) => Math.abs(x - 1) > 1e-3)) {
    // factors are linear; the texels are sRGB
    const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4), srgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
    for (let i = 0; i < data.length; i += 4) for (let k = 0; k < 3; k++) data[i + k] = Math.round(Math.min(1, srgb(lin(data[i + k] / 255) * m[k])) * 255);
  }
  return { data, w: info.width, h: info.height };
}
// colour under transparent texels: pulled in from the nearest opaque ones (pull-push over a pyramid), so mip levels
// and filtering never bleed black into a leaf's edge
function bleed(data, w, h) {
  const levels = [{ w, h, c: new Float32Array(w * h * 4) }];
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3] > 8 ? 1 : 0;
    levels[0].c.set([data[i * 4] * a, data[i * 4 + 1] * a, data[i * 4 + 2] * a, a], i * 4);
  }
  while (levels.at(-1).w > 1 || levels.at(-1).h > 1) {
    const p = levels.at(-1), nw = Math.max(1, p.w >> 1), nh = Math.max(1, p.h >> 1), c = new Float32Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const sx = Math.min(p.w - 1, x * 2 + dx), sy = Math.min(p.h - 1, y * 2 + dy);
      for (let k = 0; k < 4; k++) c[(y * nw + x) * 4 + k] += p.c[(sy * p.w + sx) * 4 + k];
    }
    levels.push({ w: nw, h: nh, c });
  }
  // each level's colour: its own where it has any, else its parent's
  let col = null;
  for (let l = levels.length - 1; l >= 0; l--) {
    const p = levels[l], q = levels[l + 1], out = new Float32Array(p.w * p.h * 3);
    for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
      const i = y * p.w + x, a = p.c[i * 4 + 3];
      if (a > 0 || !col) for (let k = 0; k < 3; k++) out[i * 3 + k] = a > 0 ? p.c[i * 4 + k] / a : 0;
      else { const j = Math.min(q.h - 1, y >> 1) * q.w + Math.min(q.w - 1, x >> 1); for (let k = 0; k < 3; k++) out[i * 3 + k] = col[j * 3 + k]; }
    }
    col = out;
  }
  for (let i = 0; i < w * h; i++) if (data[i * 4 + 3] <= 8) for (let k = 0; k < 3; k++) data[i * 4 + k] = Math.round(col[i * 3 + k]);
}
// shelf packing at one scale; returns rects or null
function pack(items, W, H, s, pad) {
  const rects = [];
  const order = items.map((it, i) => ({ it, i, w: Math.max(8, Math.round(Math.min(it.w * s, W - 2 * pad))), h: Math.max(8, Math.round(Math.min(it.h * s, H - 2 * pad))) })).sort((a, b) => b.h - a.h);
  let x = 0, y = 0, rowH = 0;
  for (const o of order) {
    const ww = o.w + 2 * pad, hh = o.h + 2 * pad;
    if (x + ww > W) { x = 0; y += rowH; rowH = 0; }
    if (y + hh > H) return null;
    rects[o.i] = { x: x + pad, y: y + pad, w: o.w, h: o.h };
    x += ww; rowH = Math.max(rowH, hh);
  }
  return rects;
}
async function atlas(mats, size, leaf, tints) {
  // one entry per distinct image pair
  const items = [], slotOf = new Map(), byKey = new Map();
  for (const { mat, wrap } of mats) {
    const ct = mat.getBaseColorTexture(), nt = mat.getNormalTexture();
    const tint = Object.entries(tints || {}).find(([k]) => mat.getName().toLowerCase().includes(k))?.[1] || null;
    const key = createHash('md5').update(Buffer.from(ct.getImage())).update(nt ? Buffer.from(nt.getImage()) : '').update(JSON.stringify([mat.getBaseColorFactor(), tint])).digest('hex');
    if (!byKey.has(key)) {
      byKey.set(key, items.length);
      const sz = ct.getSize();
      items.push({ mat, ct, nt, tint, w: sz[0], h: sz[1], wrap });
    } else if (wrap) items[byKey.get(key)].wrap = true;
    slotOf.set(mat, byKey.get(key));
  }
  const pad = leaf ? 6 : 8;
  let s = 1, rects = null;
  for (; s > 0.01; s *= 0.92) if ((rects = pack(items, size[0], size[1], s, pad))) break;
  const C = Buffer.alloc(size[0] * size[1] * 4), N = Buffer.alloc(size[0] * size[1] * 4);
  for (let i = 0; i < N.length; i += 4) { N[i] = 128; N[i + 1] = 128; N[i + 2] = 255; N[i + 3] = 255; }
  const blit = async (src, dst, r, wrap, alpha) => {
    // the gutter repeats a wrapped map and clamps a leaf's
    const { data } = await sharp(src.data, { raw: { width: src.w, height: src.h, channels: 4 } }).resize(r.w, r.h, { kernel: 'lanczos3', fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
    for (let y = -pad; y < r.h + pad; y++) for (let x = -pad; x < r.w + pad; x++) {
      const sx = wrap ? ((x % r.w) + r.w) % r.w : Math.min(r.w - 1, Math.max(0, x));
      const sy = wrap ? ((y % r.h) + r.h) % r.h : Math.min(r.h - 1, Math.max(0, y));
      const si = (sy * r.w + sx) * 4, di = ((r.y + y) * size[0] + r.x + x) * 4;
      dst[di] = data[si]; dst[di + 1] = data[si + 1]; dst[di + 2] = data[si + 2]; dst[di + 3] = alpha ? data[si + 3] : 255;
    }
  };
  for (const [i, it] of items.entries()) {
    const r = rects[i];
    const alpha = leaf && it.mat.getAlphaMode() !== 'OPAQUE';
    await blit(await decode(it.ct, it.mat.getBaseColorFactor(), it.tint), C, r, it.wrap, alpha);
    if (it.nt) await blit(await decode(it.nt), N, r, it.wrap, false);
  }
  if (leaf) bleed(C, size[0], size[1]);
  const uvRects = items.map((it, i) => [rects[i].x / size[0], rects[i].y / size[1], rects[i].w / size[0], rects[i].h / size[1], it.wrap ? 1 : 0]);
  return { C, N, rects: uvRects, slotOf, scale: s };
}
function encode(buf, w, h, kind, codec, tmp, tag, outW = w, outH = h) {
  const png = `${tmp}/${tag}.png`, out = `${tmp}/${tag}.ktx2`;
  return sharp(buf, { raw: { width: w, height: h, channels: 4 } }).resize(outW, outH, { kernel: 'lanczos3' }).png({ compressionLevel: 1 }).toFile(png).then(() => {
    const args = { color: [], alpha: [], normal: ['-normal_map'] }[kind];
    const enc = codec === 'uastc' ? ['-uastc', '-uastc_level', '2', '-ktx2_zstandard_level', '18'] : ['-q', '255'];
    execFileSync('basisu', ['-ktx2', ...enc, ...args, '-mipmap', '-output_file', out, png], { stdio: 'ignore' });
    return readFileSync(out);
  });
}

// ---------------------------------------------------------------- write
function addMesh(doc, buffer, name, g, mat) {
  const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', g.P))
    .setAttribute('NORMAL', acc('VEC3', g.N))
    .setAttribute('TEXCOORD_0', acc('VEC2', g.UV))
    .setAttribute('_AL', acc('VEC3', g.AL))
    .setAttribute('_AW', acc('VEC4', g.AW))
    .setIndices(acc('SCALAR', g.I))
    .setMaterial(mat);
  const mesh = doc.createMesh(name).addPrimitive(prim);
  return doc.createNode(name).setMesh(mesh);
}
async function writeFlora(file, parts, tex, extras) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();
  const mk = (leaf) => {
    const m = doc.createMaterial(leaf ? 'leaves' : 'wood').setDoubleSided(leaf).setRoughnessFactor(0.8).setMetallicFactor(0);
    const c = doc.createTexture(leaf ? 'leafC' : 'woodC').setImage(tex[leaf ? 'lc' : 'wc']).setMimeType('image/ktx2').setURI(leaf ? 'lc.ktx2' : 'wc.ktx2');
    const n = doc.createTexture(leaf ? 'leafN' : 'woodN').setImage(tex[leaf ? 'ln' : 'wn']).setMimeType('image/ktx2').setURI(leaf ? 'ln.ktx2' : 'wn.ktx2');
    m.setBaseColorTexture(c).setNormalTexture(n);
    if (leaf) m.setAlphaMode('MASK').setAlphaCutoff(0.5);
    return m;
  };
  const mw = mk(false), ml = mk(true);
  for (const [name, g] of Object.entries(parts)) if (g && g.I.length) scene.addChild(addMesh(doc, buffer, name, g, name[0] === 'l' ? ml : mw));
  doc.getRoot().setExtras(extras);
  doc.createExtension(KHRTextureBasisu).setRequired(true);
  doc.createExtension(KHRMeshQuantization).setRequired(true);
  await doc.transform(reorder({ encoder: MeshoptEncoder }), quantize({ pattern: /^(NORMAL|TEXCOORD_0)$/ }));
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  await io.write(file, doc);
  return statSync(file).size / 1e6;
}

const tris = (g) => (g ? g.I.length / 3 : 0);
async function writtenTex(file, atlasHash) {
  if (!process.env.FLORA_REUSE_TEX || !existsSync(file)) return null;
  const doc = await io.read(file);
  if (doc.getRoot().getExtras()?.flora?.atlasHash !== atlasHash) return null;
  const by = Object.fromEntries(doc.getRoot().listTextures().map((t) => [t.getName(), t.getImage()]));
  return by.leafC && by.leafN && by.woodC && by.woodN ? { lc: by.leafC, ln: by.leafN, wc: by.woodC, wn: by.woodN } : null;
}
for (const [name, spec] of Object.entries(SPECIES)) {
  if (only.length && !only.includes(name)) continue;
  const raw = `.cache/sf_full/${spec.src}.glb`;
  if (!existsSync(raw)) { console.log('missing', raw); continue; }
  const t0 = Date.now();
  const doc = await io.read(raw);
  if (doc.getRoot().listExtensionsUsed().some((e) => e.extensionName === 'KHR_materials_pbrSpecularGlossiness')) await doc.transform(metalRough());
  const prims = readPrims(doc, spec);
  place(prims, spec);
  // a map wraps when any of its triangles reach outside 0..1
  const wrapOf = new Map();
  for (const p of prims) {
    let w = wrapOf.get(p.mat) || false;
    for (let i = 0; i < p.UV.length && !w; i++) if (p.UV[i] < -0.02 || p.UV[i] > 1.02) w = true;
    wrapOf.set(p.mat, w);
  }
  const mats = (leaf) => [...new Set(prims.filter((p) => p.leaf === leaf).map((p) => p.mat))].map((mat) => ({ mat, wrap: wrapOf.get(mat) }));
  const LA = spec.atlas ?? (spec.under ? [1024, 1024] : [2048, 2048]), WA = spec.woodAtlas ?? (spec.under ? [512, 1024] : [1024, 2048]);
  const la = await atlas(mats(true), LA, true, spec.tint);
  const wa = await atlas(mats(false), WA, false, spec.tint);
  if (process.env.FLORA_DEBUG) {
    await sharp(la.C, { raw: { width: LA[0], height: LA[1], channels: 4 } }).png().toFile(`.cache/flora_${name}_lc.png`);
    await sharp(wa.C, { raw: { width: WA[0], height: WA[1], channels: 4 } }).png().toFile(`.cache/flora_${name}_wc.png`);
    await sharp(wa.N, { raw: { width: WA[0], height: WA[1], channels: 4 } }).png().toFile(`.cache/flora_${name}_wn.png`);
  }
  const slots = new Map([...la.slotOf, ...wa.slotOf]);
  const wood = merge(prims, false, slots), leaves = merge(prims, true, slots);
  const info = attributes(wood, leaves, spec);
  const rawTris = [tris(wood), tris(leaves)];
  const w0 = simplify(wood, spec.lod0[0], 0.002), l0 = simplify(leaves, spec.lod0[1], 0.003);
  const w1 = simplify(wood, spec.lod1[0], 0.02, true);
  const l1 = simplify(spec.thin ? thinLeaves(leaves, spec.thin) : leaves, spec.lod1[1], 0.02, true);

  const rects = { w: wa.rects, l: la.rects };
  const atlasHash = createHash('sha1').update(la.C).update(la.N).update(wa.C).update(wa.N).update(JSON.stringify([LA, WA, rects])).update(encode.toString()).digest('hex');
  const keptTex = await writtenTex(`${OUT}/${name}.glb`, atlasHash), keptTexM = await writtenTex(`${OUT}/${name}.m.glb`, atlasHash);
  const tmp = mkdtempSync(`${tmpdir()}/flora-`);
  const tex = keptTex || {
    lc: await encode(la.C, LA[0], LA[1], 'alpha', 'uastc', tmp, 'lc'),
    ln: await encode(la.N, LA[0], LA[1], 'normal', 'uastc', tmp, 'ln', LA[0] / 2, LA[1] / 2),
    wc: await encode(wa.C, WA[0], WA[1], 'color', 'uastc', tmp, 'wc'),
    wn: await encode(wa.N, WA[0], WA[1], 'normal', 'uastc', tmp, 'wn', WA[0] / 2, WA[1] / 2),
  };
  const texM = keptTexM || {
    lc: await encode(la.C, LA[0], LA[1], 'alpha', 'etc1s', tmp, 'mlc', LA[0] / 2, LA[1] / 2),
    ln: await encode(la.N, LA[0], LA[1], 'normal', 'uastc', tmp, 'mln', LA[0] / 4, LA[1] / 4),
    wc: await encode(wa.C, WA[0], WA[1], 'color', 'etc1s', tmp, 'mwc', WA[0] / 2, WA[1] / 2),
    wn: await encode(wa.N, WA[0], WA[1], 'normal', 'uastc', tmp, 'mwn', WA[0] / 4, WA[1] / 4),
  };
  rmSync(tmp, { recursive: true, force: true });
  const extras = { flora: { height: info.height, radius: info.radius, palm: !!spec.palm, under: !!spec.under, rects, atlasHash } };
  const mb = await writeFlora(`${OUT}/${name}.glb`, { w0, l0, w1, l1 }, tex, extras);
  // phones: the far level near, and a lighter one again far
  const w1m = simplify(wood, spec.lod1[0] * 0.5, 0.04, true), l1m = simplify(spec.thin ? thinLeaves(leaves, spec.thin * 0.6) : leaves, spec.lod1[1] * 0.5, 0.04, true);
  const mmb = await writeFlora(`${OUT}/${name}.m.glb`, { w0: w1, l0: l1, w1: w1m, l1: l1m }, texM, extras);
  console.log(name.padEnd(10), `raw ${rawTris.join('+')} -> lod0 ${tris(w0)}+${tris(l0)} lod1 ${tris(w1)}+${tris(l1)} | h ${info.height.toFixed(1)} r ${info.radius.toFixed(1)} | atlas scale l ${la.scale.toFixed(2)} w ${wa.scale.toFixed(2)} | ${mb.toFixed(2)} MB, mobile ${mmb.toFixed(2)} MB | ${keptTex && keptTexM ? 'atlases kept | ' : ''}${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
