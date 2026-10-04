// Sky: physically based single scattering, volumetric cumulus, cirrus, sun, moon, stars, Milky Way and rainbow.
// Two tiers keep it cheap: a small panorama (amortised over four frames) feeds reflections, ambient and fog;
// the visible clouds are ray-marched at half resolution, one pixel in four per frame, with reprojected history.
import * as THREE from 'three';
import { U, UNIFORMS_GLSL, NOISE, WATER } from '../core/shared.js';
import { fs, pass, rt } from '../core/gpu.js';

// ------------------------------------------------------------------ 3D cloud noise (generated on the CPU)
function tileableWorley3(N, cells, seed) {
  const pts = new Float32Array(cells * cells * cells * 3);
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < pts.length; i++) pts[i] = rnd();
  const out = new Float32Array(N * N * N);
  const inv = cells / N;
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const px = (x + 0.5) * inv, py = (y + 0.5) * inv, pz = (z + 0.5) * inv;
    const cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz);
    let md = 9;
    for (let k = -1; k <= 1; k++) for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const gx = cx + i, gy = cy + j, gz = cz + k;
      const wx = ((gx % cells) + cells) % cells, wy = ((gy % cells) + cells) % cells, wz = ((gz % cells) + cells) % cells;
      const o = ((wz * cells + wy) * cells + wx) * 3;
      const dx = gx + pts[o] - px, dy = gy + pts[o + 1] - py, dz = gz + pts[o + 2] - pz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < md) md = d;
    }
    out[(z * N + y) * N + x] = Math.sqrt(md);
  }
  return out;
}

function tileablePerlin3(N, period, seed) {
  // gradient noise on a periodic lattice
  const P = period;
  const g = new Float32Array(P * P * P * 3);
  let s = seed;
  const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647);
  for (let i = 0; i < P * P * P; i++) {
    const t = rnd() * Math.PI * 2, u = rnd() * 2 - 1, r = Math.sqrt(1 - u * u);
    g[i * 3] = r * Math.cos(t); g[i * 3 + 1] = r * Math.sin(t); g[i * 3 + 2] = u;
  }
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const out = new Float32Array(N * N * N);
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const px = ((x + 0.5) / N) * P, py = ((y + 0.5) / N) * P, pz = ((z + 0.5) / N) * P;
    const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
    const fx = px - ix, fy = py - iy, fz = pz - iz;
    let v = 0;
    const ux = fade(fx), uy = fade(fy), uz = fade(fz);
    for (let k = 0; k < 2; k++) for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const o = ((((iz + k) % P) * P + ((iy + j) % P)) * P + ((ix + i) % P)) * 3;
      const d = g[o] * (fx - i) + g[o + 1] * (fy - j) + g[o + 2] * (fz - k);
      v += d * (i ? ux : 1 - ux) * (j ? uy : 1 - uy) * (k ? uz : 1 - uz);
    }
    out[(z * N + y) * N + x] = v;
  }
  return out;
}

function makeCloudNoise() {
  const N = 64;
  const w1 = tileableWorley3(N, 4, 11), w2 = tileableWorley3(N, 8, 23), w3 = tileableWorley3(N, 16, 37);
  const p1 = tileablePerlin3(N, 4, 5), p2 = tileablePerlin3(N, 8, 9), p3 = tileablePerlin3(N, 16, 13);
  const shape = new Uint8Array(N * N * N * 2);
  for (let i = 0; i < N * N * N; i++) {
    const per = 0.5 + (p1[i] * 0.55 + p2[i] * 0.3 + p3[i] * 0.15) * 0.9;
    const wor = 1 - (w1[i] * 0.625 + w2[i] * 0.25 + w3[i] * 0.125) * 1.25;
    // perlin-worley: perlin remapped by worley, billowy with round edges
    const pw = Math.min(1, Math.max(0, (per - (1 - wor)) / (1 - (1 - wor) + 1e-4) * 0.5 + wor * 0.5));
    shape[i * 2] = Math.round(Math.min(1, Math.max(0, pw)) * 255);
    shape[i * 2 + 1] = Math.round(Math.min(1, Math.max(0, wor)) * 255);
  }
  const t = new THREE.Data3DTexture(shape, N, N, N);
  t.format = THREE.RGFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.unpackAlignment = 1;
  t.needsUpdate = true;

  const M = 32;
  const d1 = tileableWorley3(M, 4, 71), d2 = tileableWorley3(M, 8, 83), d3 = tileableWorley3(M, 16, 97);
  const det = new Uint8Array(M * M * M);
  for (let i = 0; i < M * M * M; i++) det[i] = Math.round(Math.min(1, Math.max(0, 1 - (d1[i] * 0.625 + d2[i] * 0.25 + d3[i] * 0.125) * 1.3)) * 255);
  const td = new THREE.Data3DTexture(det, M, M, M);
  td.format = THREE.RedFormat;
  td.type = THREE.UnsignedByteType;
  td.wrapS = td.wrapT = td.wrapR = THREE.RepeatWrapping;
  td.minFilter = td.magFilter = THREE.LinearFilter;
  td.unpackAlignment = 1;
  td.needsUpdate = true;
  return { shape: t, detail: td };
}

