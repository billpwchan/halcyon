// Ground-truth ambient occlusion (Jimenez et al. 2016, after XeGTAO) at half resolution from the opaque depth.
// Without a G-buffer the occlusion is applied to the whole resolved pixel, so the pass also estimates how much of
// each pixel's light came from the sun (shadow map, normal from depth) and occludes only the rest: sunlit faces keep
// their contrast, and only light from the sky and the ground is taken away in creases, under eaves and at the foot
// of everything that stands on the ground.
import * as THREE from 'three';
import { fs, pass, rt } from './gpu.js';
import { U } from './shared.js';

const DIRS = 2, STEPS = 6;

const AO_FRAG = /* glsl */ `
precision highp float;
precision highp sampler2DShadow;
uniform sampler2D tDepth, tAmb;
uniform sampler2DShadow tShadow;
uniform mat4 uProj, uInvProj, uViewInv, uShadowM;
uniform vec2 uFull;
uniform vec3 uSunDir, uSunCol;
uniform float uRadius, uOn, uShadowOn;
varying vec2 vUv;
const float PI = 3.14159265;
vec3 viewPos(vec2 uv){
  float z = texture2D(tDepth, uv).x;
  vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
  return v.xyz / v.w;
}
float bayer4(vec2 p){
  ivec2 q = ivec2(mod(p, 4.0));
  int i = q.x + q.y * 4;
  int b[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(b[i]) + 0.5) / 16.0;
}
float fastAcos(float x){
  float a = abs(x);
  float r = (-0.156583 * a + 1.570796) * sqrt(max(1.0 - a, 0.0));
  return x >= 0.0 ? r : PI - r;
}
void main(){
  // the top-left texel of this pixel's 2x2 block, exactly: depth is not to be interpolated
  vec2 px = floor(gl_FragCoord.xy) * 2.0 + 0.5;
  vec2 uv = px / uFull;
  float z = texture2D(tDepth, uv).x;
  // sky: a far distance that half floats still hold (1e5 would store as Inf)
  if (z >= 1.0 || uOn < 0.5) { gl_FragColor = vec4(1.0, 6e4, 0.0, 1.0); return; }
  vec3 P = viewPos(uv);
  float dist = -P.z;
  // normal from depth: on each axis the neighbour nearer in depth, so silhouettes do not bend it
  vec2 tx = 1.0 / uFull;
  vec3 pl = viewPos(uv - vec2(tx.x, 0.0)), pr = viewPos(uv + vec2(tx.x, 0.0));
  vec3 pd = viewPos(uv - vec2(0.0, tx.y)), pu = viewPos(uv + vec2(0.0, tx.y));
  vec3 dx = abs(pr.z - P.z) < abs(P.z - pl.z) ? pr - P : P - pl;
  vec3 dy = abs(pu.z - P.z) < abs(P.z - pd.z) ? pu - P : P - pd;
  vec3 N = normalize(cross(dx, dy));
  vec3 V = normalize(-P);
  if (dot(N, V) < 0.0) N = -N;

  // a fixed world radius, its screen size shrinking with distance; far away there is nothing left to resolve
  float fade = 1.0 - smoothstep(90.0, 160.0, dist);
  vec2 rUv = vec2(uProj[0][0], uProj[1][1]) * 0.5 * uRadius / dist;
  float vis = 1.0;
  if (rUv.y * uFull.y > 2.0 && fade > 0.0) {
    float n0 = bayer4(gl_FragCoord.xy), n1 = fract(n0 * 7.0 + 0.37);
    float falloffMul = -1.0 / (uRadius * 0.4), falloffAdd = 1.0 / 0.4;
    vis = 0.0;
    for (int d = 0; d < ${DIRS}; d++) {
      float phi = (float(d) + n0) * PI / ${DIRS}.0;
      vec2 dir = vec2(cos(phi), sin(phi));
      vec3 dirV = vec3(dir, 0.0);
      vec3 ortho = dirV - dot(dirV, V) * V;
      vec3 axis = normalize(cross(dirV, V));
      vec3 projN = N - axis * dot(N, axis);
      float projLen = length(projN) + 1e-5;
      float sgnN = sign(dot(ortho, projN));
      float cosN = clamp(dot(projN, V) / projLen, 0.0, 1.0);
      float n = sgnN * fastAcos(cosN);
      float low0 = cos(n + PI * 0.5), low1 = cos(n - PI * 0.5);
      float hc0 = low0, hc1 = low1;
      for (int s = 0; s < ${STEPS}; s++) {
        float t = (float(s) + n1) / ${STEPS}.0;
        t = t * t;
        // at least a texel out, or the first sample is the pixel itself
        vec2 off = dir * max(t * rUv, tx * 2.0);
        vec3 S0 = viewPos(uv + off) - P, S1 = viewPos(uv - off) - P;
        float l0 = length(S0), l1 = length(S1);
        float w0 = clamp(l0 * falloffMul + falloffAdd, 0.0, 1.0), w1 = clamp(l1 * falloffMul + falloffAdd, 0.0, 1.0);
        hc0 = max(hc0, mix(low0, dot(S0 / l0, V), w0));
        hc1 = max(hc1, mix(low1, dot(S1 / l1, V), w1));
      }
      float h0 = -fastAcos(hc1), h1 = fastAcos(hc0);
      h0 = n + max(h0 - n, -PI * 0.5);
      h1 = n + min(h1 - n, PI * 0.5);
      float sinN = sin(n);
      float a0 = (cosN + 2.0 * h0 * sinN - cos(2.0 * h0 - n)) * 0.25;
      float a1 = (cosN + 2.0 * h1 * sinN - cos(2.0 * h1 - n)) * 0.25;
      vis += projLen * (a0 + a1);
    }
    vis = clamp(vis / ${DIRS}.0, 0.0, 1.0);
    vis = mix(1.0, vis, fade);
  }

  // the sun's share of this pixel's light: direct sun on this face against the sky and the ground's ambient
  vec3 Pw = (uViewInv * vec4(P, 1.0)).xyz;
  vec3 Nw = normalize(mat3(uViewInv) * N);
  float lit = 1.0;
  if (uShadowOn > 0.5) {
    vec4 sc = uShadowM * vec4(Pw + Nw * 0.08, 1.0);
    if (all(greaterThan(sc.xyz, vec3(0.0))) && all(lessThan(sc.xyz, vec3(1.0)))) lit = texture(tShadow, vec3(sc.xy, sc.z - 0.0005));
  }
  const vec3 L = vec3(0.2126, 0.7152, 0.0722);
  float eSun = dot(uSunCol, L) * max(dot(Nw, uSunDir), 0.0) * lit;
  float eSky = dot(texture2D(tAmb, vec2(0.5 / 64.0, 4.5 / 8.0)).rgb, L) * PI;
  float eAmb = eSky * (0.7 + 0.3 * Nw.y) + dot(uSunCol, L) * max(uSunDir.y, 0.0) * 0.12 * (0.5 - 0.5 * Nw.y);
  float share = eAmb / max(eAmb + eSun, 1e-4);
  gl_FragColor = vec4(1.0 - (1.0 - vis) * share, dist, 0.0, 1.0);
}`;

