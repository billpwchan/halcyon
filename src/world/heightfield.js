// The island's heightfield, generated on the GPU, read back once for the CPU (walking, placement, buoyancy),
// plus the coast distance field (jump flooding), the sun-visibility map and the cloud weather map.
import * as THREE from 'three';
import { fs, pass, rt, readFloat } from '../core/gpu.js';
import { NOISE } from '../core/shared.js';
import { HF, LOBES, BAYS, REEF, PASS, MOTUS, PATHS, PADS, LIGHTHOUSE, VILLAGE } from './layout.js';

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const arr = (name, rows) => `const vec${rows[0].length} ${name}[${rows.length}] = vec${rows[0].length}[](${rows.map((r) => `vec${r.length}(${r.map(f).join(',')})`).join(',')});`;

// GLSL shared by the generator and the coast pass: the ring of the reef and the island outline
export const ISLAND_GLSL = /* glsl */ `
${arr('LOBES', LOBES.map((l) => l.slice(0, 4)))}
${arr('BAYS', BAYS.map((b) => b.slice(0, 4)))}
${arr('MOTUS', MOTUS.map((m) => [(m[0] * Math.PI) / 180, (m[1] * Math.PI) / 180, m[2], m[3]]))}
const vec4 REEF = vec4(${f(REEF.cx)}, ${f(REEF.cz)}, ${f(REEF.rx)}, ${f(REEF.rz)});
const float REEF_HALF = ${f(REEF.half)};
const vec2 PASS = vec2(${PASS.a}, ${PASS.half});
const vec3 LIGHT = vec3(${f(LIGHTHOUSE.x)}, ${f(LIGHTHOUSE.z)}, ${f(LIGHTHOUSE.top)});

float sdEllipse(vec2 p, vec4 e, float rot){
  vec2 q = p - e.xy; float c = cos(rot), s = sin(rot);
  q = vec2(c * q.x + s * q.y, -s * q.x + c * q.y);
  return (length(q / e.zw) - 1.0) * min(e.z, e.w);
}
float smin(float a, float b, float k){ float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
float smax(float a, float b, float k){ return -smin(-a, -b, k); }

// signed distance (m) to the reef centreline: + outside (ocean), - inside (lagoon); also returns the angle
float ringDist(vec2 p, out float ang){
  vec2 q = p - REEF.xy;
  ang = atan(q.y, q.x);
  float wob = (hNoise(vec2(ang * 3.0, 1.7)) - 0.5) * 120.0 + (hNoise(vec2(ang * 11.0, 4.3)) - 0.5) * 34.0;
  return (length(q / REEF.zw) - 1.0) * min(REEF.z, REEF.w) - wob;
}
// soft weight for angle a inside [a0, a1] (radians; a1 may exceed 2pi), feathered by ~3 degrees
float angIn(float a, float a0, float a1){
  float c = 0.5 * (a0 + a1), hw = 0.5 * (a1 - a0);
  float da = abs(mod(a - c + 3.14159265, 6.2831853) - 3.14159265);
  return smoothstep(hw + 0.05, hw - 0.05, da);
}
`;

// lobes carry their rotation in a separate table (vec4 holds cx, cz, rx, rz)
const LOBE_ROT = LOBES.map((l) => l[4]);
const BAY_ROT = BAYS.map((b) => b[4]);

const GEN_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tFeat, tMassif;
uniform vec4 uHF, uMassif;
varying vec2 vUv;
${NOISE}
${ISLAND_GLSL}
const float LOBE_ROT[${LOBE_ROT.length}] = float[](${LOBE_ROT.map(f).join(',')});
const float BAY_ROT[${BAY_ROT.length}] = float[](${BAY_ROT.map(f).join(',')});

