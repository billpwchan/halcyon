// Living coral on the lagoon heads, the back-reef and the reef crest: photogrammetry scans of six species, instanced.
// Each colony draws at the detail its own distance asks for; the reef is cut into cells only to skip, in one test, the
// stretches past what the water and the distance let you see, which are left to the terrain's coral colouring.
import * as THREE from 'three';
import { patch } from '../core/shared.js';
import { modelLods, MOBILE } from '../core/models.js';
import { HF } from './layout.js';

// span: colony width (m); core: massive heads that anchor a cluster; solid: a diver cannot slip between its parts;
// tilt: how far it leans into the slope; shallow / deep: relative abundance above and below 3 m; tint: living colour
// over the scan's; hues: the shades a colony may take
const SPECIES = [
  { name: 'coral_porites', span: [1.8, 3.4], core: true, solid: true, tilt: 0.6, shallow: 1, deep: 1.3, hues: [[1, 1, 1], [1.1, 0.95, 0.8], [0.85, 0.97, 0.9]] },
  { name: 'coral_rock', span: [1.6, 3.0], core: true, solid: true, tilt: 0.7, shallow: 1, deep: 1, hues: [[1, 1, 1], [1.05, 0.95, 1], [0.92, 1, 0.95]] },
  // the brain scan is a bleached skeleton's grey-blue; living Platygyra is tan to olive
  { name: 'coral_brain', span: [0.6, 1.5], solid: true, tilt: 0.5, shallow: 0.1, deep: 0.18, tint: [1.3, 1.02, 0.55], hues: [[1, 1, 1], [0.82, 1.05, 0.78], [1.06, 0.88, 0.86]] },
  { name: 'coral_acropora', span: [0.8, 1.7], tilt: 0.25, shallow: 0.35, deep: 0.22, hues: [[1, 1, 1], [1.12, 1, 0.74], [0.82, 0.92, 1.06]] },
  { name: 'coral_staghorn', span: [0.7, 1.4], tilt: 0.3, shallow: 0.22, deep: 0.3, hues: [[1, 1, 1], [0.88, 1, 0.84], [1.1, 0.94, 0.9]] },
  { name: 'coral_pocillopora', span: [0.3, 0.6], tilt: 0.4, shallow: 0.3, deep: 0.22, hues: [[1, 1, 1], [1.16, 0.84, 0.9], [0.9, 1.02, 0.78]] },
];
const CELL = 24;
// level switch distances (m) from the camera to a colony's surface, by its screen size: full scan detail within arm's
// reach, a tenth of it to 8 m, then down to a few hundred triangles
// (phones skip the full scan and reach less far)
const FAR = MOBILE ? [0, 5, 14] : [3, 8, 20];
// past this the colonies shrink away over the last 15 m, leaving the terrain's coral colouring; under water the haze
// has swallowed them by then anyway
// per colony in a cell's near list: x, middle y, z, horizontal radius, half height
const NS = 5;
const CUT = MOBILE ? 45 : 70, CUT_UNDER = MOBILE ? 35 : 50, FADE = 15;
// a colony's top stays this far below the surface
const TOP = -0.4;

const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const smooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };

