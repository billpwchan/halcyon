// One set of uniforms and GLSL helpers drives every material, so light, air, water and weather agree everywhere.
import * as THREE from 'three';
import { HF } from '../world/layout.js';

const v2 = (x = 0, y = 0) => new THREE.Vector2(x, y);
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const v4 = (x = 0, y = 0, z = 0, w = 0) => new THREE.Vector4(x, y, z, w);

export const MAX_LAMPS = 16;

export const U = {
  uTime: { value: 0 },
  uSunDir: { value: v3(0.3, 0.5, -0.8).normalize() }, // dominant light: the sun, or the moon at night
  uTrueSun: { value: v3(0.3, 0.5, -0.8).normalize() },
  uMoonDir: { value: v3(-0.3, 0.5, 0.8).normalize() },
  uSunCol: { value: v3(3, 2.8, 2.5) }, // radiance of the dominant light at the ground
  uNight: { value: 0 },
  uDay: { value: 1 },
  uWind: { value: v4(0.8, 0.6, 0.6, 0) }, // dir xz, strength 0..1.5, gust
  uSwell: { value: 1 }, // ocean energy (storm raises it)
  uRain: { value: 0 },
  uWet: { value: 0 },
  uCover: { value: 0.35 }, // cloud cover 0..1
  uFlash: { value: 0 },
  uFlashDir: { value: v3(0, 0.6, -0.8).normalize() },
  uHaze: { value: 1 },
  uLampOn: { value: 0 },
  uBiolum: { value: 0 },
  uCamUnder: { value: 0 },
  uExposureK: { value: 1 },
  uLampPos: { value: Array.from({ length: MAX_LAMPS }, () => v4(0, -999, 0, 1)) },
  uLampCol: { value: Array.from({ length: MAX_LAMPS }, () => v3()) },
  uTorch: { value: v4(0, -999, 0, 0) }, // pos, on
  uTorchDir: { value: v3(0, 0, -1) },
  uHF: { value: v4(HF.origin, HF.origin, HF.size, HF.res) },
  uCloudOff: { value: v2(0, 0) }, // weather map scroll, metres
  uBoat: { value: v4(0, 0, 0, 0) }, // x, z, heading, speed (wake, biolum)
  uSwimmer: { value: v4(0, -999, 0, 0) }, // x, y, z, speed
  tSky: { value: null }, // sky + cloud panorama (equirect, mipmapped)
  tAmb: { value: null }, // horizon fog ring + ambient irradiance
  tHeight: { value: null }, // terrain heightfield (R = height)
  tCoast: { value: null }, // R = signed distance to the break line, GB = shoreward dir, A = lagoon
  tHorizon: { value: null }, // terrain sun visibility for the current sun
  tWeather: { value: null }, // cloud coverage map
  tCaustics: { value: null },
  tVegMap: { value: null }, // R forest, G palm, B grass, A rock density (vegmap.js)
};

export const UNIFORMS_GLSL = /* glsl */ `
uniform float uTime, uNight, uDay, uSwell, uRain, uWet, uCover, uFlash, uHaze, uLampOn, uBiolum, uCamUnder, uExposureK;
uniform vec3 uSunDir, uTrueSun, uMoonDir, uSunCol, uFlashDir, uTorchDir;
uniform vec4 uWind, uHF, uBoat, uSwimmer, uTorch;
uniform vec2 uCloudOff;
uniform vec4 uLampPos[${MAX_LAMPS}];
uniform vec3 uLampCol[${MAX_LAMPS}];
uniform sampler2D tSky, tAmb, tHeight, tCoast, tHorizon, tWeather, tCaustics, tVegMap;
`;

export const NOISE = /* glsl */ `
float hHash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hHash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec2 hHash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float hNoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hHash12(i), hHash12(i+vec2(1,0)), u.x), mix(hHash12(i+vec2(0,1)), hHash12(i+vec2(1,1)), u.x), u.y); }
float hFbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ s += a * hNoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p; a *= 0.5; } return s; }
float hFbm2(vec2 p){ return 0.6667 * hNoise(p) + 0.3333 * hNoise(mat2(1.6, 1.2, -1.2, 1.6) * p); }
`;