vec2 g2(vec2 i){ float h = hHash12(i) * 6.2831853; return vec2(cos(h), sin(h)); }
vec3 noised(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  vec2 ga = g2(i), gb = g2(i + vec2(1, 0)), gc = g2(i + vec2(0, 1)), gd = g2(i + vec2(1, 1));
  float va = dot(ga, f), vb = dot(gb, f - vec2(1, 0)), vc = dot(gc, f - vec2(0, 1)), vd = dot(gd, f - vec2(1, 1));
  float v = va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * (va - vb - vc + vd);
  vec2 d = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd) + du * (u.yx * (va - vb - vc + vd) + vec2(vb, vc) - va);
  return vec3(v, d);
}
// fbm whose higher octaves are damped on steep ground: reads as ridges and eroded gullies
float eroded(vec2 p, int oct){
  float a = 0.0, b = 1.0; vec2 d = vec2(0.0);
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 10; i++){
    if (i >= oct) break;
    vec3 n = noised(p);
    d += n.yz;
    a += b * n.x / (1.0 + dot(d, d));
    b *= 0.5;
    p = m * p;
  }
  return a;
}

// the mountain's relief at this texel (massif.js): full, or blurred for the smooth surface
float massifAt(float detail){
  ivec2 t = ivec2(floor(vUv * uHF.w)) - ivec2(uMassif.xy);
  if (t.x < 0 || t.y < 0 || t.x >= int(uMassif.z) || t.y >= int(uMassif.w)) return 0.0;
  vec2 m = texelFetch(tMassif, t, 0).rg;
  return detail > 0.5 ? m.r : m.g;
}

float islandShape(vec2 p){
  float d = 1e9;
  for (int i = 0; i < ${LOBES.length}; i++) d = smin(d, sdEllipse(p, LOBES[i], LOBE_ROT[i]), 110.0);
  for (int i = 0; i < ${BAYS.length}; i++) d = smax(d, -sdEllipse(p, BAYS[i], BAY_ROT[i]), 60.0);
  // ragged coastline: headlands and coves
  d += (hFbm(p * 0.0035) - 0.5) * 150.0 + (hNoise(p * 0.016) - 0.5) * 26.0;
  return d;
}

// detail = 0 gives the smooth version used for flattening pads and paths
float islandH(vec2 p, float detail, out float er){
  float sd = islandShape(p);
  float din = -sd;
  er = eroded(p / 380.0 + 7.3, detail > 0.5 ? 9 : 3);
  // beach: gentle, width varies along the coast
  float bw = 34.0 + 26.0 * hNoise(p * 0.006);
  float beach = din * mix(0.075, 0.05, smoothstep(0.0, bw, din));
  float plain = 2.0 + 3.5 * smoothstep(bw, bw + 160.0, din) + (hNoise(p * 0.01) - 0.5) * 1.6 * smoothstep(bw, bw + 60.0, din);
  float land = din < bw ? beach : mix(beach, plain, smoothstep(bw - 10.0, bw + 40.0, din));
  // the fringing shelf slopes into the lagoon and is gone well before the reef, which owns the outer seabed
  land = din < 0.0 ? -2.9 * (1.0 - exp(din / 30.0)) - max(-din - 40.0, 0.0) * 0.06 - max(-din - 250.0, 0.0) * 0.5 : land;
  // the mountain: a real one (scripts/massif.mjs), rising out of the plain behind the beaches; the village keeps its
  // flat ground at the foot of the spurs
  float lot = smoothstep(${f(VILLAGE.r + 150)}, ${f(VILLAGE.r)}, length(p - vec2(${f(VILLAGE.x)}, ${f(VILLAGE.z)})));
  float mountains = massifAt(detail) * smoothstep(bw + 10.0, bw + 200.0, din) * (1.0 - lot);
  float h = land + mountains;
  // fine roughness inland, none on the sand
  h += (hNoise(p * 0.07) - 0.5) * 1.4 * smoothstep(bw + 10.0, bw + 80.0, din) * detail;
  return h;
}

