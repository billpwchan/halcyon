// Fireflies along the forest edges of the trails and gardens after dark: each drifts on its own loop and
// flashes in its own rhythm, a slow yellow-green pulse with long dark gaps. All motion is in the vertex shader.
import * as THREE from 'three';
import { U, COMMON } from '../core/shared.js';
import { LAYER_FX } from '../core/pipeline.js';
import { PATHS } from '../world/layout.js';
import { PLAN, along, polyLength } from '../world/plan.js';

export function createFireflies(hf, n = 900) {
  let seed = 4242;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pos = [], aux = [];
  const spots = [];
  for (const p of PATHS) spots.push({ pts: p.pts, L: polyLength(p.pts), w: p.w });
  let tries = 0;
  while (pos.length < n * 3 && tries++ < n * 40) {
    let x, z;
    const u = r();
    if (u < 0.45) {
      // most along the trails, thickest near the village end where people walk at night
      const sp = spots[Math.floor(r() * spots.length)];
      const a = along(sp.pts, Math.pow(r(), 2.2) * sp.L);
      const side = r() < 0.5 ? -1 : 1, off = sp.w / 2 + 2 + r() * 12;
      x = a.x + a.tz * side * off; z = a.z - a.tx * side * off;
    } else {
      const hs = PLAN.houses[Math.floor(r() * PLAN.houses.length)];
      const ang = r() * Math.PI * 2, d = 7 + r() * 12;
      x = hs.x + Math.cos(ang) * d; z = hs.z + Math.sin(ang) * d;
    }
    const g = hf.heightAt(x, z);
    if (g < 1.2 || g > 60) continue;
    pos.push(x, g + 0.4 + r() * 2.6, z);
    // drift radius, phase, blink period, blink offset
    aux.push(0.6 + r() * 1.8, r() * 6.283, 2.2 + r() * 3.8, r());
  }
  const count = pos.length / 3;
  const base = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  g.attributes.position = base.attributes.position;
  g.attributes.uv = base.attributes.uv;
  g.setAttribute('iPos', new THREE.InstancedBufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('iAux', new THREE.InstancedBufferAttribute(new Float32Array(aux), 4));
  g.instanceCount = count;
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...U, uK: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform float uTime, uK;
      attribute vec3 iPos; attribute vec4 iAux;
      varying vec2 vUv; varying float vK; varying vec3 vWP;
      void main(){
        vUv = uv * 2.0 - 1.0;
        float t = uTime * 0.35 + iAux.y;
        vec3 p = iPos + vec3(sin(t) * iAux.x + sin(t * 2.3 + 1.0) * 0.3, sin(t * 1.7 + iAux.y) * 0.45, cos(t * 0.8) * iAux.x + cos(t * 2.9) * 0.25);
        vWP = p;
        // a flash is a quick rise and a slower fade, then dark for the rest of the period
        float ph = fract(uTime / iAux.z + iAux.w);
        float flash = smoothstep(0.0, 0.08, ph) * (1.0 - smoothstep(0.1, 0.45, ph));
        vK = flash * uK;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        float d = -mv.z;
        float size = clamp(0.09, d * 0.0035, d * 0.05) * (vK > 0.002 ? 1.0 : 0.0);
        mv.xy += position.xy * size * 2.0;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      varying vec2 vUv; varying float vK; varying vec3 vWP;
      void main(){
        float r2 = dot(vUv, vUv);
        if (r2 > 1.0 || vK < 0.002) discard;
        float core = exp(-r2 * 30.0) * 2.5 + exp(-r2 * 6.0) * 0.18;
        vec3 v = vWP - cameraPosition; float dist = length(v);
        float T = exp(-hHazeOD(cameraPosition, v / dist, dist));
        gl_FragColor = vec4(vec3(0.62, 1.0, 0.22) * core * vK * T * 2.2, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.layers.set(LAYER_FX);
  mesh.visible = false;
  return {
    mesh,
    count,
    update() {
      const k = THREE.MathUtils.smoothstep(U.uNight.value, 0.6, 0.9) * (1 - U.uRain.value);
      mat.uniforms.uK.value = k;
      mesh.visible = k > 0.01;
    },
  };
}
