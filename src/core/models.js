// glTF models (processed by scripts/models.mjs): loading, normalising to metres, baking into instanced or merged meshes.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// model textures are KTX2 (UASTC), transcoded to whichever block format this GPU samples natively
const ktx2 = new KTX2Loader().setTranscoderPath('./basis/');
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2);
let gpu = null;
export const initModels = (renderer) => { gpu = renderer; return ktx2.detectSupport(renderer); };
const cache = new Map();
// phones get each model's 1K-texture build; far levels (<name>.lodN) are geometry only and shared by both
export const MOBILE = matchMedia('(pointer: coarse)').matches;
export const loadModel = (name) => {
  const file = MOBILE && !name.includes('.lod') ? `${name}.m` : name;
  if (!cache.has(file)) cache.set(file, loader.loadAsync(`./assets/models/${file}.glb`).then((g) => (MOBILE || registerHd(g), g)));
  return cache.get(file);
};
// plants built by scripts/flora.mjs: atlases and both levels of detail in one file
export const loadFlora = (name) => {
  const file = MOBILE ? `${name}.m` : name;
  if (!cache.has('flora/' + file)) cache.set('flora/' + file, loader.loadAsync(`./assets/flora/${file}.glb`));
  return cache.get('flora/' + file);
};

// ---- texture streaming: every model loads with 1K maps; its larger maps (listed in extras.hd) come in when the
// camera gets near something wearing them, closest first, one model at a time
const SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'specularIntensityMap', 'specularColorMap'];
const hdSets = [];
function registerHd(g) {
  const hd = g.parser.json.extras?.hd;
  if (!hd?.length) return;
  const byName = new Map();
  g.scene.traverse((o) => { for (const m of o.material ? [o.material].flat() : []) for (const k of SLOTS) if (m[k]?.name) byName.set(m[k].name, m[k]); });
  const items = hd.map((h) => ({ ...h, low: byName.get(h.name) })).filter((h) => h.low);
  if (items.length) hdSets.push({ items, lows: new Set(items.map((h) => h.low)), root: g.scene, state: 0 });
}
const _sph = new THREE.Sphere();
let hdBusy = false, hdNext = 0;
// distance from the camera to the nearest mesh that wears one of the set's textures, less the reach where 1K stops
// being enough (about three of its own sizes, plus room to load while the camera keeps coming)
// (the meshes are found once: the world is built before the first frame, and a walk of the whole scene for every set,
// twice a second, is garbage the frame loop pays for)
function hdReach(set, scene, cam) {
  if (!set.meshes) {
    set.meshes = [];
    scene.traverse((o) => { if (o.isMesh && [o.material].flat().some((m) => SLOTS.some((k) => set.lows.has(m[k])))) set.meshes.push(o); });
  }
  let best = Infinity;
  for (const o of set.meshes) {
    if (!o.visible) continue;
    if (o.isInstancedMesh || o.geometry.isInstancedBufferGeometry) {
      // instanced reef life: its near levels only hold instances close enough to want the full maps
      if (o.userData.near && (o.isInstancedMesh ? o.count : o.geometry.instanceCount) > 0) best = Math.min(best, -1);
      continue;
    }
    const g = o.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    _sph.copy(g.boundingSphere).applyMatrix4(o.matrixWorld);
    best = Math.min(best, cam.position.distanceTo(_sph.center) - _sph.radius * 7 - 15);
  }
  return best;
}
// A 4K map is some 20 MB of blocks, and going up whole it holds its frame for tens of milliseconds. So its storage is
// allocated first (three sends no data while the source is not dataReady), then its block rows follow a couple of
// megabytes a frame, bound through three's own state so its record of bound textures stays true. Formats with 16-byte
// 4x4 blocks only (ASTC 4x4, BPTC); smaller maps and other formats go up whole, one a frame.
const STRIP = 2 << 20;
function* uploadSteps(tex) {
  const gl = gpu.getContext(), srgb = THREE.ColorManagement.getTransfer(tex.colorSpace) === THREE.SRGBTransfer;
  const fmt = tex.format === THREE.RGBA_ASTC_4x4_Format ? (srgb ? 0x93d0 : 0x93b0) : tex.format === THREE.RGBA_BPTC_Format ? (srgb ? 0x8e8d : 0x8e8c) : 0;
  if (!fmt || !tex.mipmaps?.length || tex.mipmaps[0].width < 2048) {
    gpu.initTexture(tex);
    yield;
    return;
  }
  tex.source.dataReady = false;
  gpu.initTexture(tex);
  const glTex = gpu.properties.get(tex).__webglTexture;
  for (const [level, m] of tex.mipmaps.entries()) {
    const rowBytes = Math.ceil(m.width / 4) * 16, blockRows = Math.ceil(m.height / 4);
    const per = Math.max(1, Math.floor(STRIP / rowBytes));
    for (let by = 0; by < blockRows; by += per) {
      const n = Math.min(per, blockRows - by);
      gpu.state.bindTexture(gl.TEXTURE_2D, glTex);
      gl.compressedTexSubImage2D(gl.TEXTURE_2D, level, 0, by * 4, m.width, Math.min(n * 4, m.height - by * 4), fmt, m.data.subarray(by * rowBytes, (by + n) * rowBytes));
      // the small levels share a frame
      if (rowBytes * n > STRIP / 4) yield;
    }
  }
  tex.source.dataReady = true;
  yield;
}
export function streamHd(scene, camera, time) {
  if (MOBILE || hdBusy || time < hdNext) return;
  hdNext = time + 0.5;
  let pick = null, pickD = 0;
  for (const set of hdSets) {
    if (set.state) continue;
    const d = hdReach(set, scene, camera);
    if (d < 0 && (!pick || d < pickD)) { pick = set; pickD = d; }
  }
  if (!pick) return;
  pick.state = 1; hdBusy = true;
  Promise.all(pick.items.map((h) => ktx2.loadAsync(`./assets/models/${h.file}`).then((t) => {
    const low = h.low;
    Object.assign(t, { colorSpace: low.colorSpace, wrapS: low.wrapS, wrapT: low.wrapT, anisotropy: low.anisotropy, channel: low.channel, flipY: low.flipY });
    t.name = low.name;
    return [low, t];
  }))).then((pairs) => new Promise((done) => {
    // up to the GPU a little each frame, and only then the swap: a set landing in one frame stacks every upload there
    const steps = (function* () { for (const [, t] of pairs) yield* uploadSteps(t); })();
    const next = () => (steps.next().done ? done(pairs) : requestAnimationFrame(next));
    requestAnimationFrame(next);
  })).then((pairs) => {
    const swap = new Map(pairs);
    // every material that wears a low map takes the full one: the clones made for patched shaders in the world, and
    // the model's own, which later clones copy
    for (const root of [scene, pick.root]) root.traverse((o) => { for (const m of o.material ? [o.material].flat() : []) for (const k of SLOTS) if (swap.has(m[k])) m[k] = swap.get(m[k]); });
    for (const low of swap.keys()) low.dispose();
  }).catch((e) => console.warn('[ha] hd textures', e)).finally(() => { hdBusy = false; });
}