float seabed(vec2 p, float detail, out float coral){
  float ang;
  float rs = ringDist(p, ang);
  float n1 = hFbm(p * 0.006), n2 = hNoise(p * 0.03);
  // lagoon floor: white sand, shallows, coral heads
  float lag = -6.2 + (n1 - 0.5) * 5.0 + (hNoise(p * 0.0013) - 0.5) * 3.0;
  // coral heads: lobed knolls with ragged edges (a warped grid of value noise reads as ellipses on a lattice), and lone
  // heads scattered over the sand around them
  vec2 bq = p * 0.024 + 3.1 + (vec2(hNoise(p * 0.045 + 1.7), hNoise(p * 0.045 + 8.3)) - 0.5) * 0.9;
  float bn = hNoise(bq) * 0.75 + hNoise(p * 0.085 + 5.3) * 0.25;
  float lone = smoothstep(0.86, 0.94, hNoise(p * 0.075 + 13.0)) * smoothstep(0.4, 0.58, bn);
  float bommie = max(smoothstep(0.62, 0.78, bn), lone * 0.8) * (4.0 + 2.0 * n2);
  lag = min(lag + bommie * detail, -1.35 - 0.3 * n2);
  float backFlat = -1.15 - 0.4 * n2 + (hNoise(p * 0.08) - 0.5) * 0.35 * detail;
  float crest = -0.5 + (n2 - 0.5) * 0.45 + (hNoise(p * 0.11) - 0.5) * 0.25 * detail;
  float od = rs - REEF_HALF;
  // spur and groove down the outer slope
  float spur = sin(ang * 520.0 + hNoise(p * 0.02) * 6.0) * 1.6 * smoothstep(0.0, 20.0, od) * smoothstep(160.0, 40.0, od);
  float drop = -0.6 - 30.0 * smoothstep(0.0, 60.0, od) - 160.0 * smoothstep(60.0, 380.0, od) - 300.0 * smoothstep(380.0, 1000.0, od) + spur * detail;
  float inner = mix(backFlat, lag, smoothstep(-REEF_HALF, -REEF_HALF - 190.0, rs));
  // blend the crest into the back-reef and the outer slope
  float eIn = smoothstep(-REEF_HALF - 14.0, -REEF_HALF + 8.0, rs);
  float eOut = smoothstep(REEF_HALF + 10.0, REEF_HALF - 8.0, rs);
  float h = rs < 0.0 ? mix(inner, crest, eIn) : mix(drop, crest, eOut);
  // living coral: the heads in the lagoon, the reef crest, patches on the back-reef, the spurs outside
  float patches = smoothstep(0.52, 0.7, hNoise(p * 0.045 + 11.0) * 0.7 + n2 * 0.3);
  coral = smoothstep(0.25, 0.6, bommie / 4.0);
  coral = max(coral, smoothstep(REEF_HALF + 30.0, REEF_HALF - 6.0, abs(rs)) * (0.55 + 0.45 * patches));
  coral = max(coral, smoothstep(-REEF_HALF - 10.0, -REEF_HALF - 30.0, rs) * smoothstep(-REEF_HALF - 200.0, -REEF_HALF - 120.0, rs) * patches * 0.8);
  coral = max(coral, smoothstep(0.0, 15.0, od) * smoothstep(140.0, 60.0, od) * (0.5 + 0.5 * spur / 1.6));
  // the pass: a deep channel through the reef
  float pw = angIn(ang, PASS.x - PASS.y, PASS.x + PASS.y);
  float chan = -16.0 + (n2 - 0.5) * 4.0;
  h = mix(h, min(h, chan), pw * smoothstep(320.0, 120.0, abs(rs)));
  // motus: low sand islands riding the reef
  for (int i = 0; i < ${MOTUS.length}; i++){
    vec4 mo = MOTUS[i];
    float w = angIn(ang, mo.x, mo.y);
    if (w <= 0.0) continue;
    float hw = mo.z * (0.75 + 0.5 * hNoise(vec2(ang * 9.0, float(i))));
    float prof = smoothstep(hw * 1.6, hw * 0.15, abs(rs + 6.0));
    float top = mo.w * (0.55 + 0.45 * hNoise(p * 0.02));
    float hm = mix(-2000.0, top, pow(prof, 0.8));
    h = smax(h, mix(-2000.0, hm, w), 1.2);
    coral *= 1.0 - smoothstep(0.2, 0.6, prof * w);
  }
  // the light's stack: a basalt plateau with cliffs to a boulder apron, and a level pad for the tower
  {
    float lr = length(p - LIGHT.xy);
    float nn = hNoise(p * 0.09) * 0.6 + hNoise(p * 0.27 + 3.1) * 0.4;
    float rr = lr + (nn - 0.5) * 14.0;
    float top = LIGHT.z - 0.6 + hNoise(p * 0.35) * 0.9;
    float stack = mix(-5.0, top, smoothstep(21.5, 16.5, rr));
    stack = max(stack, mix(-12.0, 1.1, smoothstep(46.0, 25.0, rr + (hNoise(p * 0.6) - 0.5) * 8.0)));
    stack = mix(stack, LIGHT.z, smoothstep(11.0, 8.0, lr));
    // local only: beyond the apron the stack has no say over the seabed
    h = smax(h, mix(-2000.0, stack, smoothstep(58.0, 46.0, lr)), 1.5);
    coral *= smoothstep(34.0, 56.0, lr);
  }
  return h;
}