// Sky panorama: equirectangular, elevation linear in v. Fog colour comes from the clear-sky ring in tAmb.
export const SKYLIB = /* glsl */ `
vec2 hSkyUv(vec3 d){ return vec2(atan(d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5); }
vec3 hSky(vec3 d, float lod){ return textureLod(tSky, hSkyUv(d), lod).rgb; }
// clear sky near the horizon in direction d (rows: 1, 6, 16, 40 degrees of elevation)
vec3 hFogCol(vec3 d){
  float u = atan(d.z, d.x) * 0.15915494 + 0.5;
  float e = clamp(asin(clamp(d.y, -1.0, 1.0)) * 57.29578, 0.0, 40.0);
  float row = e < 6.0 ? e / 5.0 - 0.2 : (e < 16.0 ? 1.0 + (e - 6.0) / 10.0 : 2.0 + (e - 16.0) / 24.0);
  row = clamp(row, 0.0, 3.0);
  return texture2D(tAmb, vec2(u, (row + 0.5) / 8.0)).rgb;
}
// ambient irradiance (already divided by pi) from the sky above, around and below
vec3 hAmbient(vec3 n){
  vec3 up = texture2D(tAmb, vec2(0.5 / 64.0, 4.5 / 8.0)).rgb;
  vec3 side = texture2D(tAmb, vec2(1.5 / 64.0, 4.5 / 8.0)).rgb;
  vec3 down = texture2D(tAmb, vec2(2.5 / 64.0, 4.5 / 8.0)).rgb;
  float y = n.y;
  return y > 0.0 ? mix(side, up, y) : mix(side, down, -y);
}
`;

// sun visibility from terrain occlusion and cloud shadows
export const SUNVIS = /* glsl */ `
vec2 hHfUv(vec2 xz){ return (xz - uHF.xy) / uHF.z; }
float hTerrainH(vec2 xz){ return texture2D(tHeight, hHfUv(xz)).r; }
float hCloudShadow(vec3 wp){
  vec3 L = uSunDir;
  float t = (1600.0 - wp.y) / max(L.y, 0.08);
  vec2 q = wp.xz + L.xz * t + uCloudOff;
  float c = texture2D(tWeather, q / 24000.0).r;
  float dens = smoothstep(1.0 - uCover, 1.0 - uCover + 0.28, c);
  return 1.0 - dens * 0.8 * smoothstep(0.0, 0.1, L.y);
}
float hSunVis(vec3 wp){
  vec2 uv = hHfUv(wp.xz);
  float hz = 1.0;
  if (all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)))) hz = texture2D(tHorizon, uv).r;
  return hz * hCloudShadow(wp);
}
// light thrown back up by the ground (radiance, divided by pi like hAmbient): coral sand in sun is a broad warm
// lamp under everything near it, grass and litter much less, water hardly at all. Without it every face turned
// from the sky is lit by the sky alone and goes blue and dark.
vec3 hBounce(vec3 wp){
  vec2 uv = hHfUv(wp.xz);
  float gh = texture2D(tHeight, uv).r;
  vec4 vg = texture2D(tVegMap, uv);
  float veg = clamp(max(max(vg.r * 1.4, vg.g * 0.9), vg.b * 1.2), 0.0, 1.0);
  vec3 alb = mix(vec3(0.6, 0.56, 0.48), vec3(0.11, 0.12, 0.06), veg);
  alb = mix(vec3(0.03, 0.07, 0.08), alb, smoothstep(-0.4, 0.3, gh));
  // ground under a canopy is mostly in the canopy's shade
  float lit = (1.0 - 0.8 * max(vg.r, vg.g * 0.55)) * hCloudShadow(vec3(wp.x, gh, wp.z)) * (1.0 - uNight);
  vec3 up = texture2D(tAmb, vec2(0.5 / 64.0, 4.5 / 8.0)).rgb;
  return alb * (uSunCol * max(uSunDir.y, 0.0) * lit * 0.31831 + up);
}
`;

