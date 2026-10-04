// Vegetation: plants scattered from the vegetation map and drawn as full geometry near the camera (two levels of
// detail with dithered cross-fades), as hemi-octahedral impostors beyond, all swaying in the shared wind.
// The plants are scanned and modelled species built by scripts/flora.mjs: each is a wood part and a leaf part whose
// source maps share one atlas per part, with wind and foliage occlusion baked into its vertices.
// Near instances are culled per 32 m cell on the CPU; impostors are one static draw whose vertex shader keeps
// only the trees past the hand-over distance.
import * as THREE from 'three';
import { U, patch, COMMON } from '../core/shared.js';
import { loadFlora, toFloat } from '../core/models.js';
import { HF, VILLAGE } from '../world/layout.js';
import { PLAN } from '../world/plan.js';
import { vnoise } from '../world/vegmap.js';

const NEAR0 = 62, BAND0 = 5; // palms: full detail, handing over to LOD1 across 57..62 m
const NEAR_T = 46; // broadleaf trees, denser and heavier, hand over sooner
// a tree's full scan only within FULL; from there to its near distance it keeps the near level's wood and half its
// leaves (each scaled up about its centre), which at that range is under two pixels of difference per leaf
const FULL = 24, BAND_F = 4, THINB = 0.5;
// trees past MID draw a lighter level made from LOD1 at load (thinLeaves): the band out to the impostors holds most of
// the visible trees, each a hundred to two hundred pixels tall
const MID = 115, BAND_M = 10; // LOD1 handing over to LOD2 across 105..115 m
const FAR1 = 180, BAND1 = 16; // LOD2 handing over to impostors across 164..180 m, about their own frame size (128 px)
const THIN2 = 0.4; // share of LOD1's leaves LOD2 keeps
const NEAR_U = 22, BAND_NU = 4; // understory: full detail to 22 m, its light level beyond
const UNDER = 70, BAND_U = 18; // and shrinks away across 52..70 m
const SHADOW_BOX = 84; // half size of the sun's shadow box (main.js), plus a margin
const CELL = 32;
const IMP_N = 8; // frames per side of the hemi-octahedral grid
const IMP_FIT = 0.96; // a frame's content stays inside this share of its cell, away from mip bleed
const SLOTS_X = 4, SLOTS_Y = 3;
const RECTS = 16; // atlas rectangles per part

// species; a tree's `slot` is the impostor that stands in for it far away
const PROTOS = [
  { asset: 'palm_a', group: 'tree', slot: 0, palm: true },
  { asset: 'palm_b', group: 'tree', slot: 1, palm: true },
  { asset: 'palm_c', group: 'tree', slot: 2, palm: true },
  { asset: 'palm_d', group: 'tree', slot: 3, palm: true },
  { asset: 'fig', group: 'tree', slot: 4 },
  { asset: 'fig_b', group: 'tree', slot: 5 },
  { asset: 'orchid', group: 'tree', slot: 6 },
  { asset: 'poinciana', group: 'tree', slot: 7 },
  { asset: 'poinciana_b', group: 'tree', slot: 8 },
  { asset: 'frangipani', group: 'tree', slot: 9 },
  { asset: 'cordyline', group: 'tree', slot: 10 },
  { asset: 'banana', group: 'under' },
  { asset: 'banana_b', group: 'under' },
  { asset: 'monstera', group: 'under' },
  { asset: 'hibiscus', group: 'under' },
  { asset: 'hibiscus_b', group: 'under' },
  { asset: 'turkscap', group: 'under' },
  { asset: 'sago', group: 'under' },
  { asset: 'sago_b', group: 'under' },
  { asset: 'butterfly', group: 'under' },
  { asset: 'rhapis', group: 'under' },
  { asset: 'fern', group: 'under' },
  { asset: 'fern_b', group: 'under' },
  { asset: 'taro', group: 'under' },
];
const byAsset = (...names) => names.map((n) => PROTOS.findIndex((p) => p.asset === n)).filter((k) => k >= 0);
// the roles placement asks for, and the species that fill them
const ID = {
  palmLean: byAsset('palm_a', 'palm_b'), palmMid: byAsset('palm_b', 'palm_c', 'palm_a'), palmTall: byAsset('palm_c', 'palm_d'), palmYoung: byAsset('palm_a', 'palm_b'),
  broad: byAsset('fig', 'fig_b', 'orchid'), bread: byAsset('fig_b', 'frangipani'), flame: byAsset('poinciana', 'poinciana_b'),
  banana: byAsset('banana', 'banana_b'), pandan: byAsset('cordyline'), fern: byAsset('fern', 'fern_b', 'monstera', 'taro'),
  shrub: byAsset('hibiscus', 'hibiscus_b'), sprig: byAsset('sago', 'rhapis'), beach: byAsset('turkscap', 'hibiscus_b', 'butterfly'),
};
// young palms are the grown ones at a smaller size
const YOUNG = 0.4;

// ------------------------------------------------------------------ shared GLSL
const TREE_GLSL = /* glsl */ `
float hTreeHash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
// wind in world metres for a plant rooted at root; w = sway, flex, flutter amplitudes and a phase
vec3 hTreeWind(vec3 root, vec4 w, float ph){
  vec2 wd = normalize(uWind.xy + vec2(1e-4));
  float S = uWind.z, t = uTime;
  float gust = 0.5 + 0.5 * sin(dot(root.xz, wd) * 0.035 - t * 0.8) * sin(dot(root.xz, vec2(-wd.y, wd.x)) * 0.021 + t * 0.31);
  vec3 W = vec3(wd.x, 0.0, wd.y);
  vec3 off = W * w.x * (S * (0.35 + 0.9 * gust) + S * 0.3 * sin(t * 0.85 + ph));
  float bob = sin(t * 1.7 + ph + w.w * 1.3) * 0.7 + sin(t * 2.9 + w.w * 2.1 + ph) * 0.3;
  off += (W * (0.4 + 0.8 * gust + 0.25 * bob) + vec3(0.0, bob * 0.5 - 0.15 * gust, 0.0)) * w.y * S;
  return off;
}
// one plant to the next: a little lighter or darker, a touch warmer or cooler, as real stands vary
vec3 hTreeTint(vec2 xz){
  float a = hTreeHash(xz * 0.731), b = hTreeHash(xz.yx * 1.37 + 4.1);
  return mix(vec3(0.96, 1.0, 1.03), vec3(1.05, 1.02, 0.9), a) * (0.92 + 0.16 * b);
}
float hIgn(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`;
// a part's maps share one atlas: rect = xy origin, zw size (z < 0: the map tiles, so the uv wraps inside it)
const ATLAS_GLSL = /* glsl */ `
uniform sampler2D tC, tN;
uniform vec4 uRects[${RECTS}];
uniform vec2 uAtlas;
vec2 hAtUv(vec2 uv, vec4 r){ return r.xy + (r.z < 0.0 ? fract(uv) : clamp(uv, 0.0, 1.0)) * abs(r.zw); }
`;