// quantized attributes cannot take a baked transform; expand to float first
export function toFloat(g) {
  for (const name of ['position', 'normal', 'uv', 'tangent']) {
    const a = g.attributes[name];
    if (!a || (a.array instanceof Float32Array && !a.isInterleavedBufferAttribute)) continue;
    const out = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = a.getComponent(i, c);
    g.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize));
  }
  return g;
}

/**
 * Static model as parts: one geometry per material, in metres, base on y = 0, centred in x/z, facing +z.
 * fit: { width | height | length } target size; yaw: extra turn so the model's front faces +z.
 */
export async function modelParts(name, { width, height, length, yaw = 0, matrix } = {}) {
  const g = await loadModel(name);
  const root = g.scene;
  root.updateMatrixWorld(true);
  const byMat = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const geo = toFloat(o.geometry.clone()).applyMatrix4(o.matrixWorld);
    for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    const m = o.material;
    if (!byMat.has(m)) byMat.set(m, []);
    byMat.get(m).push(geo);
  });
  const parts = [...byMat].map(([mat, geos]) => ({ mat, geo: geos.length > 1 ? mergeGeometries(geos, false) : geos[0] }));
  const box = new THREE.Box3();
  for (const p of parts) { p.geo.computeBoundingBox(); box.union(p.geo.boundingBox); }
  const size = box.getSize(new THREE.Vector3());
  const k = width ? width / size.x : height ? height / size.y : length ? length / size.z : 1;
  const M = matrix || new THREE.Matrix4().makeRotationY(yaw).multiply(new THREE.Matrix4().makeScale(k, k, k)).multiply(new THREE.Matrix4().makeTranslation(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2));
  for (const p of parts) { p.geo.applyMatrix4(M); p.geo.computeBoundingBox(); p.geo.computeBoundingSphere(); }
  return { parts, height: size.y * k, scale: k, matrix: M };
}

