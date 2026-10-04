// The built world: village, pier, overwater bungalows, beach bar with string lights, the pass light, boats and lamps.
import * as THREE from 'three';
import { U, MAX_LAMPS, patch, COMMON } from '../core/shared.js';
import { LAYER_FX } from '../core/pipeline.js';
import { modelParts, modelLods, bakeParts, lodParts, placeMatrix } from '../core/models.js';
import { Builder } from './geo.js';
import { PLAN, along, polyLength } from './plan.js';

const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const LAMP_COL = [1.0, 0.6, 0.28];

// GLTF materials into the shared world look: no stray metalness, a floor on roughness, haze, shadows, lamps
function adopt(mat, key) {
  mat.metalness = 0;
  mat.metalnessMap = null;
  mat.roughness = Math.max(mat.roughness, 0.75);
  if (mat.map) mat.map.anisotropy = 8;
  return patch(mat, { key: 'mdl-' + key, wet: 0.8 });
}

// planks across a path, joists under them, a cap and two piles every bent down to the seabed. The gaps between
// boards are narrower than a shadow-map texel and alias into a grid of light on the seabed, so each laid board also
// casts a shadow one full pitch wide (caster): the deck's shadow is solid but for the missing boards.
function walkway(b, caster, hf, pts, w, deck, r, opts = {}) {
  const L = polyLength(pts);
  const plankW = 0.2, pitch = 0.235;
  for (let s = 0.12; s < L; s += pitch) {
    const p = along(pts, s);
    const yaw = Math.atan2(p.tx, p.tz);
    const shade = 0.78 + r() * 0.3;
    const tone = [shade, shade * (0.96 + r() * 0.05), shade * (0.9 + r() * 0.08)];
    if (r() < 0.012 && !opts.solid) continue; // a missing board here and there
    b.box(p.x + (r() - 0.5) * 0.03, deck - 0.025 + (r() - 0.5) * 0.012, p.z, w + (r() - 0.5) * 0.06, 0.05, plankW, yaw + (r() - 0.5) * 0.012, tone, 0.45, [r() * 4, r() * 4]);
    caster.box(p.x, deck - 0.03, p.z, w, 0.04, pitch + 0.02, yaw, [1, 1, 1]);
  }
  const bent = 3.0;
  for (let s = 0; s <= L + 0.01; s += bent) {
    const p = along(pts, Math.min(s, L));
    const yaw = Math.atan2(p.tx, p.tz);
    const nx = Math.cos(yaw), nz = -Math.sin(yaw);
    b.box(p.x, deck - 0.2, p.z, w + 0.35, 0.16, 0.16, yaw, [0.7, 0.66, 0.6], 0.5, [r() * 3, 0]);
    for (const side of [-1, 1]) {
      const x = p.x + nx * side * (w / 2 + 0.06), z = p.z + nz * side * (w / 2 + 0.06);
      const ground = hf.heightAt(x, z);
      if (ground > deck - 0.35) continue;
      const lean = (r() - 0.5) * 0.06;
      b.cyl([x + lean, ground - 0.6, z + lean], [x, deck - 0.12, z], 0.13 + r() * 0.03, 7, [0.62, 0.56, 0.5], 0.5, 0.12);
    }
  }
  // joists run with the walk, each bent to bent
  for (let s = 0; s < L - 0.1; s += bent) {
    const a = along(pts, s), c = along(pts, Math.min(s + bent, L));
    const mx = (a.x + c.x) / 2, mz = (a.z + c.z) / 2, len = Math.hypot(c.x - a.x, c.z - a.z);
    const yaw = Math.atan2(c.x - a.x, c.z - a.z);
    for (const off of [-w / 2 + 0.25, 0, w / 2 - 0.25]) {
      b.box(mx + Math.cos(yaw) * off, deck - 0.11, mz - Math.sin(yaw) * off, 0.1, 0.12, len + 0.05, yaw, [0.66, 0.6, 0.54], 0.5, [r(), 0]);
    }
  }
}

