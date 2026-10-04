// Animals with somewhere to be: whales blowing and breaching beyond the reef, a dolphin pod porpoising across the lagoon,
// turtles and rays over the sand, blacktips in the shallows, gulls and frigatebirds overhead, crabs on the wet sand.
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { patch, U } from '../core/shared.js';
import { loadModel, toFloat } from '../core/models.js';
import { ringPoint, PIER, PASS } from '../world/layout.js';

const TAU = Math.PI * 2;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

// Procedural motion for static scans (no rig): a travelling body wave toward the tail, or wings that beat and glide.
// Uniforms live in model space; uMoPh is each animal's own phase, written just before it draws.
const MOTION_HEAD = /* glsl */ `
uniform vec3 uMoC, uMoH, uMoD, uFlL;
uniform float uMoL, uMoA, uMoF, uMoK, uFlW, uFlA, uFlF, uMoPh;
float hFlapAng(vec3 p, out float hw){
  float hx = abs(dot(p - uMoC, uFlL));
  hw = smoothstep(0.1, 1.0, hx / uFlW);
  // beat a few strokes, then hold the wings out and glide
  float beat = smoothstep(-0.3, 0.5, sin(uTime * 0.45 + uMoPh * 3.0));
  return (uFlA * sin(uTime * uFlF + uMoPh) + uFlA * 0.4 * sin(uTime * uFlF - 0.9 + uMoPh) * hw) * hw * beat;
}
// wings bend up about a hinge near the body; each side mirrors the other
vec3 hFlapPos(vec3 p, float a){
  vec3 q = p - uMoC;
  float lx = dot(q, uFlL), sg = lx < 0.0 ? -1.0 : 1.0, ax = abs(lx), x0 = 0.1 * uFlW;
  if (ax <= x0) return p;
  float r = ax - x0, ca = cos(a), sa = sin(a);
  float lat = x0 + r * ca - q.y * sa, up = r * sa + q.y * ca;
  return uMoC + (q - lx * uFlL - vec3(0.0, q.y, 0.0)) + sg * lat * uFlL + vec3(0.0, up, 0.0);
}
vec3 hFlapDir(vec3 n, vec3 p, float a){
  float sg = dot(p - uMoC, uFlL) < 0.0 ? -1.0 : 1.0;
  float nl = dot(n, uFlL), ca = cos(a), sa = sin(a);
  float lat = sg * nl * ca - n.y * sa, up = sg * nl * sa + n.y * ca;
  return (n - nl * uFlL - vec3(0.0, n.y, 0.0)) + sg * lat * uFlL + vec3(0.0, up, 0.0);
}
`;
const SWIM_HOOK = /* glsl */ `
  {
    float hU = 0.5 - 0.5 * dot(transformed - uMoC, uMoH) / uMoL;
    float hW = pow(smoothstep(0.3, 1.0, hU), 1.6) + 0.06 * hU;
    transformed += uMoD * uMoA * hW * sin(uTime * uMoF - hU * uMoK + uMoPh);
  }
`;
// The humpback scan holds its pectorals almost straight down, which reads as legs from below. Swing them out about a
// hinge on the flank to a cruising angle (model space: head on -x, fins at x -3.2..-0.8, roots at |z| 1.6, y 0).
const WHALE_FINS_HEAD = /* glsl */ `
float hFinW(vec3 p){
  return smoothstep(1.45, 1.75, abs(p.z)) * smoothstep(0.35, -0.05, p.y) * smoothstep(-3.5, -3.1, p.x) * smoothstep(-0.45, -0.8, p.x);
}
vec2 hFinRot(vec2 v, float a){ float c = cos(a), s = sin(a); return vec2(v.x * c - v.y * s, v.x * s + v.y * c); }
`;
const WHALE_FINS = /* glsl */ `
  {
    float fA = (0.66 + 0.07 * sin(uTime * 0.55 + uMoPh)) * hFinW(position);
    float fS = position.z < 0.0 ? -1.0 : 1.0;
    vec2 fR = hFinRot(vec2(abs(transformed.z) - 1.6, transformed.y), fA);
    transformed.z = fS * (1.6 + fR.x); transformed.y = fR.y;
  }
`;
const WHALE_FINS_NORMAL = /* glsl */ `
  {
    float fA = (0.66 + 0.07 * sin(uTime * 0.55 + uMoPh)) * hFinW(position);
    float fS = position.z < 0.0 ? -1.0 : 1.0;
    vec2 fN = hFinRot(vec2(fS * objectNormal.z, objectNormal.y), fA);
    objectNormal.z = fS * fN.x; objectNormal.y = fN.y;
  }
`;
const FLAP_HOOK = /* glsl */ `
  { float hw; float a = hFlapAng(position, hw); if (hw > 0.0) transformed = hFlapPos(transformed, a); }
`;
const FLAP_NORMAL = /* glsl */ `
  { float hw; float a = hFlapAng(position, hw); if (hw > 0.0) objectNormal = normalize(hFlapDir(objectNormal, position, a)); }
`;

