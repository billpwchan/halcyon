// Reef fish around the coral heads, moved entirely in the vertex shader; they part around a swimmer.
// Fusiliers school in mid-water over each head, goatfish work the sand at its foot, parrotfish graze the coral,
// a pair of angelfish keeps close. The models are museum scans; each fish picks a detail level by its own distance.
import * as THREE from 'three';
import { patch, U } from '../core/shared.js';
import { modelLods } from '../core/models.js';

// every scan lies with its head toward -x: width is body length, the yaw turns the head onto +z
// n per school, rad school radius (m), lift: [min, max] metres above the coral head's sand, speed (rad/s around the school),
// spread: vertical scatter (m); polar: the whole school mills one way round, packed into a ring
const SPECIES = [
  { name: 'fusilier', len: 0.26, n: 34, rad: 3.2, lift: [1.5, 2.3], speed: 0.55, spread: 0.9, polar: true },
  { name: 'goatfish', len: 0.3, n: 6, rad: 4.5, lift: [0.18, 0.3], speed: 0.22, spread: 0.08 },
  { name: 'parrotfish', len: 0.5, n: 3, rad: 5.5, lift: [0.6, 1.2], speed: 0.25, spread: 0.6 },
  { name: 'angelfish', len: 0.22, n: 2, rad: 1.8, lift: [0.7, 1.1], speed: 0.4, spread: 0.3 },
];
// switch distances from a fish to the camera: the full scan within arm's length, a tenth of it while the fish still
// spans a few hundred pixels, then a few thousand triangles, then a sketch. The same for every species: none is
// longer than half a metre, and each level of a larger scan carries more triangles to match.
const FAR = [2, 5, 15];