// Shore waves, shared by the ocean surface, the beach shading and (ported) the CPU sampler.
// d: signed distance to the break line (+ seaward), lag: 1 inside the reef, returns
// x = water level offset, y = foam, z = front steepness (for the lip), w = run-up level reached this cycle.
export const SHORE = /* glsl */ `
vec4 hShore(vec2 p, float d, float lag, float t){
  // inside the reef only a small chop reaches the beaches, and only right at the water's edge
  float expo = mix(1.0, 0.12, lag) * uSwell;
  float lambda = mix(26.0, 10.0, lag);
  float T = mix(8.5, 4.6, lag);
  float off = hNoise(p * 0.0045) * 1.6 + hNoise(p * 0.017) * 0.35;
  float grp = 0.55 + 0.45 * sin(t * 0.11 + hNoise(p * 0.0021) * 6.2832);
  float A = 0.62 * expo * grp;
  float phi = d / lambda + t / T + off;
  float s = fract(phi);
  float steep = smoothstep(42.0, 3.0, d);
  float fw = mix(0.42, 0.1, steep);
  float back = pow(max(1.0 - s / (1.0 - fw), 0.0), 1.7);
  float front = pow(smoothstep(1.0 - fw, 1.0, s), 1.4);
  float prof = max(back, front);
  float shoal = (1.0 + 1.5 * steep) * smoothstep(95.0, 45.0, d) * mix(1.0, smoothstep(26.0, 6.0, d), lag);
  float broken = smoothstep(7.0, -1.0, d);
  float h = A * shoal * prof * (1.0 - 0.75 * broken) - A * 0.25 * shoal;
  // white water: the breaking face, then the bore it leaves behind; the lagoon's chop only breaks at the very edge
  float zone = mix(1.0, 0.3, lag);
  float foam = smoothstep(1.0 - fw * 1.2, 1.0, s) * smoothstep(18.0 * zone, 2.0 * zone, d) * expo;
  foam += exp(-s * 4.0) * smoothstep(9.0 * zone, 0.0, d) * expo * 1.2;
  // swash: the sheet runs up the beach on each arrival and drains back
  float sw = fract(t / T + off);
  float env = sw < 0.14 ? smoothstep(0.0, 0.14, sw) : pow(1.0 - (sw - 0.14) / 0.86, 1.25);
  float R = (0.18 + 0.55 * A) * grp;
  float runup = R * env - max(-d, 0.0) * 0.004;
  float inSwash = smoothstep(3.0, -2.0, d);
  h = mix(h, runup, inSwash);
  // in the lagoon the sheet is a few centimetres of clear water; its froth is the contact line, drawn by the water
  foam += inSwash * env * 0.9 * exp(min(d, 0.0) / mix(9.0, 30.0, 1.0 - lag)) * mix(1.0, 0.15, lag);
  return vec4(h, foam, front * steep * (1.0 - broken) * expo, R);
}
`;

// absorption and in-scatter of the lagoon water
export const WATER = /* glsl */ `
const vec3 hWaterSigma = vec3(0.46, 0.085, 0.045);
vec3 hWaterScatter(){
  float lit = max(uSunDir.y, 0.0);
  vec3 sun = uSunCol * (0.25 + 0.75 * lit);
  vec3 amb = texture2D(tAmb, vec2(0.5 / 64.0, 4.5 / 8.0)).rgb * 3.14159;
  return (sun * 0.032 + amb * 0.05) * vec3(0.05, 0.42, 0.62);
}
`;

// aerial perspective above water; absorption and in-scatter when the camera is under it
export const ATMOS = WATER + /* glsl */ `
float hHazeOD(vec3 ro, vec3 rd, float dist){
  // exponential haze (scale height 380 m) integrated analytically along the ray
  float k = 0.00012 * uHaze, b = 1.0 / 380.0;
  float dy = rd.y * dist;
  float h0 = k * exp(-b * max(ro.y, 0.0));
  return abs(dy) > 0.01 ? h0 * (1.0 - exp(-b * dy)) / (b * dy / dist) : h0 * dist;
}
vec3 hAtmos(vec3 col, vec3 wp){
  vec3 v = wp - cameraPosition; float dist = length(v); vec3 rd = v / max(dist, 1e-4);
  if (uCamUnder > 0.5) {
    float tw = dist;
    if (wp.y > 0.0 && rd.y > 0.0) tw = min(dist, (0.0 - cameraPosition.y) / rd.y);
    vec3 T = exp(-hWaterSigma * tw * 1.15);
    return col * T + hWaterScatter() * (1.0 - T);
  }
  float T = exp(-hHazeOD(cameraPosition, rd, dist));
  vec3 fc = hFogCol(rd);
  return col * T + fc * (1.0 - T);
}
`;

