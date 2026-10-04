// Tessendorf FFT ocean: three cascades of 256x256, each band of the spectrum in exactly one cascade.
// Per frame: evolve the spectrum, inverse FFT (Stockham, 2x8 passes, two packed complex fields per channel pair),
// then assemble displacement + derivatives with mipmaps, and integrate a decaying whitecap foam.
// A CPU sampler sums the strongest modes of the same spectrum for buoyancy and the camera.
import * as THREE from 'three';
import { fs, pass, rt } from '../core/gpu.js';

export const N = 256;
export const CASCADES = [
  { L: 431, lmin: 16.0, lmax: 1e9 },
  { L: 97, lmin: 3.8, lmax: 16.0 },
  { L: 23, lmin: 0.0, lmax: 3.8 },
];
const G = 9.81;
const LOOP = 240; // seconds; frequencies are quantised so the sea repeats exactly
const W0 = (2 * Math.PI) / LOOP;
export const CHOP = 1.15;

// seeded gaussian
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// directional spectrum: trade-wind sea plus a long swell from the east-south-east
function spectrum(kx, kz, wind, swellDir) {
  const k = Math.hypot(kx, kz);
  if (k < 1e-6) return 0;
  const kh = [kx / k, kz / k];
  // wind sea (Phillips, U = 7.5 m/s)
  const U = 7.5, Lw = (U * U) / G;
  const cw = kh[0] * wind[0] + kh[1] * wind[1];
  let sea = (Math.exp(-1 / (k * Lw * k * Lw)) / (k * k * k * k)) * cw * cw;
  if (cw < 0) sea *= 0.08;
  sea *= Math.exp(-k * k * 0.0004);
  // swell: narrow in direction and wavelength (~140 m)
  const ks = (2 * Math.PI) / 140;
  const cs = kh[0] * swellDir[0] + kh[1] * swellDir[1];
  const swell = cs > 0 ? Math.exp(-((k - ks) * (k - ks)) / (2 * 0.012 * 0.012)) * Math.pow(cs, 24) * 45000 : 0;
  return sea + swell;
}