// a static scan with every node transform baked, so the motion shader works in one model space
async function flatScene(name) {
  const g = await loadModel(name);
  g.scene.updateMatrixWorld(true);
  const flat = new THREE.Group();
  g.scene.traverse((o) => { if (o.isMesh) flat.add(new THREE.Mesh(toFloat(o.geometry.clone()).applyMatrix4(o.matrixWorld), o.material)); });
  return flat;
}

// a template: the model normalised to a body length along +z, materials joined to the world look.
// yaw turns the model's head onto +z. swim: { dir: 'y' | 'x', amp (m), freq (rad/s), k (rad along the body) };
// flap: { amp (rad), freq (rad/s) } for a bird with wings along its lateral axis; lods: switch distances (m) for <name>.lodN
async function template(name, { length, yaw = 0, key, tint, swim, flap, lods, fins }) {
  const g = await loadModel(name);
  const motion = !!(swim || flap);
  let root = motion ? await flatScene(name) : g.scene;
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const axisLen = Math.abs(Math.cos(yaw)) > 0.5 ? size.z : size.x;
  const k = length / axisLen;
  const center = box.getCenter(new THREE.Vector3());
  const head = new THREE.Vector3(-Math.sin(yaw), 0, Math.cos(yaw));
  const lateral = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
  const moU = {
    uMoC: { value: center }, uMoH: { value: head }, uMoL: { value: axisLen / 2 }, uMoPh: { value: 0 },
    uMoD: { value: swim?.dir === 'x' ? lateral : new THREE.Vector3(0, 1, 0) }, uMoA: { value: (swim?.amp || 0) / k },
    uMoF: { value: swim?.freq || 0 }, uMoK: { value: swim?.k || 0 },
    uFlL: { value: lateral }, uFlW: { value: Math.abs(lateral.x) > 0.5 ? size.x / 2 : size.z / 2 }, uFlA: { value: flap?.amp || 0 }, uFlF: { value: flap?.freq || 0 },
  };
  const mats = new Map(), byName = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.frustumCulled = motion; // skinned bounds do not follow the animation; the procedural motion stays inside its bounds
    const m = o.material;
    if (!mats.has(m)) {
      const c = m.clone();
      c.metalness = 0;
      c.metalnessMap = null;
      c.roughness = Math.max(c.roughness, 0.5);
      if (tint) c.color.multiply(new THREE.Color(...tint));
      // feather and fin cards: cut out against the MSAA samples instead of blending over whatever lies behind
      if (c.transparent && c.map) { c.transparent = false; c.alphaTest = 0.5; c.alphaToCoverage = true; c.depthWrite = true; }
      patch(c, {
        key: `fauna-${key}-${mats.size}`, wet: 0, wrap: 0.25,
        ...(motion ? {
          uniforms: moU, vertexHead: MOTION_HEAD + (fins ? WHALE_FINS_HEAD : ''),
          hooks: { vertex: (fins ? WHALE_FINS : '') + (swim ? SWIM_HOOK : FLAP_HOOK), ...(flap ? { beginNormal: FLAP_NORMAL } : fins ? { beginNormal: WHALE_FINS_NORMAL } : {}) },
        } : {}),
      });
      mats.set(m, c);
      byName.set(m.name, c);
    }
    o.material = mats.get(m);
    o.castShadow = false;
    o.receiveShadow = true;
  });
  // far levels: simplified geometry in the same model space, wearing the level-0 materials
  const levels = [];
  for (const [i, dist] of (lods || []).entries()) {
    const lv = await flatScene(`${name}.lod${i + 1}`);
    lv.traverse((o) => { if (o.isMesh) { o.material = byName.get(o.material.name) || [...mats.values()][0]; o.castShadow = false; o.receiveShadow = true; } });
    levels.push({ root: lv, dist });
  }
  return { gltf: g, root, k, yaw, center, size, half: (size.y * k) / 2, clips: g.animations, moU, motion, levels };
}