export const CAUSTICS = /* glsl */ `
// light reaching an underwater point through the surface, with focused caustic bands
vec3 hUnderLight(vec3 wp, vec3 n){
  float depth = max(-wp.y, 0.0);
  vec3 L = uSunDir;
  float path = depth / max(L.y, 0.2);
  vec3 att = exp(-hWaterSigma * path);
  vec2 q = wp.xz - L.xz * depth / max(L.y, 0.2);
  float c1 = texture2D(tCaustics, q * 0.11).r;
  float c2 = texture2D(tCaustics, q * 0.083 + vec2(0.31, 0.57)).r;
  // scaled so the pattern averages to 1: caustics move light around, they do not remove it
  float c = min(c1, c2) * 5.0 + 0.42;
  float far = smoothstep(90.0, 420.0, distance(wp, cameraPosition));
  c = mix(1.0, c, smoothstep(0.0, 1.2, depth) * smoothstep(60.0, 8.0, depth) * (1.0 - far));
  return att * c * max(dot(n, L) * 0.7 + 0.3, 0.0);
}
`;

export const LAMPS = /* glsl */ `
vec3 hLamps(vec3 wp, vec3 nW, float wrap){
  vec3 acc = vec3(0.0);
  if (uLampOn < 0.01 && uTorch.w < 0.5) return acc;
  for (int i = 0; i < ${MAX_LAMPS}; i++){
    vec4 lp = uLampPos[i];
    vec3 L = lp.xyz - wp;
    float d2 = dot(L, L);
    float r2 = lp.w * lp.w;
    if (d2 > r2 * 9.0) continue;
    float d = sqrt(d2);
    // pools of light with dark between them, not an even wash
    float att = 1.0 / (1.0 + 2.5 * d2 / r2) * smoothstep(3.0 * lp.w, 1.4 * lp.w, d);
    float ndl = (dot(nW, L / d) + wrap) / (1.0 + wrap);
    acc += uLampCol[i] * att * max(ndl, 0.0);
  }
  acc *= uLampOn;
  if (uTorch.w > 0.5) {
    vec3 L = uTorch.xyz - wp; float d = length(L); L /= max(d, 1e-3);
    float cone = smoothstep(0.86, 0.96, dot(-L, uTorchDir));
    acc += vec3(1.0, 0.92, 0.8) * 9.0 * cone / (1.0 + d * d * 0.06) * max(dot(nW, L), 0.0);
  }
  return acc;
}
`;

// wind for plants: bend grows with height above the root, times stiffness
export const WIND = /* glsl */ `
vec3 hWindOffset(vec3 root, float h, float stiff){
  vec2 wd = uWind.xy;
  float gust = 0.6 + 0.4 * sin(dot(root.xz, wd) * 0.045 - uTime * 1.1) * sin(dot(root.xz, vec2(-wd.y, wd.x)) * 0.027 + uTime * 0.47);
  float s = uWind.z * (0.55 + gust) * stiff;
  float bend = h * h * 0.018;
  float flutter = sin(uTime * 2.3 + root.x * 0.7 + root.z * 0.9) * 0.22 + sin(uTime * 4.1 + root.z * 1.3) * 0.1;
  return vec3(wd.x, 0.0, wd.y) * bend * s * (1.0 + flutter) + vec3(0.0, -bend * s * 0.12, 0.0);
}
`;

export const COMMON = UNIFORMS_GLSL + NOISE + SKYLIB + SUNVIS + ATMOS + CAUSTICS + LAMPS;

const WP_VERT = /* glsl */ `
  {
    vec4 hWP4 = vec4(transformed, 1.0);
    #ifdef USE_BATCHING
      hWP4 = batchingMatrix * hWP4;
    #endif
    #ifdef USE_INSTANCING
      hWP4 = instanceMatrix * hWP4;
    #endif
    vHWP = (modelMatrix * hWP4).xyz;
  }
`;