// ------------------------------------------------------------------ GLSL
const ATMOS_GLSL = /* glsl */ `
const float Re = 6360e3, Ra = 6440e3;
const vec3 bR = vec3(5.802e-6, 13.558e-6, 33.1e-6);
const vec3 bOz = vec3(0.65e-6, 1.881e-6, 0.085e-6);
vec2 raySph(vec3 ro, vec3 rd, float r){ float b = dot(ro, rd); float c = dot(ro, ro) - r * r; float d = b * b - c; if (d < 0.0) return vec2(-1.0); d = sqrt(d); return vec2(-b - d, -b + d); }
vec3 dens(float h, float hz){ return vec3(exp(-h / 8000.0), exp(-h / 1200.0) * hz, max(0.0, 1.0 - abs(h - 25000.0) / 15000.0)); }
vec3 extinct(vec3 d, float bM){ return bR * d.x + vec3(bM * 1.11) * d.y + bOz * d.z; }
vec3 trans(vec3 p, vec3 L, float bM, float hz){
  float tl = raySph(p, L, Ra).y;
  float tg = raySph(p, L, Re).x;
  if (tg > 0.0) return vec3(0.0);
  vec3 od = vec3(0.0);
  float dt = tl / 5.0;
  for (int i = 0; i < 5; i++){ vec3 q = p + L * dt * (float(i) + 0.5); od += dens(length(q) - Re, hz) * dt; }
  return exp(-extinct(od, bM));
}
float phR(float c){ return 3.0 / (16.0 * 3.14159) * (1.0 + c * c); }
float phM(float c, float g){ float g2 = g * g; return 3.0 / (8.0 * 3.14159) * ((1.0 - g2) * (1.0 + c * c)) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }
// radiance of the clear sky toward rd, lit by the sun and (dimly) the moon
vec3 atmosphere(vec3 rd, vec3 sunL, vec3 moonL, float camH, float hz){
  vec3 ro = vec3(0.0, Re + max(camH, 1.0), 0.0);
  float bM = 3.996e-6 * hz;
  float tMax = raySph(ro, rd, Ra).y;
  float tg = raySph(ro, rd, Re).x;
  bool ground = tg > 0.0;
  if (ground) tMax = tg;
  tMax = min(tMax, 300e3);
  vec3 sumS = vec3(0.0), sumM = vec3(0.0);
  vec3 od = vec3(0.0);
  const int N = 14;
  float tPrev = 0.0;
  for (int i = 0; i < N; i++){
    float f = (float(i) + 0.5) / float(N);
    float t = tMax * f * f;
    float tn = tMax * (float(i) + 1.0) * (float(i) + 1.0) / float(N * N);
    float dt = tn - tPrev; tPrev = tn;
    vec3 p = ro + rd * t;
    vec3 d = dens(length(p) - Re, hz) * dt;
    od += d;
    vec3 Tv = exp(-extinct(od, bM));
    vec3 up = normalize(p);
    vec3 Ts = trans(p, sunL, bM, hz);
    vec3 Tm = moonL.y > -0.2 ? trans(p, moonL, bM, hz) : vec3(0.0);
    sumS += Tv * (d.x * bR * phR(dot(rd, sunL)) * Ts + d.y * bM * phM(dot(rd, sunL), 0.76) * Ts);
    sumM += Tv * (d.x * bR * phR(dot(rd, moonL)) * Tm + d.y * bM * phM(dot(rd, moonL), 0.76) * Tm);
  }
  vec3 col = sumS * 22.0 + sumM * 22.0 * 0.0035;
  if (ground) {
    // the sea at the end of a downward ray: dark blue, lit by sun and sky
    vec3 Tv = exp(-extinct(od, bM));
    vec3 Tsun = trans(ro + rd * tMax + vec3(0.0, 10.0, 0.0), sunL, bM, hz);
    col += Tv * vec3(0.006, 0.02, 0.035) * (Tsun * max(sunL.y, 0.0) * 22.0 + 0.4);
  }
  return col;
}
`;