void main(){
  vec2 p = uHF.xy + vUv * uHF.z;
  vec4 feat = texture2D(tFeat, vUv);
  float er;
  float hi = islandH(p, 1.0, er);
  float erS;
  float his = islandH(p, 0.0, erS);
  // pads and paths pull toward the smooth surface
  float pad = feat.g;
  hi = mix(hi, his + 0.15, pad);
  hi = mix(hi, mix(hi, his, 0.7) - 0.18, feat.r * smoothstep(0.5, 3.0, hi));
  float coral;
  float sb = seabed(p, 1.0, coral);
  float h = smax(hi, sb, 3.0);
  // alpha carries the pads on land and, negated, the coral under water
  coral *= smoothstep(-0.3, -1.2, h) * smoothstep(hi - 0.5, hi + 1.5, sb);
  gl_FragColor = vec4(h, er, feat.r, h >= 0.0 ? pad : -coral);
}`;

// Jump flooding over the -0.9 m isoline (where waves break): seed, flood, then resolve to distance + direction.
const BREAK_LEVEL = -0.9;
const SEED_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tH; uniform vec2 uTexel;
varying vec2 vUv;
void main(){
  float h = texture2D(tH, vUv).r - ${BREAK_LEVEL.toFixed(2)};
  float a = texture2D(tH, vUv + vec2(uTexel.x, 0.0)).r - ${BREAK_LEVEL.toFixed(2)};
  float b = texture2D(tH, vUv + vec2(0.0, uTexel.y)).r - ${BREAK_LEVEL.toFixed(2)};
  float c = texture2D(tH, vUv - vec2(uTexel.x, 0.0)).r - ${BREAK_LEVEL.toFixed(2)};
  float d = texture2D(tH, vUv - vec2(0.0, uTexel.y)).r - ${BREAK_LEVEL.toFixed(2)};
  bool edge = (h * a <= 0.0) || (h * b <= 0.0) || (h * c <= 0.0) || (h * d <= 0.0);
  gl_FragColor = edge ? vec4(vUv, 0.0, 1.0) : vec4(-1.0, -1.0, 0.0, 0.0);
}`;
const JFA_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSrc; uniform float uStep; uniform vec2 uTexel;
varying vec2 vUv;
void main(){
  vec2 best = vec2(-1.0); float bd = 1e9;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec2 s = texture2D(tSrc, vUv + vec2(x, y) * uStep * uTexel).xy;
    if (s.x < 0.0) continue;
    float d = dot(s - vUv, s - vUv);
    if (d < bd){ bd = d; best = s; }
  }
  gl_FragColor = vec4(best, 0.0, 1.0);
}`;
const COAST_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSeed, tH; uniform vec4 uHF;
varying vec2 vUv;
${NOISE}
${ISLAND_GLSL}
void main(){
  vec2 s = texture2D(tSeed, vUv).xy;
  float h = texture2D(tH, vUv).r;
  float sgn = h < ${BREAK_LEVEL.toFixed(2)} ? 1.0 : -1.0;
  vec2 dv = (s - vUv) * uHF.z;
  float dist = s.x < 0.0 ? 999.0 : length(dv);
  vec2 dir = dist > 1e-3 ? dv / dist * sgn : vec2(0.0);
  vec2 p = uHF.xy + vUv * uHF.z;
  float ang;
  float rs = ringDist(p, ang);
  float lagoon = smoothstep(-REEF_HALF + 10.0, -REEF_HALF - 60.0, rs);
  gl_FragColor = vec4(dist * sgn, dir, lagoon);
}`;