const LIGHTS_BEGIN = THREE.ShaderChunk.lights_fragment_begin.replace(
  'getDirectionalLightInfo( directionalLight, directLight );',
  'getDirectionalLightInfo( directionalLight, directLight ); directLight.color *= hVis;'
);

/**
 * Patch a built-in material (Standard or Lambert) into the shared world: sky ambient and reflections, terrain and
 * cloud shadow, haze or underwater fog, caustics, lamps, lightning and wetness.
 * opts: { key, wet, wrap, uniforms, vertexHead, fragHead, hooks: { vertex, vertexPost, beginNormal, map, normal, alpha, preLight, light, post } }
 */
export function patch(mat, opts = {}) {
  const wet = opts.wet ?? 1;
  const hooks = opts.hooks || {};
  const extra = opts.uniforms || {};
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U, extra);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vHWP;\n${UNIFORMS_GLSL}\n${NOISE}\n${WIND}\n${opts.vertexHead || ''}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${hooks.beginNormal || ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${hooks.vertex || ''}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${WP_VERT}\n${hooks.vertexPost || ''}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vHWP;\n${COMMON}\n${opts.fragHead || ''}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${hooks.map || ''}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${hooks.normal || ''}`)
      .replace('#include <alphatest_fragment>', `${hooks.alpha || ''}\n#include <alphatest_fragment>`)
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        vec3 hNW = inverseTransformDirection(normal, viewMatrix);
        float hVis = hSunVis(vHWP);
        ${hooks.preLight || ''}
        {
          float hWetK = ${wet.toFixed(3)} * uWet;
          diffuseColor.rgb *= 1.0 - 0.35 * hWetK;
          #ifdef STANDARD
            roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.35, hWetK);
          #endif
        }`
      )
      .replace('#include <lights_fragment_begin>', LIGHTS_BEGIN)
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `
        irradiance += (hAmbient(hNW) + hBounce(vHWP) * clamp(0.5 - 0.5 * hNW.y, 0.0, 1.0)) * 3.14159;
        #if defined( RE_IndirectSpecular )
          {
            vec3 hR = reflect(-normalize(cameraPosition - vHWP), hNW);
            hR.y = abs(hR.y);
            radiance += hSky(hR, 3.0 + material.roughness * 4.0) * (1.0 - material.roughness * 0.6);
          }
        #endif
        if (vHWP.y < 0.15) {
          // under the surface the sun arrives filtered and focused into caustics
          vec3 ul = hUnderLight(vHWP, hNW);
          float k = smoothstep(0.15, -0.2, vHWP.y);
          reflectedLight.directDiffuse = mix(reflectedLight.directDiffuse, reflectedLight.directDiffuse * ul * 1.4, k);
          // sky light is filtered by the water above it as well
          vec3 hAtt = exp(-hWaterSigma * max(-vHWP.y, 0.0) * 1.15);
          reflectedLight.indirectDiffuse *= mix(vec3(1.0), hAtt * 0.8, k);
          reflectedLight.indirectSpecular *= mix(vec3(1.0), hAtt * 0.25, k);
        }
        reflectedLight.directDiffuse += BRDF_Lambert(material.diffuseColor) * (hLamps(vHWP, hNW, ${(opts.wrap ?? 0).toFixed(2)}) + uFlash * vec3(1.0, 1.1, 1.4) * max(dot(hNW, uFlashDir) * 0.6 + 0.4, 0.0));
        ${hooks.light || ''}
        #include <lights_fragment_end>`
      )
      .replace('#include <fog_fragment>', `gl_FragColor.rgb = hAtmos(gl_FragColor.rgb, vHWP);\n${hooks.post || ''}`);
    if (opts.onShader) opts.onShader(sh);
  };
  mat.customProgramCacheKey = () => 'h:' + (opts.key || mat.type) + ':' + wet;
  return mat;
}

// depth material for shadow casting that shares a vertex hook (wind) and alpha cut-out
export function patchDepth(mat, opts = {}) {
  const hooks = opts.hooks || {};
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U, opts.uniforms || {});
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${UNIFORMS_GLSL}\n${NOISE}\n${WIND}\n${opts.vertexHead || ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${hooks.vertex || ''}`);
  };
  mat.customProgramCacheKey = () => 'hd:' + (opts.key || 'd');
  return mat;
}