// The rotation and step pattern repeats every 4 texels, so a box over one whole period cancels it exactly: 5 taps per
// axis, the two end ones at half weight (same phase), on whole-texel offsets (the targets are nearest-filtered). A tap
// counts only on this texel's own surface: its depth is checked against the plane through this texel, extrapolated in
// 1/z (linear in screen space for a plane), so a face seen edge-on keeps all its taps and the pattern still cancels.
const BLUR_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSrc; uniform vec2 uTexel;
varying vec2 vUv;
void main(){
  vec2 c = texture2D(tSrc, vUv).rg;
  if (c.g > 5e4) { gl_FragColor = vec4(1.0, c.g, 0.0, 1.0); return; }
  float iz = 1.0 / c.g;
  float l = 1.0 / texture2D(tSrc, vUv - vec2(uTexel.x, 0.0)).g, r = 1.0 / texture2D(tSrc, vUv + vec2(uTexel.x, 0.0)).g;
  float d = 1.0 / texture2D(tSrc, vUv - vec2(0.0, uTexel.y)).g, u = 1.0 / texture2D(tSrc, vUv + vec2(0.0, uTexel.y)).g;
  float gx = abs(iz - l) < abs(r - iz) ? iz - l : r - iz;
  float gy = abs(iz - d) < abs(u - iz) ? iz - d : u - iz;
  float tol = c.g * 0.03 + 0.03;
  float acc = 0.0, w = 0.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 s = texture2D(tSrc, vUv + vec2(i, j) * uTexel).rg;
    float pz = 1.0 / max(iz + gx * float(i) + gy * float(j), 1e-6);
    float k = (abs(i) == 2 ? 0.5 : 1.0) * (abs(j) == 2 ? 0.5 : 1.0) * (1.0 - smoothstep(tol * 0.5, tol, abs(s.g - pz)));
    acc += s.r * k; w += k;
  }
  gl_FragColor = vec4(w > 0.0 ? acc / w : c.r, c.g, 0.0, 1.0);
}`;

export class AmbientOcclusion {
  constructor() {
    this.a = rt(4, 4, { min: THREE.NearestFilter, mag: THREE.NearestFilter });
    this.b = rt(4, 4, { min: THREE.NearestFilter, mag: THREE.NearestFilter });
    this.radius = 1.4;
    this.mat = pass(AO_FRAG, {
      tDepth: { value: null }, tAmb: U.tAmb, tShadow: { value: null },
      uProj: { value: new THREE.Matrix4() }, uInvProj: { value: new THREE.Matrix4() }, uViewInv: { value: new THREE.Matrix4() }, uShadowM: { value: new THREE.Matrix4() },
      uFull: { value: new THREE.Vector2() }, uSunDir: U.uSunDir, uSunCol: U.uSunCol,
      uRadius: { value: this.radius }, uOn: { value: 1 }, uShadowOn: { value: 0 },
    });
    this.blurMat = pass(BLUR_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
  }
  setSize(W, H) {
    const w = Math.ceil(W / 2), h = Math.ceil(H / 2);
    this.a.setSize(w, h);
    this.b.setSize(w, h);
    this.mat.uniforms.uFull.value.set(W, H);
    this.blurMat.uniforms.uTexel.value.set(1 / w, 1 / h);
  }
  // returns the texture to multiply the resolved image by: R = factor, G = view distance
  render(renderer, depth, camera, sun) {
    const u = this.mat.uniforms;
    u.tDepth.value = depth;
    u.uProj.value.copy(camera.projectionMatrix);
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uViewInv.value.copy(camera.matrixWorld);
    const map = sun?.castShadow && sun.shadow.map?.depthTexture;
    u.uShadowOn.value = map ? 1 : 0;
    u.tShadow.value = map || null;
    if (map) u.uShadowM.value.copy(sun.shadow.matrix);
    fs.render(renderer, this.mat, this.a);
    this.blurMat.uniforms.tSrc.value = this.a.texture;
    fs.render(renderer, this.blurMat, this.b);
    return this.b.texture;
  }
}