export async function createFish(hf) {
  const group = new THREE.Group();
  // school sites: coral in three to seven metres of lagoon water, with room above it for a school, nearest the places
  // people go first
  const r = (() => { let s = 911; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
  const sites = [];
  const want = [[168, 560], [168, 470], [310, 470], [230, 450], [380, 440], [90, 470], [-60, 520], [-420, 620], [-300, 700], [-900, 500], [-1150, 420], [500, 600]];
  for (const [wx, wz] of want) {
    let best = null;
    for (let i = 0; i < 200; i++) {
      const x = wx + (r() - 0.5) * 120, z = wz + (r() - 0.5) * 120;
      const h = hf.heightAt(x, z);
      if (h > -2.8 || h < -7.5) continue;
      // a school wants a whole knoll under it, not a lone head
      let coral = 0;
      for (let k = 0; k < 9; k++) coral -= hf.sampleField(hf.pad, x + Math.cos(k * 0.785) * (k ? 7 : 0), z + Math.sin(k * 0.785) * (k ? 7 : 0)) / 9;
      const score = coral - Math.hypot(x - wx, z - wz) * 0.004;
      if (!best || score > best.score) best = { x, z, h, score };
    }
    if (best) sites.push(best);
  }

  const kinds = [];
  for (const sp of SPECIES) {
    const model = await modelLods(sp.name, { width: sp.len, yaw: Math.PI / 2 }, FAR.length);
    // per-site fish data
    const perSite = sites.map((s) => {
      const school = [], fish = [];
      const way = r() < 0.5 ? -1 : 1;
      for (let i = 0; i < sp.n; i++) {
        // mid-water fish never break the surface; bottom fish follow the sand
        const cy = Math.min(s.h + sp.lift[0] + r() * (sp.lift[1] - sp.lift[0]), -0.6);
        // a polarised school shares one heading and speed, so it holds together as a ring
        school.push(s.x, cy, s.z, sp.rad * (sp.polar ? 0.85 + r() * 0.3 : 0.7 + r() * 0.6));
        fish.push(sp.polar ? (i / sp.n) * 6.283 * 2.2 + r() * 0.5 : r() * 100, sp.speed * (sp.polar ? 0.95 + r() * 0.1 : 0.8 + r() * 0.4) * (sp.polar ? way : r() < 0.5 ? -1 : 1), (r() - 0.5) * sp.spread, 0.85 + r() * 0.3);
      }
      return { school, fish };
    });
    const cap = sites.length * sp.n;
    const L = sp.len.toFixed(3);
    const levels = model.levels.map((parts, li) => {
      const aSchool = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
      const aFish = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
      const meshes = parts.map(({ mat, geo }) => {
        const g = new THREE.InstancedBufferGeometry().copy(geo);
        g.instanceCount = 0;
        g.setAttribute('iSchool', aSchool);
        g.setAttribute('iFish', aFish);
        const m = new THREE.Mesh(g, mat);
        m.userData.near = li <= 1;
        m.frustumCulled = false;
        group.add(m);
        return m;
      });
      return { aSchool, aFish, meshes };
    });
    for (const { mat } of model.levels[0]) {
      mat.metalness = 0;
      mat.roughness = Math.max(mat.roughness, 0.4);
      patch(mat, {
        key: 'fish-' + sp.name, wet: 0, wrap: 0.3,
        vertexHead: /* glsl */ `attribute vec4 iSchool; attribute vec4 iFish;`,
        hooks: {
          beginNormal: /* glsl */ `
            float fT = uTime * iFish.y / iSchool.w + iFish.x;
            float fR = iSchool.w * (${sp.polar ? '0.92 + 0.08' : '0.55 + 0.45'} * sin(iFish.x * 3.1));
            // the whole school drifts around its head
            vec3 fC = iSchool.xyz + vec3(sin(uTime * 0.05 + iSchool.x) * 2.5, 0.0, cos(uTime * 0.04 + iSchool.z) * 2.5);
            vec3 fP = fC + vec3(cos(fT) * fR, iFish.z + sin(fT * 1.7 + iFish.x) * 0.35 * ${(sp.spread / 1.4).toFixed(3)}, sin(fT) * fR * 0.7);
            vec3 fV = vec3(-sin(fT) * fR, cos(fT * 1.7 + iFish.x) * 0.6 * ${(sp.spread / 1.4).toFixed(3)}, cos(fT) * fR * 0.7) * sign(iFish.y);
            // part around a swimmer
            vec3 fD = fP - uSwimmer.xyz; float fDL = length(fD);
            fP += fD / max(fDL, 0.01) * max(2.5 - fDL, 0.0) * 1.2;
            vec3 fFw = normalize(fV);
            vec3 fRt = normalize(cross(vec3(0.0, 1.0, 0.0), fFw));
            mat3 fB = mat3(fRt, cross(fFw, fRt), fFw);
            objectNormal = fB * objectNormal;`,
          vertex: /* glsl */ `
            float fS = iFish.w;
            // the body bends toward the tail
            float fTail = smoothstep(0.1 * ${L}, -0.5 * ${L}, transformed.z);
            transformed.x += sin(uTime * 11.0 + iFish.x * 7.0 + transformed.z * 18.0 / ${L} * 0.1) * 0.22 * ${L} * fTail * fTail;
            transformed = fB * (transformed * fS) + fP;`,
        },
      });
    }
    // every fish of the species in one list: where its school is, and its own phase, speed, depth and size
    const S = new Float32Array(perSite.flatMap((p) => p.school)), F = new Float32Array(perSite.flatMap((p) => p.fish));
    kinds.push({ sp, levels, S, F, far: FAR, lv: new Int8Array(cap).fill(-1) });
  }

  // each fish takes the level its distance asks for: where it is follows the shader's path, less the small swerve
  // around a swimmer; the instance lists are only rewritten when some fish changes level
  function assign(camera) {
    const t = U.uTime.value, cp = camera.position;
    for (const k of kinds) {
      const { S, F, lv, far, levels } = k, polar = k.sp.polar;
      let changed = false;
      for (let i = 0; i < lv.length; i++) {
        const o = i * 4, w = S[o + 3];
        const fT = (t * F[o + 1]) / w + F[o];
        const fR = w * (polar ? 0.92 + 0.08 * Math.sin(F[o] * 3.1) : 0.55 + 0.45 * Math.sin(F[o] * 3.1));
        const x = S[o] + Math.sin(t * 0.05 + S[o]) * 2.5 + Math.cos(fT) * fR;
        const z = S[o + 2] + Math.cos(t * 0.04 + S[o + 2]) * 2.5 + Math.sin(fT) * fR * 0.7;
        const d = Math.hypot(x - cp.x, S[o + 1] + F[o + 2] - cp.y, z - cp.z);
        let l = d < far[0] ? 0 : d < far[1] ? 1 : d < far[2] ? 2 : 3;
        // a little hysteresis so a fish on a boundary does not flicker between levels
        const cur = lv[i];
        if (cur >= 0 && l !== cur && Math.abs(d - far[Math.min(l, cur)]) < far[0] * 0.15) l = cur;
        if (l !== cur) { lv[i] = l; changed = true; }
      }
      if (!changed) continue;
      const n = levels.map(() => 0);
      for (let i = 0; i < lv.length; i++) {
        const li = lv[i], a = levels[li].aSchool.array, b = levels[li].aFish.array, j = n[li]++;
        for (let e = 0; e < 4; e++) { a[j * 4 + e] = S[i * 4 + e]; b[j * 4 + e] = F[i * 4 + e]; }
      }
      levels.forEach((L, li) => {
        L.aSchool.needsUpdate = L.aFish.needsUpdate = true;
        for (const m of L.meshes) { m.geometry.instanceCount = n[li]; m.visible = n[li] > 0; }
      });
    }
  }
  // the schools only matter within sight of the water they live in
  function update(camera) {
    let near = 1e9;
    for (const s of sites) near = Math.min(near, Math.hypot(camera.position.x - s.x, camera.position.z - s.z));
    group.visible = near < 160 && camera.position.y < 60;
    if (group.visible) assign(camera);
  }
  return { group, update, sites };
}