export async function createCoral(hf) {
  const group = new THREE.Group();
  const models = await Promise.all(SPECIES.map((sp) => modelLods(sp.name, { width: 1 }, FAR.length)));
  const uCut = { value: CUT };
  models.forEach((m, si) => { for (const { mat } of m.levels[0]) {
    mat.metalness = 0;
    mat.metalnessMap = null;
    mat.roughness = Math.max(mat.roughness, 0.75);
    if (SPECIES[si].tint) mat.color.multiply(new THREE.Color(...SPECIES[si].tint));
    patch(mat, {
      key: 'coral',
      wet: 0,
      uniforms: { uCut },
      vertexHead: 'uniform float uCut;',
      // shrink each colony toward its base over the last stretch before the cut
      hooks: { vertex: /* glsl */ `
        #ifdef USE_INSTANCING
          vec3 cIP = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          transformed *= smoothstep(uCut, uCut - ${FADE.toFixed(1)}, distance(cIP, cameraPosition));
        #endif` },
    });
  } });

  // ---- placement: massive heads on a coarse grid, the rest on a fine one around and between them
  const r = rng(7171);
  const coralAt = (x, z) => -hf.sampleField(hf.pad, x, z);
  const cells = new Map();
  const cellOf = (x, z) => {
    const i = Math.floor(x / CELL), j = Math.floor(z / CELL), k = i * 100000 + j;
    if (!cells.has(k)) cells.set(k, { i, j, x0: i * CELL, z0: j * CELL, y0: 0, y1: -40, items: SPECIES.map(() => []), near: SPECIES.map(() => []), cols: SPECIES.map(() => []) });
    return cells.get(k);
  };
  const cores = new Map();
  const n = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), q = new THREE.Quaternion(), qy = new THREE.Quaternion(), m4 = new THREE.Matrix4();
  const s3 = new THREE.Vector3(), p3 = new THREE.Vector3();
  function place(si, x, z, h, span) {
    const sp = SPECIES[si], M = models[si];
    // the model's height for a unit width; shrink a colony that would reach the surface, drop it if that leaves a twig
    const hk = M.height;
    // no two colonies alike: stretched a little each way
    const fx = 0.85 + r() * 0.3, fy = 0.75 + r() * 0.4, fz = 0.85 + r() * 0.3;
    let w = span;
    if (h + w * fy * hk * 0.9 > TOP) w = (TOP - h) / (hk * fy * 0.9);
    if (w < sp.span[0] * 0.6) return false;
    hf.normalAt(x, z, n);
    // on a slope the ground falls away under the downhill rim by as much as the colony does not lean with it
    const fall = (Math.sqrt(Math.max(1 - n.y * n.y, 0)) / Math.max(n.y, 0.3)) * w * 0.5 * Math.max(fx, fz) * (1 - sp.tilt);
    q.setFromUnitVectors(up, n.lerp(up, 1 - sp.tilt).normalize());
    qy.setFromAxisAngle(up, r() * Math.PI * 2);
    q.multiply(qy);
    // bed the base into the sand
    p3.set(x, h - w * fy * hk * (sp.core ? 0.14 : 0.06) - fall * 0.7, z);
    m4.compose(p3, q, s3.set(w * fx, w * fy, w * fz));
    const c = cellOf(x, z);
    c.items[si].push(...m4.elements);
    // and each its own shade of the species' colours
    const hue = sp.hues[Math.floor(r() * sp.hues.length)], b = 0.86 + r() * 0.26;
    c.cols[si].push(hue[0] * b, hue[1] * b, hue[2] * b);
    // the middle of the colony, and how far its surface reaches out sideways and up
    const top = p3.y + w * fy * hk;
    c.near[si].push(x, (p3.y + top) / 2, z, w * Math.max(fx, fz) * 0.5, (top - p3.y) / 2);
    c.y0 = Math.min(c.y0, h); c.y1 = Math.max(c.y1, top);
    return true;
  }
  const x0 = HF.origin, x1 = HF.origin + HF.size;
  const cores0 = SPECIES.flatMap((sp, i) => (sp.core ? [i] : []));
  // heads crowd the tops of the coral knolls and thin out down their flanks
  for (let z = x0; z < x1; z += 5) for (let x = x0; x < x1; x += 5) {
    const px = x + r() * 5, pz = z + r() * 5, c = coralAt(px, pz);
    if (c < 0.35 || r() > smooth(0.35, 0.85, c) * 0.8) continue;
    const h = hf.heightAt(px, pz);
    if (h > -1.4 || h < -16) continue;
    const si = cores0[Math.floor(r() * cores0.length)], sp = SPECIES[si];
    const span = sp.span[0] + r() * (sp.span[1] - sp.span[0]);
    if (place(si, px, pz, h, span)) cores.set(Math.floor(px / 5) * 100000 + Math.floor(pz / 5), { x: px, z: pz, rad: span * 0.5 });
  }
  const small = SPECIES.flatMap((sp, i) => (sp.core ? [] : [i]));
  // smaller colonies may crowd a head's foot but not grow out of its middle
  const nearCore = (x, z) => {
    const ci = Math.floor(x / 5), cj = Math.floor(z / 5);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const k = cores.get((ci + a) * 100000 + cj + b);
      if (k && Math.hypot(k.x - x, k.z - z) < k.rad * 0.65) return true;
    }
    return false;
  };
  for (let z = x0; z < x1; z += 1.3) for (let x = x0; x < x1; x += 1.3) {
    const c = coralAt(x, z);
    if (c < 0.25) continue;
    const px = x + (r() - 0.5) * 1.1, pz = z + (r() - 0.5) * 1.1;
    // dense cover on the knolls, scattered colonies on their skirts
    if (r() > Math.pow(smooth(0.25, 0.85, c), 1.6) * (MOBILE ? 0.45 : 0.85)) continue;
    const h = hf.heightAt(px, pz);
    if (h > -0.9 || h < -16 || nearCore(px, pz)) continue;
    const deep = smooth(-2.5, -4.5, h);
    let tot = 0;
    for (const i of small) tot += SPECIES[i].shallow * (1 - deep) + SPECIES[i].deep * deep;
    let pick = r() * tot, si = small[0];
    for (const i of small) { pick -= SPECIES[i].shallow * (1 - deep) + SPECIES[i].deep * deep; if (pick <= 0) { si = i; break; } }
    const sp = SPECIES[si];
    place(si, px, pz, h, sp.span[0] + r() * (sp.span[1] - sp.span[0]));
  }
  const cellList = [...cells.values()];
  for (const c of cellList) {
    c.items = c.items.map((a) => new Float32Array(a));
    c.near = c.near.map((a) => new Float32Array(a));
    c.cols = c.cols.map((a) => new Float32Array(a));
    c.level = c.near.map((a) => new Int8Array(a.length / NS).fill(-1));
  }
  const total = SPECIES.map((_, si) => cellList.reduce((a, c) => a + c.items[si].length / 16, 0));

  // ---- one instanced mesh per species, level and material; filled with the cells that draw at that level
  const meshes = models.map((M, si) => M.levels.map((parts, li) => parts.map(({ mat, geo }) => {
    const im = new THREE.InstancedMesh(geo, mat, Math.max(total[si], 1));
    im.name = `${SPECIES[si].name}.${li}`;
    im.userData.near = li <= 1;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(total[si], 1) * 3), 3).setUsage(THREE.DynamicDrawUsage);
    im.count = 0;
    im.frustumCulled = false;
    im.receiveShadow = true;
    group.add(im);
    return im;
  })));

  // each colony in view takes the level its distance asks for, rebuilt whenever the camera has moved half a metre or
  // turned a few degrees; the view is tested a little wider than the screen so nothing pops in at its edges as you turn
  const last = new THREE.Vector3(1e9, 0, 0), lastDir = new THREE.Vector3(), dir = new THREE.Vector3();
  const frustum = new THREE.Frustum(), pm = new THREE.Matrix4(), sph = new THREE.Sphere(), box = new THREE.Box3();
  let lastProj = 0;
  const inRange = [], byDist = (a, b) => a.d - b.d;
  const inView = (c) => {
    box.min.set(c.x0, c.y0 - 1, c.z0);
    box.max.set(c.x0 + CELL, c.y1, c.z0 + CELL);
    return frustum.intersectsBox(box);
  };
  const counts = meshes.map((lv) => lv.map(() => 0));
  function assign(camera) {
    const cp = camera.position, under = cp.y < 0;
    camera.getWorldDirection(dir);
    const proj = camera.fov * 1000 + camera.aspect;
    if (cp.distanceToSquared(last) < 0.25 && dir.dot(lastDir) > 0.996 && proj === lastProj) return;
    last.copy(cp);
    lastDir.copy(dir);
    lastProj = proj;
    const cut = under ? CUT_UNDER : CUT;
    uCut.value = cut;
    const widen = 0.14, n0 = 0.1, half = THREE.MathUtils.degToRad(camera.fov / 2);
    const T = Math.tan(half + widen) * n0;
    const R = Math.tan(Math.atan(Math.tan(half) * camera.aspect) + widen) * n0;
    frustum.setFromProjectionMatrix(pm.makePerspective(-R, R, T, -T, n0, cut + 10).multiply(camera.matrixWorldInverse));
    for (const c of counts) c.fill(0);
    // nearest cells first, so the instance lists run roughly front to back and the depth test spares the shading of
    // colonies hidden behind nearer ones
    inRange.length = 0;
    for (const c of cellList) {
      const dx = Math.max(c.x0 - cp.x, 0, cp.x - c.x0 - CELL), dz = Math.max(c.z0 - cp.z, 0, cp.z - c.z0 - CELL);
      const dy = Math.max(c.y0 - cp.y, 0, cp.y - c.y1);
      c.d = dx * dx + dy * dy + dz * dz;
      if (c.d > cut * cut || !inView(c)) { for (const l of c.level) l.fill(-1); continue; }
      inRange.push(c);
    }
    inRange.sort(byDist);
    for (const c of inRange) {
      for (let si = 0; si < SPECIES.length; si++) {
        const nr = c.near[si], lvA = c.level[si], mats = c.items[si], cols = c.cols[si];
        for (let k = 0, n = lvA.length; k < n; k++) {
          const o = k * NS, rad = Math.max(nr[o + 3], nr[o + 4]);
          const d = Math.hypot(nr[o] - cp.x, nr[o + 1] - cp.y, nr[o + 2] - cp.z) - rad;
          let lv = d + rad > cut || !frustum.intersectsSphere(sph.set(sph.center.set(nr[o], nr[o + 1], nr[o + 2]), rad * 1.1)) ? -1 : d < FAR[0] ? 0 : d < FAR[1] ? 1 : d < FAR[2] ? 2 : 3;
          // hold a colony at its level within half a metre of a boundary so it does not flicker
          const cur = lvA[k];
          if (cur >= 0 && lv >= 0 && lv !== cur && Math.abs(d - FAR[Math.min(lv, cur)]) < 0.5) lv = cur;
          lvA[k] = lv;
          if (lv < 0) continue;
          // element by element: a subarray view per colony is thousands of short-lived objects, and the GC pauses show
          const im = meshes[si][lv][0], m = im.instanceMatrix.array, col = im.instanceColor.array, j = counts[si][lv]++;
          for (let e = 0; e < 16; e++) m[j * 16 + e] = mats[k * 16 + e];
          for (let e = 0; e < 3; e++) col[j * 3 + e] = cols[k * 3 + e];
        }
      }
    }
    meshes.forEach((levels, si) => levels.forEach((parts, li) => {
      const n = counts[si][li], arr = parts[0].instanceMatrix.array, col = parts[0].instanceColor.array;
      parts.forEach((im, pi) => {
        if (pi > 0 && n) { im.instanceMatrix.array.set(arr.subarray(0, n * 16)); im.instanceColor.array.set(col.subarray(0, n * 3)); }
        im.count = n;
        im.visible = n > 0;
        for (const [a, size] of [[im.instanceMatrix, 16], [im.instanceColor, 3]]) {
          a.clearUpdateRanges();
          a.addUpdateRange(0, n * size);
          a.needsUpdate = n > 0;
        }
      });
    }));
  }

  // a diver slides around the colonies instead of through them: each is an ellipsoid about its middle, snug for the
  // massive heads, smaller for the open branching ones
  function push(p, r) {
    const ci = Math.floor(p.x / CELL), cj = Math.floor(p.z / CELL);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const c = cells.get((ci + a) * 100000 + cj + b);
      if (!c || p.y > c.y1 + r || p.y < c.y0 - 4) continue;
      for (let si = 0; si < SPECIES.length; si++) {
        const nr = c.near[si], k0 = SPECIES[si].solid ? 0.84 : 0.6;
        for (let k = 0; k < nr.length; k += NS) {
          const dx = p.x - nr[k], dy = p.y - nr[k + 1], dz = p.z - nr[k + 2];
          const A = nr[k + 3] * k0 + r, B = nr[k + 4] * k0 + r;
          const e = Math.sqrt((dx * dx + dz * dz) / (A * A) + (dy * dy) / (B * B));
          // out along the ray from its middle, onto its surface
          if (e < 1 && e > 1e-4) p.set(nr[k] + dx / e, nr[k + 1] + dy / e, nr[k + 2] + dz / e);
        }
      }
    }
  }

  console.log(`[ha] coral ${total.map((t, i) => `${SPECIES[i].name.slice(6)} ${t}`).join(', ')} in ${cellList.length} cells`);
  return {
    group,
    cells: cellList,
    count: total.reduce((a, b) => a + b, 0),
    push,
    update(camera) {
      group.visible = camera.position.y < 400;
      if (group.visible) assign(camera);
    },
  };
}
