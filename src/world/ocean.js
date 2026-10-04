// Ocean surface: CDLOD grid displaced by the FFT cascades, attenuated by depth and by the reef, with breaking
// shore waves and swash, a ripple simulation for wakes and splashes, and full shading: refraction with
// physically based absorption, sky and screen-space reflections, foam, sub-surface glow, Snell's window from
// below and bioluminescence at night.
import * as THREE from 'three';
import { U, UNIFORMS_GLSL, NOISE, SKYLIB, SUNVIS, ATMOS, SHORE } from '../core/shared.js';
import { fs, pass, rt } from '../core/gpu.js';
import { CASCADES, N as FFT_N } from './oceansim.js';

const LEAF = 8;
const GRID = 16;
const LEVELS = 13;
const R0 = 48;
export const LAYER_WATER = 1;

// ------------------------------------------------------------------ foam lace texture (tiling)
function foamTexture(renderer) {
  const t = rt(512, 512, { type: THREE.UnsignedByteType, wrap: THREE.RepeatWrapping, mips: true, min: THREE.LinearMipmapLinearFilter });
  const m = pass(/* glsl */ `
    precision highp float; varying vec2 vUv;
    float h21(vec2 p, float per){ p = mod(p, per); vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    vec2 h22(vec2 p, float per){ return vec2(h21(p, per), h21(p + 19.19, per)); }
    // distance to cell edges: bubbles separated by thin films of foam
    float cells(vec2 p, float per){
      vec2 i = floor(p), f = fract(p); float d1 = 9.0, d2 = 9.0;
      for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){ vec2 g = vec2(x, y); vec2 o = h22(i + g, per); float d = length(g + o - f); if (d < d1){ d2 = d1; d1 = d; } else if (d < d2) d2 = d; }
      return d2 - d1;
    }
    float vn(vec2 p, float per){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(h21(i, per), h21(i + vec2(1, 0), per), u.x), mix(h21(i + vec2(0, 1), per), h21(i + vec2(1, 1), per), u.x), u.y); }
    void main(){
      vec2 p = vUv;
      float a = 1.0 - smoothstep(0.0, 0.12, cells(p * 12.0, 12.0));
      float b = 1.0 - smoothstep(0.0, 0.1, cells(p * 27.0 + 3.0, 27.0));
      float c = 1.0 - smoothstep(0.0, 0.08, cells(p * 61.0 + 7.0, 61.0));
      float n = vn(p * 8.0, 8.0) * 0.6 + vn(p * 23.0, 23.0) * 0.4;
      float lace = max(a * 0.85, max(b * 0.7, c * 0.5)) ;
      float dense = smoothstep(0.35, 0.75, n);
      gl_FragColor = vec4(lace, dense, n, 1.0);
    }`);
  fs.render(renderer, m, t);
  m.dispose();
  return t.texture;
}

