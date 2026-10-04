// Sketchfab downloads (.cache/sf_full, full-resolution gltf archives) -> web-ready models in public/assets/models.
// For each model:  <name>.glb    desktop: full detail (or a visually lossless cut for scans far denser than pixels), webp textures
//                  <name>.m.glb  phones: same geometry budget scaled down, 1K textures
//                  <name>.lodN.glb geometry only; materials are matched by name to <name>.glb at runtime
// usage: node scripts/models.mjs [name...]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRTextureBasisu } from '@gltf-transform/extensions';
import { metalRough, flatten, join, weld, simplify, dedup, prune, reorder, quantize, cloneDocument, resample, compactPrimitive } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { mkdirSync, mkdtempSync, statSync, existsSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const RAW = '.cache/sf_full', OUT = 'public/assets/models';
// Texture size follows texel density: at the closest the camera usually gets to a model (near, m), a 3840 px wide frame
// spends about 2000/near px per metre. Each map is cut to that density over the surface it covers (span: the model's
// largest dimension in the scene, m), never past tex. A kit of small props with a 2K set each comes out near 512;
// a house atlas spread over 30 m of walls keeps its 4K.
// src: raw file; keep: fraction of vertices for LOD0, only where the
// scan is far denser than the pixels it can cover; lods: [ratio, error] per far level; drop: node-name prefixes to delete
// (colour checkers, ground patches, dangling feet); rough: roughness for scans that came unlit; skin: rigged, never joined
const MODELS = {
  whale: { src: 'whale_k', span: 14, near: 5 },
  dolphin: { src: 'dolphin_full', span: 2.6, near: 2.5, skin: true },
  turtle: { src: 'turtle_full', span: 1.1, near: 1.2, skin: true },
  manta: { src: 'manta_fb', span: 3.6, near: 2.5 },
  shark: { src: 'shark_np', span: 1.6, near: 2, skin: true },
  gull: { src: 'gull_ff', span: 0.85, near: 2, drop: ['feet_'], lods: [[0.25, 0.02], [0.06, 0.08]] },
  crab: { src: 'fwcrab', span: 0.13, near: 0.4, skin: true },
  // reef fish part around a swimmer, so they are seldom nearer than a metre
  fusilier: { src: 'fusilier', span: 0.26, near: 1.2, drop: ['Object_4'], rough: 0.4, keep: 0.045, lods: [[0.02, 0.02], [0.007, 0.05], [0.0016, 0.2]] },
  goatfish: { src: 'goatfish', span: 0.3, near: 1.2, drop: ['Object_4'], rough: 0.45, keep: 0.028, lods: [[0.012, 0.02], [0.004, 0.05], [0.001, 0.2]] },
  parrotfish: { src: 'parrot_steep', span: 0.5, near: 1.2, drop: ['Object_4'], rough: 0.5, keep: 0.03, lods: [[0.01, 0.02], [0.004, 0.05], [0.001, 0.2]] },
  angelfish: { src: 'angelfish', span: 0.22, near: 1.2, drop: ['Object_4'], rough: 0.45, keep: 0.045, lods: [[0.02, 0.02], [0.007, 0.05], [0.0016, 0.2]] },
  // buildings and the dhow keep every triangle near; far levels so the village and its shadows cost little from afar
  house: { src: 'stilt2', span: 12.5, near: 1.2, lods: [[0.2, 0.01], [0.05, 0.04]] },
  shack: { src: 'shack', span: 5, near: 1.2, lods: [[0.25, 0.01], [0.06, 0.04]] },
  lighthouse: { src: 'light_brick', span: 24, near: 2 },
  // fifteen props with a 2K PBR set each: 1K (500-750 px/m, a third-person standard) is the budget for a side prop
  kiosk: { src: 'kiosk', span: 3, near: 1, tex: 1024, lods: [[0.25, 0.01], [0.06, 0.04]] },
  dhow: { src: 'dhow', span: 7.5, near: 1.2, lods: [[0.12, 0.004], [0.03, 0.015], [0.006, 0.05]] },
  skiff: { src: 'fishboat', span: 5, near: 1.2 },
  dinghy: { src: 'oldboat', span: 4.2, near: 1.2 },
  rowboat: { src: 'rowboat', span: 4, near: 1.2 },
  // reef corals, swum past at arm's length: real scan detail near, four levels out to where the water swallows them
  coral_pocillopora: { src: 'c_pocillopora', span: 0.6, near: 0.8, keep: 0.07, lods: [[0.007, 0.02], [0.0015, 0.06], [0.0004, 0.15]] },
  coral_brain: { src: 'c_brain', span: 1.5, near: 0.8, drop: ['Object_2', 'Object_3'], keep: 0.27, lods: [[0.027, 0.02], [0.006, 0.06], [0.0015, 0.15]] },
  coral_rock: { src: 'c_okinawa', span: 3, near: 0.8, rough: 0.85, keep: 0.15, lods: [[0.015, 0.02], [0.003, 0.06], [0.0008, 0.15]] },
  coral_porites: { src: 'c_porites', span: 3.4, near: 0.8, drop: ['Object_2'], keep: 0.14, lods: [[0.014, 0.02], [0.003, 0.06], [0.0008, 0.15]] },
  coral_staghorn: { src: 'c_staghorn', span: 1.4, near: 0.8, keep: 0.077, lods: [[0.008, 0.02], [0.0016, 0.06], [0.0004, 0.15]] },
  // thousands of finger-thin branchlets: fewer than ~60 triangles each turns them to crystals
  // (and the next level still has to carry them from 3 m, so it steps down gently)
  coral_acropora: { src: 'c_acropora', span: 1.7, near: 0.8, keep: 0.36, lods: [[0.09, 0.01], [0.018, 0.04], [0.003, 0.12]] },
};
const MAX_TEX = 4096;
// every build ships 1K maps; larger ones stream from hd/ on desktop
const BASE_TEX = 1024;

const only = process.argv.slice(2);
mkdirSync(`${OUT}/hd`, { recursive: true });
await MeshoptSimplifier.ready;
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

const tris = (doc) => {
  let t = 0;
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) { const i = p.getIndices(); t += (i ? i.getCount() : p.getAttribute('POSITION').getCount()) / 3; }
  return Math.round(t);
};
const shrink = (ratio, error) => simplify({ simplifier: MeshoptSimplifier, ratio, error });
// Photogrammetry atlases cut a scan into thousands of UV islands. Collapses stay inside them, so no triangle spans two
// islands and drags a stripe of the atlas across its face. Only a far level that cannot get near its budget that way
// is let through the seams (Permissive), and past that may ignore topology (sloppy).
const shrinkScan = (ratio, error, far = false) => (doc) => {
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION'), uv = prim.getAttribute('TEXCOORD_0'), nor = prim.getAttribute('NORMAL'), idx = prim.getIndices();
    if (!idx || !uv) continue;
    const n = pos.getCount(), attr = new Float32Array(n * 5), el = [];
    for (let i = 0; i < n; i++) {
      uv.getElement(i, el); attr[i * 5] = el[0]; attr[i * 5 + 1] = el[1];
      if (nor) { nor.getElement(i, el); attr[i * 5 + 2] = el[0]; attr[i * 5 + 3] = el[1]; attr[i * 5 + 4] = el[2]; }
    }
    const P = new Float32Array(pos.getArray()), I = new Uint32Array(idx.getArray());
    const target = Math.floor((I.length * ratio) / 3) * 3;
    let [out] = MeshoptSimplifier.simplifyWithAttributes(I, P, 3, attr, 5, [1.5, 1.5, 0.25, 0.25, 0.25], null, target, error, ['Prune']);
    if (far && out.length > target * 1.4) [out] = MeshoptSimplifier.simplifyWithAttributes(I, P, 3, attr, 5, [1.5, 1.5, 0.25, 0.25, 0.25], null, target, error, ['Permissive', 'Prune']);
    if (far && out.length > target * 1.5) [out] = MeshoptSimplifier.simplifySloppy(out, P, 3, null, target, error);
    // a piece smaller than the error (a rope end, a cleat) can vanish whole
    if (!out.length) { prim.dispose(); continue; }
    idx.setArray(out);
    compactPrimitive(prim);
  }
  for (const mesh of doc.getRoot().listMeshes()) if (!mesh.listPrimitives().length) mesh.dispose();
};
// Every texture ships as KTX2: the GPU keeps it block-compressed (BC7 or ASTC, a quarter of RGBA8) and it uploads
// without a decode on the main thread. Before encoding, a texture steps down a level only while the half-size map,
// magnified back the way the GPU samples it, still matches the original (PSNR >= minDb): flat paint and empty
// emissive masks stop costing 4K, real detail keeps every texel.
const COLOR_SLOTS = new Set(['baseColorTexture', 'emissiveTexture', 'specularColorTexture']);
// The texels a map's triangles actually cover, rasterised from their UVs and grown by 2 px for filtering. Atlas
// padding and the hard edges of UV islands are never seen, so they must not decide a map's size.
function coverage(doc, t, w, h, scale) {
  const mask = new Uint8Array(w * h);
  const mats = new Set(doc.getGraph().listParentEdges(t).map((e) => e.getParent()).filter((p) => p.propertyType === 'Material'));
  const uv = [], P = [], e = [];
  let uvArea = 0, worldArea = 0, wraps = false;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const M = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
    if (!mats.has(prim.getMaterial())) continue;
    const a = prim.getAttribute('TEXCOORD_0'), pos = prim.getAttribute('POSITION'), idx = prim.getIndices();
    if (!a) continue;
    const n = a.getCount();
    for (let i = 0; i < n; i++) {
      a.getElement(i, e);
      if (e[0] < -0.01 || e[0] > 1.01 || e[1] < -0.01 || e[1] > 1.01) wraps = true;
      uv[i * 2] = e[0] * w - 0.5; uv[i * 2 + 1] = e[1] * h - 0.5;
      pos.getElement(i, e);
      for (let k = 0; k < 3; k++) P[i * 3 + k] = (M[k] * e[0] + M[4 + k] * e[1] + M[8 + k] * e[2] + M[12 + k]) * scale;
    }
    const I = idx ? idx.getArray() : Array.from({ length: n }, (_, i) => i);
    for (let f = 0; f < I.length; f += 3) {
      const ia = I[f] * 3, ib = I[f + 1] * 3, ic = I[f + 2] * 3;
      const ux = P[ib] - P[ia], uy = P[ib + 1] - P[ia + 1], uz = P[ib + 2] - P[ia + 2], vx = P[ic] - P[ia], vy = P[ic + 1] - P[ia + 1], vz = P[ic + 2] - P[ia + 2];
      worldArea += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      const ax = uv[I[f] * 2], ay = uv[I[f] * 2 + 1], bx = uv[I[f + 1] * 2], by = uv[I[f + 1] * 2 + 1], cx = uv[I[f + 2] * 2], cy = uv[I[f + 2] * 2 + 1];
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      uvArea += Math.abs(area) * 0.5;
      if (wraps) continue;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
      if (Math.abs(area) < 1e-9) { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) mask[y * w + x] = 1; continue; }
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const l0 = ((bx - x) * (cy - y) - (by - y) * (cx - x)) / area, l1 = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) / area;
        if (l0 >= -0.02 && l1 >= -0.02 && 1 - l0 - l1 >= -0.02) mask[y * w + x] = 1;
      }
    }
    }
  }
  // texels per metre of surface at this size
  const dens = Math.sqrt(uvArea / Math.max(worldArea, 1e-9));
  if (wraps) return { mask: mask.fill(1), dens };
  for (let pass = 0; pass < 2; pass++) {
    const m = mask.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!m[y * w + x] && ((x > 0 && m[y * w + x - 1]) || (x < w - 1 && m[y * w + x + 1]) || (y > 0 && m[(y - 1) * w + x]) || (y < h - 1 && m[(y + 1) * w + x]))) mask[y * w + x] = 1;
  }
  return { mask, dens };
}