const CLOUD_GLSL = /* glsl */ `
precision highp sampler3D;
uniform sampler3D tShape, tDetail;
const float CB = 900.0, CT = 2500.0;
float remap(float v, float a, float b, float c, float d){ return c + (v - a) / (b - a) * (d - c); }
float coverageAt(vec2 xz){
  float c = textureLod(tWeather, (xz + uCloudOff) / 24000.0, 0.0).r;
  return smoothstep(1.0 - uCover, 1.0 - uCover + 0.28, c);
}
// Trade-wind cumulus: flat bases, rounded towers whose height follows the local cover, billowy tops and
// wispy undersides (erosion flips with height), after the Nubis density model.
float cloudDens(vec3 p, bool detail){
  float hf = (p.y - CB) / (CT - CB);
  if (hf < 0.0 || hf > 1.0) return 0.0;
  vec2 wxz = p.xz + uCloudOff;
  vec4 wm = textureLod(tWeather, wxz / 24000.0, 0.0);
  float cov = smoothstep(1.0 - uCover, 1.0 - uCover + 0.3, wm.r);
  if (cov <= 0.001) return 0.0;
  float top = mix(0.25, 1.0, smoothstep(0.2, 1.0, cov * (0.45 + uCover * 0.8)));
  float grad = smoothstep(0.0, 0.06, hf) * smoothstep(top, top * 0.45, hf);
  if (grad <= 0.0) return 0.0;
  vec3 q = vec3(wxz.x, p.y * 1.2, wxz.y) / 3200.0 + vec3(0.0, -uTime * 0.0003, 0.0);
  vec2 sh = textureLod(tShape, q, 0.0).rg;
  float base = remap(sh.r, -(1.0 - sh.g), 1.0, 0.0, 1.0);
  base *= grad;
  float d = remap(base, 1.0 - cov, 1.0, 0.0, 1.0) * cov;
  if (d <= 0.0) return 0.0;
  if (detail) {
    float dn = textureLod(tDetail, q * 5.1 + vec3(uTime * 0.001, 0.0, 0.0), 0.0).r;
    float m = mix(dn, 1.0 - dn, clamp(hf * 6.0, 0.0, 1.0));
    d = remap(d, m * 0.24, 1.0, 0.0, 1.0);
  }
  return clamp(d, 0.0, 1.0) * mix(1.0, 1.7, uRain);
}
float phDual(float mu, float k){ return mix(phM(mu, 0.8 * k), phM(mu, -0.3 * k), 0.25); }
// march a view ray through the layer; returns in-scattered light (rgb) and transmittance (a)
vec4 marchClouds(vec3 ro, vec3 rd, int steps, float jitter, vec3 sunL, vec3 sunC, vec3 ambUp, vec3 ambDn, float maxDist){
  if (abs(rd.y) < 1e-4) return vec4(0.0, 0.0, 0.0, 1.0);
  float t0 = (CB - ro.y) / rd.y, t1 = (CT - ro.y) / rd.y;
  if (t0 > t1) { float tt = t0; t0 = t1; t1 = tt; }
  t0 = max(t0, 0.0);
  t1 = min(t1, maxDist);
  if (t1 <= t0) return vec4(0.0, 0.0, 0.0, 1.0);
  float mu = dot(rd, sunL);
  // steps grow with distance so a grazing ray still lands several samples in each cloud; empty air is
  // crossed in coarse strides, and on entering a cloud the march backs up one stride and goes fine
  float minStep = max((t1 - t0) / float(steps), 20.0);
  float t = t0 + minStep * 2.0 * jitter;
  vec3 S = vec3(0.0);
  float T = 1.0;
  const float sig = 0.06;
  bool inside = false;
  int miss = 0;
  for (int i = 0; i < 192; i++){
    if (t > t1 || T < 0.015) break;
    float dt = max(minStep, t * 0.006);
    vec3 p = ro + rd * t;
    if (!inside) {
      if (cloudDens(p, false) <= 0.0) { t += dt * 2.0; continue; }
      inside = true;
      miss = 0;
      t = max(t - dt * 2.0, t0) + dt * jitter;
      continue;
    }
    float d = cloudDens(p, true);
    if (d > 0.002) {
      miss = 0;
      float od = 0.0, ls = 26.0;
      vec3 lp = p;
      for (int j = 0; j < 6; j++){ lp += sunL * ls; od += cloudDens(lp, j < 2) * ls; ls *= 1.85; }
      // a few octaves of attenuated, flatter-phased light stand in for multiple scattering
      vec3 Ls = vec3(0.0);
      float a = 1.0, b = 1.0, c = 1.0;
      for (int o = 0; o < 3; o++){ Ls += a * exp(-od * sig * b) * phDual(mu, c); a *= 0.55; b *= 0.45; c *= 0.5; }
      float powder = 1.0 - exp(-d * sig * 90.0);
      Ls *= sunC * 4.0 * 3.14159 * 0.5 * mix(powder, 1.0, 0.7 + 0.3 * max(mu, 0.0));
      float hf = (p.y - CB) / (CT - CB);
      vec3 La = mix(ambDn, ambUp, clamp(hf * 1.6, 0.0, 1.0)) * (0.6 + 0.4 * hf);
      vec3 Lf = vec3(0.0);
      if (uFlash > 0.0) Lf = vec3(0.7, 0.75, 1.0) * uFlash * 4.0 * exp(-od * 0.004) * smoothstep(0.2, 1.0, dot(normalize(p - ro), uFlashDir));
      float dT = exp(-d * sig * dt);
      S += T * (Ls + La + Lf) * (1.0 - dT);
      T *= dT;
    } else if (++miss > 5) {
      inside = false;
    }
    t += dt;
  }
  // haze over distant clouds
  float far = clamp((t0 - 2500.0) / 40000.0, 0.0, 1.0);
  return vec4(S * (1.0 - far * 0.8), mix(T, 1.0, far * far * 0.9));
}
`;