// one animal: outer node carries the world pose, the inner one the model's own fix-up
function spawn(T, clip = 0, rate = 1) {
  let inner;
  if (T.levels.length) {
    inner = new THREE.LOD();
    inner.addLevel(T.root.clone(), 0);
    for (const l of T.levels) inner.addLevel(l.root.clone(), l.dist);
  } else inner = T.motion ? T.root.clone() : cloneSkinned(T.root);
  inner.position.copy(T.center).multiplyScalar(-T.k).applyAxisAngle(new THREE.Vector3(0, 1, 0), T.yaw);
  inner.rotation.y = T.yaw;
  inner.scale.setScalar(T.k);
  const outer = new THREE.Group();
  outer.rotation.order = 'YXZ';
  outer.add(inner);
  if (T.motion) {
    // the motion materials are shared, so each animal writes its own phase as it draws
    const ph = Math.random() * Math.PI * 2;
    inner.traverse((o) => {
      if (!o.isMesh) return;
      o.onBeforeRender = (r, s, c, g, mat) => { T.moU.uMoPh.value = ph; mat.uniformsNeedUpdate = true; };
    });
  }
  let mixer = null, action = null;
  if (T.clips.length) {
    mixer = new THREE.AnimationMixer(inner);
    action = mixer.clipAction(T.clips[clip] || T.clips[0]);
    action.play();
    action.time = Math.random() * action.getClip().duration;
    action.timeScale = rate;
  }
  return { node: outer, inner, mixer, action };
}