// Error of a smaller map magnified back to the reference size the way the GPU samples it, over the covered texels.
// A flat map with one small detailed patch (an eye, a name board) averages out fine, so the worst 0.5% of 32 px
// blocks is held to the bar too.
async function fidelity(ref, w0, h0, small, w, h, ch, mask) {
  const up = await sharp(small, { raw: { width: w, height: h, channels: ch } }).resize(w0, h0, { kernel: 'linear' }).raw().toBuffer();
  const B = 32, bw = Math.ceil(w0 / B), bh = Math.ceil(h0 / B), blk = new Float64Array(bw * bh), cnt = new Float64Array(bw * bh);
  let se = 0, n = 0;
  for (let y = 0; y < h0; y++) for (let x = 0; x < w0; x++) {
    if (!mask[y * w0 + x]) continue;
    const b = Math.floor(y / B) * bw + Math.floor(x / B);
    for (let c = 0, i = (y * w0 + x) * ch; c < ch; c++, i++) { const d = ref[i] - up[i]; se += d * d; blk[b] += d * d; cnt[b]++; n++; }
  }
  if (!n) return 99;
  const db = (mse) => 10 * Math.log10((255 * 255) / Math.max(mse, 1e-9));
  const full = B * B * ch * 0.25;
  const errs = Array.from(blk, (v, i) => (cnt[i] >= full ? v / cnt[i] : 0)).sort((a, b) => b - a);
  const used = errs.filter((v, i) => cnt[i] >= full).length || 1;
  return Math.min(db(se / n), db(errs[Math.floor(used * 0.005)]) + 4);
}
const kindOf = (doc, t) => {
  const slots = new Set(doc.getGraph().listParentEdges(t).map((e) => e.getName()));
  return slots.has('normalTexture') ? 'normal' : [...slots].some((x) => COLOR_SLOTS.has(x)) ? 'color' : 'linear';
};
// metres per model unit, from the model's largest dimension and its span in the scene
function modelScale(doc, span) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], e = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const M = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, e);
        for (let k = 0; k < 3; k++) { const v = M[k] * e[0] + M[4 + k] * e[1] + M[8 + k] * e[2] + M[12 + k]; mn[k] = Math.min(mn[k], v); mx[k] = Math.max(mx[k], v); }
      }
    }
  }
  return span / Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
}
async function encodeTex(doc, t, kind, cap, tmp, tag, { codec = 'uastc', scale = 1, need = 1e9, minDb = 42, minSize = 256 } = {}) {
  const img = Buffer.from(t.getImage());
  const meta = await sharp(img).metadata();
  const ch = meta.hasAlpha ? 4 : 3;
  const get = (w, h) => { const p = sharp(img).resize(w, h, { kernel: 'lanczos3' }).toColourspace('srgb'); return (ch === 4 ? p.ensureAlpha() : p.removeAlpha()).raw().toBuffer(); };
  // colour carries the detail you notice up close; normals and ORM stop paying off past 2K
  const lim = kind === 'color' ? cap : Math.min(cap, 2048);
  const k = Math.min(1, lim / Math.max(meta.width, meta.height));
  let w0 = Math.max(4, Math.round((meta.width * k) / 4) * 4), h0 = Math.max(4, Math.round((meta.height * k) / 4) * 4);
  let { mask, dens } = coverage(doc, t, w0, h0, scale);
  if (process.env.FID_DEBUG) console.log('  dens', tag, `${w0}x${h0}`, 'scale', scale.toFixed(4), 'dens', dens.toFixed(0), 'need', need.toFixed(0));
  // no more texels per metre than the closest view can show, rounded up to a power of two
  if (dens > need) {
    const f = 2 ** Math.ceil(Math.log2(need / dens));
    if (f < 1) {
      w0 = Math.max(4, Math.round((w0 * f) / 4) * 4); h0 = Math.max(4, Math.round((h0 * f) / 4) * 4);
      ({ mask } = coverage(doc, t, w0, h0, scale));
    }
  }
  const ref = await get(w0, h0);
  let w = w0, h = h0, buf = ref;
  while (Math.max(w, h) > minSize) {
    const cw = Math.max(4, w >> 1), cht = Math.max(4, h >> 1), cand = await get(cw, cht);
    const fd = await fidelity(ref, w0, h0, cand, cw, cht, ch, mask);
    if (process.env.FID_DEBUG) console.log('  fid', tag, kind, `${w0}x${h0} -> ${cw}x${cht}`, fd.toFixed(1), 'cover', (mask.reduce((a, b) => a + b, 0) / mask.length).toFixed(3));
    if (fd < (kind === 'color' ? minDb : minDb - 2)) break;
    w = cw; h = cht; buf = cand;
  }
  const png = `${tmp}/${tag}.png`, out = `${tmp}/${tag}.ktx2`;
  await sharp(buf, { raw: { width: w, height: h, channels: ch } }).png({ compressionLevel: 1 }).toFile(png);
  // UASTC is near lossless (BC7 / ASTC on the GPU). ETC1S is a fifth of the size and smears fine grain, so it only
  // serves maps seen from afar. No RDO: on scan textures it saves under 5% of the file for a visible loss.
  const args = { color: [], normal: ['-normal_map'], linear: ['-linear'] }[kind];
  const enc = codec === 'uastc' ? ['-uastc', '-uastc_level', '2', '-ktx2_zstandard_level', '18'] : ['-q', '255'];
  execFileSync('basisu', ['-ktx2', ...enc, ...args, '-mipmap', '-output_file', out, png], { stdio: 'ignore' });
  return { data: readFileSync(out), w, h };
}