export class OceanSim {
  constructor(renderer) {
    this.renderer = renderer;
    this.wind = [0.8, 0.6];
    this.swellDir = [-0.92, -0.39]; // travelling toward west-north-west, from the ESE
    this.cascades = CASCADES.map((c, i) => this.makeCascade(c, i));
    this.normalise(1.7);
    this.cascades.forEach((c) => (c.h0Tex.needsUpdate = true));
    this.buildCPU();

    const common = `precision highp float; varying vec2 vUv; const float PI = 3.141592653589793;`;
    this.specMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: `out vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        in vec2 vUv;
        layout(location = 0) out vec4 o0;
        layout(location = 1) out vec4 o1;
        uniform sampler2D tH0;
        uniform float uT, uL, uW0, uChop;
        const float PI = 3.141592653589793;
        vec2 cm(vec2 a, vec2 b){ return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
        void main(){
          vec2 px = floor(gl_FragCoord.xy);
          vec2 n = vec2(px.x < ${N / 2}.0 ? px.x : px.x - ${N}.0, px.y < ${N / 2}.0 ? px.y : px.y - ${N}.0);
          vec2 k = 2.0 * PI * n / uL;
          float kl = length(k);
          vec4 h0 = texelFetch(tH0, ivec2(px), 0);
          float w = floor(sqrt(9.81 * kl) / uW0) * uW0;
          float ph = w * uT;
          vec2 e = vec2(cos(ph), sin(ph));
          vec2 h = cm(h0.xy, e) + cm(h0.zw, vec2(e.x, -e.y));
          vec2 ih = vec2(-h.y, h.x); // i*h
          vec2 kn = kl > 1e-6 ? k / kl : vec2(0.0);
          // horizontal displacement +i k/|k| h pulls points toward the crests (sharp crests, broad troughs)
          vec2 Dx = ih * kn.x * uChop;
          vec2 Dz = ih * kn.y * uChop;
          vec2 Dy = h;
          vec2 sx = ih * k.x;            // i kx h
          vec2 sz = ih * k.y;
          vec2 dxx = -h * (kl > 1e-6 ? k.x * k.x / kl : 0.0) * uChop;
          vec2 dzz = -h * (kl > 1e-6 ? k.y * k.y / kl : 0.0) * uChop;
          vec2 dxz = -h * (kl > 1e-6 ? k.x * k.y / kl : 0.0) * uChop;
          // pack two real fields per complex number: A + iB
          o0 = vec4(Dx + vec2(-Dy.y, Dy.x), Dz + vec2(-sx.y, sx.x));
          o1 = vec4(sz + vec2(-dxx.y, dxx.x), dzz + vec2(-dxz.y, dxz.x));
        }`,
      uniforms: { tH0: { value: null }, uT: { value: 0 }, uL: { value: 1 }, uW0: { value: W0 }, uChop: { value: CHOP } },
      depthTest: false,
      depthWrite: false,
    });
    const fftFrag = (horizontal) => /* glsl */ `
      precision highp float;
      in vec2 vUv;
      layout(location = 0) out vec4 o0;
      layout(location = 1) out vec4 o1;
      uniform sampler2D tA, tB;
      uniform float uSub;
      const float PI = 3.141592653589793;
      vec2 cm(vec2 a, vec2 b){ return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
      void main(){
        ivec2 p = ivec2(gl_FragCoord.xy);
        float index = float(${horizontal ? 'p.x' : 'p.y'});
        float ev = floor(index / uSub) * (uSub * 0.5) + mod(index, uSub * 0.5);
        ivec2 pe = ${horizontal ? 'ivec2(int(ev), p.y)' : 'ivec2(p.x, int(ev))'};
        ivec2 po = ${horizontal ? `ivec2(int(ev) + ${N / 2}, p.y)` : `ivec2(p.x, int(ev) + ${N / 2})`};
        float a = 2.0 * PI * index / uSub;
        vec2 tw = vec2(cos(a), sin(a));
        vec4 ea = texelFetch(tA, pe, 0), oa = texelFetch(tA, po, 0);
        vec4 eb = texelFetch(tB, pe, 0), ob = texelFetch(tB, po, 0);
        o0 = vec4(ea.xy + cm(tw, oa.xy), ea.zw + cm(tw, oa.zw));
        o1 = vec4(eb.xy + cm(tw, ob.xy), eb.zw + cm(tw, ob.zw));
      }`;
    const mk3 = (frag, uniforms) => new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: `out vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: frag, uniforms, depthTest: false, depthWrite: false,
    });
    this.fftH = mk3(fftFrag(true), { tA: { value: null }, tB: { value: null }, uSub: { value: 2 } });
    this.fftV = mk3(fftFrag(false), { tA: { value: null }, tB: { value: null }, uSub: { value: 2 } });
    this.assemble = mk3(/* glsl */ `
      precision highp float;
      in vec2 vUv;
      layout(location = 0) out vec4 oDisp;
      layout(location = 1) out vec4 oDer;
      uniform sampler2D tA, tB, tFoamPrev;
      uniform float uDt, uFoamK;
      void main(){
        ivec2 p = ivec2(gl_FragCoord.xy);
        vec4 a = texelFetch(tA, p, 0), b = texelFetch(tB, p, 0);
        // unpacked: a = (Dx, Dy, Dz, dDy/dx), b = (dDy/dz, dDx/dx, dDz/dz, dDx/dz)
        float J = (1.0 + b.y) * (1.0 + b.z) - b.w * b.w;
        float prev = texelFetch(tFoamPrev, p, 0).w;
        // whitecaps form where the surface folds, then fade over a few seconds
        float foam = max(prev * exp(-uDt * 0.55), smoothstep(0.62, 0.18, J) * uFoamK);
        oDisp = vec4(a.x, a.y, a.z, foam);
        oDer = vec4(a.w, b.x, b.y, b.z);
      }`, { tA: { value: null }, tB: { value: null }, tFoamPrev: { value: null }, uDt: { value: 0 }, uFoamK: { value: 1 } });
    this.time = 0;
  }

  makeCascade(c, idx) {
    const r = rng(1337 + idx * 7919);
    const gauss = () => {
      const u = Math.max(1e-9, r()), v = r();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const h0 = new Float32Array(N * N * 4);
    const raw = new Float32Array(N * N * 2);
    const dk = (2 * Math.PI) / c.L;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const nx = x < N / 2 ? x : x - N, ny = y < N / 2 ? y : y - N;
      const kx = nx * dk, kz = ny * dk;
      const k = Math.hypot(kx, kz);
      const lam = k > 0 ? (2 * Math.PI) / k : 1e9;
      let P = 0;
      if (lam > c.lmin && lam <= c.lmax && !(nx === 0 && ny === 0)) P = spectrum(kx, kz, this.wind, this.swellDir);
      const amp = Math.sqrt(P * dk * dk * 0.5);
      const i = (y * N + x) * 2;
      raw[i] = gauss() * amp;
      raw[i + 1] = gauss() * amp;
    }
    // h0(k) and conj(h0(-k))
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 2;
      const mx = (N - x) % N, my = (N - y) % N;
      const j = (my * N + mx) * 2;
      const o = (y * N + x) * 4;
      h0[o] = raw[i]; h0[o + 1] = raw[i + 1];
      h0[o + 2] = raw[j]; h0[o + 3] = -raw[j + 1];
    }
    const tex = new THREE.DataTexture(h0, N, N, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    const o = { type: THREE.FloatType, min: THREE.NearestFilter, mag: THREE.NearestFilter, count: 2 };
    const out = rt(N, N, { type: THREE.HalfFloatType, count: 2, mips: true, min: THREE.LinearMipmapLinearFilter, wrap: THREE.RepeatWrapping });
    const out2 = rt(N, N, { type: THREE.HalfFloatType, count: 2, mips: true, min: THREE.LinearMipmapLinearFilter, wrap: THREE.RepeatWrapping });
    return { ...c, h0: h0, h0Tex: tex, ping: rt(N, N, o), pong: rt(N, N, o), out, out2, idx };
  }

  // scale every cascade together so the open-sea significant wave height is Hs
  normalise(Hs) {
    let v = 0;
    for (const c of this.cascades) for (let i = 0; i < N * N; i++) {
      const o = i * 4;
      v += c.h0[o] * c.h0[o] + c.h0[o + 1] * c.h0[o + 1] + c.h0[o + 2] * c.h0[o + 2] + c.h0[o + 3] * c.h0[o + 3];
    }
    const s = Hs / (4 * Math.sqrt(v));
    for (const c of this.cascades) for (let i = 0; i < N * N * 4; i++) c.h0[i] *= s;
  }

  // the strongest modes, for CPU height queries
  buildCPU() {
    const modes = [];
    for (const c of this.cascades.slice(0, 2)) {
      const dk = (2 * Math.PI) / c.L;
      const cand = [];
      for (let y = 0; y < N; y++) for (let x = 0; x < N / 2; x++) {
        const nx = x, ny = y < N / 2 ? y : y - N;
        if (nx === 0 && ny <= 0) continue;
        const o = (y * N + x) * 4;
        const e = c.h0[o] ** 2 + c.h0[o + 1] ** 2 + c.h0[o + 2] ** 2 + c.h0[o + 3] ** 2;
        if (e > 0) cand.push([e, nx * dk, ny * dk, c.h0[o], c.h0[o + 1], c.h0[o + 2], c.h0[o + 3]]);
      }
      cand.sort((a, b) => b[0] - a[0]);
      for (const m of cand.slice(0, c === this.cascades[0] ? 56 : 20)) {
        const kl = Math.hypot(m[1], m[2]);
        const w = Math.floor(Math.sqrt(G * kl) / W0) * W0;
        modes.push({ kx: m[1], kz: m[2], ar: m[3], ai: m[4], br: m[5], bi: m[6], w, kl, casc: c === this.cascades[0] ? 0 : 1 });
      }
    }
    this.modes = modes;
  }

  // open-sea surface at (x, z): height and horizontal displacement, before shore attenuation
  sampleCPU(x, z, t, out) {
    let h = 0, dx = 0, dz = 0;
    for (const m of this.modes) {
      const th = m.kx * x + m.kz * z;
      const a = th + m.w * t, b = th - m.w * t;
      const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
      // 2 Re[(A e^{iwt} + B e^{-iwt}) e^{ik.x}]
      const re = m.ar * ca - m.ai * sa + m.br * cb - m.bi * sb;
      const im = m.ar * sa + m.ai * ca + m.br * sb + m.bi * cb;
      h += 2 * re;
      // horizontal: 2 Re[i kn (..)] = -2 kn Im(..)
      dx -= 2 * (m.kx / m.kl) * im * CHOP;
      dz -= 2 * (m.kz / m.kl) * im * CHOP;
    }
    out.h = h; out.dx = dx; out.dz = dz;
    return out;
  }

  update(dt, swell, foamK) {
    const r = this.renderer;
    this.time += dt;
    const t = this.time;
    for (const c of this.cascades) {
      const s = this.specMat.uniforms;
      s.tH0.value = c.h0Tex; s.uT.value = t; s.uL.value = c.L;
      fs.render(r, this.specMat, c.ping);
      let src = c.ping, dst = c.pong;
      for (const m of [this.fftH, this.fftV]) {
        for (let sub = 2; sub <= N; sub *= 2) {
          m.uniforms.tA.value = src.textures[0];
          m.uniforms.tB.value = src.textures[1];
          m.uniforms.uSub.value = sub;
          fs.render(r, m, dst);
          [src, dst] = [dst, src];
        }
      }
      const a = this.assemble.uniforms;
      a.tA.value = src.textures[0];
      a.tB.value = src.textures[1];
      a.tFoamPrev.value = c.out2.textures[0];
      a.uDt.value = dt;
      a.uFoamK.value = foamK;
      fs.render(r, this.assemble, c.out);
      [c.out, c.out2] = [c.out2, c.out];
    }
  }

  // current textures: displacement (Dx, Dy, Dz, foam) and derivatives (sx, sz, dxx, dzz) per cascade
  get disp() { return this.cascades.map((c) => c.out2.textures[0]); }
  get deriv() { return this.cascades.map((c) => c.out2.textures[1]); }
}