export async function createFauna(hf, particles) {
  const F = { onEvent: null };
  const group = new THREE.Group();
  const rnd = Math.random;
  const agents = [];
  const groundAt = (x, z) => hf.heightAt(x, z);

  const [whaleT, dolphinT, turtleT, mantaT, sharkT, gullT, crabT] = await Promise.all([
    // a humpback's flukes drive it; the stroke is slow and lives in the last third of the body
    template('whale', { length: 14, yaw: Math.PI / 2, key: 'whale', swim: { dir: 'y', amp: 0.55, freq: 1.3, k: 2.2 }, fins: true }),
    template('dolphin', { length: 2.6, key: 'dolphin' }),
    template('turtle', { length: 1.1, key: 'turtle' }),
    template('manta', { length: 3.6, key: 'manta' }),
    template('shark', { length: 1.6, yaw: Math.PI / 2, key: 'shark' }),
    template('gull', { length: 0.55, key: 'gull', flap: { amp: 0.42, freq: 11 }, lods: [30, 110] }),
    template('crab', { length: 0.13, key: 'crab' }),
  ]);
  const frigateT = await template('gull', { length: 0.85, key: 'frigate', tint: [0.2, 0.2, 0.22], flap: { amp: 0.3, freq: 6 }, lods: [30, 110] });

  // ---------------------------------------------------------------- whales: deep water outside the reef
  const whales = [
    { c: ringPoint(TAU * 0.25, 480), R: 320, dir: 1 },
    { c: ringPoint((330 / 360) * TAU, 420), R: 260, dir: -1 },
  ].map((w, i) => {
    const s = spawn(whaleT, 0, 1);
    group.add(s.node);
    return { ...w, ...s, a: rnd() * TAU, y: -9, pitch: 0, roll: 0, state: 'cruise', t: 6 + i * 14, cycle: 0, vy: 0, blown: 0 };
  });
  const head = new THREE.Vector3();
  function updateWhale(w, dt) {
    const speed = w.state === 'breach' ? 0 : 2.4;
    w.a += (speed / w.R) * dt * w.dir;
    const x = w.c[0] + Math.cos(w.a) * w.R, z = w.c[1] + Math.sin(w.a) * w.R;
    const yaw = Math.atan2(-Math.sin(w.a) * w.dir, Math.cos(w.a) * w.dir);
    w.t -= dt;
    let ty = w.y, tp = 0, tr = 0;
    switch (w.state) {
      case 'cruise':
        ty = -9 + Math.sin(w.a * 9) * 1.5;
        if (w.t <= 0) {
          w.cycle++;
          if (w.cycle % 3 === 0 && rnd() < 0.7) { w.state = 'breach'; w.t = 7; w.y = -14; w.vy = 0; w.blown = 0; }
          else { w.state = 'rise'; w.t = 7; }
        }
        break;
      case 'rise':
        ty = -0.9; tp = 0.12;
        if (w.t <= 0) { w.state = 'surface'; w.t = 13; w.blown = 0; }
        break;
      case 'surface': {
        // the back rolls through the surface, blowing twice
        ty = -0.75 + Math.sin((13 - w.t) * 0.9) * 0.15;
        tp = Math.sin((13 - w.t) * 0.9) * 0.05;
        const blowAt = [1.0, 7.0];
        if (w.blown < 2 && 13 - w.t > blowAt[w.blown]) {
          w.blown++;
          head.set(0, 1.1, 4.6).applyEuler(w.node.rotation).add(w.node.position);
          particles.emit(head.x, 0.4, head.z, 0, 9, 0, 1.4, 90, 3.2, 0.5, 3.6, 0);
          F.onEvent?.('blow', head.x, 0.4, head.z);
          particles.emit(head.x, 0.4, head.z, 0, 6, 0, 2.2, 40, 1.6, 0.12, 0.25, 1);
        }
        if (w.t <= 0) { w.state = 'dive'; w.t = 9; }
        break;
      }
      case 'dive':
        // fluke-up: nose down, tail lifting clear before it slides under
        ty = -14; tp = -0.55 * smooth(9, 6, w.t) * smooth(0, 3, w.t);
        if (w.t <= 0) { w.state = 'cruise'; w.t = 25 + rnd() * 20; }
        break;
      case 'breach': {
        // a run from depth, out to the pectorals, a half roll, and the fall
        const T = 7 - w.t;
        if (T < 1.6) { w.vy = lerp(w.vy, 11.5, 1 - Math.exp(-dt * 3)); tp = 1.25; }
        else w.vy -= 9.8 * dt;
        w.y += w.vy * dt;
        if (w.y < 1.5 && w.vy < 0 && !w.splash) {
          w.splash = true;
          F.onEvent?.('breach', x, 0, z);
          // the fall: a crown thrown up and out, a column from the middle, mist drifting off downwind
          particles.emitRing(x, 0.3, z, 3, 7, 5, 15, 340, 2.8, 0.5, 1.1, 1);
          particles.emit(x, 0.5, z, 0, 19, 0, 4, 150, 2.6, 0.6, 1.3, 1);
          particles.emit(x, 3.5, z, 0, 2.5, 0, 10, 40, 6.0, 3.0, 11, 0);
        }
        if (w.y > -1 && w.vy > 0 && !w.out) {
          w.out = true;
          particles.emitRing(x, 0.2, z, 1.5, 3, 2.5, 9, 170, 1.9, 0.35, 0.8, 1);
        }
        tp = T < 1.6 ? 1.25 : lerp(1.25, -0.3, smooth(1.6, 3.6, T));
        tr = smooth(1.2, 3.2, T) * 1.7;
        if (w.t <= 0) { w.state = 'cruise'; w.t = 30 + rnd() * 20; w.splash = w.out = false; w.y = -6; }
        w.node.position.set(x, w.y, z);
        w.pitch = tp; w.roll = tr;
        w.node.rotation.set(-w.pitch, yaw, w.roll);
        return;
      }
    }
    w.y = lerp(w.y, ty, 1 - Math.exp(-dt * 0.5));
    w.pitch = lerp(w.pitch, tp + (ty - w.y) * 0.03, 1 - Math.exp(-dt * 0.8));
    w.roll = lerp(w.roll, tr, 1 - Math.exp(-dt));
    w.node.position.set(x, w.y, z);
    w.node.rotation.set(-w.pitch, yaw, w.roll);
  }

  // ---------------------------------------------------------------- dolphins: a pod running a loop of the lagoon
  const pod = { cx: 120, cz: 760, rx: 330, rz: 150, s: 0, speed: 6.5 };
  const dolphins = Array.from({ length: 6 }, (_, i) => {
    const s = spawn(dolphinT, 0, 1.6);
    group.add(s.node);
    return { ...s, lag: i * 3.5 + rnd() * 2, side: (rnd() - 0.5) * 9, next: rnd() * 4, jump: -1, depth: -1.4 - rnd() * 0.8, y: -1.5 };
  });
  const podAt = (s, out) => {
    const L = (TAU * Math.sqrt((pod.rx * pod.rx + pod.rz * pod.rz) / 2));
    const a = (s / L) * TAU;
    out.x = pod.cx + Math.cos(a) * pod.rx;
    out.z = pod.cz + Math.sin(a) * pod.rz;
    out.dx = -Math.sin(a) * pod.rx;
    out.dz = Math.cos(a) * pod.rz;
    return out;
  };
  const pp = {};
  function updateDolphin(d, dt) {
    podAt(pod.s - d.lag, pp);
    const l = Math.hypot(pp.dx, pp.dz);
    const fx = pp.dx / l, fz = pp.dz / l;
    const x = pp.x - fz * d.side, z = pp.z + fx * d.side;
    d.next -= dt;
    let y = d.depth + Math.sin(pod.s * 0.4 + d.lag) * 0.3, pitch = 0;
    if (d.jump < 0 && d.next <= 0) { d.jump = 0; d.next = 3 + rnd() * 5; }
    if (d.jump >= 0) {
      // a leap: from depth up through the surface, clear by a metre, back in head first
      const T = 1.25;
      d.jump += dt / T;
      const u = d.jump;
      const arc = Math.sin(Math.min(u, 1) * Math.PI);
      y = lerp(d.depth, 1.1, arc);
      pitch = Math.cos(Math.min(u, 1) * Math.PI) * 0.75;
      if (!d.outS && y > 0) { d.outS = true; particles.emit(x, 0.1, z, fx * 2, 4, fz * 2, 1, 18, 1.0, 0.08, 0.2, 1); }
      if (!d.inS && u > 0.75 && y < 0.3) { d.inS = true; F.onEvent?.('splash', x, 0, z); particles.emit(x, 0.1, z, 0, 3.5, 0, 1.2, 26, 1.0, 0.08, 0.22, 1); particles.emit(x, 0.2, z, 0, 0.6, 0, 1.6, 8, 1.6, 0.4, 1.4, 0); }
      if (u >= 1.05) { d.jump = -1; d.outS = d.inS = false; }
    }
    d.y = d.jump >= 0 ? y : lerp(d.y, y, 1 - Math.exp(-dt * 2));
    d.node.position.set(x, d.y, z);
    d.node.rotation.set(-pitch, Math.atan2(fx, fz), 0);
  }

  // ---------------------------------------------------------------- turtles: grazing over the sand near the bungalows and pier
  const turtleHomes = [[300, 470], [250, 440], [175, 520], [140, 470], [360, 460]];
  const turtles = turtleHomes.map(([hx, hz]) => {
    const s = spawn(turtleT);
    if (s.action) s.action.stop();
    const bones = {};
    s.inner.traverse((o) => { if (o.isBone) bones[o.name] = o; });
    const find = (re) => Object.values(bones).find((b) => re.test(b.name));
    const fl = [find(/^shoulder_L/), find(/^shoulder_R/), find(/^thigh_L/), find(/^thigh_R/)];
    const rest = fl.map((b) => b && b.quaternion.clone());
    group.add(s.node);
    return { ...s, hx, hz, x: hx, z: hz, y: -2, yaw: rnd() * TAU, tx: hx, tz: hz, ph: rnd() * TAU, fl, rest, breathe: 30 + rnd() * 60, up: 0 };
  });
  const q = new THREE.Quaternion(), ax = new THREE.Vector3();
  function updateTurtle(t, dt) {
    if (Math.hypot(t.tx - t.x, t.tz - t.z) < 2) {
      const a = rnd() * TAU, r = rnd() * 35;
      t.tx = t.hx + Math.cos(a) * r; t.tz = t.hz + Math.sin(a) * r;
    }
    const want = Math.atan2(t.tx - t.x, t.tz - t.z);
    let d = want - t.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
    t.yaw += Math.max(-0.4 * dt, Math.min(0.4 * dt, d));
    t.x += Math.sin(t.yaw) * 0.45 * dt;
    t.z += Math.cos(t.yaw) * 0.45 * dt;
    const floor = groundAt(t.x, t.z);
    t.breathe -= dt;
    if (t.breathe < 0) { t.up = Math.min(1, t.up + dt * 0.12); if (t.breathe < -14) { t.breathe = 50 + rnd() * 60; } }
    else t.up = Math.max(0, t.up - dt * 0.1);
    const y = lerp(Math.min(floor + 0.6, -0.8), -0.25, smooth(0, 1, t.up));
    t.y = lerp(t.y, y, 1 - Math.exp(-dt * 0.8));
    t.node.position.set(t.x, t.y, t.z);
    t.node.rotation.set(-(y - t.y) * 0.5, t.yaw, Math.sin(t.ph) * 0.05);
    // flippers: a slow fore stroke, the hind ones steering
    t.ph += dt * 1.6;
    const s = Math.sin(t.ph);
    t.fl.forEach((b, i) => {
      if (!b) return;
      const amp = i < 2 ? 0.55 : 0.2;
      ax.set(1, 0, 0);
      q.setFromAxisAngle(ax, s * amp * (i % 2 ? -1 : 1));
      b.quaternion.copy(t.rest[i]).multiply(q);
    });
  }

  // ---------------------------------------------------------------- manta rays: wide slow circles inside the pass
  const pass = ringPoint(PASS.a, -260);
  const mantas = [[pass[0], pass[1], 70], [pass[0] + 160, pass[1] + 90, 55], [380, 780, 60]].map(([cx, cz, R], i) => {
    const s = spawn(mantaT);
    // wings beat as a wave from the body out to the tips, each ray on its own phase
    s.inner.traverse((o) => {
      if (!o.isMesh) return;
      o.material = o.material.clone();
      // tips travel about 0.8 m either way; sx runs 0 at the spine to 1 at a wingtip
      const cx = mantaT.center.x.toFixed(4), hs = (mantaT.size.x / 2).toFixed(4), amp = (0.8 / mantaT.k).toFixed(4);
      patch(o.material, { key: 'fauna-manta-flap', wet: 0, wrap: 0.25, uniforms: { uPh: { value: i * 2.1 } }, vertexHead: 'uniform float uPh;', hooks: { vertex: `{ float sx = abs(transformed.x - ${cx}) / ${hs}; transformed.y += sin(uTime * 1.3 + uPh - sx * 1.6) * ${amp} * sx * sx; }` } });
    });
    group.add(s.node);
    return { ...s, cx, cz, R, a: rnd() * TAU, dir: i % 2 ? 1 : -1 };
  });
  function updateManta(m, dt) {
    m.a += (1.3 / m.R) * dt * m.dir;
    const x = m.cx + Math.cos(m.a) * m.R, z = m.cz + Math.sin(m.a) * m.R;
    const floor = groundAt(x, z);
    const y = Math.max(floor + 1.5, -5 + Math.sin(m.a * 3) * 1.5);
    m.node.position.set(x, Math.min(y, -1.2), z);
    m.node.rotation.set(Math.sin(m.a * 3) * 0.08, Math.atan2(-Math.sin(m.a) * m.dir, Math.cos(m.a) * m.dir), -0.18 * m.dir);
  }

  // ---------------------------------------------------------------- blacktip reef sharks along the village beach
  const sharks = Array.from({ length: 4 }, (_, i) => {
    const s = spawn(sharkT, 0, 1.1);
    group.add(s.node);
    return { ...s, x: 120 + i * 60, base: 412 + rnd() * 10, dir: i % 2 ? 1 : -1, ph: rnd() * 10, fin: i < 2 };
  });
  function updateShark(s, dt) {
    s.x += s.dir * 1.3 * dt;
    if (s.x > 380) s.dir = -1;
    if (s.x < 40) s.dir = 1;
    s.ph += dt;
    const z = s.base + Math.sin(s.ph * 0.35) * 7;
    const dz = Math.cos(s.ph * 0.35) * 7 * 0.35;
    const floor = groundAt(s.x, z);
    if (floor > -0.7) s.dir = s.x > 210 ? -1 : 1;
    // two cruise high enough for the dorsal to cut the surface
    const y = Math.max(s.fin ? -0.3 : -1.1, floor + 0.35);
    s.node.position.set(s.x, y, z);
    s.node.rotation.set(0, Math.atan2(s.dir * 1.3, dz), 0);
  }

  // ---------------------------------------------------------------- gulls over the pier and beach, frigatebirds high over the peak
  const birds = [];
  const flock = (T, n, cx, cz, alt, r0, r1, speed, rate) => {
    for (let i = 0; i < n; i++) {
      const s = spawn(T, 0, rate * (0.8 + rnd() * 0.4));
      group.add(s.node);
      birds.push({ ...s, cx: cx + (rnd() - 0.5) * 40, cz: cz + (rnd() - 0.5) * 40, R: lerp(r0, r1, rnd()), alt: alt[0] + rnd() * (alt[1] - alt[0]), a: rnd() * TAU, dir: rnd() < 0.5 ? -1 : 1, speed: speed * (0.85 + rnd() * 0.3), bob: rnd() * TAU, rate: s.action ? s.action.timeScale : 1 });
    }
  };
  flock(gullT, 8, PIER.x, 540, [10, 26], 25, 60, 9, 1.0);
  flock(gullT, 6, 260, 405, [8, 20], 20, 45, 8, 1.0);
  flock(frigateT, 4, -70, -150, [370, 450], 90, 170, 7, 0.25);
  function updateBird(b, dt) {
    b.a += (b.speed / b.R) * dt * b.dir;
    b.bob += dt * 0.3;
    const x = b.cx + Math.cos(b.a) * b.R, z = b.cz + Math.sin(b.a) * b.R;
    const y = b.alt + Math.sin(b.bob) * 3;
    b.node.position.set(x, y, z);
    const yaw = Math.atan2(-Math.sin(b.a) * b.dir, Math.cos(b.a) * b.dir);
    // bank into the turn
    b.node.rotation.set(-Math.cos(b.bob) * 0.08, yaw, -Math.atan((b.speed * b.speed) / (b.R * 9.8)) * b.dir);
    if (b.action) b.action.timeScale = b.rate * (0.7 + 0.5 * Math.max(0, Math.sin(b.bob * 2.3)));
  }

  // ---------------------------------------------------------------- crabs on the wet sand; they bolt for the water when you come close
  const crabs = Array.from({ length: 14 }, () => {
    const s = spawn(crabT, 0, 0.8 + rnd() * 0.5);
    group.add(s.node);
    const x = 60 + rnd() * 300;
    return { ...s, x, z: 0, hx: x, yaw: rnd() * TAU, run: 0, hide: 0 };
  });
  const coast = { d: 0, dx: 0, dz: 0, lag: 0 };
  // the swash line along the village beach, found once per crab
  for (const c of crabs) {
    let z = 380;
    while (z < 410 && groundAt(c.x, z) > 0.45) z += 0.5;
    c.z = c.hz = z - 2 - rnd() * 4;
  }
  function updateCrab(c, dt, cam) {
    const d = Math.hypot(cam.x - c.x, cam.z - c.z);
    if (d < 6 && c.hide <= 0) c.run = 1.6;
    if (c.run > 0) {
      c.run -= dt;
      hf.coastAt(c.x, c.z, coast);
      // sideways toward the sea, then gone into a hole
      c.x += -coast.dx * 2.2 * dt;
      c.z += -coast.dz * 2.2 * dt;
      if (c.run <= 0) c.hide = 12;
    }
    if (c.hide > 0) {
      c.hide -= dt;
      if (c.hide <= 0) { c.x = c.hx + (rnd() - 0.5) * 6; c.z = c.hz + (rnd() - 0.5) * 2; }
    }
    const y = groundAt(c.x, c.z) + crabT.half * 0.8 - (c.hide > 0 ? 0.4 : 0);
    c.node.position.set(c.x, y, c.z);
    c.node.rotation.y = c.yaw;
    if (c.action) c.action.timeScale = c.run > 0 ? 3 : 1;
  }

  // ---------------------------------------------------------------- tick, with distance culling
  const cam = new THREE.Vector3();
  const tick = (list, fn, far, dt, extra) => {
    for (const a of list) {
      const p = a.node.position;
      const d = Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z);
      a.node.visible = d < far;
      fn(a, dt, extra);
      if (a.mixer && a.node.visible) a.mixer.update(dt);
    }
  };
  function update(camera, dt) {
    cam.copy(camera.position);
    pod.s += pod.speed * dt;
    tick(whales, updateWhale, 2600, dt);
    tick(dolphins, updateDolphin, 900, dt);
    tick(turtles, updateTurtle, 160, dt);
    tick(mantas, updateManta, 220, dt);
    tick(sharks, updateShark, 160, dt);
    tick(birds, updateBird, 700, dt);
    tick(crabs, updateCrab, 45, dt, cam);
  }
  Object.assign(F, { group, update, whales, dolphins, turtles, mantas, sharks, birds, crabs, pod });
  return F;
}