const VERT_HEAD = /* glsl */ `
attribute vec3 aL;
attribute vec4 aW;
uniform vec4 uFade;
uniform float uShrink;
varying vec3 vLeaf;
varying vec2 vLUv;
varying vec2 vFadeIO;
varying vec3 vTint;
${TREE_GLSL}
`;
const VERT_HOOK = /* glsl */ `
  vLeaf = aL;
  vLUv = uv;
  vFadeIO = vec2(1.0);
  vTint = vec3(1.0);
  #ifdef USE_INSTANCING
  {
    vec3 hRoot = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    mat3 hIm = mat3(instanceMatrix);
    float hPh = hTreeHash(hRoot.xz) * 6.2832;
    transformed += transpose(hIm) * hTreeWind(hRoot, aW, hPh) / dot(hIm[0], hIm[0]);
    transformed += objectNormal * sin(uTime * 8.0 + aW.w * 11.0 + hPh + dot(transformed, vec3(2.3, 1.9, 2.7))) * aW.z * uWind.z;
    float hD = distance(cameraPosition, hRoot);
    vFadeIO = vec2(uFade.x < 0.0 ? 1.0 : smoothstep(uFade.x, uFade.y, hD), 1.0 - smoothstep(uFade.z, uFade.w, hD));
    // small plants shrink into the ground rather than dissolve: no dither pattern to see
    if (uShrink > 0.5) { transformed *= max(vFadeIO.y, 0.001); vFadeIO.y = 1.0; }
    vTint = hTreeTint(hRoot.xz);
  }
  #endif
`;
const FRAG_HEAD = /* glsl */ `
varying vec3 vLeaf;
varying vec2 vLUv;
varying vec2 vFadeIO;
varying vec3 vTint;
${TREE_GLSL}
${ATLAS_GLSL}
mat3 hTangentFrame(vec3 eye, vec3 n, vec2 uv){
  vec3 q0 = dFdx(eye), q1 = dFdy(eye);
  vec2 st0 = dFdx(uv), st1 = dFdy(uv);
  vec3 q1p = cross(q1, n), q0p = cross(n, q0);
  vec3 T = q1p * st0.x + q0p * st1.x, B = q1p * st0.y + q0p * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float sc = det == 0.0 ? 0.0 : inversesqrt(det);
  return mat3(T * sc, B * sc, n);
}
// below a closed canopy the sky is mostly leaves: less of its blue, more green light through and off them
vec3 hCanopy(vec3 wp){
  vec4 v = texture2D(tVegMap, hHfUv(wp.xz));
  float dens = clamp(max(v.r, v.g * 0.75) * 1.3 - 0.15, 0.0, 1.0);
  return mix(vec3(1.0), vec3(0.5, 0.62, 0.36), dens * smoothstep(16.0, 3.0, wp.y - hTerrainH(wp.xz)));
}
`;
const DITHER = /* glsl */ `
  { float hN = hIgn(gl_FragCoord.xy); if (hN < 1.0 - vFadeIO.x || hN >= vFadeIO.y) discard; }
`;

// in and out distances of one level: x..y dithers in (x < 0: always in), z..w out; shrink: out by shrinking
function fade(p, level) {
  if (p.under) return level === 0
    ? { v: new THREE.Vector4(-1, -1, NEAR_U - BAND_NU, NEAR_U), shrink: 0 }
    : { v: new THREE.Vector4(NEAR_U - BAND_NU, NEAR_U, UNDER - BAND_U, UNDER), shrink: 1 };
  if (level === 0) return { v: new THREE.Vector4(-1, -1, FULL - BAND_F, FULL), shrink: 0 };
  if (level === 'b') return { v: new THREE.Vector4(FULL - BAND_F, FULL, p.near - BAND0, p.near), shrink: 0 };
  if (level === 1) return { v: new THREE.Vector4(p.near - BAND0, p.near, MID - BAND_M, MID), shrink: 0 };
  return { v: new THREE.Vector4(MID - BAND_M, MID, FAR1 - BAND1, FAR1), shrink: 0 };
}

// a share of the leaves (each connected card or leaflet whole), each scaled up about its own centre so the crown
// keeps its cover; the same rule the build's thinLeaves (scripts/flora.mjs) uses for LOD1. Some scans split a leaf
// into pieces that share only seam positions, not vertices: those are joined first, or a piece would be kept without
// its other half and pulled away from it by the scaling
function thinLeaves(geo, keep) {
  const I = geo.index.array, P = geo.getAttribute('position');
  const n = P.count, parent = new Int32Array(n).map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const seen = new Map();
  for (let v = 0; v < n; v++) {
    // millimetres, offset into 17 bits a component: exact as one double for plants within +-65 m of their origin
    const key = (Math.round(P.getX(v) * 1000) + 65536) + (Math.round(P.getY(v) * 1000) + 65536) * 131072 + (Math.round(P.getZ(v) * 1000) + 65536) * 17179869184;
    const w = seen.get(key);
    if (w === undefined) seen.set(key, v); else parent[find(v)] = find(w);
  }
  for (let t = 0; t < I.length; t += 3) {
    const a = find(I[t]), b = find(I[t + 1]);
    parent[b] = a; parent[find(I[t + 2])] = a;
  }
  const c = new Float64Array(n * 4);
  for (let v = 0; v < n; v++) {
    const r = find(v);
    c[r * 4] += P.getX(v); c[r * 4 + 1] += P.getY(v); c[r * 4 + 2] += P.getZ(v); c[r * 4 + 3]++;
  }
  const hash = (r) => { let h = Math.imul(r ^ 0x5bd1e995, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
  const kept = [];
  for (let t = 0; t < I.length; t += 3) if (hash(find(I[t])) < keep) kept.push(I[t], I[t + 1], I[t + 2]);
  const s = 1 / Math.sqrt(keep), pos = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const r = find(v), m = c[r * 4 + 3];
    for (let k = 0; k < 3; k++) {
      const x = P.getComponent(v, k), mid = c[r * 4 + k] / m;
      pos[v * 3 + k] = m > 1 ? mid + (x - mid) * s : x;
    }
  }
  const out = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(geo.attributes)) out.setAttribute(name, a);
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setIndex(kept);
  out.computeBoundingSphere();
  return out;
}

// captures the light that reaches the leaf through its shadow, for translucency
function sunThroughShadow(sh) {
  const fs = sh.fragmentShader;
  const a = fs.indexOf('directionalLight = directionalLights[ i ];');
  if (a < 0) return;
  const b = fs.indexOf('RE_Direct(', a);
  sh.fragmentShader = fs.slice(0, b) + 'hSunT = directLight.color;\n\t\t' + fs.slice(b);
}

