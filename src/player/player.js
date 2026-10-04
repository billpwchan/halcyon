// How you move: walk the sand, piers and boardwalks; swim and dive; sail the outrigger; fly; or ride the tour.
import * as THREE from 'three';
import { U } from '../core/shared.js';
import { PLAN } from '../world/plan.js';
import { POIS, LIGHTHOUSE, PIER } from '../world/layout.js';
import { modelParts, bakeParts } from '../core/models.js';

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
export const MODES = ['walk', 'swim', 'sail', 'fly', 'tour'];

// distance from (x, z) to a polyline
function distPoly(pts, x, z) {
  let best = 1e9;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
    const dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
  }
  return best;
}

// the tour: hand-placed keyframes, [camera, look-at], visiting every place in one unbroken move
const TOUR = [
  [[620, 140, 1250], [80, 20, 300]],
  [[330, 40, 760], [168, 4, 520]],
  [[190, 7, 640], [168, 3, 470]],
  [[150, 4.2, 520], [170, 4, 360]],
  [[230, 9, 420], [310, 3, 460]],
  [[380, 6, 520], [300, 3, 450]],
  [[520, 3.5, 700], [300, 1, 780]],
  [[120, 2.2, 820], [-200, 1, 760]],
  [[-420, 3, 740], [-700, 2, 560]],
  [[-900, 9, 560], [-1250, 6, 400]],
  [[-1240, 22, 330], [LIGHTHOUSE.x, 18, LIGHTHOUSE.z]],
  [[-1240, 34, 80], [LIGHTHOUSE.x, 14, LIGHTHOUSE.z]],
  [[-700, 95, -120], [-70, 230, -150]],
  [[-360, 280, -440], [-70, 290, -150]],
  [[120, 370, -460], [-70, 250, -150]],
  [[700, 200, 150], [300, 40, 300]],
];

