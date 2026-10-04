// HDR post chain: bloom (13-tap down / tent up, Karis on the first step), sun shafts at quarter resolution,
// then one composite to the canvas: exposure, ACES, grade, underwater light, lens droplets, vignette, grain, sharpen.
import * as THREE from 'three';
import { fs, pass, rt } from './gpu.js';

export class Post {
  constructor(renderer) {
    this.renderer = renderer;
    this.levels = 6;
    this.mips = Array.from({ length: this.levels }, () => rt(4, 4));
    this.shaftA = rt(4, 4);
    this.shaftB = rt(4, 4);
    // eye adaptation: a 1x1 exposure factor that follows the scene's log-average luminance, entirely on the GPU
    this.adaptA = rt(1, 1, { type: THREE.FloatType });
    this.adaptB = rt(1, 1, { type: THREE.FloatType });
    this.adaptInit = true;
    this.adaptPass = pass(/* glsl */ `
      precision highp float;
      uniform sampler2D tSrc, tPrev; uniform float uRef, uMax, uUp, uDown, uInit;
      varying vec2 vUv;
      void main(){
        float acc = 0.0, tw = 0.0;
        for (int j = 0; j < 6; j++) for (int i = 0; i < 8; i++) {
          vec2 uv = (vec2(float(i), float(j)) + 0.5) / vec2(8.0, 6.0);
          float w = 1.0 - 0.7 * length((uv - 0.5) * vec2(1.0, 1.3));
          float l = dot(texture2D(tSrc, uv).rgb, vec3(0.2126, 0.7152, 0.0722));
          acc += log(max(l, 1e-4)) * w; tw += w;
        }
        float lum = exp(acc / tw);
        // partial adaptation with a dead zone: ordinary daylight views keep their grade, a dark forest opens up
        float e = log2(uRef / lum);
        e = sign(e) * max(abs(e) - 1.0, 0.0) * 0.7;
        float target = clamp(exp2(e), 0.8, uMax);
        float prev = texture2D(tPrev, vec2(0.5)).r;
        float k = uInit > 0.5 ? 1.0 : (target > prev ? uUp : uDown);
        gl_FragColor = vec4(mix(prev, target, k), lum, 0.0, 1.0);
      }`, { tSrc: { value: null }, tPrev: { value: null }, uRef: { value: 0.1 }, uMax: { value: 2 }, uUp: { value: 0 }, uDown: { value: 0 }, uInit: { value: 1 } });

    this.down = pass(/* glsl */ `
      precision highp float;
      uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uFirst;
      varying vec2 vUv;
      vec3 s(vec2 o){ return texture2D(tSrc, vUv + o * uTexel).rgb; }
      float lw(vec3 c){ return 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722)) * 0.25); }
      void main(){
        vec3 a = s(vec2(-2, 2)), b = s(vec2(0, 2)), c = s(vec2(2, 2));
        vec3 d = s(vec2(-2, 0)), e = s(vec2(0, 0)), f = s(vec2(2, 0));
        vec3 g = s(vec2(-2, -2)), h = s(vec2(0, -2)), i = s(vec2(2, -2));
        vec3 j = s(vec2(-1, 1)), k = s(vec2(1, 1)), l = s(vec2(-1, -1)), m = s(vec2(1, -1));
        vec3 r;
        if (uFirst > 0.5) {
          vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25, g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25, g4 = (j + k + l + m) * 0.25;
          float w0 = lw(g0), w1 = lw(g1), w2 = lw(g2), w3 = lw(g3), w4 = lw(g4);
          r = (g0 * w0 * 0.125 + g1 * w1 * 0.125 + g2 * w2 * 0.125 + g3 * w3 * 0.125 + g4 * w4 * 0.5) / (w0 * 0.125 + w1 * 0.125 + w2 * 0.125 + w3 * 0.125 + w4 * 0.5);
        } else {
          r = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
        }
        gl_FragColor = vec4(min(max(r, 0.0), vec3(6e4)), 1.0);
      }`, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 } });
    this.up = pass(/* glsl */ `
      precision highp float;
      uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uRadius;
      varying vec2 vUv;
      void main(){
        vec2 o = uTexel * uRadius;
        vec3 r = texture2D(tSrc, vUv).rgb * 4.0;
        r += (texture2D(tSrc, vUv + vec2(-o.x, 0.0)).rgb + texture2D(tSrc, vUv + vec2(o.x, 0.0)).rgb + texture2D(tSrc, vUv + vec2(0.0, -o.y)).rgb + texture2D(tSrc, vUv + vec2(0.0, o.y)).rgb) * 2.0;
        r += texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb + texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb + texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb + texture2D(tSrc, vUv + vec2(o.x, o.y)).rgb;
        gl_FragColor = vec4(r / 16.0, 1.0);
      }`, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 } }, { extra: { blending: THREE.AdditiveBlending, transparent: true } });

    this.shaftMask = pass(/* glsl */ `
      precision highp float;
      uniform sampler2D tScene, tDepth; uniform vec2 uSun; uniform float uAspect;
      varying vec2 vUv;
      void main(){
        float d = texture2D(tDepth, vUv).x;
        float sky = step(0.99999, d);
        vec2 dv = vUv - uSun; dv.x *= uAspect;
        float r = length(dv);
        vec3 c = texture2D(tScene, vUv).rgb;
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        gl_FragColor = vec4(min(c, vec3(40.0)) * sky * smoothstep(0.6, 0.0, r) / (1.0 + l * 0.1), 1.0);
      }`, { tScene: { value: null }, tDepth: { value: null }, uSun: { value: new THREE.Vector2() }, uAspect: { value: 1 } });
    this.shaftBlur = pass(/* glsl */ `
      precision highp float;
      uniform sampler2D tSrc; uniform vec2 uSun; uniform float uStep;
      varying vec2 vUv;
      void main(){
        vec2 dir = (uSun - vUv) * uStep;
        vec3 acc = vec3(0.0); float w = 1.0, tw = 0.0;
        vec2 uv = vUv + dir * fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453);
        for (int i = 0; i < 12; i++){ acc += texture2D(tSrc, uv).rgb * w; tw += w; w *= 0.93; uv += dir; }
        gl_FragColor = vec4(acc / tw, 1.0);
      }`, { tSrc: { value: null }, uSun: { value: new THREE.Vector2() }, uStep: { value: 0.04 } });

    this.composite = pass(/* glsl */ `
      precision highp float;
      uniform sampler2D tScene, tBloom, tShaft, tDepth, tAdapt;
      uniform vec2 uSrcTexel, uSunUv, uNearFar;
      uniform float uUpscale, uExposure, uBloom, uShaft, uTime, uSharpen, uVignette, uSat, uFade, uAspect, uNightK, uUnder, uDrops, uChroma, uContrast;
      uniform vec3 uWB, uFadeCol, uShaftCol, uLift;
      varying vec2 vUv;
      vec3 aces(vec3 x){
        const mat3 m1 = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
        const mat3 m2 = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
        vec3 v = m1 * x;
        vec3 a = v * (v + 0.0245786) - 0.000090537;
        vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
        return clamp(m2 * (a / b), 0.0, 1.0);
      }
      vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
      float h21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y); }
      // water left on the lens after surfacing: round drops that refract and slowly slide
      vec3 drops(vec2 uv){
        vec2 p = uv * vec2(uAspect, 1.0) * 9.0;
        vec2 acc = vec2(0.0); float m = 0.0;
        for (int l = 0; l < 2; l++){
          vec2 q = p * (l == 0 ? 1.0 : 2.3) + float(l) * 7.1;
          vec2 i = floor(q);
          vec2 c = vec2(h21(i), h21(i + 3.3)) * 0.6 + 0.2;
          c.y += fract(uTime * 0.02 * (0.3 + h21(i + 9.0))) * 0.1;
          vec2 d = q - i - c;
          float r = (0.12 + 0.18 * h21(i + 1.7)) * step(0.45, h21(i + 5.5));
          float k = smoothstep(r, r * 0.6, length(d));
          acc += d / max(r, 1e-3) * k; m = max(m, k);
        }
        return vec3(acc, m);
      }
      // 5-tap Catmull-Rom (the four corner taps carry almost no weight): a bilinear stretch of a reduced-resolution frame
      // reads as soft on a 2x display
      vec3 catmullRom(vec2 uv){
        vec2 size = 1.0 / uSrcTexel;
        vec2 p = uv * size;
        vec2 t1 = floor(p - 0.5) + 0.5;
        vec2 f = p - t1;
        vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
        vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
        vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
        vec2 w3 = f * f * (-0.5 + 0.5 * f);
        vec2 w12 = w1 + w2;
        vec2 t0 = (t1 - 1.0) * uSrcTexel, t3 = (t1 + 2.0) * uSrcTexel, t12 = (t1 + w2 / w12) * uSrcTexel;
        float a = w12.x * w0.y, b = w0.x * w12.y, c = w12.x * w12.y, d = w3.x * w12.y, e = w12.x * w3.y;
        vec3 r = texture2D(tScene, vec2(t12.x, t0.y)).rgb * a + texture2D(tScene, vec2(t0.x, t12.y)).rgb * b
               + texture2D(tScene, t12).rgb * c + texture2D(tScene, vec2(t3.x, t12.y)).rgb * d + texture2D(tScene, vec2(t12.x, t3.y)).rgb * e;
        return r / (a + b + c + d + e);
      }
      void main(){
        vec2 uv = vUv;
        vec3 dr = vec3(0.0);
        if (uDrops > 0.01) { dr = drops(uv); uv += dr.xy * 0.035 * uDrops; }
        if (uUnder > 0.5) {
          // a gentle wobble of everything seen through water
          uv += vec2(sin(uv.y * 22.0 + uTime * 1.7), cos(uv.x * 19.0 + uTime * 1.3)) * 0.0018;
        }
        vec3 c = uUpscale > 0.5 ? catmullRom(uv) : texture2D(tScene, uv).rgb;
        vec2 cuv = vUv - 0.5;
        if (uChroma > 0.0) {
          vec2 off = cuv * dot(cuv, cuv) * uChroma;
          c.r = texture2D(tScene, uv - off).r;
          c.b = texture2D(tScene, uv + off).b;
        }
        vec3 n0 = texture2D(tScene, uv + vec2(0.0, uSrcTexel.y)).rgb, n1 = texture2D(tScene, uv - vec2(0.0, uSrcTexel.y)).rgb;
        vec3 n2 = texture2D(tScene, uv + vec2(uSrcTexel.x, 0.0)).rgb, n3 = texture2D(tScene, uv - vec2(uSrcTexel.x, 0.0)).rgb;
        // the bicubic lobes overshoot around HDR highlights; the cross neighbours bound what the pixel can be
        if (uUpscale > 0.5) c = clamp(c, min(min(n0, n1), min(n2, n3)), max(max(n0, n1), max(n2, n3)));
        vec3 n = n0 + n1 + n2 + n3;
        vec3 hp = c - n * 0.25;
        float lc = dot(c, vec3(0.3, 0.59, 0.11));
        c = max(c + hp * uSharpen / (1.0 + lc * 2.0), 0.0);
        vec3 bloom = texture2D(tBloom, uv).rgb;
        c = mix(c, bloom, uBloom);
        c += texture2D(tShaft, uv).rgb * uShaftCol * uShaft;
        vec2 sv = vUv - uSunUv; sv.x *= uAspect;
        c += uShaftCol * uShaft * exp(-length(sv) * 4.0) * 0.1;
        if (uUnder > 0.5) {
          // shafts of light hanging from the surface, swaying
          float x = vUv.x * 7.0 + (vUv.y - 1.0) * 0.6;
          float rays = vn(vec2(x * 1.3 + uTime * 0.15, uTime * 0.07)) * vn(vec2(x * 3.1 - uTime * 0.1, 3.0));
          rays = pow(rays, 2.0) * smoothstep(0.0, 1.0, vUv.y);
          // in-scatter grows with the water between the eye and what it sees, and saturates where the fog does
          float z = texture2D(tDepth, vUv).r * 2.0 - 1.0;
          float d = 2.0 * uNearFar.x * uNearFar.y / (uNearFar.y + uNearFar.x - z * (uNearFar.y - uNearFar.x));
          c += vec3(0.25, 0.7, 0.8) * rays * 0.35 * uShaft * 3.0 * (0.4 + 0.6 * smoothstep(6.0, 60.0, d));
        }
        c *= uExposure * uWB * texture2D(tAdapt, vec2(0.5)).r;
        float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
        float scot = uNightK * smoothstep(0.3, 0.0, lum);
        c = mix(c, vec3(lum * 0.72, lum * 0.88, lum * 1.38), scot * 0.55);
        vec3 t = aces(c);
        float l = dot(t, vec3(0.2126, 0.7152, 0.0722));
        t = mix(vec3(l), t, uSat);
        // contrast as a power around middle grey: a linear pivot at 0.5 would push every shadow below black
        t = clamp(0.18 * pow(t / 0.18, vec3(uContrast)), 0.0, 1.0);
        t = t + uLift * (1.0 - t);
        float v = 1.0 - dot(cuv * vec2(1.0, 0.85), cuv * vec2(1.0, 0.85)) * uVignette;
        t *= v;
        t += dr.z * uDrops * 0.03;
        t = mix(t, uFadeCol, uFade);
        vec3 o = toSRGB(clamp(t, 0.0, 1.0));
        float g = fract(sin(dot(vUv * 1000.0 + uTime * 7.13, vec2(12.9898, 78.233))) * 43758.5453);
        float g2 = fract(sin(dot(vUv * 1000.0 - uTime * 3.71, vec2(39.346, 11.135))) * 24634.6345);
        o += (g + g2 - 1.0) * (0.012 + uNightK * 0.012);
        gl_FragColor = vec4(o, 1.0);
      }`, {
      tScene: { value: null }, tBloom: { value: null }, tShaft: { value: null }, tDepth: { value: null }, tAdapt: { value: null },
      uSrcTexel: { value: new THREE.Vector2() }, uSunUv: { value: new THREE.Vector2(-9, -9) }, uNearFar: { value: new THREE.Vector2() },
      uUpscale: { value: 0 }, uExposure: { value: 1 }, uBloom: { value: 0.045 }, uShaft: { value: 0 }, uTime: { value: 0 }, uSharpen: { value: 0.18 },
      uVignette: { value: 0.42 }, uSat: { value: 1.06 }, uFade: { value: 0 }, uAspect: { value: 1 }, uNightK: { value: 0 },
      uUnder: { value: 0 }, uDrops: { value: 0 }, uChroma: { value: 0.0012 }, uContrast: { value: 1.04 },
      uWB: { value: new THREE.Vector3(1, 1, 1) }, uFadeCol: { value: new THREE.Vector3() }, uShaftCol: { value: new THREE.Vector3(1, 0.8, 0.55) },
      uLift: { value: new THREE.Vector3(0.006, 0.01, 0.014) },
    });
  }

  setSize(w, h) {
    let mw = Math.max(1, w >> 1), mh = Math.max(1, h >> 1);
    for (const m of this.mips) { m.setSize(mw, mh); mw = Math.max(1, mw >> 1); mh = Math.max(1, mh >> 1); }
    this.shaftA.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    this.shaftB.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    this.srcW = w; this.srcH = h;
  }

  bloom(src) {
    const r = this.renderer;
    let input = src;
    for (let i = 0; i < this.levels; i++) {
      const t = this.mips[i];
      this.down.uniforms.tSrc.value = input.texture;
      this.down.uniforms.uTexel.value.set(1 / input.width, 1 / input.height);
      this.down.uniforms.uFirst.value = i === 0 ? 1 : 0;
      fs.render(r, this.down, t);
      input = t;
    }
    for (let i = this.levels - 1; i > 0; i--) {
      const s = this.mips[i], t = this.mips[i - 1];
      this.up.uniforms.tSrc.value = s.texture;
      this.up.uniforms.uTexel.value.set(1 / s.width, 1 / s.height);
      fs.render(r, this.up, t);
    }
    return this.mips[0].texture;
  }

  // ref: the log-average luminance the current light would give an ordinary sunlit scene (exposure factor 1)
  adapt(dt, ref, max) {
    const a = this.adaptPass.uniforms;
    a.tSrc.value = this.mips[this.levels - 1].texture;
    a.tPrev.value = this.adaptA.texture;
    a.uRef.value = ref;
    a.uMax.value = max;
    // eyes take longer to open up in the dark than to close down in the glare
    a.uUp.value = 1 - Math.exp(-dt * 0.9);
    a.uDown.value = 1 - Math.exp(-dt * 2.8);
    a.uInit.value = this.adaptInit ? 1 : 0;
    this.adaptInit = false;
    fs.render(this.renderer, this.adaptPass, this.adaptB);
    [this.adaptA, this.adaptB] = [this.adaptB, this.adaptA];
    this.composite.uniforms.tAdapt.value = this.adaptA.texture;
  }

  shafts(sceneTex, depthTex, sunUv, aspect) {
    const r = this.renderer;
    const m = this.shaftMask.uniforms;
    m.tScene.value = sceneTex; m.tDepth.value = depthTex; m.uSun.value.copy(sunUv); m.uAspect.value = aspect;
    fs.render(r, this.shaftMask, this.shaftA);
    const b = this.shaftBlur.uniforms;
    b.uSun.value.copy(sunUv);
    b.tSrc.value = this.shaftA.texture; b.uStep.value = 0.055;
    fs.render(r, this.shaftBlur, this.shaftB);
    b.tSrc.value = this.shaftB.texture; b.uStep.value = 0.018;
    fs.render(r, this.shaftBlur, this.shaftA);
    return this.shaftA.texture;
  }

  final(sceneTex, bloomTex, shaftTex, depthTex) {
    const u = this.composite.uniforms;
    u.tScene.value = sceneTex; u.tBloom.value = bloomTex; u.tShaft.value = shaftTex; u.tDepth.value = depthTex;
    u.uSrcTexel.value.set(1 / this.srcW, 1 / this.srcH);
    // how far the frame is stretched to the canvas: the upscale filter and a stronger sharpen only when it is
    const k = Math.min(1, this.srcW / Math.max(1, this.renderer.domElement.width));
    u.uUpscale.value = k < 0.99 ? 1 : 0;
    u.uSharpen.value = 0.18 + 0.4 * (1 - k);
    fs.render(this.renderer, this.composite, null);
  }
}