const atlasUniforms = (part) => ({
  tC: { value: part.c },
  tN: { value: part.n },
  uRects: { value: part.rects },
  uAtlas: { value: new THREE.Vector2(part.c.image.width, part.c.image.height) },
});
// the rectangle and the gradients of its unwrapped uv, so mip selection never jumps at a tile seam
const ATLAS_MAP = /* glsl */ `
  vec4 hRect = uRects[int(vLeaf.x + 0.5)];
  vec2 hRs = abs(hRect.zw), hGx = dFdx(vLUv) * hRs, hGy = dFdy(vLUv) * hRs;
  vec2 hAuv = hAtUv(vLUv, hRect);
  vec4 hLt = textureGrad(tC, hAuv, hGx, hGy);`;
const ATLAS_NORMAL = /* glsl */ `
  {
    vec3 hMapN = textureGrad(tN, hAuv, hGx, hGy).xyz * 2.0 - 1.0;
    normal = normalize(hTangentFrame(-vViewPosition, normal, vLUv) * hMapN);
  }`;

function leafMaterial(part, f) {
  const m = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.62, metalness: 0, alphaTest: 0.5, alphaToCoverage: true });
  m.userData.u = { uFade: { value: f.v }, uShrink: { value: f.shrink }, ...atlasUniforms(part) };
  return patch(m, {
    key: 'leafA',
    wet: 0.6,
    uniforms: m.userData.u,
    vertexHead: VERT_HEAD,
    fragHead: FRAG_HEAD,
    hooks: {
      vertex: VERT_HOOK,
      map: ATLAS_MAP + /* glsl */ `
        diffuseColor.rgb *= hLt.rgb * vTint;
        // mip levels average a leaf's edge into its gap: hold the cover the full-size map had
        float hLod = max(0.0, 0.5 * log2(max(dot(hGx, hGx), dot(hGy, hGy)) * dot(uAtlas, uAtlas) * 0.5));
        diffuseColor.a = hLt.a * (1.0 + hLod * 0.28);`,
      normal: ATLAS_NORMAL,
      // leaves within reach of the eye are cut away, as in games where you push through brush; cut, not dissolved:
      // without temporal filtering a dissolve shows as a dot screen across the nearest, largest leaves
      alpha: DITHER + 'if (distance(cameraPosition, vHWP) < 0.45) discard;',
      preLight: 'vec3 hSunT = vec3(0.0);',
      light: /* glsl */ `
        irradiance *= vLeaf.z * hCanopy(vHWP);
        reflectedLight.directDiffuse *= mix(0.65, 1.0, vLeaf.z);
        reflectedLight.indirectSpecular *= 0.35 * vLeaf.z * hCanopy(vHWP);
        reflectedLight.directSpecular *= 0.6;
        {
          // light through the blade: strongest looking toward the sun, tinted by the leaf it passes
          vec3 hV = normalize(cameraPosition - vHWP);
          float hBack = pow(max(dot(-hV, uSunDir), 0.0), 4.0);
          float hThru = max(-dot(hNW, uSunDir), 0.0);
          vec3 hTr = diffuseColor.rgb * mix(vec3(1.0), vec3(1.15, 1.25, 0.45), 0.6);
          reflectedLight.directDiffuse += hTr * hSunT * (0.35 * hThru + 1.2 * hBack) * (0.35 + 0.65 * vLeaf.z) * 0.3183;
        }`,
    },
    onShader: sunThroughShadow,
  });
}

function woodMaterial(part, f) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
  m.userData.u = { uFade: { value: f.v }, uShrink: { value: f.shrink }, ...atlasUniforms(part) };
  return patch(m, {
    key: 'woodA',
    wet: 1,
    uniforms: m.userData.u,
    vertexHead: VERT_HEAD,
    fragHead: FRAG_HEAD,
    hooks: {
      vertex: VERT_HOOK,
      map: ATLAS_MAP + 'diffuseColor.rgb *= hLt.rgb * mix(vec3(1.0), vTint, 0.5);',
      normal: ATLAS_NORMAL,
      alpha: DITHER,
      light: 'vec3 hCan = hCanopy(vHWP); irradiance *= vLeaf.z * hCan; reflectedLight.directDiffuse *= mix(0.6, 1.0, vLeaf.z); reflectedLight.indirectSpecular *= 0.35 * vLeaf.z * hCan;',
    },
  });
}