export async function createBuilt(renderer, hf, tex) {
  const group = new THREE.Group();
  const fx = new THREE.Group();
  const r = rng(77);
  const ground = (x, z) => hf.heightAt(x, z);

  // ---------------------------------------------------------------- models
  // fit: the scan's length on its own x (width) or z (length) axis; yaw turns its front onto +z
  const [house, hut, kiosk, light, dhow, skiff, dinghy, rowboat] = await Promise.all([
    modelLods('house', { width: 10, yaw: Math.PI / 2 }, 2), // bamboo frame and thatch; the door is on a gable end
    modelLods('shack', { width: 5 }, 2), // a fisherman's plank hut with its own porch deck
    modelLods('kiosk', { height: 2.9 }, 2),
    modelParts('lighthouse', { height: 24 }),
    modelLods('dhow', { width: 7.5, yaw: Math.PI / 2 }, 3),
    modelParts('skiff', { width: 5, yaw: -Math.PI / 2 }),
    modelParts('dinghy', { length: 4.2 }),
    modelParts('rowboat', { length: 4 }),
  ]);
  for (const [m, k] of [[house, 'house'], [hut, 'hut'], [kiosk, 'kiosk'], [light, 'light'], [dhow, 'dhow'], [skiff, 'skiff'], [dinghy, 'dinghy'], [rowboat, 'rowboat']]) m.parts.forEach((p, i) => adopt(p.mat, k + i));
  const BOATS = { dhow, skiff, dinghy, rowboat };
  // level switch distances (m): each far level holds its outline to a few pixels from there out
  const LOD_AT = { house: [0, 45, 140], hut: [0, 30, 90], kiosk: [0, 20, 60], dhow: [0, 20, 50, 140] };

  // village houses: on low stilts, settled into the ground on their downhill side
  const placeOn = (list) => list.map((h) => {
    const c = Math.cos(h.yaw), s = Math.sin(h.yaw), rr = 3.5 * h.s;
    const hs = [[0, 0], [rr, 0], [-rr, 0], [0, rr], [0, -rr]].map(([a, b]) => ground(h.x + a * c + b * s, h.z - a * s + b * c));
    return { ...h, matrix: placeMatrix(h.x, Math.min(...hs) - 0.15, h.z, h.yaw, h.s) };
  });
  const houses = placeOn(PLAN.houses.filter((h) => h.kind === 'house'));
  const huts = placeOn(PLAN.houses.filter((h) => h.kind === 'hut'));
  group.add(...lodParts(house.levels, houses, LOD_AT.house), ...lodParts(hut.levels, huts, LOD_AT.hut));

  // overwater bungalows: the model's own stilts stretched down to the sand
  const BW = 12 / 10; // bungalows are a size up from the village houses
  // from the model's vertex histogram: joists start at 15% of its height, the floor boards top out at 20%
  const stiltTop = 0.15 * house.height, floorTop = 0.2 * house.height;
  const bungs = PLAN.bungalows.map((b) => {
    const base = PLAN.walk.deck + 0.05 - floorTop * BW;
    return { ...b, base, sea: ground(b.x, b.z), matrix: placeMatrix(b.x, base, b.z, b.yaw + Math.PI, BW) };
  });
  group.add(...lodParts(house.levels, bungs, LOD_AT.house, (g, b) => {
    const bottom = (b.sea - 0.4 - b.base) / BW;
    const k = (stiltTop - bottom) / stiltTop;
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (y < stiltTop) p.setY(i, stiltTop - (stiltTop - y) * k);
    }
  }));

  // the bar, and its lighthouse across the lagoon
  // the bar: a bamboo house a size up, opened onto the sand, with two tiki counters out under the string lights
  const BR = PLAN.bar, bc = Math.cos(BR.yaw), bs = Math.sin(BR.yaw);
  const barAt = (dx, dz) => [BR.x + dx * bc + dz * bs, BR.z - dx * bs + dz * bc];
  const [hx, hz] = barAt(0, -2.5);
  group.add(...lodParts(house.levels, [{ matrix: placeMatrix(hx, ground(hx, hz) - 0.25, hz, BR.yaw + Math.PI / 2, 1.25) }], LOD_AT.house));
  group.add(...lodParts(kiosk.levels, [[-3.2, 5.2, 0.15], [3.2, 5.2, -0.15]].map(([dx, dz, t]) => {
    const [x, z] = barAt(dx, dz);
    return { matrix: placeMatrix(x, ground(x, z) - 0.05, z, BR.yaw + t, 1) };
  }), LOD_AT.kiosk));
  const L = PLAN.light;
  const lightBase = ground(L.x, L.z) - 0.15;
  group.add(...bakeParts(light.parts, [{ matrix: placeMatrix(L.x, lightBase, L.z, 0.6, 1) }]));

  // ---------------------------------------------------------------- wood: pier, boardwalk, poles
  const wood = new Builder(), shade = new Builder();
  const P = PLAN.pier;
  walkway(wood, shade, hf, [[P.x, P.z0], [P.x, P.z1 - P.headD]], P.w, P.deck, r);
  walkway(wood, shade, hf, [[P.x - P.headW / 2, P.z1 - P.headD / 2], [P.x + P.headW / 2, P.z1 - P.headD / 2]], P.headD, P.deck, r, { solid: true });
  for (const x of [P.x - P.headW / 2 + 1, P.x - 3, P.x + 3, P.x + P.headW / 2 - 1]) wood.cyl([x, P.deck, P.z1 - 0.5], [x, P.deck + 0.55, P.z1 - 0.5], 0.17, 9, [0.5, 0.46, 0.42], 0.5, 0.15);
  const W = PLAN.walk;
  walkway(wood, shade, hf, W.spine, W.w, W.deck, r);
  walkway(wood, shade, hf, W.arc, W.w, W.deck, r);
  for (const b of PLAN.bungalows) walkway(wood, shade, hf, b.spur, 1.8, W.deck, r);
  // string-light poles at the bar
  const poles = PLAN.bar.poles.map((p) => ({ ...p, y: ground(p.x, p.z) }));
  for (const p of poles) wood.cyl([p.x, p.y - 0.4, p.z], [p.x + (r() - 0.5) * 0.1, p.y + 3.7, p.z], 0.075, 7, [0.85, 0.78, 0.6], 0.6, 0.06);
  // lamp posts: street and walk
  const lamps = [];
  for (const l of PLAN.lamps) {
    if (l.kind === 'porch') {
      lamps.push({ x: l.x, y: ground(l.x, l.z) + l.y, z: l.z, k: 0.6, r: 5 });
      continue;
    }
    const deck = l.kind === 'walk' ? W.deck : ground(l.x, l.z);
    const top = deck + (l.kind === 'walk' ? 2.2 : 2.9);
    wood.box(l.x, (deck + top) / 2 - 0.2, l.z, 0.12, top - deck + 0.4, 0.12, r(), [0.5, 0.45, 0.4]);
    lamps.push({ x: l.x, y: top + 0.18, z: l.z, k: 1, r: 7 });
  }
  for (const l of P.lamps) {
    wood.box(l.x, P.deck + 1.05, l.z, 0.11, 2.1, 0.11, 0, [0.5, 0.45, 0.4]);
    lamps.push({ x: l.x, y: P.deck + 2.25, z: l.z, k: 0.75, r: 7 });
  }
  const woodMat = patch(new THREE.MeshStandardMaterial({ map: tex.weathered_planks_c, normalMap: tex.weathered_planks_n, vertexColors: true, roughness: 0.85 }), {
    key: 'pier', wet: 1,
    hooks: {
      // wet, darker and green-stained where the tide reaches the piles
      map: /* glsl */ `
        // the texture is dark varnished brown (albedo ~0.06); keep its grain, re-base it on sun-bleached silver-tan (~0.3)
        float grain = clamp(dot(diffuseColor.rgb, vec3(0.3, 0.5, 0.2)) / 0.062, 0.35, 1.9);
        diffuseColor.rgb = mix(vec3(0.36, 0.33, 0.29), diffuseColor.rgb / 0.062 * 0.3, 0.25) * grain;
        float tide = smoothstep(0.7, -0.1, vHWP.y + 0.15 * sin(vHWP.x * 1.7 + vHWP.z * 2.3));
        diffuseColor.rgb *= mix(vec3(1.0), vec3(0.42, 0.5, 0.36), tide);
        diffuseColor.rgb *= mix(vec3(1.0), vec3(0.55, 0.5, 0.45), smoothstep(-0.2, -1.5, vHWP.y));`,
    },
  });
  // yard life: laundry, benches, woodpiles, water tanks; crates at the pier root
  const cloth = new Builder();
  const CLOTH = [[0.92, 0.9, 0.86], [0.35, 0.55, 0.78], [0.88, 0.42, 0.33], [0.95, 0.78, 0.3], [0.22, 0.26, 0.5], [0.55, 0.75, 0.55]];
  for (const h of PLAN.houses) {
    const n = 1 + (r() < 0.5 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const a = h.yaw + Math.PI * (0.45 + r() * 1.1);
      const d = h.r * h.s + 2 + r() * 2.5;
      const x = h.x + Math.sin(a) * d, z = h.z + Math.cos(a) * d, y = ground(x, z);
      if (y < 0.9) continue;
      const yaw = a + Math.PI / 2 + (r() - 0.5) * 0.5;
      const ux = Math.cos(yaw), uz = -Math.sin(yaw);
      const kind = r();
      if (kind < 0.35) {
        const len = 3.5 + r() * 1.5;
        for (const e of [-1, 1]) wood.cyl([x + ux * e * len / 2, y - 0.3, z + uz * e * len / 2], [x + ux * e * len / 2, y + 2.0, z + uz * e * len / 2], 0.04, 6, [0.7, 0.62, 0.5]);
        cloth.box(x, y + 1.9, z, len, 0.012, 0.012, yaw, [0.85, 0.85, 0.8]);
        for (let t = -len / 2 + 0.5; t < len / 2 - 0.4; t += 0.55 + r() * 0.35) {
          const w = 0.4 + r() * 0.35, hh = 0.45 + r() * 0.5;
          cloth.box(x + ux * t, y + 1.9 - hh / 2, z + uz * t, w, hh, 0.012, yaw + (r() - 0.5) * 0.15, CLOTH[Math.floor(r() * CLOTH.length)], 1, [0, 0], (r() - 0.5) * 0.2);
        }
      } else if (kind < 0.6) {
        wood.box(x, y + 0.45, z, 1.7, 0.06, 0.38, yaw, [0.75, 0.68, 0.58]);
        for (const e of [-0.7, 0.7]) wood.box(x + ux * e, y + 0.21, z + uz * e, 0.08, 0.48, 0.32, yaw, [0.6, 0.55, 0.48]);
      } else if (kind < 0.8) {
        for (let k = 0; k < 11; k++) {
          const row = k < 5 ? 0 : k < 9 ? 1 : 2, i2 = k < 5 ? k : k < 9 ? k - 5 : k - 9;
          const o = (i2 - (row === 0 ? 2 : row === 1 ? 1.5 : 0.5)) * 0.17;
          const c = [x + Math.sin(yaw) * o, y + 0.09 + row * 0.15, z + Math.cos(yaw) * o];
          wood.cyl([c[0] - ux * 0.5, c[1], c[2] - uz * 0.5], [c[0] + ux * 0.5, c[1], c[2] + uz * 0.5], 0.08, 6, [0.72, 0.6, 0.46], 0.8);
        }
      } else {
        wood.box(x, y + 0.2, z, 1.7, 0.4, 1.7, yaw, [0.55, 0.5, 0.45]);
        cloth.cyl([x, y + 0.4, z], [x, y + 1.85, z], 0.72, 14, [0.2, 0.27, 0.24]);
        cloth.cyl([x, y + 1.85, z], [x, y + 2.05, z], 0.72, 14, [0.2, 0.27, 0.24], 0.5, 0.2);
      }
    }
  }
  for (let i = 0; i < 7; i++) {
    const x = P.x + 3 + (i % 3) * 0.75 + r() * 0.1, z = P.z0 - 3 + Math.floor(i / 3) * 0.8, y = ground(x, z);
    wood.box(x, y + 0.3 + (i === 6 ? 0.6 : 0), z, 0.62, 0.6, 0.62, r() * 0.3, [0.85, 0.78, 0.62], 0.6, [r() * 3, r() * 3]);
  }
  const clothMat = patch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, side: THREE.DoubleSide }), { key: 'cloth', wet: 1, wrap: 0.5 });
  const clothMesh = new THREE.Mesh(cloth.geometry(), clothMat);
  clothMesh.castShadow = clothMesh.receiveShadow = true;
  group.add(clothMesh);
  const woodMesh = new THREE.Mesh(wood.geometry(), woodMat);
  woodMesh.castShadow = woodMesh.receiveShadow = true;
  group.add(woodMesh);
  // drawn into the shadow map only, the view pass gets an empty range (three's shadow pass tests layers against the view
  // camera, so a layer can't do it)
  const shadeMesh = new THREE.Mesh(shade.geometry(), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
  shadeMesh.castShadow = true;
  shadeMesh.onBeforeShadow = () => shadeMesh.geometry.setDrawRange(0, Infinity);
  shadeMesh.onBeforeRender = () => shadeMesh.geometry.setDrawRange(0, 0);
  group.add(shadeMesh);

  // ---------------------------------------------------------------- bar string lights: catenaries of bulbs
  const B = PLAN.bar;
  const barY = ground(B.x, B.z);
  const anchors = [
    // the front eave of the bar house
    [B.x - 5.2, barY + 3.4, B.z + 1.5], [B.x + 5.2, barY + 3.4, B.z + 1.5],
    ...poles.map((p) => [p.x, p.y + 3.6, p.z]),
  ];
  const strands = [[0, 2], [1, 3], [2, 4], [3, 5], [4, 5], [2, 3]];
  const bulbs = [];
  for (const [a, c] of strands) {
    const A = anchors[a], C = anchors[c];
    const len = Math.hypot(C[0] - A[0], C[2] - A[2]);
    const n = Math.round(len / 0.55);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const sag = Math.sin(t * Math.PI) * len * 0.06;
      bulbs.push([A[0] + (C[0] - A[0]) * t, A[1] + (C[1] - A[1]) * t - sag - 0.1, A[2] + (C[2] - A[2]) * t]);
    }
  }
  lamps.push({ x: B.x, y: barY + 3.0, z: B.z + 9, k: 1.0, r: 9 }, { x: B.x, y: barY + 2.4, z: B.z + 1.5, k: 0.8, r: 6 });

  // lantern housings and bulbs: dim glass by day, lit at night
  const glow = [...bulbs.map((p) => ({ p, s: 0.55, k: 0.55 })), ...lamps.map((l) => ({ p: [l.x, l.y, l.z], s: 1.3, k: 1.5 }))];
  const bulbGeo = new THREE.IcosahedronGeometry(1, 1);
  const bulbMat = patch(new THREE.MeshStandardMaterial({ color: 0xfff1d8, roughness: 0.3, emissive: new THREE.Color(...LAMP_COL) }), { key: 'bulb', wet: 0 });
  const bulbMesh = new THREE.InstancedMesh(bulbGeo, bulbMat, glow.length);
  glow.forEach((g, i) => bulbMesh.setMatrixAt(i, placeMatrix(g.p[0], g.p[1], g.p[2], 0, g.s > 1 ? 0.13 : 0.05)));
  bulbMesh.computeBoundingSphere();
  group.add(bulbMesh);

  // ---------------------------------------------------------------- the pass light: lantern, beam, flash
  const lanternY = lightBase + light.height * 0.86;
  const beam = makeBeam();
  beam.position.set(L.x, lanternY, L.z);
  fx.add(beam);
  glow.push({ p: [L.x, lanternY, L.z], s: 7, k: 6, light: true });
  lamps.push({ x: L.x, y: lanternY - 3, z: L.z, k: 3, r: 14 });

  const sprites = makeGlow(glow);
  fx.add(sprites.mesh);

  // ---------------------------------------------------------------- boats
  const moored = [];
  for (const bt of PLAN.boats) {
    const m = BOATS[bt.kind];
    // afloat, a dhow draws most of its white-limed bottom: only the top plank of it shows
    const y = bt.beached ? ground(bt.x, bt.z) - 0.05 : -0.95;
    const one = [{ matrix: new THREE.Matrix4() }];
    const meshes = m.levels ? lodParts(m.levels, one, LOD_AT[bt.kind]) : bakeParts(m.parts, one);
    const g = new THREE.Group();
    g.add(...meshes);
    g.position.set(bt.x, y, bt.z);
    g.rotation.y = bt.yaw;
    if (bt.beached) g.rotation.z = 0.08; // resting on a hull edge
    group.add(g);
    if (!bt.beached) moored.push({ g, y, ph: r() * 6 });
  }

  // nearest lamps feed the shader's fixed-size list
  const lampPos = U.uLampPos.value, lampCol = U.uLampCol.value;
  const order = lamps.map((_, i) => i);
  const cam = new THREE.Vector3();
  let t = 0;
  function update(camera, dt, env) {
    t += dt;
    cam.copy(camera.position);
    order.sort((a, b) => (lamps[a].x - cam.x) ** 2 + (lamps[a].z - cam.z) ** 2 - (lamps[b].x - cam.x) ** 2 - (lamps[b].z - cam.z) ** 2);
    for (let i = 0; i < MAX_LAMPS; i++) {
      const l = lamps[order[i]];
      if (!l) { lampPos[i].set(0, -999, 0, 1); continue; }
      lampPos[i].set(l.x, l.y, l.z, l.r);
      lampCol[i].set(LAMP_COL[0], LAMP_COL[1], LAMP_COL[2]).multiplyScalar(l.k * 6);
    }
    const on = U.uLampOn.value;
    bulbMat.emissiveIntensity = 0.05 + on * 60;
    sprites.mat.uniforms.uOn.value = on;
    // nine-second sweep; the beam only reads against a dark sky
    const ang = (t / 9) * Math.PI * 2;
    beam.rotation.y = ang;
    beam.material.uniforms.uOn.value = on;
    sprites.mat.uniforms.uSweep.value.set(Math.cos(ang), -Math.sin(ang));
    for (const m of moored) {
      m.g.position.y = m.y + Math.sin(t * 0.9 + m.ph) * 0.06;
      m.g.rotation.z = Math.sin(t * 0.7 + m.ph) * 0.035;
      m.g.rotation.x = Math.sin(t * 0.55 + m.ph * 1.3) * 0.02;
    }
  }
  return { group, fx, update, lamps, moored };
}