// Soft terrain shadow toward the sun, marched across the heightfield.
const HORIZON_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tH; uniform vec3 uL; uniform vec4 uHF;
varying vec2 vUv;
void main(){
  vec2 p = uHF.xy + vUv * uHF.z;
  float h0 = max(texture2D(tH, vUv).r, 0.0) + 1.5;
  vec3 L = normalize(vec3(uL.x, max(uL.y, 0.015), uL.z));
  float vis = 1.0;
  float t = 4.0;
  for (int i = 0; i < 56; i++){
    vec3 q = vec3(p.x, h0, p.y) + vec3(L.x, L.y, L.z) * t;
    vec2 uv = (q.xz - uHF.xy) / uHF.z;
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0))) || q.y > 400.0) break;
    float hq = texture2D(tH, uv).r;
    vis = min(vis, clamp(14.0 * (q.y - hq) / t + 0.5, 0.0, 1.0));
    t *= 1.11;
    t += 2.0;
  }
  gl_FragColor = vec4(smoothstep(0.0, 1.0, vis), 0.0, 0.0, 1.0);
}`;

// tiling cloud coverage map: periodic fbm, broken into cells
const WEATHER_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
float h21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float pn(vec2 p, float per){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  float a = h21(mod(i, per)), b = h21(mod(i + vec2(1, 0), per)), c = h21(mod(i + vec2(0, 1), per)), d = h21(mod(i + vec2(1, 1), per));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y); }
float wl(vec2 p, float per){ vec2 i = floor(p), f = fract(p); float md = 1.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){ vec2 g = vec2(x, y); vec2 o = vec2(h21(mod(i + g, per)), h21(mod(i + g, per) + 17.0)); md = min(md, length(g + o - f)); }
  return md; }
void main(){
  vec2 p = vUv;
  float s = 0.0, a = 0.5, per = 6.0;
  for (int i = 0; i < 6; i++){ s += a * pn(p * per, per); per *= 2.0; a *= 0.5; }
  // clouds of one size in an even scatter read as a pattern: small puffs, the usual cumulus and the odd big
  // congestus, gathered into clusters with clear lanes between them
  float field = pn(p * 3.0, 3.0);
  float cells = max(1.0 - wl(p * 10.0, 10.0), (1.0 - wl(p * 23.0, 23.0)) * 0.86);
  cells = max(cells, (1.0 - wl(p * 5.0, 5.0)) * 1.06 * smoothstep(0.55, 0.8, field));
  float c = s * 0.75 + cells * 0.45 - 0.17 + (field - 0.5) * 0.3;
  gl_FragColor = vec4(c, cells, s, 1.0);
}`;