// shadow casters: same wind, leaf cut-outs from the atlas
function depthMaterial(part, leaf) {
  const m = new THREE.MeshDepthMaterial({ side: leaf ? THREE.DoubleSide : THREE.FrontSide });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U, atlasUniforms(part), { uFade: { value: new THREE.Vector4(-1, -1, 1e5, 1e5) }, uShrink: { value: 0 } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nuniform float uTime; uniform vec4 uWind;\n${VERT_HEAD}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvec3 objectNormal = normal;\n${VERT_HOOK}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vLeaf; varying vec2 vLUv; varying vec2 vFadeIO; varying vec3 vTint;\n${ATLAS_GLSL}`)
      .replace('#include <alphatest_fragment>', leaf ? 'if (texture(tC, hAtUv(vLUv, uRects[int(vLeaf.x + 0.5)])).a < 0.5) discard;' : '');
  };
  m.customProgramCacheKey = () => 'veg-depthA-' + (leaf ? 1 : 0);
  return m;
}

// shadow-only meshes still need a main-pass material: one that draws nothing. Its side decides which faces
// cast (three flips single-sided materials for the shadow pass), so leaves get a double-sided one.
const nothing = (side) => new THREE.ShaderMaterial({
  vertexShader: 'void main(){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }',
  fragmentShader: 'void main(){ gl_FragColor = vec4(0.0); }',
  colorWrite: false,
  depthWrite: false,
  side,
});
const NOTHING = nothing(THREE.FrontSide), NOTHING2 = nothing(THREE.DoubleSide);

// ------------------------------------------------------------------ impostors
const OCT = /* glsl */ `
vec2 hOctEnc(vec3 d){ d /= abs(d.x) + abs(d.y) + abs(d.z); return vec2(d.x + d.z, d.x - d.z); }
vec3 hOctDec(vec2 e){ vec2 t = vec2(e.x + e.y, e.x - e.y) * 0.5; return normalize(vec3(t.x, 1.0 - abs(t.x) - abs(t.y), t.y)); }
void hFrameBasis(vec2 cell, out vec3 d, out vec3 rt, out vec3 up){
  d = hOctDec(cell / ${(IMP_N - 1).toFixed(1)} * 2.0 - 1.0);
  up = normalize(vec3(0.0, 1.0, 0.0) - d * d.y);
  rt = normalize(cross(up, d));
}
`;

const CAPTURE_VERT = /* glsl */ `
in vec3 aL;
uniform vec4 uSphere;
uniform float uSlot;
out vec3 vN; out vec3 vD; out vec2 vUv2; out vec3 vL;
${OCT}
void main(){
  float i = float(gl_InstanceID % ${IMP_N}), j = float(gl_InstanceID / ${IMP_N});
  vec3 d, rt, up;
  hFrameBasis(vec2(i, j), d, rt, up);
  vec3 q = position - uSphere.xyz;
  vec2 xy = vec2(dot(q, rt), dot(q, up)) / uSphere.w;
  vec2 cell = vec2(mod(uSlot, ${SLOTS_X}.0), floor(uSlot / ${SLOTS_X}.0)) * ${IMP_N}.0 + vec2(i, j);
  vec2 ndc = (cell + 0.5 + 0.5 * ${IMP_FIT} * xy) / vec2(${SLOTS_X * IMP_N}.0, ${SLOTS_Y * IMP_N}.0) * 2.0 - 1.0;
  gl_Position = vec4(ndc, -dot(q, d) / uSphere.w * 0.98, 1.0);
  vN = normal; vD = d; vUv2 = uv; vL = aL;
}`;
const CAPTURE_FRAG = /* glsl */ `
uniform float uWood;
in vec3 vN; in vec3 vD; in vec2 vUv2; in vec3 vL;
layout(location = 0) out vec4 gAlb;
layout(location = 1) out vec4 gNrm;
${ATLAS_GLSL}
void main(){
  vec4 r = uRects[int(vL.x + 0.5)];
  vec2 s = abs(r.zw);
  vec4 t = textureGrad(tC, hAtUv(vUv2, r), dFdx(vUv2) * s, dFdy(vUv2) * s);
  vec3 c = t.rgb; float a = uWood > 0.5 ? 1.0 : t.a;
  if (a < 0.5) discard;
  vec3 n = normalize(vN);
  if (dot(n, vD) < 0.0) n = -n;
  gAlb = vec4(sqrt(c), 1.0);
  gNrm = vec4(n * 0.5 + 0.5, vL.z * (uWood > 0.5 ? 0.8 : 1.0));
}`;

const IMP_VERT = /* glsl */ `
attribute vec4 iPos;  // root xyz, yaw
attribute vec4 iDat;  // scale, slot
uniform vec4 uSpheres[${SLOTS_X * SLOTS_Y}];
uniform vec2 uFadeIn;
varying vec4 vF0, vF1, vF2;
varying vec3 vWts, vTint;
varying vec3 vSun, vAmbU, vAmbS, vAmbD, vFogT, vFogS;
varying float vYaw, vFade, vOne;
${COMMON}
${TREE_GLSL}
${OCT}
vec4 frameUv(vec2 cell, vec3 pl, float R, float slot){
  vec3 d, rt, up;
  hFrameBasis(cell, d, rt, up);
  vec2 uv = vec2(dot(pl, rt), dot(pl, up)) / R;
  vec2 base = vec2(mod(slot, ${SLOTS_X}.0), floor(slot / ${SLOTS_X}.0)) * ${IMP_N}.0 + cell;
  return vec4(base, uv);
}
void main(){
  float s = iDat.x, slot = iDat.y, yaw = iPos.w;
  vec4 sp = uSpheres[int(slot + 0.5)];
  float cy = cos(yaw), sy = sin(yaw);
  vec3 C = iPos.xyz + vec3(cy * sp.x + sy * sp.z, sp.y, -sy * sp.x + cy * sp.z) * s;
  float R = sp.w * s;
  float dRoot = distance(cameraPosition, iPos.xyz);
  vFade = smoothstep(uFadeIn.x, uFadeIn.y, dRoot);
  if (vFade <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 toCam = cameraPosition - C;
  float dist = length(toCam);
  vec3 v = toCam / dist;
  vec3 camRt = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = normalize(cross(v, camRt));
  vec3 rt = cross(up, v);
  vec3 off = (rt * position.x + up * position.y) * R;
  // pulled toward the camera so the card does not cut into the slope behind it, scaled to keep its size
  float pull = min(R * 0.7, dist * 0.5);
  vec2 wd = normalize(uWind.xy + vec2(1e-4));
  float sway = uWind.z * (0.35 + 0.25 * sin(uTime * 0.85 + hTreeHash(iPos.xz) * 6.28)) * 0.04 * R;
  vec3 wp = C + v * pull + off * ((dist - pull) / dist) + vec3(wd.x, 0.0, wd.y) * sway * max(position.y + 0.3, 0.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  // view direction in the plant's own frame picks the three nearest captured frames
  vec3 vl = normalize(vec3(cy * v.x - sy * v.z, max(v.y, 0.0) + 1e-4, sy * v.x + cy * v.z));
  vec2 g = (hOctEnc(vl) * 0.5 + 0.5) * ${(IMP_N - 1).toFixed(1)};
  vec2 gi = clamp(floor(g), 0.0, ${(IMP_N - 2).toFixed(1)});
  vec2 f = g - gi;
  vec2 c0, c1 = gi + vec2(1.0, 0.0), c2 = gi + vec2(0.0, 1.0);
  vec3 w;
  if (f.x + f.y < 1.0) { c0 = gi; w = vec3(1.0 - f.x - f.y, f.x, f.y); }
  else { c0 = gi + vec2(1.0); w = vec3(f.x + f.y - 1.0, 1.0 - f.y, 1.0 - f.x); }
  // heaviest frame first: it alone rejects most of the empty margin
  if (w.y > w.x && w.y >= w.z) { vec2 t = c0; c0 = c1; c1 = t; w = w.yxz; }
  else if (w.z > w.x) { vec2 t = c0; c0 = c2; c2 = t; w = w.zyx; }
  vWts = w;
  vec3 pl = off / s;
  pl = vec3(cy * pl.x - sy * pl.z, pl.y, sy * pl.x + cy * pl.z);
  vF0 = frameUv(c0, pl, sp.w, slot);
  vF1 = frameUv(c1, pl, sp.w, slot);
  vF2 = frameUv(c2, pl, sp.w, slot);
  vYaw = yaw;
  vTint = hTreeTint(iPos.xz);
  vOne = step(450.0, dist);
  // lighting that does not change across one tree, done once per corner instead of per pixel
  vSun = uSunCol * hSunVis(C);
  vAmbU = texture2D(tAmb, vec2(0.5 / 64.0, 4.5 / 8.0)).rgb;
  vAmbS = texture2D(tAmb, vec2(1.5 / 64.0, 4.5 / 8.0)).rgb;
  vAmbD = texture2D(tAmb, vec2(2.5 / 64.0, 4.5 / 8.0)).rgb;
  vFogS = hAtmos(vec3(0.0), wp);
  vFogT = hAtmos(vec3(1.0), wp) - vFogS;
}`;

const IMP_FRAG = /* glsl */ `
uniform sampler2D tAlb, tNrm;
uniform vec3 uSunDir;
varying vec4 vF0, vF1, vF2;
varying vec3 vWts, vTint;
varying vec3 vSun, vAmbU, vAmbS, vAmbD, vFogT, vFogS;
varying float vYaw, vFade, vOne;
float hIgn(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
vec2 atlasUv(vec4 f){
  vec2 uv = clamp(0.5 + 0.5 * ${IMP_FIT} * f.zw, 0.0, 1.0);
  return (f.xy + uv) / vec2(${SLOTS_X * IMP_N}.0, ${SLOTS_Y * IMP_N}.0);
}
void main(){
  if (hIgn(gl_FragCoord.xy) < 1.0 - vFade) discard;
  vec2 u0 = atlasUv(vF0);
  vec4 a = texture2D(tAlb, u0);
  if (a.a < 0.02 && vWts.x > 0.5) discard;
  vec4 n = texture2D(tNrm, u0);
  if (vOne < 0.5) {
    vec2 u1 = atlasUv(vF1), u2 = atlasUv(vF2);
    a = a * vWts.x + texture2D(tAlb, u1) * vWts.y + texture2D(tAlb, u2) * vWts.z;
    n = n * vWts.x + texture2D(tNrm, u1) * vWts.y + texture2D(tNrm, u2) * vWts.z;
  }
  float cov = (a.a - 0.5) / max(fwidth(a.a), 1e-4) + 0.5;
  if (cov <= 0.02) discard;
  float inv = 1.0 / max(a.a, 1e-3);
  vec3 alb = a.rgb * inv; alb *= alb;
  alb *= vTint;
  vec3 nl = normalize(n.rgb * inv * 2.0 - 1.0);
  float ao = n.a * inv;
  float cy = cos(vYaw), sy = sin(vYaw);
  vec3 N = vec3(cy * nl.x + sy * nl.z, nl.y, -sy * nl.x + cy * nl.z);
  float ndl = dot(N, uSunDir);
  vec3 amb = N.y > 0.0 ? mix(vAmbS, vAmbU, N.y) : mix(vAmbS, vAmbD, -N.y);
  vec3 col = alb * (vSun * (max(ndl, 0.0) * mix(0.7, 1.0, ao) + vec3(1.1, 1.2, 0.55) * 0.2 * max(-ndl, 0.0) * (0.4 + 0.6 * ao)) * 0.3183 + amb * mix(0.4, 1.0, ao));
  gl_FragColor = vec4(col * vFogT + vFogS, clamp(cov, 0.0, 1.0));
}`;

// ------------------------------------------------------------------ placement
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const pick = (arr, r) => (arr.length ? arr[Math.floor(r * arr.length) % arr.length] : -1);

function scatter(hf, veg, density, gallery) {
  const r = rng(7);
  const out = { x: [], y: [], z: [], yaw: [], s: [], k: [] };
  const add = (x, z, k, yaw, s) => {
    if (k < 0) return;
    out.x.push(x); out.y.push(hf.solidAt(x, z) - 0.12); out.z.push(z); out.yaw.push(yaw); out.s.push(s); out.k.push(k);
  };
  const c = { d: 0, dx: 0, dz: 0, lag: 0 };
  const lo = HF.origin + 2, hi = HF.origin + HF.size - 2;
  const grid = (step, fn) => {
    for (let z = lo; z < hi; z += step) for (let x = lo; x < hi; x += step) {
      const px = x + (r() - 0.5) * step * 0.95, pz = z + (r() - 0.5) * step * 0.95;
      const f = veg.at(veg.forest, px, pz), p = veg.at(veg.palm, px, pz), g = veg.at(veg.grass, px, pz);
      if (f + p + g <= 0.01) { r(); continue; }
      fn(px, pz, f, p, g, r());
    }
  };
  // palms: the beaches and motus, leaning out over the water near it
  grid(5.0 / Math.sqrt(density), (x, z, f, p, g, u) => {
    // groves of a few palms with sand between them, not an even stand
    const grove = smooth(0.38, 0.68, vnoise(x * 0.03 + 11.3, z * 0.03 - 4.1) * 0.6 + vnoise(x * 0.13, z * 0.13) * 0.4);
    if (u > p * (0.04 + 0.92 * grove)) return;
    const h = hf.heightAt(x, z);
    if (h < 0.6) return;
    hf.coastAt(x, z, c);
    const inland = -c.d;
    // local +x is the lean; point it seaward (the coast field points inland on land)
    const ll = Math.hypot(c.dx, c.dz);
    const lx = ll > 0.1 ? -c.dx / ll : 0, lz = ll > 0.1 ? -c.dz / ll : 0;
    const front = ll > 0.1 ? smooth(0.5, 0.15, veg.at(veg.palm, x + lx * 14, z + lz * 14) / Math.max(p, 0.05)) : 0;
    const t = r();
    let k, young = false;
    if (t < 0.14 + 0.16 * smooth(15, 50, inland)) { k = pick(ID.palmYoung, r()); young = true; }
    else if (r() < Math.max(front, smooth(40, 12, inland)) * 0.85) k = pick(ID.palmLean, r());
    else if (inland < 90 && r() < 0.6) k = pick(ID.palmMid, r());
    else k = pick(ID.palmTall, r());
    const toward = ll > 0.1 && inland < 120;
    const yaw = toward ? Math.atan2(-lz, lx) + (r() - 0.5) * (front > 0.5 ? 0.7 : 1.4) : r() * Math.PI * 2;
    add(x, z, k, yaw, (0.72 + r() * 0.6) * (young ? YOUNG : 1));
  });
  // canopy: broadleaf forest, breadfruit low and near the village, flame trees in the lowland and at its edge
  const vx = VILLAGE.x, vz = VILLAGE.z;
  // trees at their real size stand some 7 m apart where the forest closes
  grid(7.0 / Math.sqrt(density), (x, z, f, p, g, u) => {
    if (u > f * 0.97) return;
    const h = hf.heightAt(x, z);
    const dv = Math.hypot(x - vx, z - vz);
    const t = r();
    let k;
    if (h < 45 && t < 0.09) k = pick(ID.palmTall, r());
    else if (t < 0.09 + 0.16 * smooth(40, 8, h) * (0.4 + 0.6 * smooth(500, 150, dv)) * (1 - f * 0.5)) k = pick(ID.flame, r());
    else if (t < 0.35 && h < 80 && r() < 0.35 + 0.5 * smooth(420, 120, dv)) k = pick(ID.bread, r());
    else k = pick(ID.broad, r());
    const s = (0.8 + r() * 0.5) * (1 + 0.15 * smooth(40, 90, h)) * (1 - 0.12 * smooth(150, 320, h)) * (0.85 + 0.15 * f);
    add(x, z, k, r() * Math.PI * 2, s);
  });
  // on the peak's flanks the crowns close over: a sparser layer of big trees between the first, or from across the
  // lagoon the slopes read as trees dotted over bare ground
  grid(10.0 / Math.sqrt(density), (x, z, f, p, g, u) => {
    const h = hf.heightAt(x, z);
    if (h < 40 || u > Math.min(1, (f - 0.4) * 1.6) * smooth(40, 80, h)) return;
    add(x, z, pick(r() < 0.2 ? ID.bread : ID.broad, r()), r() * Math.PI * 2, (0.95 + r() * 0.4) * (1 - 0.12 * smooth(150, 320, h)));
  });
  // understory, drawn only near the camera
  grid(3.3 / Math.sqrt(density), (x, z, f, p, g, u) => {
    const h = hf.heightAt(x, z);
    if (h < 0.7) return;
    const dv = Math.hypot(x - vx, z - vz);
    const clump = vnoise(x * 0.07, z * 0.07);
    hf.coastAt(x, z, c);
    const inland = -c.d;
    const ll = Math.hypot(c.dx, c.dz);
    const sx = ll > 0.1 ? -c.dx / ll : 0, sz = ll > 0.1 ? -c.dz / ll : 0;
    const vegHere = Math.max(p, f, g * 0.6);
    const vegOut = Math.max(veg.at(veg.palm, x + sx * 10, z + sz * 10), veg.at(veg.grass, x + sx * 10, z + sz * 10) * 0.6);
    const edge = smooth(0.25, 0.5, vegHere) * smooth(0.6, 0.2, vegOut / Math.max(vegHere, 0.05)) * smooth(4, 10, inland);
    let k = -1, s = 0.8 + r() * 0.45;
    if (f > 0.25 && u < 0.5 * f * (0.4 + clump)) k = pick(r() < 0.75 ? ID.fern : ID.sprig, r());
    else if (inland > 35 && (f > 0.1 || g > 0.3) && u < 0.07 * smooth(320, 120, dv) * smooth(40, 6, h) + 0.04 * f * (1 - f) * 4 * smooth(40, 10, h)) k = pick(ID.banana, r());
    else if (u < 0.6 * edge * (0.4 + clump)) { k = pick(ID.beach, r()); s = 1.3 + r() * 1.1; }
    else if (p > 0.25 && h < 6 && inland > 10 && u < 0.08 * p) k = pick(ID.pandan, r());
    // under the palms away from the sand: scrub and young growth, so the grove is not a field of bare poles
    else if (p > 0.25 && inland > 14 && u < 0.3 * p * (0.25 + clump) * smooth(14, 30, inland)) { k = pick(r() < 0.6 ? ID.beach : ID.fern, r()); s = 1.0 + r() * 0.9; }
    else if (dv < 380 && g > 0.15 && u < 0.05) k = pick(ID.shrub, r());
    else if (u < 0.03 * g * (1 - f) + 0.03 * f * (1 - f) * 4) k = pick(ID.sprig, r());
    if (k < 0) return;
    add(x, z, k, r() * Math.PI * 2, s);
  });
  // gardens: bananas and hibiscus at the sides and backs of the village houses, the door side left open
  for (const h of PLAN.houses) {
    const n = 3 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) {
      const a = h.yaw + Math.PI * (0.35 + r() * 1.3);
      const d = h.r * h.s + 1.2 + r() * 4;
      const x = h.x + Math.sin(a) * d, z = h.z + Math.cos(a) * d;
      if (hf.heightAt(x, z) < 0.8) continue;
      add(x, z, r() < 0.4 ? pick(ID.banana, r()) : pick(ID.shrub, r()), r() * Math.PI * 2, 0.8 + r() * 0.5);
    }
  }
  if (gallery) {
    for (const k of Object.keys(out)) out[k].length = 0;
    PROTOS.forEach((_, k) => add(gallery.x + (k % 6) * 22, gallery.z + Math.floor(k / 6) * 26, k, 0.6, 1));
  }
  const n = out.x.length;
  const o = { n, x: Float32Array.from(out.x), y: Float32Array.from(out.y), z: Float32Array.from(out.z), yaw: Float32Array.from(out.yaw), s: Float32Array.from(out.s), k: Uint8Array.from(out.k) };
  return o;
}

// ------------------------------------------------------------------ the system
// one species from its flora file: geometry with the wind and occlusion attributes under the names the shaders use
async function loadSpecies(def) {
  const g = await loadFlora(def.asset);
  g.scene.updateMatrixWorld(true);
  const flora = g.parser.json.extras.flora;
  const geo = (name) => {
    const o = g.scene.getObjectByName(name);
    if (!o) return null;
    const src = toFloat(o.geometry.clone()).applyMatrix4(o.matrixWorld);
    const out = new THREE.BufferGeometry();
    for (const [a, b] of [['position', 'position'], ['normal', 'normal'], ['uv', 'uv'], ['_al', 'aL'], ['_aw', 'aW']]) out.setAttribute(b, src.getAttribute(a));
    out.setIndex(src.index);
    out.computeBoundingSphere();
    return out;
  };
  const part = (name, rects) => {
    const o = g.scene.getObjectByName(name + '0');
    if (!o) return null;
    const m = o.material;
    const rv = Array.from({ length: RECTS }, (_, i) => {
      const r = rects[i] || [0, 0, 1, 1, 0];
      return new THREE.Vector4(r[0], r[1], r[4] ? -r[2] : r[2], r[3]);
    });
    for (const t of [m.map, m.normalMap]) { t.anisotropy = 8; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; }
    return { c: m.map, n: m.normalMap, rects: rv };
  };
  const lod0 = { wood: geo('w0'), leaves: geo('l0') }, lod1 = { wood: geo('w1'), leaves: geo('l1') };
  return {
    lod0,
    lodB: def.group === 'under' ? null : { wood: lod0.wood, leaves: thinLeaves(lod0.leaves, THINB) },
    lod1,
    lod2: def.group === 'under' ? null : { wood: lod1.wood, leaves: thinLeaves(lod1.leaves, THIN2) },
    wood: part('w', flora.rects.w),
    leaves: part('l', flora.rects.l),
    height: flora.height,
    radius: flora.radius,
  };
}

export async function createVegetation(renderer, hf, veg, tex, opts = {}) {
  const t0 = performance.now();
  const mobile = !!opts.mobile;
  const species = await Promise.all(PROTOS.map(loadSpecies));
  const t1 = performance.now();

  const group = new THREE.Group();
  group.name = 'vegetation';
  const protos = PROTOS.map((def, k) => {
    const sp = species[k];
    const under = def.group === 'under';
    const lv = { under, near: def.palm ? NEAR0 : NEAR_T };
    const cap = under ? 1600 : 900;
    const cap1 = under ? 3000 : 2600;
    const mats = {
      wood: sp.wood && [0, 1, 2, 'b'].map((l) => woodMaterial(sp.wood, fade(lv, l))),
      leaf: [0, 1, 2, 'b'].map((l) => leafMaterial(sp.leaves, fade(lv, l))),
      depthWood: sp.wood && depthMaterial(sp.wood, false),
      depthLeaf: depthMaterial(sp.leaves, true),
    };
    const mk = (geo, mat, n, depth, name) => {
      if (!geo || !mat) return null;
      const m = new THREE.InstancedMesh(geo, mat, n);
      m.count = 0;
      m.visible = false;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (depth) {
        m.castShadow = true;
        m.customDepthMaterial = depth;
        // a caster is drawn into the shadow map only: the view pass would run all its vertices to draw nothing
        m.onBeforeShadow = () => { m.count = m.userData.n; };
        m.onBeforeRender = () => { m.count = 0; };
      }
      else m.receiveShadow = true;
      m.name = name;
      group.add(m);
      return m;
    };
    const g0 = sp.lod0, gB = sp.lodB, g1 = sp.lod1, g2 = sp.lod2;
    const p = {
      def,
      sp,
      under,
      near: under ? NEAR_U : lv.near,
      height: sp.height,
      radius: sp.radius,
      lod0: [mk(g0.wood, mats.wood?.[0], cap, null, 'w0'), mk(g0.leaves, mats.leaf[0], cap, null, 'l0')].filter(Boolean),
      // leaf shadows from the far level: fewer leaves scaled up to the same cover, and at 8 cm shadow texels the
      // difference does not show. Wood casts from the near level, which also receives: a coarser trunk would shade
      // the one drawn wherever their surfaces part
      shadow: [mk(g0.wood, NOTHING, cap, mats.depthWood, 'ws'), mk(g1.leaves, NOTHING2, cap, mats.depthLeaf, 'ls')].filter(Boolean),
      lodB: gB ? [mk(gB.wood, mats.wood?.[3], cap, null, 'wb'), mk(gB.leaves, mats.leaf[3], cap, null, 'lb')].filter(Boolean) : [],
      lod1: [mk(g1.wood, mats.wood?.[1], cap1, null, 'w1'), mk(g1.leaves, mats.leaf[1], cap1, null, 'l1')].filter(Boolean),
      lod2: g2 ? [mk(g2.wood, mats.wood?.[2], cap1, null, 'w2'), mk(g2.leaves, mats.leaf[2], cap1, null, 'l2')].filter(Boolean) : [],
      geo0: g0,
      mats,
    };
    // a bounding sphere around both parts, for the impostor frames
    const box = new THREE.Box3();
    for (const geo of [g0.wood, g0.leaves]) if (geo) { geo.computeBoundingBox(); box.union(geo.boundingBox); }
    const cen = box.getCenter(new THREE.Vector3());
    let R = 0;
    const q = new THREE.Vector3();
    for (const geo of [g0.wood, g0.leaves]) {
      if (!geo) continue;
      const a = geo.getAttribute('position');
      for (let i = 0; i < a.count; i++) R = Math.max(R, q.fromBufferAttribute(a, i).distanceTo(cen));
    }
    p.sphere = new THREE.Vector4(cen.x, cen.y, cen.z, R * 1.02);
    return p;
  });
  const t2 = performance.now();

  // ---------------------------------------------------------------- impostor atlas, captured in one draw per part
  const FR = mobile ? 64 : 128;
  const atlas = new THREE.WebGLRenderTarget(FR * IMP_N * SLOTS_X, FR * IMP_N * SLOTS_Y, {
    count: 2,
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
    depthBuffer: true,
  });
  const spheres = Array.from({ length: SLOTS_X * SLOTS_Y }, () => new THREE.Vector4(0, 0, 0, 1));
  {
    const capScene = new THREE.Scene();
    const done = new Set();
    protos.forEach((p) => {
      const slot = p.def.slot;
      if (slot === undefined || slot < 0 || done.has(slot)) return;
      done.add(slot);
      spheres[slot].copy(p.sphere);
      for (const [geo, wood, part] of [[p.geo0.wood, 1, p.sp.wood], [p.geo0.leaves, 0, p.sp.leaves]]) {
        if (!geo || !part) continue;
        const mat = new THREE.ShaderMaterial({
          glslVersion: THREE.GLSL3,
          vertexShader: CAPTURE_VERT,
          fragmentShader: CAPTURE_FRAG,
          uniforms: { uSphere: { value: p.sphere }, uSlot: { value: slot }, uWood: { value: wood }, ...atlasUniforms(part) },
          side: wood ? THREE.FrontSide : THREE.DoubleSide,
        });
        const m = new THREE.InstancedMesh(geo, mat, IMP_N * IMP_N);
        m.frustumCulled = false;
        capScene.add(m);
      }
    });
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevShadow = renderer.shadowMap.enabled;
    renderer.shadowMap.enabled = false;
    renderer.setRenderTarget(atlas);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(capScene, cam);
    renderer.setRenderTarget(null);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.shadowMap.enabled = prevShadow;
    capScene.traverse((o) => { if (o.material) o.material.dispose(); });
  }
  const t3 = performance.now();

  // ---------------------------------------------------------------- scatter, cells, impostor instances
  const inst = scatter(hf, veg, opts.density ?? 1, opts.gallery);
  const NC = Math.ceil(HF.size / CELL);
  const cellOf = (x, z) => Math.min(NC - 1, Math.max(0, Math.floor((z - HF.origin) / CELL))) * NC + Math.min(NC - 1, Math.max(0, Math.floor((x - HF.origin) / CELL)));
  const start = new Uint32Array(NC * NC + 1);
  for (let i = 0; i < inst.n; i++) start[cellOf(inst.x[i], inst.z[i]) + 1]++;
  for (let c = 0; c < NC * NC; c++) start[c + 1] += start[c];
  const fill = start.slice(0, NC * NC);
  const order = new Uint32Array(inst.n);
  for (let i = 0; i < inst.n; i++) order[fill[cellOf(inst.x[i], inst.z[i])]++] = i;
  const cellY = new Float32Array(NC * NC * 2).fill(0);
  for (let c = 0; c < NC * NC; c++) {
    let lo = 1e9, hi = -1e9;
    for (let q = start[c]; q < start[c + 1]; q++) {
      const i = order[q];
      lo = Math.min(lo, inst.y[i]);
      hi = Math.max(hi, inst.y[i] + protos[inst.k[i]].height * inst.s[i]);
    }
    cellY[c * 2] = lo; cellY[c * 2 + 1] = hi;
  }

  let nImp = 0;
  for (let i = 0; i < inst.n; i++) if ((protos[inst.k[i]].def.slot ?? -1) >= 0) nImp++;
  const impGeo = new THREE.InstancedBufferGeometry();
  impGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  impGeo.setIndex([0, 1, 2, 0, 2, 3]);
  const iPos = new Float32Array(nImp * 4), iDat = new Float32Array(nImp * 4);
  {
    let j = 0;
    for (let i = 0; i < inst.n; i++) {
      const slot = protos[inst.k[i]].def.slot ?? -1;
      if (slot < 0) continue;
      iPos.set([inst.x[i], inst.y[i], inst.z[i], inst.yaw[i]], j * 4);
      iDat.set([inst.s[i], slot, 0, 0], j * 4);
      j++;
    }
  }
  impGeo.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 4));
  impGeo.setAttribute('iDat', new THREE.InstancedBufferAttribute(iDat, 4));
  impGeo.instanceCount = nImp;
  const impMat = new THREE.ShaderMaterial({
    vertexShader: IMP_VERT,
    fragmentShader: IMP_FRAG,
    uniforms: Object.assign({}, U, {
      tAlb: { value: atlas.textures[0] },
      tNrm: { value: atlas.textures[1] },
      uSpheres: { value: spheres },
      uFadeIn: { value: new THREE.Vector2(FAR1 - BAND1, FAR1) },
    }),
    alphaToCoverage: true,
  });
  const impostors = new THREE.Mesh(impGeo, impMat);
  impostors.frustumCulled = false;
  impostors.name = 'impostors';
  group.add(impostors);
  const t4 = performance.now();
  console.log(`[ha] veg: load ${(t1 - t0) | 0}ms, plants ${(t2 - t1) | 0}ms, atlas ${(t3 - t2) | 0}ms, scatter ${(t4 - t3) | 0}ms; ${inst.n} plants, ${nImp} impostors`);

  // ---------------------------------------------------------------- per-frame selection
  const frustum = new THREE.Frustum();
  const pv = new THREE.Matrix4();
  const box = new THREE.Box3();
  const sph = new THREE.Sphere();
  const shd = new THREE.Sphere();
  const lastPos = new THREE.Vector3(1e9, 0, 0), lastDir = new THREE.Vector3(), dir = new THREE.Vector3();
  const counts0 = new Uint16Array(protos.length), countsB = new Uint16Array(protos.length), counts1 = new Uint16Array(protos.length), counts2 = new Uint16Array(protos.length), countsS = new Uint16Array(protos.length);
  let lastNear = -1;
  const put = (meshes, n, i) => {
    if (!meshes.length || n >= meshes[0].instanceMatrix.count) return false;
    const a = meshes[0].instanceMatrix.array;
    const s = inst.s[i], c = Math.cos(inst.yaw[i]) * s, sn = Math.sin(inst.yaw[i]) * s;
    const o = n * 16;
    a[o] = c; a[o + 1] = 0; a[o + 2] = -sn; a[o + 3] = 0;
    a[o + 4] = 0; a[o + 5] = s; a[o + 6] = 0; a[o + 7] = 0;
    a[o + 8] = sn; a[o + 9] = 0; a[o + 10] = c; a[o + 11] = 0;
    a[o + 12] = inst.x[i]; a[o + 13] = inst.y[i]; a[o + 14] = inst.z[i]; a[o + 15] = 1;
    return true;
  };
  // the wood and leaf meshes of one variant share an instance buffer
  for (const p of protos) for (const set of [p.lod0, p.lodB, p.shadow, p.lod1, p.lod2]) for (let m = 1; m < set.length; m++) set[m].instanceMatrix = set[0].instanceMatrix;

  function update(camera, shadowCenter) {
    camera.getWorldDirection(dir);
    if (camera.position.distanceToSquared(lastPos) < 0.04 && dir.dot(lastDir) > 0.99995 && camera.near === lastNear) return;
    lastPos.copy(camera.position); lastDir.copy(dir); lastNear = camera.near;
    pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pv);
    counts0.fill(0); countsB.fill(0); counts1.fill(0); counts2.fill(0); countsS.fill(0);
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const sx = shadowCenter.x, sz = shadowCenter.z;
    // a caster matters only if its shadow, swept away from the sun, can land in view
    const L = U.uSunDir.value;
    const ly = Math.max(L.y, 0.12);
    const shx = -L.x / ly, shz = -L.z / ly;
    const R = FAR1;
    const i0 = Math.max(0, Math.floor((cx - R - HF.origin) / CELL)), i1 = Math.min(NC - 1, Math.floor((cx + R - HF.origin) / CELL));
    const j0 = Math.max(0, Math.floor((cz - R - HF.origin) / CELL)), j1 = Math.min(NC - 1, Math.floor((cz + R - HF.origin) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const c = j * NC + i;
      if (start[c] === start[c + 1]) continue;
      const x0 = HF.origin + i * CELL, z0 = HF.origin + j * CELL;
      const ddx = Math.max(x0 - cx, 0, cx - x0 - CELL), ddz = Math.max(z0 - cz, 0, cz - z0 - CELL);
      if (ddx * ddx + ddz * ddz > R * R) continue;
      box.min.set(x0 - 8, cellY[c * 2], z0 - 8);
      box.max.set(x0 + CELL + 8, cellY[c * 2 + 1], z0 + CELL + 8);
      const vis = frustum.intersectsBox(box);
      const inShadow = Math.abs(x0 + CELL / 2 - sx) < SHADOW_BOX + CELL / 2 && Math.abs(z0 + CELL / 2 - sz) < SHADOW_BOX + CELL / 2;
      if (!vis && !inShadow) continue;
      for (let q = start[c]; q < start[c + 1]; q++) {
        const n = order[q];
        const k = inst.k[n];
        const p = protos[k];
        const dx = inst.x[n] - cx, dy = inst.y[n] - cy, dz = inst.z[n] - cz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const under = p.under;
        const near = under ? UNDER : p.near;
        if (d < near && inShadow && Math.abs(inst.x[n] - sx) < SHADOW_BOX && Math.abs(inst.z[n] - sz) < SHADOW_BOX) {
          const h = p.height * inst.s[n];
          shd.center.set(inst.x[n] + shx * h * 0.5, inst.y[n] + h * 0.25, inst.z[n] + shz * h * 0.5);
          shd.radius = Math.max(p.radius * inst.s[n], h * 0.5) + Math.hypot(shx, shz) * h * 0.5 + 2;
          if (frustum.intersectsSphere(shd) && put(p.shadow, countsS[k], n)) countsS[k]++;
        }
        if (!vis || d > R) continue;
        const sc = inst.s[n];
        sph.center.set(inst.x[n], inst.y[n] + p.height * sc * 0.5, inst.z[n]);
        sph.radius = Math.max(p.radius, p.height * 0.5) * sc;
        if (!frustum.intersectsSphere(sph)) continue;
        if (d < p.near) {
          if ((under || d < FULL) && put(p.lod0, counts0[k], n)) counts0[k]++;
          if (!under && d > FULL - BAND_F && put(p.lodB, countsB[k], n)) countsB[k]++;
        }
        if (d > p.near - (under ? BAND_NU : BAND0) && d < (under ? UNDER : MID)) { if (put(p.lod1, counts1[k], n)) counts1[k]++; }
        if (!under && d > MID - BAND_M) { if (put(p.lod2, counts2[k], n)) counts2[k]++; }
      }
    }
    protos.forEach((p, k) => {
      for (const [set, cnt] of [[p.lod0, counts0[k]], [p.lodB, countsB[k]], [p.shadow, countsS[k]], [p.lod1, counts1[k]], [p.lod2, counts2[k]]]) {
        for (const m of set) { m.count = m.userData.n = cnt; m.visible = cnt > 0; }
        if (set.length && cnt) { set[0].instanceMatrix.clearUpdateRanges(); set[0].instanceMatrix.addUpdateRange(0, cnt * 16); set[0].instanceMatrix.needsUpdate = true; }
      }
    });
  }

  return {
    group,
    update,
    stats: () => ({ plants: inst.n, impostors: nImp, lod0: counts0.reduce((a, b) => a + b, 0), lodB: countsB.reduce((a, b) => a + b, 0), lod1: counts1.reduce((a, b) => a + b, 0), lod2: counts2.reduce((a, b) => a + b, 0), shadow: countsS.reduce((a, b) => a + b, 0) }),
    atlas,
    inst,
    protos,
  };
}