// far levels carry no textures but keep their UVs: at runtime they wear the level-0 materials
async function write(doc, file, keepAttributes = false) {
  await doc.transform(dedup(), prune({ keepAttributes }), reorder({ encoder: MeshoptEncoder }), quantize());
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  await io.write(file, doc);
  return (statSync(file).size / 1e6).toFixed(2);
}

for (const [name, o] of Object.entries(MODELS)) {
  if (only.length && !only.includes(name)) continue;
  const rawFile = `${RAW}/${o.src}.glb`;
  if (!existsSync(rawFile)) { console.log('missing', rawFile); continue; }
  const base = await io.read(rawFile);
  const root = base.getRoot();
  for (const n of root.listNodes()) if (o.drop?.some((d) => n.getName().startsWith(d))) { n.getMesh()?.dispose(); n.dispose(); }
  const used = root.listExtensionsUsed().map((e) => e.extensionName);
  if (used.includes('KHR_materials_pbrSpecularGlossiness')) await base.transform(metalRough());
  const unlit = root.listExtensionsUsed().find((e) => e.extensionName === 'KHR_materials_unlit');
  if (unlit) {
    unlit.dispose();
    for (const m of root.listMaterials()) m.setMetallicFactor(0).setRoughnessFactor(o.rough ?? 0.6);
  }
  root.listMaterials().forEach((m, i) => m.setName(`m${i}_${m.getName() || ''}`.slice(0, 48)));
  const raw = tris(base);
  if (!o.skin) await base.transform(flatten(), join({ keepNamed: false }));
  await base.transform(weld(), resample());

  const reduce = o.keep ? shrinkScan : shrink;
  const desk = cloneDocument(base);
  const mob = cloneDocument(base);
  if (o.keep) await desk.transform(reduce(o.keep, 0.004));
  // phones: half the triangles, through UV seams if need be; a small screen hides the smear
  if (o.keep || o.lods) await mob.transform(reduce((o.keep ?? 1) * 0.5, 0.01, true));

  // Both builds carry the base maps. Larger maps go to hd/ and are listed in the model's extras: the page streams
  // them in when the camera nears the model, so the first view loads fast and close-ups still get every texel.
  const tmp = mkdtempSync(`${tmpdir()}/ktx-`);
  for (const f of readdirSync(`${OUT}/hd`)) if (f.startsWith(`${name}.t`)) rmSync(`${OUT}/hd/${f}`);
  // Every model loads with its far maps: ETC1S colour and ORM up to 1K (a fifth of UASTC, and its smearing is lost
  // with distance) and UASTC normals up to 512 (ETC1S breaks normals up). The full UASTC maps, cut to texel density,
  // stream in near. Phones keep the far maps.
  const hd = [], mobTex = mob.getRoot().listTextures();
  const opt = { scale: modelScale(desk, o.span), need: 2000 / (o.near ?? 1.5) };
  for (const [i, t] of desk.getRoot().listTextures().entries()) {
    const kind = kindOf(desk, t);
    const full = await encodeTex(desk, t, kind, o.tex ?? MAX_TEX, tmp, `${i}hi`, opt);
    const far = kind === 'normal' ? await encodeTex(desk, t, kind, BASE_TEX >> 1, tmp, `${i}n`, opt) : await encodeTex(desk, t, kind, BASE_TEX, tmp, `${i}e`, { ...opt, codec: 'etc1s' });
    if (kind !== 'normal' || full.w > far.w) {
      writeFileSync(`${OUT}/hd/${name}.t${i}.ktx2`, full.data);
      hd.push({ name: `t${i}`, file: `hd/${name}.t${i}.ktx2`, size: [full.w, full.h] });
    }
    for (const d of [t, mobTex[i]]) d.setImage(far.data).setMimeType('image/ktx2').setURI(`t${i}.ktx2`).setName(`t${i}`);
  }
  rmSync(tmp, { recursive: true, force: true });
  for (const d of [desk, mob]) d.createExtension(KHRTextureBasisu).setRequired(true);
  desk.getRoot().setExtras({ hd });
  const t0 = tris(desk);
  const mb = await write(desk, `${OUT}/${name}.glb`);
  const mmb = await write(mob, `${OUT}/${name}.m.glb`);
  const hdMb = hd.reduce((a, h) => a + statSync(`${OUT}/${h.file}`).size, 0) / 1e6;

  const lodInfo = [];
  for (const [i, [ratio, error]] of (o.lods || []).entries()) {
    let d = cloneDocument(base);
    for (const t of d.getRoot().listTextures()) t.dispose();
    await d.transform(o.keep ? shrinkScan(ratio, error, true) : shrink(ratio, error));
    // a modelled prop in many separate pieces (planks, ropes) stalls at their open edges: a far level may close them
    if (!o.keep && tris(d) > raw * ratio * 1.5) {
      d = cloneDocument(base);
      for (const t of d.getRoot().listTextures()) t.dispose();
      await d.transform(shrinkScan(ratio, error, true));
    }
    lodInfo.push(`lod${i + 1} ${tris(d)} ${await write(d, `${OUT}/${name}.lod${i + 1}.glb`, true)}MB`);
  }
  console.log(name.padEnd(17), 'raw', String(raw).padStart(8), '->', String(t0).padStart(7), 'tris', mb.padStart(6), 'MB | mobile', mmb, 'MB | hd', hdMb.toFixed(2), 'MB', hd.map((h) => h.size.join('x')).join(' '), '|', lodInfo.join(' | '));
}
