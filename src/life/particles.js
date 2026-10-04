// Spray and mist: whale blows, breach splashes, dolphin entries. A fixed pool of soft billboards, lit by sun and sky.
import * as THREE from 'three';
import { U, COMMON } from '../core/shared.js';
import { LAYER_FX } from '../core/pipeline.js';

const N = 2000;

export function createParticles() {
  const pos = new Float32Array(N * 3), vel = new Float32Array(N * 3);
  const age = new Float32Array(N).fill(1e9), life = new Float32Array(N).fill(1), size0 = new Float32Array(N), size1 = new Float32Array(N), kind = new Uint8Array(N);
  const aPos = new Float32Array(N * 4), aAux = new Float32Array(N * 4);
  const base = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  g.attributes.position = base.attributes.position;
  g.attributes.uv = base.attributes.uv;
  const iPos = new THREE.InstancedBufferAttribute(aPos, 4).setUsage(THREE.DynamicDrawUsage);
  const iAux = new THREE.InstancedBufferAttribute(aAux, 4).setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('iPos', iPos);
  g.setAttribute('iAux', iAux);
  g.instanceCount = 0;
  const mat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexShader: /* glsl */ `
      attribute vec4 iPos; attribute vec4 iAux; // xyz, size | alpha, kind, rot, -
      varying vec2 vUv; varying float vA; varying vec3 vWP; varying float vKind;
      void main(){
        vec2 c = position.xy;
        float s = sin(iAux.z), co = cos(iAux.z);
        c = vec2(c.x * co - c.y * s, c.x * s + c.y * co);
        vUv = c * 2.0;
        vA = iAux.x; vKind = iAux.y; vWP = iPos.xyz;
        vec4 mv = viewMatrix * vec4(iPos.xyz, 1.0);
        mv.xy += position.xy * iPos.w;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      varying vec2 vUv; varying float vA; varying vec3 vWP; varying float vKind;
      void main(){
        float r2 = dot(vUv, vUv);
        if (r2 > 1.0) discard;
        // mist is a soft puff, spray a denser droplet core
        float nz = hNoise(vUv * 3.0 + vWP.xz * 0.7);
        float m = vKind > 0.5 ? smoothstep(1.0, 0.15, r2) * (0.6 + 0.4 * nz) : (1.0 - r2) * (1.0 - r2) * (0.65 + 0.35 * nz);
        vec3 lit = uSunCol * max(uSunDir.y, 0.0) * hSunVis(vWP) * 0.45 + hAmbient(vec3(0.0, 1.0, 0.0)) * 3.14159 * 0.8;
        vec3 col = hAtmos(lit * vec3(0.95, 0.98, 1.0), vWP);
        gl_FragColor = vec4(col, m * vA);
      }`,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.layers.set(LAYER_FX);

  let head = 0;
  const rnd = Math.random;
  // kind 0: mist (rises, slows, swells), kind 1: spray (ballistic droplets)
  function emit(x, y, z, vx, vy, vz, spread, n, lifeS, s0, s1, k) {
    for (let i = 0; i < n; i++) {
      const j = head;
      head = (head + 1) % N;
      pos[j * 3] = x + (rnd() - 0.5) * spread * 0.3;
      pos[j * 3 + 1] = y;
      pos[j * 3 + 2] = z + (rnd() - 0.5) * spread * 0.3;
      vel[j * 3] = vx + (rnd() - 0.5) * spread;
      vel[j * 3 + 1] = vy * (0.6 + rnd() * 0.5);
      vel[j * 3 + 2] = vz + (rnd() - 0.5) * spread;
      age[j] = 0;
      life[j] = lifeS * (0.6 + rnd() * 0.6);
      size0[j] = s0 * (0.7 + rnd() * 0.6);
      size1[j] = s1 * (0.7 + rnd() * 0.6);
      kind[j] = k;
    }
  }
  // a ring: water thrown up and out from the rim of an impact, the crown of a splash
  function emitRing(x, y, z, r0, r1, vOut, vUp, n, lifeS, s0, s1, k) {
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2, rr = r0 + (r1 - r0) * rnd(), c = Math.cos(a), s = Math.sin(a);
      const up = vUp * (0.55 + rnd() * 0.6);
      emit(x + c * rr, y, z + s * rr, c * vOut * (0.5 + rnd() * 0.8), up / 0.85, s * vOut * (0.5 + rnd() * 0.8), 0.6, 1, lifeS, s0, s1, k);
    }
  }
  function update(dt, camera) {
    let n = 0;
    const wx = U.uWind.value.x * U.uWind.value.z * 2.5, wz = U.uWind.value.y * U.uWind.value.z * 2.5;
    for (let j = 0; j < N; j++) {
      if (age[j] >= life[j]) continue;
      age[j] += dt;
      const t = age[j] / life[j];
      if (t >= 1) continue;
      const i3 = j * 3;
      if (kind[j] === 1) {
        const ad = Math.exp(-dt * 0.5);
        vel[i3] *= ad; vel[i3 + 2] *= ad;
        vel[i3 + 1] -= 9.8 * dt;
        if (pos[i3 + 1] < 0 && vel[i3 + 1] < 0) { age[j] = life[j]; continue; }
      } else {
        const drag = Math.exp(-dt * 1.6);
        vel[i3] = (vel[i3] - wx) * drag + wx;
        vel[i3 + 1] = vel[i3 + 1] * drag + 0.25 * dt;
        vel[i3 + 2] = (vel[i3 + 2] - wz) * drag + wz;
      }
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;
      const k = n * 4;
      aPos[k] = pos[i3]; aPos[k + 1] = pos[i3 + 1]; aPos[k + 2] = pos[i3 + 2];
      aPos[k + 3] = size0[j] + (size1[j] - size0[j]) * Math.sqrt(t);
      aAux[k] = (kind[j] ? 0.9 : 0.4) * Math.min(1, t * 8) * (1 - t) * (1 - t);
      aAux[k + 1] = kind[j];
      aAux[k + 2] = j * 1.7;
      n++;
    }
    g.instanceCount = n;
    if (n) {
      iPos.addUpdateRange(0, n * 4);
      iAux.addUpdateRange(0, n * 4);
      iPos.needsUpdate = iAux.needsUpdate = true;
    }
  }
  return { mesh, emit, emitRing, update };
}