// level 0 plus n far levels: each far level's geometry placed exactly like level 0 and wearing level 0's materials
export async function modelLods(name, fit, n) {
  const l0 = await modelParts(name, fit);
  const byName = new Map(l0.parts.map((p) => [p.mat.name, p.mat]));
  const levels = [l0.parts];
  for (let i = 1; i <= n; i++) {
    const li = await modelParts(`${name}.lod${i}`, { matrix: l0.matrix });
    levels.push(li.parts.map((p) => ({ mat: byName.get(p.mat.name) || l0.parts[0].mat, geo: p.geo })));
  }
  return { ...l0, levels };
}

// merge several placements of the same parts into one mesh per material (static, few instances, per-placement edits)
export function bakeParts(parts, placements, edit) {
  return parts.map(({ mat, geo }) => {
    const geos = placements.map((pl, i) => {
      const g = geo.clone();
      if (edit) edit(g, pl, i);
      return g.applyMatrix4(pl.matrix);
    });
    const m = new THREE.Mesh(mergeGeometries(geos, false), mat);
    m.castShadow = m.receiveShadow = true;
    return m;
  });
}

// one THREE.LOD per placement, at the placement's own position so the switch distances are measured from it; the
// shadow pass draws whichever level the camera picked, so a far building costs its far geometry twice, not its full one
export function lodParts(levels, placements, dists, edit) {
  const pos = new THREE.Vector3();
  return placements.map((pl, i) => {
    const lod = new THREE.LOD();
    pos.setFromMatrixPosition(pl.matrix);
    lod.position.copy(pos);
    levels.forEach((parts, li) => {
      const g = new THREE.Group();
      for (const { mat, geo } of parts) {
        const gg = geo.clone();
        if (edit) edit(gg, pl, i);
        gg.applyMatrix4(pl.matrix).translate(-pos.x, -pos.y, -pos.z);
        gg.computeBoundingSphere();
        const m = new THREE.Mesh(gg, mat);
        m.castShadow = m.receiveShadow = true;
        g.add(m);
      }
      lod.addLevel(g, dists[li], 0.08);
    });
    return lod;
  });
}

export function instanceParts(parts, matrices) {
  return parts.map(({ mat, geo }) => {
    const m = new THREE.InstancedMesh(geo, mat, matrices.length);
    matrices.forEach((M, i) => m.setMatrixAt(i, M));
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
    m.castShadow = m.receiveShadow = true;
    return m;
  });
}

export const placeMatrix = (x, y, z, yaw = 0, s = 1) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(s, s, s));