// ------------------------------------------------------------------ ripples: wakes, splashes, swimmers
export class Ripples {
  constructor(renderer) {
    this.renderer = renderer;
    this.res = 512;
    this.size = 200; // metres
    this.texel = this.size / this.res;
    const o = { type: THREE.HalfFloatType, wrap: THREE.ClampToEdgeWrapping };
    this.a = rt(this.res, this.res, o);
    this.b = rt(this.res, this.res, o);
    this.origin = new THREE.Vector2(0, 0);
    this.box = new THREE.Vector4(-100, -100, this.size, 0);
    this.sim = pass(/* glsl */ `
      precision highp float; varying vec2 vUv;
      uniform sampler2D tPrev; uniform vec2 uShift, uTexel; uniform float uDt, uC2;
      void main(){
        vec2 uv = vUv + uShift;
        if (any(lessThan(uv, uTexel)) || any(greaterThan(uv, 1.0 - uTexel))) { gl_FragColor = vec4(0.0); return; }
        vec4 c = texture2D(tPrev, uv);
        float l = texture2D(tPrev, uv - vec2(uTexel.x, 0.0)).g, r = texture2D(tPrev, uv + vec2(uTexel.x, 0.0)).g;
        float d = texture2D(tPrev, uv - vec2(0.0, uTexel.y)).g, u = texture2D(tPrev, uv + vec2(0.0, uTexel.y)).g;
        float lap = l + r + d + u - 4.0 * c.g;
        float h = (2.0 * c.g - c.b + uC2 * lap) * 0.985;
        // foam: decays over a few seconds, spreads a little, and is raised where the ripples are steep
        float fl = texture2D(tPrev, uv - vec2(uTexel.x, 0.0)).r + texture2D(tPrev, uv + vec2(uTexel.x, 0.0)).r + texture2D(tPrev, uv - vec2(0.0, uTexel.y)).r + texture2D(tPrev, uv + vec2(0.0, uTexel.y)).r;
        float foam = mix(c.r, fl * 0.25, 0.04) * exp(-uDt / 2.5) + smoothstep(0.04, 0.14, abs(lap)) * uDt * 0.8;
        gl_FragColor = vec4(min(foam, 1.6), clamp(h, -2.0, 2.0), c.g, 1.0);
      }`, { tPrev: { value: null }, uShift: { value: new THREE.Vector2() }, uTexel: { value: new THREE.Vector2(1 / this.res, 1 / this.res) }, uDt: { value: 0.016 }, uC2: { value: 0.04 } });

    // stamps: instanced soft discs written with additive blending
    this.maxStamps = 256;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.stampAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.maxStamps * 4), 4); // x, z, radius, foam
    this.stampAttr2 = new THREE.InstancedBufferAttribute(new Float32Array(this.maxStamps), 1); // height impulse
    g.setAttribute('aS', this.stampAttr);
    g.setAttribute('aH', this.stampAttr2);
    this.stampMat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute vec4 aS; attribute float aH; uniform vec4 uBox;
        varying vec2 vP; varying float vF, vH;
        void main(){
          vP = position.xy; vF = aS.w; vH = aH;
          vec2 w = aS.xy + position.xy * aS.z;
          vec2 uv = (w - uBox.xy) / uBox.z;
          gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vP; varying float vF, vH;
        void main(){
          float r = dot(vP, vP);
          if (r > 1.0) discard;
          float k = (1.0 - r) * (1.0 - r);
          gl_FragColor = vec4(vF * k, vH * k, 0.0, 0.0);
        }`,
      uniforms: { uBox: { value: this.box } },
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.stampMesh = new THREE.Mesh(g, this.stampMat);
    this.stampMesh.frustumCulled = false;
    this.stampScene = new THREE.Scene();
    this.stampScene.add(this.stampMesh);
    this.stampCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.n = 0;
    this.texture = this.a.texture;
  }

  stamp(x, z, radius, foam, height) {
    if (this.n >= this.maxStamps) return;
    const a = this.stampAttr.array, k = this.n * 4;
    a[k] = x; a[k + 1] = z; a[k + 2] = radius; a[k + 3] = foam;
    this.stampAttr2.array[this.n] = height;
    this.n++;
  }

  update(dt, cx, cz) {
    const r = this.renderer;
    // follow the camera in whole texels
    const nx = Math.round(cx / this.texel) * this.texel, nz = Math.round(cz / this.texel) * this.texel;
    const sx = (nx - this.origin.x) / this.size, sz = (nz - this.origin.y) / this.size;
    this.origin.set(nx, nz);
    this.box.set(nx - this.size / 2, nz - this.size / 2, this.size, 0);
    const s = this.sim.uniforms;
    s.tPrev.value = this.a.texture;
    s.uShift.value.set(sx, sz);
    s.uDt.value = dt;
    fs.render(r, this.sim, this.b);
    if (this.n > 0) {
      this.stampMesh.geometry.instanceCount = this.n;
      this.stampAttr.needsUpdate = true;
      this.stampAttr2.needsUpdate = true;
      r.setRenderTarget(this.b);
      r.render(this.stampScene, this.stampCam);
      this.n = 0;
    }
    [this.a, this.b] = [this.b, this.a];
    this.texture = this.a.texture;
  }
}

// ------------------------------------------------------------------ surface
function gridGeometry() {
  const n = GRID + 1;
  const pos = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const k = (j * n + i) * 3; pos[k] = i; pos[k + 2] = j; }
  const idx = [];
  for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    if ((i + j) & 1) idx.push(a, c, b, b, c, d);
    else idx.push(a, c, d, a, d, b);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

const OCEAN_VERT = /* glsl */ `
${UNIFORMS_GLSL}
${NOISE}
${SHORE}
attribute vec4 aNode;
uniform vec2 uMorph[${LEVELS}];
uniform sampler2D tD0, tD1, tD2, tRip;
uniform vec3 uL;
uniform vec4 uRipBox;
varying vec3 vWP;
varying vec2 vXZ;
varying vec4 vCoast;
varying vec4 vAtt;
varying float vGround;
void main(){
  vec2 g = position.xz;
  float unit = aNode.z / ${GRID.toFixed(1)};
  vec2 xz = aNode.xy + g * unit;
  float dist = distance(cameraPosition, vec3(xz.x, 0.0, xz.y));
  vec2 mr = uMorph[int(aNode.w)];
  float mk = clamp((dist - mr.x) / (mr.y - mr.x), 0.0, 1.0);
  g -= fract(g * 0.5) * 2.0 * mk;
  xz = aNode.xy + g * unit;
  dist = distance(cameraPosition, vec3(xz.x, 0.0, xz.y));
  vec2 huv = (xz - uHF.xy) / uHF.z;
  bool inHF = all(greaterThan(huv, vec2(0.002))) && all(lessThan(huv, vec2(0.998)));
  float ground = inHF ? textureLod(tHeight, huv, 0.0).r : -500.0;
  vec4 cst = inHF ? textureLod(tCoast, huv, 0.0) : vec4(999.0, 0.0, 0.0, 0.0);
  float depth = -ground;
  float lag = cst.a;
  // the reef stops the swell; shallow water flattens the chop
  float aBig = mix(1.0, 0.07, lag) * smoothstep(0.0, 14.0, depth) * uSwell;
  float aMid = mix(1.0, 0.45, lag) * smoothstep(0.0, 3.5, depth) * mix(0.8, 1.3, clamp(uWind.z, 0.0, 1.5) / 1.5);
  float aSml = smoothstep(-0.1, 1.2, depth);
  float f1 = 1.0 - smoothstep(500.0, 1600.0, dist);
  float f2 = 1.0 - smoothstep(90.0, 260.0, dist);
  float lod0 = max(0.0, log2(dist / 220.0));
  float lod1 = max(0.0, log2(dist / 60.0));
  vec3 D = textureLod(tD0, xz / uL.x + ${(0.5 / FFT_N).toFixed(6)}, lod0).xyz * aBig;
  D += textureLod(tD1, xz / uL.y + ${(0.5 / FFT_N).toFixed(6)}, lod1).xyz * aMid * f1;
  D += textureLod(tD2, xz / uL.z + ${(0.5 / FFT_N).toFixed(6)}, 0.0).xyz * aSml * f2;
  vec4 sh = vec4(0.0);
  // shore waves move vertices only where the grid is fine enough to carry them; farther out a coarse
  // triangle would drag the waterline into a sawtooth, so there they live in the shading alone
  float shK = 1.0 - smoothstep(140.0, 360.0, dist);
  if (abs(cst.r) < 110.0 && shK > 0.0) {
    sh = hShore(xz, cst.r, lag, uTime) * shK;
    // the lip of a breaking wave leans toward the beach
    D.xz += cst.gb * sh.z * 0.9;
  }
  // likewise the swell near land, where the water meets a slope
  D *= mix(1.0, 1.0 - smoothstep(-2.0, 1.0, ground) * 0.85, smoothstep(200.0, 500.0, dist));
  // ripples from boats, swimmers and splashes
  vec2 ruv = (xz - uRipBox.xy) / uRipBox.z;
  float rip = 0.0;
  if (all(greaterThan(ruv, vec2(0.0))) && all(lessThan(ruv, vec2(1.0)))) rip = textureLod(tRip, ruv, 0.0).g * 0.35;
  vec3 wp = vec3(xz.x + D.x, D.y + sh.x + rip, xz.y + D.z);
  vWP = wp;
  vXZ = xz;
  vCoast = cst;
  vAtt = vec4(aBig, aMid * f1, aSml * f2, dist);
  vGround = ground;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const OCEAN_FRAG = /* glsl */ `
${UNIFORMS_GLSL}
${NOISE}
${SKYLIB}
${SUNVIS}
${ATMOS}
${SHORE}
uniform sampler2D tS0, tS1, tS2, tD0, tD1, tFoam, tRip, tScene, tDepth;
uniform vec3 uL;
uniform vec4 uRipBox;
uniform vec2 uRes, uNearFar;
uniform mat4 uVP;
uniform float uDbg;
varying vec3 vWP;
varying vec2 vXZ;
varying vec4 vCoast;
varying vec4 vAtt;
varying float vGround;

float linDepth(float d){ float z = d * 2.0 - 1.0; return 2.0 * uNearFar.x * uNearFar.y / (uNearFar.y + uNearFar.x - z * (uNearFar.y - uNearFar.x)); }
vec3 sceneAt(vec2 uv){ return texture2D(tScene, uv).rgb; }

// screen-space reflection: march the reflected ray against the opaque depth buffer, refine the crossing by
// bisection, and accept it only where the ray met something standing above the water
vec2 projUv(vec3 q, out float w){ vec4 c = uVP * vec4(q, 1.0); w = c.w; return c.xy / c.w * 0.5 + 0.5; }
vec4 ssr(vec3 p, vec3 R){
  float t = 1.0, tPrev = 0.0;
  for (int i = 0; i < 24; i++){
    float qd;
    vec2 uv = projUv(p + R * t, qd);
    if (qd <= 0.0 || any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) break;
    float sd = linDepth(texture2D(tDepth, uv).r);
    if (sd > uNearFar.y * 0.9) { tPrev = t; t *= 1.3; continue; }
    if (qd > sd + 0.05) {
      float a = tPrev, b = t;
      for (int j = 0; j < 5; j++){
        float m = (a + b) * 0.5, wm;
        vec2 um = projUv(p + R * m, wm);
        if (wm > linDepth(texture2D(tDepth, um).r)) b = m; else a = m;
      }
      float wh;
      vec3 qh = p + R * b;
      vec2 uh = projUv(qh, wh);
      float sdh = linDepth(texture2D(tDepth, uh).r);
      // passed behind something rather than into it
      if (wh - sdh > max(0.6, b * 0.05)) break;
      vec3 sp = cameraPosition + (qh - cameraPosition) * (sdh / wh);
      if (sp.y < 0.25) break;
      vec2 e = smoothstep(0.0, 0.06, uh) * smoothstep(1.0, 0.94, uh);
      return vec4(sceneAt(uh), e.x * e.y);
    }
    tPrev = t;
    t *= 1.3;
  }
  return vec4(0.0);
}

void main(){
  vec3 V = cameraPosition - vWP;
  float dist = length(V); V /= dist;
  bool under = uCamUnder > 0.5;
  float a0 = vAtt.x, a1 = vAtt.y, a2 = vAtt.z;
  // ---- normal: three cascades, then shore waves and ripples
  vec2 o = vec2(${(0.5 / FFT_N).toFixed(6)});
  vec4 s0 = texture2D(tS0, vXZ / uL.x + o);
  vec4 s1 = texture2D(tS1, vXZ / uL.y + o);
  vec4 s2 = texture2D(tS2, vXZ / uL.z + o);
  // the smallest cascade is kept in the normal well beyond where it stops displacing
  // each cascade leaves before its tiling period can be read as a grid
  float k2 = smoothstep(-0.1, 1.2, -vGround) * (1.0 - smoothstep(160.0, 650.0, vAtt.w));
  float k1 = max(a1, 0.6 * smoothstep(-0.1, 3.0, -vGround)) * (1.0 - 0.7 * smoothstep(900.0, 3500.0, vAtt.w));
  float sx = s0.x * a0 + s1.x * k1 + s2.x * k2;
  float sz = s0.y * a0 + s1.y * k1 + s2.y * k2;
  float dxx = s0.z * a0 + s1.z * a1, dzz = s0.w * a0 + s1.w * a1;
  vec3 N = normalize(vec3(-sx / max(1.0 + dxx, 0.2), 1.0, -sz / max(1.0 + dzz, 0.2)));
  // the shore field per pixel: interpolating it across coarse distant triangles leaves a sawtooth of foam
  vec2 huvF = (vXZ - uHF.xy) / uHF.z;
  bool inHF = all(greaterThan(huvF, vec2(0.0))) && all(lessThan(huvF, vec2(1.0)));
  vec4 cF = inHF ? texture2D(tCoast, huvF) : vec4(999.0, 0.0, 0.0, 0.0);
  // the waterline is decided per pixel against the heightfield, not by where two coarse meshes cross
  float gPix = inHF ? texture2D(tHeight, huvF).r : -500.0;
  // only give way where land is actually drawn right behind; where a coarse land triangle was itself let
  // through, keep the water rather than open a hole between the two
  if (!under && gPix > vWP.y + 0.015 && linDepth(texture2D(tDepth, gl_FragCoord.xy / uRes).r) - linDepth(gl_FragCoord.z) < 4.0) discard;
  vec4 shF = vec4(0.0);
  if (abs(cF.r) < 110.0) {
    shF = hShore(vXZ, cF.r, cF.a, uTime);
    float e = 0.5;
    float hx = hShore(vXZ + vec2(e, 0.0), cF.r - dot(cF.gb, vec2(e, 0.0)), cF.a, uTime).x;
    float hz = hShore(vXZ + vec2(0.0, e), cF.r - dot(cF.gb, vec2(0.0, e)), cF.a, uTime).x;
    N = normalize(N + vec3(-(hx - shF.x) / e, 0.0, -(hz - shF.x) / e) * 0.9);
  }
  vec2 ruv = (vXZ - uRipBox.xy) / uRipBox.z;
  float ripFoam = 0.0;
  if (all(greaterThan(ruv, vec2(0.002))) && all(lessThan(ruv, vec2(0.998)))) {
    vec2 tx = vec2(1.0 / 512.0, 0.0);
    vec4 rc = texture2D(tRip, ruv);
    float rl = texture2D(tRip, ruv - tx.xy).g, rr = texture2D(tRip, ruv + tx.xy).g;
    float rd = texture2D(tRip, ruv - tx.yx).g, ru = texture2D(tRip, ruv + tx.yx).g;
    float edge = smoothstep(0.0, 0.08, ruv.x) * smoothstep(1.0, 0.92, ruv.x) * smoothstep(0.0, 0.08, ruv.y) * smoothstep(1.0, 0.92, ruv.y);
    N = normalize(N + vec3(rl - rr, 0.0, rd - ru) * 1.6 * edge);
    ripFoam = rc.r * edge;
  }
  // rain rings
  if (uRain > 0.01) {
    vec2 rp = vXZ * 1.7;
    vec2 ci = floor(rp);
    float tt = uTime * 1.6 + hHash12(ci) * 10.0;
    vec2 c0 = ci + hHash22(ci + floor(tt)) * 0.8 + 0.1;
    float rr = length(rp - c0);
    float ph = fract(tt);
    float ring = sin((rr - ph * 0.6) * 40.0) * smoothstep(ph * 0.6 + 0.06, ph * 0.6, rr) * smoothstep(ph * 0.6 - 0.12, ph * 0.6, rr) * (1.0 - ph);
    N = normalize(N + vec3((rp - c0) / max(rr, 1e-3), 0.0).xzy * ring * 0.35 * uRain * smoothstep(80.0, 10.0, dist));
  }
  // distant normals average out: flatten to keep the horizon free of sparkle noise
  N = normalize(mix(N, vec3(0.0, 1.0, 0.0), smoothstep(800.0, 6000.0, dist) * 0.6));
  // reflections of objects follow only the long waves: a mirror image broken into a wobbling column, not speckle
  vec3 Ns = normalize(vec3(-(s0.x * a0 + s1.x * a1 * 0.5), 1.0, -(s0.y * a0 + s1.y * a1 * 0.5)));
  Ns = normalize(mix(Ns, vec3(0.0, 1.0, 0.0), 0.35));
  if (under) N = -N;

  vec3 L = uSunDir;
  float vis = hSunVis(vWP);
  vec3 sunC = uSunCol * vis;
  vec2 suv = gl_FragCoord.xy / uRes;
  float waterZ = linDepth(gl_FragCoord.z);

  // ---- foam
  float fw = texture2D(tD0, vXZ / uL.x + o).w * a0 + texture2D(tD1, vXZ / uL.y + o).w * a1 * 0.7;
  vec4 fl = texture2D(tFoam, vXZ * 0.11 + N.xz * 0.02);
  vec4 fl2 = texture2D(tFoam, vXZ * 0.043 - uTime * 0.004);
  float lace = fl.r;
  float whitecap = smoothstep(0.25, 0.9, fw * (0.6 + 0.6 * fl2.g)) * (0.4 + 0.6 * lace);
  // surf froth is a finer net than a whitecap's: films between bubbles a hand across, the net warped and torn into
  // patches, so close up it reads as froth rather than as one tiled pattern
  vec2 lw = (texture2D(tFoam, vXZ * 0.019 + uTime * 0.002).zy - 0.5) * 0.8;
  float laceF = texture2D(tFoam, vXZ * 0.29 + lw + N.xz * 0.03).r;
  float laceS = max(laceF, lace * 0.55);
  laceS *= 0.35 + 0.65 * smoothstep(0.2, 0.6, fl2.b + (fl.b - 0.5) * 0.5);
  float shoreF = shF.y * (0.3 + 0.95 * laceS) * smoothstep(0.1, 0.55, shF.y + fl2.g * 0.4);
  // contact foam along the line where the water thins to a film over sand or rock
  float thin = vWP.y - gPix;
  float edgeF = smoothstep(0.14, 0.01, thin) * (0.35 + 0.8 * laceS) * smoothstep(-1.0, 0.5, vGround) * mix(0.9, 0.3, cF.a);
  // fresh wake froth is white; as it thins only the films of the net are left, then they too break up
  float froth = texture2D(tFoam, vXZ * 0.55 + lw * 1.7).r * 0.55 + fl.b * 0.45;
  float wakeF = max(clamp(ripFoam * 1.4 - (1.0 - froth) * 1.1, 0.0, 1.0), smoothstep(0.9, 1.5, ripFoam) * (0.55 + 0.45 * froth));
  float foam = clamp(whitecap + shoreF + edgeF + wakeF, 0.0, 1.0);

  vec3 col;
  if (!under) {
    float NdV = max(dot(N, V), 0.0);
    float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
    // reflection: sky panorama (with clouds), objects from the screen
    vec3 R = reflect(-V, N);
    R.y = abs(R.y) + 0.002;
    float rl = clamp(log2(dist / 30.0) * 0.6, 0.0, 4.0);
    vec3 refl = hSky(R, rl);
    vec3 Rs = reflect(-V, Ns);
    Rs.y = abs(Rs.y) + 0.002;
    vec4 sr = uDbg == 1.0 ? vec4(0.0) : ssr(vWP, Rs);
    refl = mix(refl, sr.rgb, sr.a);
    // refraction: what lies beneath, absorbed along the path through the water
    vec2 ruv2 = suv + (uDbg == 2.0 ? 0.0 : 1.0) * N.xz * 0.05 * clamp(3.0 / (1.0 + waterZ * 0.05), 0.0, 1.0) * smoothstep(0.0, 1.2, thin);
    float sceneZ = linDepth(texture2D(tDepth, ruv2).r);
    if (sceneZ < waterZ) { ruv2 = suv; sceneZ = linDepth(texture2D(tDepth, suv).r); }
    vec3 below = sceneAt(ruv2);
    float depthW = max(vWP.y - gPix, 0.0);
    // where the ray reaches the depth of the bed under this point: if the ground there is deeper still, the ray
    // runs on past a step in the bed (the far edge of a knoll) and what the screen shows beyond is right
    vec3 bedQ = vWP - V * ((depthW + 0.4) / max(V.y, 0.02));
    bool stepped = texture2D(tHeight, (bedQ.xz - uHF.xy) / uHF.z).r < bedQ.y;
    bool noBed = sceneZ - waterZ > depthW / max(V.y, 0.02) * 1.5 + 3.0 && gPix > -3.0 && !stepped;
    if (noBed) {
      // the shallow bed right here was not drawn (a coarse far triangle stood above the sea): light white sand
      below = vec3(0.55, 0.52, 0.45) * (sunC * max(L.y, 0.0) / 3.14159 + hAmbient(vec3(0.0, 1.0, 0.0)));
    }
    // light from the seabed reaches the eye along the refracted ray: its path is the depth of what this pixel shows
    // over the cosine of that ray. The depth under the surface point itself is wrong wherever the bed steps: past a
    // knoll's far edge it lays knoll-top water over the deep sand behind, a pale rim round every knoll. Far off the
    // depth buffer is too coarse and the heightfield takes over.
    float cosT = sqrt(max(1.0 - (1.0 - NdV * NdV) / 1.777, 0.05));
    float rayPath = max(sceneZ - waterZ, 0.0) * (dist / max(waterZ, 1e-3));
    float seen = mix(rayPath * V.y, depthW, noBed ? 1.0 : smoothstep(300.0, 900.0, dist));
    float path = min(seen / cosT, 400.0);
    vec3 T = exp(-hWaterSigma * path);
    vec3 scat = hWaterScatter();
    // shallow water over white sand glows from within; deep water is ink
    vec3 refr = below * T + scat * (1.0 - T);
    vec3 water = mix(refr, refl, F);
    // sun glitter
    vec3 H = normalize(L + V);
    float rough = 0.045 + 0.12 * smoothstep(50.0, 1500.0, dist) + 0.05 * uRain;
    float a2r = rough * rough;
    float NdH = max(dot(N, H), 0.0);
    float Dg = a2r / (3.14159 * pow(NdH * NdH * (a2r - 1.0) + 1.0, 2.0));
    float Fs = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
    vec3 spec = sunC * Dg * Fs * 0.25 * max(dot(N, L), 0.0) / max(NdV, 0.1);
    water += min(spec, vec3(60.0)) * (1.0 - foam);
    // light through thin crests
    float crest = max(vWP.y - 0.2, 0.0) * a0 + shF.z * 0.8;
    float back = pow(max(dot(V, -vec3(L.x, 0.0, L.z) / max(length(L.xz), 1e-3)) * 0.6 + 0.4, 0.0), 4.0);
    water += vec3(0.05, 0.42, 0.38) * sunC * crest * back * 0.18 * (1.0 - foam);
    // foam: a rough white surface in sun and sky light
    vec3 foamC = vec3(0.9, 0.93, 0.95) * (sunC * max(dot(N, L), 0.0) * 0.32 + hAmbient(vec3(0.0, 1.0, 0.0)) * 3.14159 * 0.9);
    col = mix(water, foamC, foam * 0.92);
    // the night sea answers every disturbance with light
    // plankton light where the water is stirred: breaking swash, wakes, crests; flickering specks, not a sheet
    float spark = 0.25 + 0.75 * smoothstep(0.45, 0.85, fl.g * 0.45 + hNoise(vXZ * 1.7 + vec2(uTime * 0.6, -uTime * 0.4)) * 0.55);
    float glow = (shoreF + edgeF * 0.12 + wakeF * 1.4 + whitecap * 0.3) * uBiolum * spark;
    col += vec3(0.08, 0.75, 1.0) * glow * 0.7;
    if (uDbg == 6.0) col = vec3(path / 400.0);
    if (uDbg == 7.0) col = vec3(vis);
    if (uDbg == 8.0) col = refl * 0.3;
    if (uDbg == 9.0) col = vec3(F);
    if (uDbg == 10.0) col = below;
    if (uDbg < 6.0) col = hAtmos(col, vWP);
  } else {
    // from below: Snell's window to the sky, total internal reflection outside it
    vec3 I = -V;
    vec3 Rt = refract(I, N, 1.333);
    vec3 scat = hWaterScatter();
    if (dot(Rt, Rt) < 1e-4) {
      col = scat * 1.3 + vec3(0.02, 0.1, 0.12) * foam;
    } else {
      float c = max(dot(-I, N), 0.0);
      float F = 0.02 + 0.98 * pow(1.0 - c, 5.0);
      vec2 uv = suv + Rt.xz * 0.05;
      vec3 above = sceneAt(clamp(uv, 0.001, 0.999));
      col = mix(above, scat, F);
      col += sunC * pow(max(dot(Rt, L), 0.0), 600.0) * 4.0;
    }
    col = mix(col, vec3(0.75, 0.85, 0.88) * (sunC * 0.15 + 0.1), foam * 0.6);
    col += vec3(0.08, 0.75, 1.0) * (wakeF + shoreF) * uBiolum * 0.8;
    col = hAtmos(col, vWP);
  }
  if (uDbg == 3.0) col = N * 0.5 + 0.5;
  if (uDbg == 5.0 && !under) { vec3 R5 = reflect(-V, Ns); R5.y = abs(R5.y) + 0.002; vec4 s5 = ssr(vWP, R5); col = vec3(s5.a, s5.a * 0.3, 0.0) + s5.rgb * 0.0; }
  if (uDbg == 4.0) col = vec3(foam);
  col = (any(isnan(col)) || any(isinf(col))) ? vec3(0.0) : clamp(col, 0.0, 6e4);
  gl_FragColor = vec4(col, 1.0);
}`;

export function createOcean(renderer, sim, ripples) {
  const geo = gridGeometry();
  const MAXN = 1600;
  const nodeAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAXN * 4), 4);
  nodeAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aNode', nodeAttr);
  geo.instanceCount = 0;
  const morph = [];
  for (let l = 0; l < LEVELS; l++) morph.push(new THREE.Vector2(R0 * 2 ** l * 0.75, R0 * 2 ** l));
  const foam = foamTexture(renderer);
  const uniforms = {
    ...U,
    uMorph: { value: morph },
    tD0: { value: null }, tD1: { value: null }, tD2: { value: null },
    tS0: { value: null }, tS1: { value: null }, tS2: { value: null },
    tFoam: { value: foam },
    tRip: { value: null },
    uRipBox: { value: ripples.box },
    uL: { value: new THREE.Vector3(CASCADES[0].L, CASCADES[1].L, CASCADES[2].L) },
    tScene: { value: null }, tDepth: { value: null },
    uRes: { value: new THREE.Vector2(1, 1) },
    uNearFar: { value: new THREE.Vector2(0.1, 1000) },
    uVP: { value: new THREE.Matrix4() },
    uDbg: { value: +(new URLSearchParams(location.search).get('dbg') || 0) },
  };
  const mat = new THREE.ShaderMaterial({ vertexShader: OCEAN_VERT, fragmentShader: OCEAN_FRAG, uniforms, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.layers.set(LAYER_WATER);

  const frustum = new THREE.Frustum();
  const box = new THREE.Box3();
  const m4 = new THREE.Matrix4();
  const arr = nodeAttr.array;
  const ROOT = LEAF * 2 ** (LEVELS - 1);
  let count = 0, cam;
  const select = (x0, z0, lod) => {
    const size = LEAF * 2 ** lod;
    box.min.set(x0, -4, z0); box.max.set(x0 + size, 4, z0 + size);
    if (!frustum.intersectsBox(box)) return;
    const p = cam.position;
    const dx = Math.max(x0 - p.x, 0, p.x - x0 - size), dz = Math.max(z0 - p.z, 0, p.z - z0 - size), dy = Math.max(Math.abs(p.y) - 4, 0);
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (lod === 0 || d > R0 * 2 ** (lod - 1)) {
      if (count < MAXN) { const k = count * 4; arr[k] = x0; arr[k + 1] = z0; arr[k + 2] = size; arr[k + 3] = lod; count++; }
      return;
    }
    const h = size / 2;
    select(x0, z0, lod - 1); select(x0 + h, z0, lod - 1); select(x0, z0 + h, lod - 1); select(x0 + h, z0 + h, lod - 1);
  };

  function update(camera, pipe) {
    cam = camera;
    m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(m4);
    count = 0;
    // root follows the camera, snapped to its own size so nodes never swim
    const sn = LEAF * 2 ** (LEVELS - 3);
    const rx = Math.floor(camera.position.x / sn) * sn - ROOT / 2, rz = Math.floor(camera.position.z / sn) * sn - ROOT / 2;
    select(rx, rz, LEVELS - 1);
    geo.instanceCount = count;
    nodeAttr.needsUpdate = true;
    nodeAttr.clearUpdateRanges();
    nodeAttr.addUpdateRange(0, count * 4);
    const d = sim.disp, s = sim.deriv;
    uniforms.tD0.value = d[0]; uniforms.tD1.value = d[1]; uniforms.tD2.value = d[2];
    uniforms.tS0.value = s[0]; uniforms.tS1.value = s[1]; uniforms.tS2.value = s[2];
    uniforms.tRip.value = ripples.texture;
    uniforms.uVP.value.copy(m4);
    return count;
  }

  return { mesh, material: mat, update, uniforms };
}