export async function createPlayer({ camera, canvas, hf, ripples, particles, built, coral }) {
  const P = {
    mode: 'fly',
    pos: camera.position.clone(),
    vel: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    speedFly: 30,
    vy: 0,
    grounded: false,
    input: { mx: 0, mz: 0, up: 0, look: [0, 0], run: false }, // touch and UI feed this
    onMode: null,
  };
  const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
  P.yaw = e.y; P.pitch = e.x;
  const lastQ = camera.quaternion.clone();
  const lastP = camera.position.clone();

  // ---------------------------------------------------------------- input
  const keys = new Set();
  const typing = () => document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName);
  window.addEventListener('keydown', (ev) => { if (!typing()) keys.add(ev.code); });
  window.addEventListener('keyup', (ev) => keys.delete(ev.code));
  window.addEventListener('blur', () => keys.clear());
  let drag = null;
  canvas.addEventListener('pointerdown', (ev) => { if (ev.pointerType === 'mouse' && ev.button === 0) { drag = { x: ev.clientX, y: ev.clientY }; canvas.setPointerCapture(ev.pointerId); } });
  canvas.addEventListener('pointerup', (ev) => { drag = null; canvas.releasePointerCapture?.(ev.pointerId); });
  canvas.addEventListener('dblclick', () => canvas.requestPointerLock?.());
  const look = (dx, dy) => {
    if (P.mode === 'tour') { P.setMode('fly'); }
    P.yaw -= dx * 0.0024;
    P.pitch = Math.max(-1.45, Math.min(1.45, P.pitch - dy * 0.0024));
  };
  window.addEventListener('pointermove', (ev) => {
    if (document.pointerLockElement === canvas) return look(ev.movementX, ev.movementY);
    if (!drag) return;
    look(ev.clientX - drag.x, ev.clientY - drag.y);
    drag.x = ev.clientX; drag.y = ev.clientY;
  });
  canvas.addEventListener('wheel', (ev) => {
    if (P.mode === 'fly') P.speedFly = Math.max(4, Math.min(240, P.speedFly * Math.exp(-ev.deltaY * 0.0012)));
    if (P.mode === 'sail') boat.zoom = Math.max(0.6, Math.min(2.5, boat.zoom * Math.exp(ev.deltaY * 0.001)));
  }, { passive: true });

  const axis = () => {
    const I = P.input;
    let f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) + I.mz;
    let s = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) + I.mx;
    const u = (keys.has('Space') || keys.has('KeyE') ? 1 : 0) - (keys.has('KeyC') || keys.has('KeyQ') || keys.has('ControlLeft') ? 1 : 0) + I.up;
    const l = Math.hypot(f, s);
    if (l > 1) { f /= l; s /= l; }
    if (I.look[0] || I.look[1]) { look(I.look[0], I.look[1]); I.look[0] = I.look[1] = 0; }
    return { f, s, u: Math.max(-1, Math.min(1, u)), run: keys.has('ShiftLeft') || keys.has('ShiftRight') || I.run };
  };

  // ---------------------------------------------------------------- the world as a walker sees it
  const W = PLAN.walk;
  const walkLines = [{ pts: W.spine, w: W.w, deck: W.deck }, { pts: W.arc, w: W.w, deck: W.deck }, ...PLAN.bungalows.map((b) => ({ pts: b.spur, w: 1.8, deck: W.deck }))];
  const floorAt = (x, z) => {
    let g = hf.solidAt(x, z);
    const pier = Math.abs(x - PIER.x) < PIER.w / 2 && z > PIER.z0 - 1 && z < PIER.z1 - PIER.headD;
    const head = Math.abs(x - PIER.x) < PIER.headW / 2 && z >= PIER.z1 - PIER.headD && z < PIER.z1;
    if (pier || head) g = Math.max(g, PIER.deck);
    for (const l of walkLines) if (distPoly(l.pts, x, z) < l.w / 2 + 0.05) g = Math.max(g, l.deck);
    for (const b of PLAN.bungalows) if (Math.hypot(x - b.x, z - b.z) < 5.6) g = Math.max(g, W.deck + 0.2);
    return g;
  };
  const solids = PLAN.footprints.filter((f) => f.r > 2).map((f) => ({ ...f, r: f.r * 0.8 }));
  const pushOut = (p) => {
    for (const s of solids) {
      const dx = p.x - s.x, dz = p.z - s.z, d = Math.hypot(dx, dz);
      if (d < s.r && d > 1e-3) { p.x = s.x + (dx / d) * s.r; p.z = s.z + (dz / d) * s.r; }
    }
  };
  const coast = { d: 0, dx: 0, dz: 0, lag: 0 };
  // the surface the swimmer and the boat ride: a few long swells, calmer inside the reef
  const waterAt = (x, z, t) => {
    hf.coastAt(x, z, coast);
    const amp = (0.12 + 0.5 * (1 - coast.lag)) * U.uSwell.value;
    return amp * (Math.sin(x * 0.11 + t * 1.3) * 0.5 + Math.sin(z * 0.083 - t * 1.05 + 1.7) * 0.35 + Math.sin((x + z) * 0.19 + t * 1.9) * 0.15);
  };

  // ---------------------------------------------------------------- the boat
  // the dhow from the pier head: a lateen-rigged work boat, bow on +z (its parts are already adopted by the built world)
  const dhow = await modelParts('dhow', { width: 7.5, yaw: Math.PI / 2 });
  const boatMesh = new THREE.Group();
  boatMesh.add(...bakeParts(dhow.parts, [{ matrix: new THREE.Matrix4() }]));
  boatMesh.visible = false;
  const boat = { x: PIER.x - PIER.headW / 2 - 3.2, z: PIER.z1 - 4, h: 0.05, v: 0, rud: 0, zoom: 1, camYaw: 0, pitch: 0, roll: 0, y: 0, mesh: boatMesh };

  // ---------------------------------------------------------------- the tour spline
  const curveP = new THREE.CatmullRomCurve3(TOUR.map((k) => new THREE.Vector3(...k[0])), true, 'centripetal');
  const curveL = new THREE.CatmullRomCurve3(TOUR.map((k) => new THREE.Vector3(...k[1])), true, 'centripetal');
  const tourLen = curveP.getLength();
  const tour = { u: 0, speed: 1, look: new THREE.Vector3() };
  const tv = new THREE.Vector3(), tl = new THREE.Vector3();

  P.setMode = (m, opts = {}) => {
    if (m === P.mode && !opts.force) return;
    const prev = P.mode;
    P.mode = m;
    P.vel.set(0, 0, 0);
    P.vy = 0;
    if (m === 'walk') {
      // walking starts where we waded out, or on the nearest dry land if the eye is over the sea or in the air
      const target = opts.at || (floorAt(P.pos.x, P.pos.z) < -0.5 || prev === 'fly' || prev === 'tour' || prev === 'sail' ? nearestShore(P.pos) : null);
      if (target) {
        P.pos.set(target[0], floorAt(target[0], target[1]) + 1.65, target[1]);
        // arriving by air or sea, turn to face the water: the pier runs out ahead
        if (!opts.at) { P.yaw = target[2] ?? Math.PI; P.pitch = -0.04; }
      }
    }
    if (m === 'swim') {
      // walked in from the beach: carry on from here; otherwise go in off the pier head
      const inWater = prev === 'walk' && floorAt(P.pos.x, P.pos.z) < -1.2;
      if (!inWater) P.pos.set(PIER.x + 6, 0.2, PIER.z1 + 4);
      P.pos.y = 0.2;
    }
    if (m === 'sail') {
      boat.x = PIER.x - PIER.headW / 2 - 3.2; boat.z = PIER.z1 - 4; boat.h = 0.05; boat.v = 0;
      boat.camYaw = 0;
      P.yaw = boat.h + Math.PI; P.pitch = -0.12;
    }
    boatMesh.visible = m === 'sail';
    if (built.moored[0]) built.moored[0].g.visible = m !== 'sail';
    if (m === 'tour') {
      // join the tour at the keyframe nearest the camera
      let best = 0, bd = 1e12;
      for (let i = 0; i < 400; i++) { const d = curveP.getPointAt(i / 400, tv).distanceToSquared(camera.position); if (d < bd) { bd = d; best = i / 400; } }
      tour.u = best;
    }
    if (m === 'fly') { P.pos.copy(camera.position); }
    P.onMode?.(m, prev);
  };
  function nearestShore(p) {
    // prefer the village beach, else spiral out from where we are
    if (Math.hypot(p.x - 175, p.z - 390) < 900) return [168, 372, Math.PI];
    for (let r = 0; r < 800; r += 8) for (let a = 0; a < 6.28; a += 0.4) {
      const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
      if (hf.heightAt(x, z) > 0.8) return [x, z];
    }
    return [168, 372];
  }

  const fwd = new THREE.Vector3(), right = new THREE.Vector3();
  let t = 0, bob = 0, stampT = 0;
  function update(dt) {
    t += dt;
    // a script or the debug URL moved the camera: follow it instead of fighting it
    if (!camera.quaternion.equals(lastQ) || !camera.position.equals(lastP)) {
      const e2 = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
      P.yaw = e2.y; P.pitch = e2.x;
      P.pos.copy(camera.position);
    }
    const a = axis();
    const sy = Math.sin(P.yaw), cy = Math.cos(P.yaw);
    fwd.set(-sy, 0, -cy);
    right.set(cy, 0, -sy);
    U.uSwimmer.value.set(0, -999, 0, 0);

    switch (P.mode) {
      case 'fly': {
        const sp = P.speedFly * (a.run ? 4 : 1);
        const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(P.pitch, P.yaw, 0, 'YXZ'));
        const want = dir.multiplyScalar(a.f * sp).addScaledVector(right, a.s * sp);
        want.y += a.u * sp * 0.7;
        P.vel.x = damp(P.vel.x, want.x, 4, dt); P.vel.y = damp(P.vel.y, want.y, 4, dt); P.vel.z = damp(P.vel.z, want.z, 4, dt);
        P.pos.addScaledVector(P.vel, dt);
        const floor = Math.max(hf.heightAt(P.pos.x, P.pos.z), -400) + 1.2;
        if (P.pos.y < floor && P.pos.y > -0.3) P.pos.y = floor;
        camera.position.copy(P.pos);
        camera.quaternion.setFromEuler(new THREE.Euler(P.pitch, P.yaw, 0, 'YXZ'));
        break;
      }
      case 'walk': {
        const sp = a.run ? 7.5 : 3.6;
        const wx = (fwd.x * a.f + right.x * a.s) * sp, wz = (fwd.z * a.f + right.z * a.s) * sp;
        P.vel.x = damp(P.vel.x, wx, 10, dt); P.vel.z = damp(P.vel.z, wz, 10, dt);
        const nx = P.pos.x + P.vel.x * dt, nz = P.pos.z + P.vel.z * dt;
        const g0 = floorAt(P.pos.x, P.pos.z), g1 = floorAt(nx, nz);
        // cliffs and walls stop you; a step onto a deck or a dune does not
        if (g1 - g0 < 0.7 || g1 - g0 < Math.hypot(nx - P.pos.x, nz - P.pos.z) * 1.2) { P.pos.x = nx; P.pos.z = nz; }
        pushOut(P.pos);
        const g = floorAt(P.pos.x, P.pos.z);
        if (keys.has('Space') && P.grounded) { P.vy = 4.2; P.grounded = false; }
        P.vy -= 12 * dt;
        let feet = P.pos.y - 1.65 + P.vy * dt;
        if (feet <= g) { feet = g; P.vy = 0; P.grounded = true; }
        // deep enough to swim
        if (g < -1.25 && feet < 0.2) { P.setMode('swim'); break; }
        const moving = Math.hypot(P.vel.x, P.vel.z);
        bob += dt * moving * 2.2;
        P.pos.y = feet + 1.65;
        camera.position.set(P.pos.x, P.pos.y + Math.sin(bob) * 0.035 * Math.min(moving / 3, 1.5), P.pos.z);
        camera.quaternion.setFromEuler(new THREE.Euler(P.pitch, P.yaw, Math.sin(bob * 0.5) * 0.004 * moving, 'YXZ'));
        break;
      }
      case 'swim':
      case 'dive': {
        const under = P.mode === 'dive';
        const sp = (a.run ? 2.8 : 1.5) * (under ? 1.2 : 1);
        const dir = under ? new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(P.pitch, P.yaw, 0, 'YXZ')) : fwd.clone();
        const want = dir.multiplyScalar(a.f * sp).addScaledVector(right, a.s * sp);
        if (under) want.y += a.u * sp * 0.8 + 0.12; // a little buoyant
        P.vel.x = damp(P.vel.x, want.x, 2.5, dt); P.vel.y = damp(P.vel.y, want.y, 2.5, dt); P.vel.z = damp(P.vel.z, want.z, 2.5, dt);
        P.pos.x += P.vel.x * dt; P.pos.z += P.vel.z * dt;
        const g = floorAt(P.pos.x, P.pos.z);
        const surf = waterAt(P.pos.x, P.pos.z, t);
        if (!under) {
          if (a.u < -0.5 || (a.f > 0 && P.pitch < -0.5)) { P.mode = 'dive'; P.onMode?.('dive', 'swim'); P.pos.y = surf - 0.6; }
          P.pos.y = damp(P.pos.y, surf + 0.16, 6, dt);
          if (g > -1.0) { P.setMode('walk', { at: [P.pos.x, P.pos.z] }); break; }
        } else {
          P.pos.y += P.vel.y * dt;
          coral.push(P.pos, 0.4);
          P.pos.y = Math.max(P.pos.y, g + 0.45);
          if (P.pos.y > surf - 0.25 && P.vel.y > 0) { P.mode = 'swim'; P.onMode?.('swim', 'dive'); }
        }
        camera.position.copy(P.pos);
        camera.quaternion.setFromEuler(new THREE.Euler(P.pitch, P.yaw, under ? 0 : Math.sin(t * 1.1) * 0.02, 'YXZ'));
        const spd = Math.hypot(P.vel.x, P.vel.z);
        U.uSwimmer.value.set(P.pos.x, P.pos.y, P.pos.z, spd);
        stampT -= dt;
        if (!under && spd > 0.3 && stampT <= 0) { ripples.stamp(P.pos.x + fwd.x * 0.6, P.pos.z + fwd.z * 0.6, 0.6, 0.35, 0.05); stampT = 0.12; }
        break;
      }
      case 'sail': {
        const b = boat;
        // paddle and sail: thrust ahead, a rudder that bites with speed
        const thrust = a.f > 0 ? a.f * (a.run ? 2.2 : 1.3) : a.f * 0.8;
        b.v += (thrust - b.v * 0.22 - Math.sign(b.v) * b.v * b.v * 0.03) * dt;
        b.rud = damp(b.rud, -a.s, 3, dt);
        b.h += b.rud * 0.35 * dt * Math.min(Math.abs(b.v), 3) * Math.sign(b.v || 1);
        let nx = b.x + Math.sin(b.h) * b.v * dt, nz = b.z + Math.cos(b.h) * b.v * dt;
        // the hull grounds on sand and stops at the pier
        const bowX = nx + Math.sin(b.h) * 3.4 * Math.sign(b.v || 1), bowZ = nz + Math.cos(b.h) * 3.4 * Math.sign(b.v || 1);
        const onPier = Math.abs(bowX - PIER.x) < PIER.w / 2 + 0.4 && bowZ > PIER.z0 && bowZ < PIER.z1 - PIER.headD + 0.4 || (Math.abs(bowX - PIER.x) < PIER.headW / 2 + 0.4 && bowZ > PIER.z1 - PIER.headD - 0.4 && bowZ < PIER.z1 + 0.4);
        if (hf.heightAt(bowX, bowZ) > -0.95 || onPier) { b.v *= -0.25; nx = b.x; nz = b.z; }
        b.x = nx; b.z = nz;
        const s0 = waterAt(b.x + Math.sin(b.h) * 3, b.z + Math.cos(b.h) * 3, t), s1 = waterAt(b.x - Math.sin(b.h) * 3, b.z - Math.cos(b.h) * 3, t);
        const s2 = waterAt(b.x + Math.cos(b.h) * 1.5, b.z - Math.sin(b.h) * 1.5, t), s3 = waterAt(b.x - Math.cos(b.h) * 1.5, b.z + Math.sin(b.h) * 1.5, t);
        b.y = damp(b.y, (s0 + s1 + s2 + s3) / 4 - 0.9, 5, dt);
        b.pitch = damp(b.pitch, Math.atan2(s0 - s1, 6) - b.v * 0.012, 4, dt);
        b.roll = damp(b.roll, Math.atan2(s2 - s3, 3) + b.rud * Math.abs(b.v) * 0.025, 4, dt);
        boatMesh.position.set(b.x, b.y, b.z);
        boatMesh.rotation.set(-b.pitch, b.h, b.roll, 'YXZ');
        // wake: a V of stamps off the hull, foamier with speed
        stampT -= dt;
        const sp = Math.abs(b.v);
        if (sp > 0.4 && stampT <= 0) {
          stampT = 0.07;
          for (const side of [-1, 1]) ripples.stamp(b.x - Math.sin(b.h) * 2.6 + Math.cos(b.h) * side * 0.5, b.z - Math.cos(b.h) * 2.6 - Math.sin(b.h) * side * 0.5, 0.45 + sp * 0.06, Math.min(sp * 0.03, 0.18), 0.03 + sp * 0.008);
          ripples.stamp(b.x + Math.sin(b.h) * 3.3, b.z + Math.cos(b.h) * 3.3, 0.4, Math.min(sp * 0.04, 0.2), 0.04);
        }
        U.uBoat.value.set(b.x, b.z, b.h, b.v);
        // chase camera: behind and above, free to look around
        const camYaw = P.yaw;
        const dist = 9.5 * b.zoom, h = 3.4 * b.zoom;
        const cx = b.x + Math.sin(camYaw) * dist * Math.cos(P.pitch), cz = b.z + Math.cos(camYaw) * dist * Math.cos(P.pitch);
        const cyy = Math.max(b.y + h - Math.sin(P.pitch) * dist, 0.6);
        camera.position.set(damp(camera.position.x, cx, 8, dt), damp(camera.position.y, cyy, 8, dt), damp(camera.position.z, cz, 8, dt));
        // the camera swings in behind the hull when you sail and leave the mouse alone
        if (sp > 1 && !drag) P.yaw = damp(P.yaw, P.yaw + wrapA(b.h + Math.PI - P.yaw), 0.6, dt);
        camera.lookAt(b.x, b.y + 1.6, b.z);
        P.pos.copy(camera.position);
        break;
      }
      case 'tour': {
        // constant speed along the path, slower where the keyframes bunch up
        tour.u = (tour.u + (dt * 9 * tour.speed) / tourLen) % 1;
        curveP.getPointAt(tour.u, tv);
        curveL.getPointAt(tour.u, tl);
        if (!tour.init) { tour.look.copy(tl); tour.init = true; }
        tour.look.lerp(tl, 1 - Math.exp(-dt * 1.5));
        const fl = hf.heightAt(tv.x, tv.z) + 2;
        camera.position.set(tv.x, Math.max(tv.y, fl), tv.z);
        camera.lookAt(tour.look);
        P.pos.copy(camera.position);
        const e3 = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
        P.yaw = e3.y; P.pitch = e3.x;
        if (a.f || a.s || a.u) P.setMode('fly');
        break;
      }
    }
    camera.updateMatrixWorld();
    lastQ.copy(camera.quaternion);
    lastP.copy(camera.position);
  }

  // where the camera is, in words: the nearest place and the height above what is under you
  P.place = () => {
    let best = null, bd = 1e9;
    for (const p of POIS) {
      const d = Math.hypot(camera.position.x - p.x, camera.position.z - p.z) / p.r;
      if (d < bd) { bd = d; best = p; }
    }
    return { poi: bd < 1 ? best : null, near: best, d: bd };
  };
  P.update = update;
  P.boat = boat;
  P.boatMesh = boatMesh;
  P.floorAt = floorAt;
  P.waterAt = waterAt;
  P.tour = tour;
  return P;
}