const PANO_FRAG = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 oSky;
layout(location = 1) out vec4 oClear;
${UNIFORMS_GLSL}
${NOISE}
uniform float uPhase, uCamH;
uniform vec3 uCamPos;
uniform vec3 uSunC, uAmbUpC, uAmbDnC, uCloudL;
in vec2 vUv;
${ATMOS_GLSL}
${CLOUD_GLSL}
void main(){
  ivec2 px = ivec2(gl_FragCoord.xy);
  if (int(uPhase) != (px.x & 1) + 2 * (px.y & 1)) discard;
  float az = (vUv.x - 0.5) * 6.2831853;
  float el = (vUv.y - 0.5) * 3.14159265;
  vec3 rd = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
  vec3 a = atmosphere(rd, uTrueSun, uMoonDir, uCamH, uHaze);
  vec3 col = a;
  if (rd.y > 0.0) {
    float j = hHash12(gl_FragCoord.xy + uPhase * 7.0);
    vec4 c = marchClouds(vec3(uCamPos.x, uCamH, uCamPos.z), rd, 28, j, uCloudL, uSunC, uAmbUpC, uAmbDnC, 30000.0);
    // dim and grey the sky under heavy cover
    col = a * c.a + c.rgb;
  }
  col *= 1.0 - 0.55 * uRain * smoothstep(-0.1, 0.4, rd.y);
  col += uFlash * vec3(0.5, 0.55, 0.75) * 0.8 * max(dot(rd, uFlashDir), 0.0);
  oSky = vec4(col, 1.0);
  oClear = vec4(a, 1.0);
}`;

// ambient: rows 0..3 clear-sky ring at 1/6/16/40 degrees, row 4 irradiance up/side/down from the cloudy panorama
const AMB_FRAG = /* glsl */ `
precision highp float;
${UNIFORMS_GLSL}
${NOISE}
uniform sampler2D tPano;
uniform float uCamH;
varying vec2 vUv;
${ATMOS_GLSL}
vec3 pano(vec3 d, float lod){ return textureLod(tPano, vec2(atan(d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5), lod).rgb; }
void main(){
  int row = int(floor(vUv.y * 8.0));
  int col = int(floor(vUv.x * 64.0));
  if (row < 4) {
    float el = row == 0 ? 1.0 : (row == 1 ? 6.0 : (row == 2 ? 16.0 : 40.0));
    float az = (vUv.x - 0.5) * 6.2831853;
    vec3 rd = vec3(cos(radians(el)) * cos(az), sin(radians(el)), cos(radians(el)) * sin(az));
    // the haze itself is greyed by overcast and rain
    vec3 a = atmosphere(rd, uTrueSun, uMoonDir, uCamH, uHaze);
    vec3 cl = pano(rd, 4.0);
    a = mix(a, cl, 0.35 + 0.5 * uCover);
    gl_FragColor = vec4(a, 1.0);
    return;
  }
  if (row == 4 && col < 3) {
    vec3 acc = vec3(0.0); float w = 0.0;
    for (int i = 0; i < 12; i++) for (int j = 0; j < 6; j++){
      float az = float(i) / 12.0 * 6.2831853;
      float el = (float(j) + 0.5) / 6.0 * 1.5708;
      vec3 d = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
      vec3 n = col == 0 ? vec3(0.0, 1.0, 0.0) : (col == 1 ? vec3(cos(az), 0.0, sin(az)) : vec3(0.0, -1.0, 0.0));
      vec3 dd = col == 2 ? vec3(d.x, -d.y, d.z) : (col == 1 ? normalize(vec3(cos(az), sin(el) * 2.0 - 1.0, sin(az))) : d);
      float c = max(dot(dd, n), 0.0);
      vec3 L = pano(dd, 5.0);
      if (dd.y < 0.0) L = pano(vec3(dd.x, -dd.y, dd.z), 6.0) * 0.12 + vec3(0.02, 0.05, 0.06) * max(uSunDir.y, 0.0);
      acc += L * c; w += c;
    }
    gl_FragColor = vec4(acc / max(w, 1e-3), 1.0);
    return;
  }
  gl_FragColor = vec4(0.0);
}`;

// visible clouds: quarter-resolution march of one pixel in each 2x2 block of the half-res buffer
const CLOUD_MARCH_FRAG = /* glsl */ `
precision highp float;
${UNIFORMS_GLSL}
${NOISE}
uniform sampler2D tDepth;
uniform mat4 uInvVP;
uniform vec2 uOff, uHalfRes;
uniform vec3 uCamPos, uSunC, uAmbUpC, uAmbDnC, uCloudL;
uniform float uFrame;
varying vec2 vUv;
${ATMOS_GLSL}
${CLOUD_GLSL}
void main(){
  // which half-res pixel this quarter-res pixel stands for this frame
  vec2 hp = floor(gl_FragCoord.xy) * 2.0 + uOff + 0.5;
  vec2 uv = hp / uHalfRes;
  vec2 tx = 1.0 / (uHalfRes * 2.0);
  float dep = max(max(texture2D(tDepth, uv + tx * vec2(-1.0, -1.0)).r, texture2D(tDepth, uv + tx * vec2(1.0, -1.0)).r),
                  max(texture2D(tDepth, uv + tx * vec2(-1.0, 1.0)).r, texture2D(tDepth, uv + tx * vec2(1.0, 1.0)).r));
  vec4 ndc = vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec4 w = uInvVP * ndc; vec3 rd = normalize(w.xyz / w.w - uCamPos);
  if (dep < 0.99999) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  if (rd.y < 0.003) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float j = fract(hHash12(hp) + uFrame * 0.618034);
  vec4 c = marchClouds(uCamPos, rd, 64, j, uCloudL, uSunC, uAmbUpC, uAmbDnC, 42000.0);
  gl_FragColor = c;
}`;

const CLOUD_RESOLVE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tNew, tHist;
uniform mat4 uInvVP, uPrevVP;
uniform vec2 uOff, uHalfRes;
uniform vec3 uCamPos;
uniform float uReset;
varying vec2 vUv;
void main(){
  vec2 hp = floor(gl_FragCoord.xy);
  vec2 q = mod(hp, 2.0);
  vec2 qp = floor(hp / 2.0);
  vec4 n = texture2D(tNew, (qp + 0.5) / (uHalfRes * 0.5));
  // reproject this pixel's view direction into the previous frame (clouds are effectively at infinity)
  vec4 w = uInvVP * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize(w.xyz / w.w - uCamPos);
  vec4 pc = uPrevVP * vec4(rd * 1e5, 0.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  bool ok = pc.w > 0.0 && all(greaterThan(puv, vec2(0.0))) && all(lessThan(puv, vec2(1.0))) && uReset < 0.5;
  vec4 a = texture2D(tNew, vUv);
  vec4 h = ok ? texture2D(tHist, puv) : a;
  // fresh sample: blend lightly with history to settle the jitter; the other three keep their history
  gl_FragColor = all(equal(q, uOff)) ? (ok ? mix(h, n, 0.2) : mix(a, n, 0.5)) : h;
}`;

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = position;
  vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const DOME_FRAG = /* glsl */ `
precision highp float;
${UNIFORMS_GLSL}
${NOISE}
uniform sampler2D tClear, tClouds;
uniform vec2 uRes;
uniform float uMoonPhase, uRainbow, uCirrus, uStarRot, uSunScale;
varying vec3 vDir;
${WATER}
vec3 hsv(float h){ return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
vec3 stars(vec3 d){
  vec3 acc = vec3(0.0);
  for (int l = 0; l < 2; l++){
    float sc = l == 0 ? 160.0 : 420.0;
    vec3 p = d * sc;
    vec3 c = floor(p);
    vec3 f = fract(p);
    float h = hHash13(c + float(l) * 17.0);
    float th = l == 0 ? 0.965 : 0.94;
    if (h > th) {
      vec3 o = vec3(hHash13(c + 1.3), hHash13(c + 2.7), hHash13(c + 5.1)) * 0.6 + 0.2;
      float r = length(f - o);
      float mag = pow((h - th) / (1.0 - th), 3.0);
      float tw = 0.75 + 0.25 * sin(uTime * (2.0 + 6.0 * hHash13(c)) + h * 40.0);
      vec3 tint = mix(vec3(1.0, 0.75, 0.55), vec3(0.7, 0.82, 1.0), hHash13(c + 9.1));
      acc += tint * mag * tw * smoothstep(0.08, 0.0, r) * (l == 0 ? 9.0 : 2.0);
    }
  }
  return acc;
}
vec3 milkyWay(vec3 d){
  // a band along a tilted great circle, with dust lanes
  vec3 n = normalize(vec3(0.35, 0.55, -0.76));
  float b = dot(d, n);
  vec3 t = normalize(cross(n, vec3(0.0, 1.0, 0.0)));
  float along = atan(dot(d, cross(n, t)), dot(d, t));
  float core = exp(-b * b * 26.0) * (0.55 + 0.45 * cos(along - 0.6));
  vec2 q = vec2(along * 3.0, b * 9.0);
  float cl = hFbm(q * 2.3) * 0.7 + hFbm(q * 7.0) * 0.3;
  float dust = smoothstep(0.42, 0.7, hFbm(q * 3.1 + 4.0)) * exp(-b * b * 80.0);
  vec3 col = mix(vec3(0.55, 0.62, 0.85), vec3(1.0, 0.86, 0.7), exp(-b * b * 90.0));
  return col * core * cl * (1.0 - dust * 0.8) * 0.06;
}
vec3 moon(vec3 d, out float cov){
  vec3 m = uMoonDir;
  float ang = acos(clamp(dot(d, m), -1.0, 1.0));
  float R = 0.0105;
  cov = smoothstep(R, R * 0.92, ang);
  if (cov <= 0.0) return vec3(0.0);
  // a little sphere: craters and maria by noise, lit from the sun's side
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 tx = normalize(cross(up, m)), ty = cross(m, tx);
  vec2 q = vec2(dot(d - m, tx), dot(d - m, ty)) / R;
  float z = sqrt(max(1.0 - dot(q, q), 0.0));
  vec3 nrmV = vec3(q, z);
  float ph = uMoonPhase * 6.2831853;
  vec3 sunLocal = normalize(vec3(sin(ph), 0.1, -cos(ph)));
  float lit = smoothstep(-0.05, 0.12, dot(nrmV, sunLocal));
  float maria = smoothstep(0.45, 0.7, hFbm(q * 2.4 + 3.0)) * 0.35;
  float crat = smoothstep(0.75, 0.9, hNoise(q * 9.0)) * 0.15;
  float alb = 0.9 - maria - crat + hNoise(q * 22.0) * 0.08;
  return vec3(1.0, 0.97, 0.92) * alb * (lit * 1.0 + 0.012) * 1.6;
}
vec3 rainbow(vec3 d){
  float c = dot(d, -uTrueSun);
  float a = degrees(acos(clamp(c, -1.0, 1.0)));
  // primary at ~42 degrees (red outside), secondary at ~51 degrees (reversed, fainter)
  float p = (a - 40.6) / 1.9;
  float s = (a - 50.2) / 3.0;
  vec3 col = vec3(0.0);
  if (p > 0.0 && p < 1.0) col += hsv(0.82 * (1.0 - p)) * sin(p * 3.14159) * 0.55;
  if (s > 0.0 && s < 1.0) col += hsv(0.82 * s) * sin(s * 3.14159) * 0.22;
  // Alexander's dark band between them, brighter sky inside the bow
  col -= 0.04 * step(42.5, a) * step(a, 50.2);
  col += 0.05 * smoothstep(40.0, 25.0, a);
  return col * smoothstep(0.0, 0.08, d.y);
}
float cirrus(vec3 d){
  if (d.y < 0.01) return 0.0;
  vec2 p = d.xz / (d.y + 0.08) * 1.6 + uCloudOff / 9000.0;
  vec2 dir = normalize(uWind.xy + vec2(0.001));
  vec2 q = vec2(dot(p, dir), dot(p, vec2(-dir.y, dir.x)));
  q.x *= 0.35;
  // patches of fibrous cirrus with hooked, warped strands rather than ruled lines
  float mask = smoothstep(0.42, 0.72, hFbm(p * 0.32 + 3.1));
  float w = hFbm(q * 2.2 + 5.0);
  float n = hFbm(q * 1.4 + w * 1.1);
  float streak = hFbm(vec2(q.x * 0.8, q.y * 6.5) + vec2(w * 2.2, hFbm(q * 1.7) * 1.6) + 2.0);
  return smoothstep(0.48, 0.86, n * 0.5 + streak * 0.6) * mask * uCirrus * smoothstep(0.02, 0.25, d.y);
}
void main(){
  // from under the sea the dome only shows past the end of the sea floor and the surface mesh: open water
  if (uCamUnder > 0.5) { gl_FragColor = vec4(hWaterScatter(), 1.0); return; }
  vec3 d = normalize(vDir);
  vec2 suv = gl_FragCoord.xy / uRes;
  vec3 sky = textureLod(tClear, vec2(atan(d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5), 0.0).rgb;
  // cirrus high above
  float ci = cirrus(d);
  vec3 sunC = uSunCol * (1.0 - uNight);
  float mu = dot(d, uTrueSun);
  vec3 ciCol = sunC * (0.06 + 0.25 * pow(max(mu, 0.0), 8.0)) + sky * 0.6 + uSunCol * uNight * 0.02;
  sky = mix(sky, ciCol, ci * 0.55);
  // space behind the air: stars, Milky Way, moon, sun disc
  float clearK = smoothstep(-0.02, 0.06, d.y) * (1.0 - ci * 0.7);
  vec3 sd = d;
  float cr = cos(uStarRot), sr = sin(uStarRot);
  sd.xz = mat2(cr, -sr, sr, cr) * sd.xz;
  vec3 night = (stars(sd) + milkyWay(sd)) * uNight * clearK;
  float mcov;
  vec3 mc = moon(d, mcov);
  float sunA = acos(clamp(mu, -1.0, 1.0));
  float sunR = 0.0095 * uSunScale;
  float disc = smoothstep(sunR, sunR * 0.85, sunA);
  float limb = 1.0 - 0.6 * (1.0 - sqrt(max(1.0 - pow(sunA / sunR, 2.0), 0.0)));
  vec3 sunDisc = uSunCol * disc * limb * 260.0 * (1.0 - uNight);
  vec3 space = night * (1.0 - mcov) + mc * mcov * smoothstep(-0.03, 0.03, uMoonDir.y) + sunDisc;
  space *= smoothstep(-0.02, 0.02, d.y);
  // the clouds in front of all of it
  vec4 cl = texture2D(tClouds, suv);
  vec3 col = (sky + space) * cl.a + cl.rgb;
  col *= 1.0 - 0.5 * uRain * smoothstep(-0.1, 0.4, d.y);
  col += rainbow(d) * uRainbow * sky * 2.5 * cl.a;
  col += uFlash * vec3(0.4, 0.45, 0.6) * max(dot(d, uFlashDir), 0.0) * cl.a;
  gl_FragColor = vec4(col, 1.0);
}`;

export class Sky {
  constructor(renderer) {
    this.renderer = renderer;
    const noise = makeCloudNoise();
    this.noise = noise;
    this.panoW = 512;
    this.panoH = 256;
    this.pano = rt(this.panoW, this.panoH, { count: 2, mips: true, min: THREE.LinearMipmapLinearFilter, wrap: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping });
    this.pano.textures[0].generateMipmaps = true;
    this.pano.textures[1].generateMipmaps = false;
    this.pano.textures[1].minFilter = THREE.LinearFilter;
    this.amb = rt(64, 8, { type: THREE.HalfFloatType, wrap: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping });
    U.tSky.value = this.pano.textures[0];
    U.tAmb.value = this.amb.texture;

    const cloudU = {
      tShape: { value: noise.shape },
      tDetail: { value: noise.detail },
      uSunC: { value: new THREE.Vector3(1, 1, 1) },
      uCloudL: { value: new THREE.Vector3(0, 1, 0) },
      uAmbUpC: { value: new THREE.Vector3(0.3, 0.4, 0.6) },
      uAmbDnC: { value: new THREE.Vector3(0.2, 0.2, 0.25) },
      uCamPos: { value: new THREE.Vector3() },
    };
    this.cloudU = cloudU;
    this.panoMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: `out vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: PANO_FRAG,
      uniforms: { ...U, ...cloudU, uPhase: { value: 0 }, uCamH: { value: 2 } },
      depthTest: false,
      depthWrite: false,
    });
    this.ambMat = pass(AMB_FRAG, { ...U, tPano: { value: this.pano.textures[0] }, uCamH: { value: 2 } });

    this.cloudMarch = pass(CLOUD_MARCH_FRAG, {
      ...U, ...cloudU,
      tDepth: { value: null }, uInvVP: { value: new THREE.Matrix4() }, uOff: { value: new THREE.Vector2() },
      uHalfRes: { value: new THREE.Vector2(2, 2) }, uFrame: { value: 0 },
    });
    this.cloudResolve = pass(CLOUD_RESOLVE_FRAG, {
      tNew: { value: null }, tHist: { value: null }, uInvVP: { value: new THREE.Matrix4() }, uPrevVP: { value: new THREE.Matrix4() },
      uOff: { value: new THREE.Vector2() }, uHalfRes: { value: new THREE.Vector2(2, 2) }, uCamPos: { value: new THREE.Vector3() }, uReset: { value: 1 },
    });
    this.qRT = rt(2, 2);
    this.hA = rt(2, 2);
    this.hB = rt(2, 2);
    this.frame = 0;
    this.prevVP = new THREE.Matrix4();
    this.vp = new THREE.Matrix4();
    this.invVP = new THREE.Matrix4();
    this.reset = true;

    this.domeMat = new THREE.ShaderMaterial({
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      uniforms: {
        ...U, tClear: { value: this.pano.textures[1] }, tClouds: { value: this.hA.texture }, uRes: { value: new THREE.Vector2(1, 1) },
        uMoonPhase: { value: 0.35 }, uRainbow: { value: 0 }, uCirrus: { value: 0.5 }, uStarRot: { value: 0 }, uSunScale: { value: 1 },
      },
      depthWrite: false,
      depthTest: true,
      side: THREE.BackSide,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), this.domeMat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1000;
    this.phase = 0;
    this.warm = 0;
  }

  setSize(W, H) {
    const hw = Math.max(2, Math.ceil(W / 4) * 2), hh = Math.max(2, Math.ceil(H / 4) * 2);
    if (hw === this.hA.width && hh === this.hA.height) return;
    // the history is a picture of the sky at infinity, so it carries over a resize: keep the old one for
    // the next resolve instead of starting again from blocky quarter-resolution samples
    this.carry?.dispose();
    this.carry = this.hB;
    this.hB = rt(hw, hh);
    this.hA.dispose();
    this.hA = rt(hw, hh);
    this.qRT.setSize(hw / 2, hh / 2);
    this.cloudMarch.uniforms.uHalfRes.value.set(hw, hh);
    this.cloudResolve.uniforms.uHalfRes.value.set(hw, hh);
    this.domeMat.uniforms.uRes.value.set(W, H);
    if (this.carry.width <= 2) this.reset = true;
  }

  // cloud lighting colours from the environment (computed on the CPU)
  setLight(dir, col, amb) {
    this.cloudU.uCloudL.value.copy(dir);
    this.cloudU.uSunC.value.copy(col).multiplyScalar(1.1);
    this.cloudU.uAmbUpC.value.set(0.36, 0.46, 0.66).multiplyScalar(amb);
    this.cloudU.uAmbDnC.value.set(0.2, 0.24, 0.28).multiplyScalar(amb);
  }

  // panorama (1/4 per frame) and ambient
  updatePanorama(camera, full) {
    const r = this.renderer;
    const n = full ? 4 : 1;
    this.panoMat.uniforms.uCamH.value = Math.max(2, camera.position.y);
    this.cloudU.uCamPos.value.copy(camera.position);
    for (let i = 0; i < n; i++) {
      this.panoMat.uniforms.uPhase.value = this.phase;
      this.phase = (this.phase + 1) % 4;
      fs.render(r, this.panoMat, this.pano);
    }
    this.ambMat.uniforms.uCamH.value = Math.max(2, camera.position.y);
    fs.render(r, this.ambMat, this.amb);
  }

  // visible clouds, after the opaque pass so covered pixels are skipped
  updateClouds(camera, depthTex) {
    const r = this.renderer;
    this.vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.invVP.copy(this.vp).invert();
    const order = [[0, 0], [1, 1], [1, 0], [0, 1]];
    const o = order[this.frame & 3];
    const m = this.cloudMarch.uniforms;
    m.tDepth.value = depthTex;
    m.uInvVP.value.copy(this.invVP);
    m.uOff.value.set(o[0], o[1]);
    m.uFrame.value = this.frame;
    this.cloudU.uCamPos.value.copy(camera.position);
    fs.render(r, this.cloudMarch, this.qRT);
    const s = this.cloudResolve.uniforms;
    s.tNew.value = this.qRT.texture;
    s.tHist.value = (this.carry ?? this.hB).texture;
    s.uInvVP.value.copy(this.invVP);
    s.uPrevVP.value.copy(this.prevVP);
    s.uOff.value.set(o[0], o[1]);
    s.uCamPos.value.copy(camera.position);
    s.uReset.value = this.reset ? 1 : 0;
    fs.render(r, this.cloudResolve, this.hA);
    this.domeMat.uniforms.tClouds.value = this.hA.texture;
    [this.hA, this.hB] = [this.hB, this.hA];
    this.prevVP.copy(this.vp);
    this.frame++;
    this.reset = false;
    if (this.carry) { this.carry.dispose(); this.carry = null; }
  }
}