// camera-facing additive glows around lamps and bulbs, fogged by the haze, with the lighthouse's sweep
function makeGlow(list) {
  const base = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  g.attributes.position = base.attributes.position;
  g.attributes.uv = base.attributes.uv;
  g.setAttribute('iPos', new THREE.InstancedBufferAttribute(new Float32Array(list.flatMap((l) => l.p)), 3));
  g.setAttribute('iSize', new THREE.InstancedBufferAttribute(new Float32Array(list.map((l) => l.s)), 1));
  g.setAttribute('iK', new THREE.InstancedBufferAttribute(new Float32Array(list.map((l) => (l.light ? -l.k : l.k))), 1));
  g.instanceCount = list.length;
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...U, uOn: { value: 0 }, uSweep: { value: new THREE.Vector2(1, 0) } },
    vertexShader: /* glsl */ `
      attribute vec3 iPos; attribute float iSize, iK;
      varying vec2 vUv; varying float vK; varying vec3 vWP;
      uniform vec2 uSweep;
      void main(){
        vUv = uv * 2.0 - 1.0;
        vWP = iPos;
        float k = abs(iK);
        float size = iSize;
        if (iK < 0.0) {
          // the light flares as the beam sweeps past the eye
          vec2 toCam = normalize(cameraPosition.xz - iPos.xz);
          float flare = pow(max(dot(toCam, uSweep), 0.0), 60.0);
          k *= 0.35 + 12.0 * flare;
          size *= 1.0 + 5.0 * flare;
        }
        vK = k;
        vec4 mv = viewMatrix * vec4(iPos, 1.0);
        float d = -mv.z;
        // never thinner than a couple of pixels' worth in the distance, never a wall of light up close
        size = clamp(size, d * 0.004, d * 0.2);
        k *= smoothstep(0.3, 3.0, d);
        mv.xy += position.xy * size;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      uniform float uOn;
      varying vec2 vUv; varying float vK; varying vec3 vWP;
      void main(){
        float r2 = dot(vUv, vUv);
        if (r2 > 1.0) discard;
        float core = exp(-r2 * 40.0) * 3.0 + exp(-r2 * 7.0) * 0.1;
        vec3 v = vWP - cameraPosition; float dist = length(v);
        float T = exp(-hHazeOD(cameraPosition, v / dist, dist));
        gl_FragColor = vec4(vec3(1.0, 0.62, 0.3) * core * vK * uOn * T * 3.0, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.layers.set(LAYER_FX);
  return { mesh, mat };
}

// the lighthouse beam: a long soft cone lit by the haze it passes through
function makeBeam() {
  const len = 420;
  const geo = new THREE.CylinderGeometry(22, 0.35, len, 24, 1, true);
  geo.translate(0, len / 2, 0);
  geo.rotateZ(-Math.PI / 2 - 0.035); // along +x, tipped a little toward the water
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...U, uOn: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vWP; varying vec3 vN; varying float vAlong;
      void main(){
        vAlong = position.x / ${len.toFixed(1)};
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWP = w.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      uniform float uOn;
      varying vec3 vWP; varying vec3 vN; varying float vAlong;
      void main(){
        vec3 V = normalize(cameraPosition - vWP);
        // brighter through the core of the cone than at its silhouette
        float rim = pow(abs(dot(V, vN)), 3.0);
        float fall = exp(-vAlong * 4.0) * smoothstep(0.0, 0.03, vAlong) * (0.8 + 0.2 * hNoise(vWP.xz * 0.05 + uTime * 0.3));
        float dens = 0.35 + 0.65 * uHaze;
        float a = rim * fall * dens * uOn * smoothstep(0.0, 4.0, vWP.y);
        vec3 v = vWP - cameraPosition; float dist = length(v);
        float T = exp(-hHazeOD(cameraPosition, v / dist, dist));
        gl_FragColor = vec4(vec3(1.0, 0.86, 0.62) * a * 0.22 * T, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.layers.set(LAYER_FX);
  return m;
}