function paintFeatures() {
  const N = 1024;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const g = cv.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, N, N);
  const toPx = (x) => ((x - HF.origin) / HF.size) * N;
  const sc = N / HF.size;
  g.globalCompositeOperation = 'lighter';
  // pads: green, soft disc
  for (const [x, z, r, k] of PADS) {
    const gr = g.createRadialGradient(toPx(x), toPx(z), 0, toPx(x), toPx(z), r * sc);
    const v = Math.round(k * 255);
    gr.addColorStop(0, `rgb(0,${v},0)`);
    gr.addColorStop(0.65, `rgb(0,${Math.round(v * 0.85)},0)`);
    gr.addColorStop(1, 'rgb(0,0,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, N, N);
  }
  // paths: red, soft line
  g.globalCompositeOperation = 'lighten';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.filter = 'blur(1.2px)';
  for (const p of PATHS) {
    g.strokeStyle = 'rgb(255,0,0)';
    g.lineWidth = p.w * sc;
    g.beginPath();
    p.pts.forEach(([x, z], i) => (i ? g.lineTo(toPx(x), toPx(z)) : g.moveTo(toPx(x), toPx(z))));
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = false;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

export class Heightfield {
  constructor(renderer) {
    this.renderer = renderer;
    this.res = HF.res;
    this.coastRes = 1024;
  }

  generate(massif) {
    const r = this.renderer;
    const N = this.res;
    const feat = paintFeatures();
    this.rtH = rt(N, N, { type: THREE.FloatType });
    const gen = pass(GEN_FRAG, {
      tFeat: { value: feat },
      tMassif: { value: massif.tex },
      uHF: { value: new THREE.Vector4(HF.origin, HF.origin, HF.size, HF.res) },
      uMassif: { value: new THREE.Vector4(massif.i0, massif.j0, massif.w, massif.h) },
    });
    fs.render(r, gen, this.rtH);
    const raw = readFloat(r, this.rtH, N, N);
    this.massif = massif;
    this.h = new Float32Array(N * N);
    this.er = new Float32Array(N * N);
    this.path = new Float32Array(N * N);
    this.pad = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) {
      this.h[i] = raw[i * 4];
      this.er[i] = raw[i * 4 + 1];
      this.path[i] = raw[i * 4 + 2];
      this.pad[i] = raw[i * 4 + 3];
    }
    gen.dispose();
    feat.dispose();
    massif.tex.dispose();
    this.tHeight = this.rtH.texture;
    // float textures are filtered linearly on Apple and desktop GPUs; fall back to nearest otherwise
    const ok = r.extensions.has('OES_texture_float_linear');
    this.tHeight.minFilter = this.tHeight.magFilter = ok ? THREE.LinearFilter : THREE.NearestFilter;
    this.floatLinear = ok;
    this.buildCoast();
    this.buildWeather();
    this.rtHorizon = rt(1024, 1024, { type: THREE.HalfFloatType });
    this.horizonMat = pass(HORIZON_FRAG, { tH: { value: this.tHeight }, uL: { value: new THREE.Vector3(0, 1, 0) }, uHF: { value: new THREE.Vector4(HF.origin, HF.origin, HF.size, HF.res) } });
    this.horizonQuad = 4;
    this.lastL = new THREE.Vector3(0, -1, 0);
  }

  // what a walker stands on
  solidAt(x, z) {
    return this.heightAt(x, z);
  }

  buildCoast() {
    const r = this.renderer;
    const M = this.coastRes;
    const texel = new THREE.Vector2(1 / M, 1 / M);
    const a = rt(M, M, { type: THREE.FloatType, min: THREE.NearestFilter, mag: THREE.NearestFilter });
    const b = rt(M, M, { type: THREE.FloatType, min: THREE.NearestFilter, mag: THREE.NearestFilter });
    const seed = pass(SEED_FRAG, { tH: { value: this.tHeight }, uTexel: { value: texel } });
    fs.render(r, seed, a);
    const jfa = pass(JFA_FRAG, { tSrc: { value: null }, uStep: { value: 1 }, uTexel: { value: texel } });
    let src = a, dst = b;
    for (let step = M / 2; step >= 1; step /= 2) {
      jfa.uniforms.tSrc.value = src.texture;
      jfa.uniforms.uStep.value = step;
      fs.render(r, jfa, dst);
      [src, dst] = [dst, src];
    }
    // one more pass at step 1 cleans up JFA's few wrong seeds
    jfa.uniforms.tSrc.value = src.texture;
    jfa.uniforms.uStep.value = 1;
    fs.render(r, jfa, dst);
    [src, dst] = [dst, src];
    this.rtCoast = rt(M, M, { type: THREE.FloatType });
    const coast = pass(COAST_FRAG, { tSeed: { value: src.texture }, tH: { value: this.tHeight }, uHF: { value: new THREE.Vector4(HF.origin, HF.origin, HF.size, HF.res) } });
    fs.render(r, coast, this.rtCoast);
    this.coast = readFloat(r, this.rtCoast, M, M);
    this.tCoast = this.rtCoast.texture;
    this.tCoast.minFilter = this.tCoast.magFilter = this.floatLinear ? THREE.LinearFilter : THREE.NearestFilter;
    a.dispose(); b.dispose(); seed.dispose(); jfa.dispose(); coast.dispose();
  }

  buildWeather() {
    this.rtWeather = rt(512, 512, { type: THREE.HalfFloatType, wrap: THREE.RepeatWrapping, mips: true, min: THREE.LinearMipmapLinearFilter });
    const m = pass(WEATHER_FRAG);
    fs.render(this.renderer, m, this.rtWeather);
    m.dispose();
    this.tWeather = this.rtWeather.texture;
  }

  // the horizon map follows the sun in quarters; a full refresh takes four frames
  updateHorizon(L, force) {
    const r = this.renderer;
    if (!force && this.horizonQuad >= 4) {
      if (L.angleTo(this.lastL) < 0.004) return;
      this.horizonQuad = 0;
      this.lastL.copy(L);
      this.horizonMat.uniforms.uL.value.copy(L);
    }
    if (force) {
      this.lastL.copy(L);
      this.horizonMat.uniforms.uL.value.copy(L);
      r.setRenderTarget(this.rtHorizon);
      fs.render(r, this.horizonMat, this.rtHorizon);
      this.horizonQuad = 4;
      return;
    }
    const q = this.horizonQuad++;
    const x = (q & 1) * 512, y = (q >> 1) * 512;
    this.rtHorizon.scissor.set(x, y, 512, 512);
    this.rtHorizon.scissorTest = true;
    fs.render(r, this.horizonMat, this.rtHorizon);
    this.rtHorizon.scissorTest = false;
  }

  // ---------------------------------------------------------------- CPU sampling
  heightAt(x, z) {
    const N = this.res;
    const u = ((x - HF.origin) / HF.size) * N - 0.5;
    const v = ((z - HF.origin) / HF.size) * N - 0.5;
    if (u < 0 || v < 0 || u >= N - 1 || v >= N - 1) return -400;
    const i = Math.floor(u), j = Math.floor(v);
    const fu = u - i, fv = v - j;
    const k = j * N + i;
    const h = this.h;
    return (h[k] * (1 - fu) + h[k + 1] * fu) * (1 - fv) + (h[k + N] * (1 - fu) + h[k + N + 1] * fu) * fv;
  }

  sampleField(arr, x, z) {
    const N = this.res;
    const i = Math.min(N - 1, Math.max(0, Math.floor(((x - HF.origin) / HF.size) * N)));
    const j = Math.min(N - 1, Math.max(0, Math.floor(((z - HF.origin) / HF.size) * N)));
    return arr[j * N + i];
  }

  normalAt(x, z, out) {
    const e = HF.texel;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    out.set(-hx, 2 * e, -hz).normalize();
    return out;
  }

  // signed distance to the break line, shoreward direction and lagoon mask
  coastAt(x, z, out) {
    const M = this.coastRes;
    const u = ((x - HF.origin) / HF.size) * M - 0.5;
    const v = ((z - HF.origin) / HF.size) * M - 0.5;
    if (u < 0 || v < 0 || u >= M - 1 || v >= M - 1) { out.d = 999; out.dx = 0; out.dz = 0; out.lag = 0; return out; }
    const i = Math.floor(u), j = Math.floor(v);
    const fu = u - i, fv = v - j;
    const c = this.coast;
    const s = (o) => {
      const k0 = (j * M + i) * 4 + o, k1 = k0 + 4, k2 = k0 + M * 4, k3 = k2 + 4;
      return (c[k0] * (1 - fu) + c[k1] * fu) * (1 - fv) + (c[k2] * (1 - fu) + c[k3] * fu) * fv;
    };
    out.d = s(0); out.dx = s(1); out.dz = s(2); out.lag = s(3);
    return out;
  }
}
