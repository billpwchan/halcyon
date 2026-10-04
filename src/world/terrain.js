// Terrain: one instanced grid patch drawn per CDLOD quadtree node, displaced from the heightfield in the vertex
// shader and morphed toward the next coarser grid near each range boundary, so there are no seams or pops.
import * as THREE from 'three';
import { U, patch, SHORE } from '../core/shared.js';
import { HF, VILLAGE } from './layout.js';

const LEAF = 32; // metres
const GRID = 32; // quads per patch side
const LEVELS = 8; // 32 m .. 4096 m
const R0 = 192; // range of the finest level, metres
export const LAYERS = ['coast_sand_01', 'damp_beach_sand', 'coral_gravel', 'forrest_ground_01', 'dry_decay_leaves', 'park_dirt', 'dark_rock', 'rock_face', 'coast_land_rocks_01', 'mud_forest'];

function patchGeometry() {
  const n = GRID + 1;
  const pos = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = (j * n + i) * 3;
    pos[k] = i; pos[k + 1] = 0; pos[k + 2] = j;
  }
  const idx = [];
  for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    // alternate the diagonal so morphing stays symmetric
    if ((i + j) & 1) idx.push(a, c, b, b, c, d);
    else idx.push(a, c, d, a, d, b);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * n * 3).fill(0), 3));
  g.setIndex(idx);
  return g;
}

export function createTerrain(hf, vegTex, texC, texN) {
  const MAXN = 1400;
  const geo = patchGeometry();
  const nodeAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAXN * 4), 4);
  nodeAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aNode', nodeAttr);
  geo.instanceCount = 0;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const morph = [];
  for (let l = 0; l < LEVELS; l++) {
    const R = R0 * 2 ** l;
    morph.push(new THREE.Vector2(R * 0.75, R));
  }
  const uniforms = {
    tVeg: { value: vegTex },
    tLayC: { value: texC },
    tLayN: { value: texN },
    uMorph: { value: morph },
  };

  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
  patch(mat, {
    key: 'terrain',
    wet: 0.8,
    uniforms,
    vertexHead: /* glsl */ `
      attribute vec4 aNode;
      uniform vec2 uMorph[${LEVELS}];
      varying float vDist;
      vec2 tHfUv(vec2 xz){ return (xz - uHF.xy) / uHF.z; }
      float tH(vec2 xz){ return textureLod(tHeight, tHfUv(xz), 0.0).r; }
      // far vertices sit metres apart: average the height over that footprint so sharp crests do not zigzag.
      // The width follows distance, not the patch level, so neighbouring patches agree on shared vertices.
      float tHf(vec2 xz, float w){
        if (w < 0.9) return tH(xz);
        return tH(xz) * 0.36 + (tH(xz + vec2(w, w)) + tH(xz + vec2(-w, w)) + tH(xz + vec2(w, -w)) + tH(xz + vec2(-w, -w))) * 0.11
          + (tH(xz + vec2(w * 1.6, 0.0)) + tH(xz - vec2(w * 1.6, 0.0)) + tH(xz + vec2(0.0, w * 1.6)) + tH(xz - vec2(0.0, w * 1.6))) * 0.05;
      }
    `,
    hooks: {
      beginNormal: /* glsl */ `
        vec2 tg = position.xz;
        float tUnit = aNode.z / ${GRID.toFixed(1)};
        vec2 txz = aNode.xy + tg * tUnit;
        float th = tH(txz);
        float tdist = distance(cameraPosition, vec3(txz.x, th, txz.y));
        vec2 tm = uMorph[int(aNode.w)];
        float tk = clamp((tdist - tm.x) / (tm.y - tm.x), 0.0, 1.0);
        tg -= fract(tg * 0.5) * 2.0 * tk;
        txz = aNode.xy + tg * tUnit;
        th = tH(txz);
        th = tHf(txz, distance(cameraPosition, vec3(txz.x, th, txz.y)) * 0.004);
        // the fragment stage rebuilds the normal from the heightfield per pixel
        objectNormal = vec3(0.0, 1.0, 0.0);
      `,
      vertex: /* glsl */ `
        transformed = vec3(txz.x, th, txz.y);
        vDist = tdist;
      `,
      // under a closed canopy the sky is mostly leaves: less of its blue, more green light through and off them
      light: /* glsl */ `
        reflectedLight.indirectDiffuse *= mix(vec3(1.0), vec3(0.5, 0.62, 0.36), tCanopy);
      `,
    },
    fragHead: /* glsl */ `
      precision highp sampler2DArray;
      uniform sampler2D tVeg;
      uniform sampler2DArray tLayC, tLayN;
      varying float vDist;
      float tCanopy, tBank;
      const vec3 tVil = vec3(${VILLAGE.x.toFixed(1)}, ${VILLAGE.z.toFixed(1)}, ${VILLAGE.r.toFixed(1)});
      ${SHORE}
      vec3 tri(sampler2DArray s, float layer, vec3 p, vec3 w, float sc){
        return texture(s, vec3(p.zy * sc, layer)).rgb * w.x + texture(s, vec3(p.xz * sc, layer)).rgb * w.y + texture(s, vec3(p.xy * sc, layer)).rgb * w.z;
      }
      // two scales, rotated, hide the tiling of large flat layers
      vec3 lay2(sampler2DArray s, float layer, vec2 uv, float k){
        vec3 a = texture(s, vec3(uv, layer)).rgb;
        vec2 r = mat2(0.8, 0.6, -0.6, 0.8) * uv * 0.31 + 0.37;
        vec3 b = texture(s, vec3(r, layer)).rgb;
        return mix(a, b, k);
      }
      float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    `,
    hooks2: null,
  });

  // the splat runs in place of the map, the ground normal in place of the normal map
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh) => {
    prev(sh);
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        vec2 tuv = hHfUv(vHWP.xz);
        tCanopy = 0.0;
        float tE = uHF.z / uHF.w;
        vec3 tNg = normalize(vec3(hTerrainH(vHWP.xz - vec2(tE, 0.0)) - hTerrainH(vHWP.xz + vec2(tE, 0.0)), 2.0 * tE, hTerrainH(vHWP.xz - vec2(0.0, tE)) - hTerrainH(vHWP.xz + vec2(0.0, tE))));
        vec4 tVg = texture2D(tVeg, tuv);
        vec4 tHd = texture2D(tHeight, tuv);
        vec4 tCs = texture2D(tCoast, hHfUv(vHWP.xz));
        // shading follows the heightfield per pixel; far away the mesh is too coarse to place a waterline
        float th = tHd.r;
        // far away a coarse triangle can stand above the sea where the true ground is under it: let the water through
        if (uCamUnder < 0.5 && vDist > 120.0 && th < -0.03 && vHWP.y > 0.0) discard;
        float tSlope = 1.0 - tNg.y;
        float tN1 = hNoise(vHWP.xz * 0.05), tN2 = hNoise(vHWP.xz * 0.012), tN3 = hNoise(vHWP.xz * 0.21);
        vec2 tSuv = vHWP.xz * 0.25;
        float tFade = smoothstep(60.0, 240.0, vDist);

        // weights
        float wRock = max(tVg.a, smoothstep(0.42, 0.62, tSlope + (tN1 - 0.5) * 0.18));
        float beachTop = 1.9 + 1.6 * tN2;
        // the open beach runs from the water over its crest and some way behind it. Inland of that the sand carries
        // soil wherever plants grow, reaching toward the beach in tongues under the trees rather than along a line
        float inland = -tCs.r;
        float vegK = clamp(max(max(tVg.r * 1.4, tVg.g * 1.1), tVg.b * 1.2), 0.0, 1.0);
        float backshore = smoothstep(6.0, 24.0, inland + (tN1 - 0.5) * 18.0 + (tN3 - 0.5) * 6.0);
        // swept yards and bare patches behind the beach are soil too, not beach
        float soil = max(vegK, 0.6) * backshore * smoothstep(0.9, 1.6, th);
        soil = smoothstep(0.12, 0.6, soil + (hNoise(vHWP.xz * 0.09 + 2.0) - 0.5) * 0.35);
        float wSand = smoothstep(beachTop + 0.7, beachTop - 0.3, th) * (1.0 - wRock) * (1.0 - soil);
        float wPath = tHd.b * (1.0 - wRock) * (1.0 - wSand * 0.6);
        // litter needs a closed canopy over it; under scattered trees grass grows
        float wForest = smoothstep(0.2, 0.6, tVg.r + (tN3 - 0.5) * 0.15) * (1.0 - wRock) * (1.0 - wSand) * (1.0 - wPath);
        float wOpen = max(1.0 - wRock - wSand - wPath - wForest, 0.0);
        // open ground is lawn where the map has grass, bare sandy soil between
        float lawn = smoothstep(0.12, 0.5, tVg.b + (tN3 - 0.5) * 0.35 + (tN1 - 0.5) * 0.2);
        // bare soil is trodden ground by the village and the beach; up the hills open ground is all grass
        lawn = max(lawn, smoothstep(5.0, 14.0, th + (tN1 - 0.5) * 6.0));
        float wGrass = wOpen * lawn, wSoil = wOpen * (1.0 - lawn);
        float under = smoothstep(-0.2, -1.4, th);
        // coral rubble on the reef top and around coral heads, sand between
        float coralK = max(-tHd.a, 0.0) * under;
        coralK *= smoothstep(0.25, 0.5, coralK + (tN3 - 0.5) * 0.5 + (tN1 - 0.5) * 0.3);
        float rubble = smoothstep(0.3, 0.7, tN1 * 0.6 + tN3 * 0.4) * under * smoothstep(-6.0, -1.0, th) * (1.0 - coralK) * 0.6;

        vec3 col, nT; float rough;
        // sand: luminance of the scan drives a white coral palette
        vec3 sTex = lay2(tLayC, 0.0, tSuv, 0.35);
        float sl = lum(sTex);
        vec3 sandC = mix(vec3(0.68, 0.62, 0.5), vec3(0.9, 0.86, 0.78), clamp((sl - 0.18) * 2.2, 0.0, 1.0));
        sandC *= mix(vec3(1.0), vec3(1.02, 0.97, 0.94), tN2);
        // dry sand is not paper: it is cream, mottled where the wind sorts it, flecked with shell grit, and at the
        // top of the swash lies a broken wrack line of weed and husks. The grain alone averages away past a few metres.
        float dry = smoothstep(0.35, 1.0, th) * smoothstep(-0.2, 0.3, th);
        float mott = hNoise(vHWP.xz * 0.7) * 0.6 + hNoise(vHWP.xz * 2.3) * 0.4;
        sandC *= mix(vec3(1.0), vec3(0.98, 0.95, 0.88) * (0.88 + 0.2 * mott), dry);
        float grit = smoothstep(0.6, 0.78, hNoise(vHWP.xz * 1.6 + 5.0) * 0.7 + tN3 * 0.3) * dry;
        grit *= 0.55 + 0.45 * hNoise(vHWP.xz * 6.0 + 1.0);
        sandC = mix(sandC, lay2(tLayC, 2.0, vHWP.xz * 0.6, 0.3) * vec3(1.0, 0.94, 0.84), grit * 0.4);
        // the wrack is scraps a hand across; past a few tens of metres only their average shade is left, without sparkle
        float wBand = smoothstep(0.1, 0.0, abs(th - 0.8 - (tN1 - 0.5) * 0.5)) * smoothstep(0.3, 0.6, hNoise(vHWP.xz * 0.35 + 6.0));
        float bits = smoothstep(0.64, 0.8, hNoise(vHWP.xz * 13.0 + 2.0) * 0.55 + hNoise(vHWP.xz * 2.6) * 0.45);
        float wrack = wBand * mix(bits, 0.14, smoothstep(12.0, 35.0, vDist));
        // weed dries dark and dull: the leaf scan for its fibre, not for its colour
        sandC = mix(sandC, vec3(lum(lay2(tLayC, 4.0, vHWP.xz * 0.45, 0.4))) * vec3(0.95, 0.85, 0.66), wrack * 0.8);
        vec3 sandN = texture(tLayN, vec3(tSuv, 0.0)).rgb * 2.0 - 1.0;
        // wet sand and the swash line
        float wetZ = 0.0, film = 0.0;
        if (abs(tCs.r) < 70.0 && th < 2.5) {
          vec4 sh = hShore(vHWP.xz, tCs.r, tCs.a, uTime);
          wetZ = smoothstep(sh.w + 0.12, sh.w - 0.12, th);
          film = smoothstep(sh.x + 0.1, sh.x - 0.01, th) * wetZ;
        }
        wetZ = max(wetZ, smoothstep(0.25, -0.2, th));
        vec3 wetC = sandC * vec3(0.66, 0.64, 0.6);
        // a tropical lawn: short green grass with dead patches and twigs, greener where it is shaded and damp
        vec3 grassC = lay2(tLayC, 3.0, vHWP.xz * 0.3, 0.4);
        grassC = mix(grassC * vec3(0.62, 0.92, 0.5), grassC * vec3(0.8, 0.9, 0.62), smoothstep(0.3, 0.8, tN2)) * (0.85 + 0.3 * tN3);
        // forest floor: broad dead leaves over dark humus, the humus showing in patches
        vec3 leafC = lay2(tLayC, 4.0, vHWP.xz * 0.27, 0.4) * vec3(0.9, 0.88, 0.84);
        vec3 humusC = lay2(tLayC, 9.0, vHWP.xz * 0.22, 0.4) * vec3(1.25, 1.2, 1.15);
        float hum = smoothstep(0.4, 0.7, hNoise(vHWP.xz * 0.13 + 8.0) * 0.7 + tN3 * 0.3);
        vec3 forestC = mix(leafC, humusC, hum * 0.75);
        // on banks too steep for a map laid flat from above, the ground layers are laid on from the side as well
        vec3 tw = pow(abs(tNg), vec3(4.0)); tw /= dot(tw, vec3(1.0));
        float bank = smoothstep(0.2, 0.36, tSlope + (tN1 - 0.5) * 0.08) * (1.0 - tFade);
        tBank = bank;
        if (bank > 0.0) {
          vec3 bankC = mix(tri(tLayC, 4.0, vHWP, tw, 0.27) * vec3(0.9, 0.88, 0.84), tri(tLayC, 9.0, vHWP, tw, 0.22) * vec3(1.25, 1.2, 1.15), hum * 0.75 + 0.2);
          forestC = mix(forestC, bankC, bank);
          grassC = mix(grassC, tri(tLayC, 3.0, vHWP, tw, 0.3) * vec3(0.6, 0.78, 0.48), bank);
        }
        // the grass is kept short round the village; beyond it it grows rank: dry and lush patches, tussocks, and
        // weeds and seedlings in dark clumps a metre or two across
        float kept = 1.0 - smoothstep(tVil.z * 0.8, tVil.z * 1.5, length(vHWP.xz - tVil.xy));
        float m1 = hNoise(vHWP.xz * 0.045 + 1.3), m2 = hNoise(vHWP.xz * 0.16 - 2.0), m3 = hNoise(vHWP.xz * 0.7 + 5.0);
        vec3 rankC = mix(grassC * vec3(0.62, 0.78, 0.5), grassC * vec3(1.02, 0.94, 0.62), smoothstep(0.35, 0.7, m1 * 0.6 + m2 * 0.4));
        rankC *= 0.8 + 0.35 * m3;
        rankC = mix(rankC, vec3(0.05, 0.085, 0.03), smoothstep(0.6, 0.8, m2 * 0.5 + m3 * 0.5) * 0.7);
        grassC = mix(grassC, rankC, (1.0 - kept) * 0.85);
        // above the plain open ground is not a lawn but tall grass and scrub: darker, olive, broken by bushes
        // (and on any slope off the flat): a lawn is something people keep
        float wild = max(smoothstep(10.0, 35.0, th + (tN1 - 0.5) * 12.0), smoothstep(0.06, 0.2, tSlope) * smoothstep(3.0, 9.0, th));
        float bush = smoothstep(0.42, 0.68, hNoise(vHWP.xz * 0.09) * 0.45 + hNoise(vHWP.xz * 0.27 + 3.0) * 0.3 + tN3 * 0.25);
        vec3 scrubC = mix(grassC * vec3(0.6, 0.64, 0.46), vec3(0.06, 0.1, 0.035) * (0.8 + 0.5 * tN3), bush * 0.85);
        grassC = mix(grassC, scrubC, wild);
        // a field of blades shades itself: seen from afar it is darker than any flat photo of it
        grassC *= mix(1.0, 0.78, smoothstep(15.0, 120.0, vDist));
        // trodden sand and the soil between plants: coral sand with fine litter, a little darker than the beach
        vec3 pathC = lay2(tLayC, 5.0, vHWP.xz * 0.25, 0.3) * vec3(1.12, 1.08, 1.02);
        vec3 soilC = mix(pathC, sandC * vec3(0.8, 0.77, 0.72), 0.45 + 0.25 * (1.0 - soil));
        // rock: triplanar basalt high up, weathered stone lower down, sea-worn near the water
        float basalt = smoothstep(60.0, 140.0, th + tN2 * 40.0);
        float shoreR = smoothstep(4.0, 0.5, th);
        // the dark_rock scan is near black; weathered basalt in daylight reads as a warm charcoal grey
        vec3 rockC = tri(tLayC, 6.0, vHWP, tw, 0.09) * vec3(2.0, 1.95, 1.9);
        rockC = mix(tri(tLayC, 7.0, vHWP, tw, 0.07) * vec3(0.8, 0.78, 0.74), rockC, basalt);
        rockC = mix(rockC, tri(tLayC, 8.0, vHWP, tw, 0.12) * 0.85, shoreR);
        // cliff faces: vertical runs of water stain and of hanging moss and ferns, densest in the gullies
        float tU = abs(tNg.x) > abs(tNg.z) ? vHWP.z : vHWP.x;
        float runs = hNoise(vec2(tU * 0.09, vHWP.y * 0.008)) * 0.65 + hNoise(vec2(tU * 0.35, vHWP.y * 0.03)) * 0.35;
        float stain = smoothstep(0.5, 0.75, hNoise(vec2(tU * 0.22 + 7.0, vHWP.y * 0.004)));
        rockC *= 1.0 - 0.45 * stain * wRock;
        float hang = smoothstep(0.5, 0.68, runs + (tN1 - 0.5) * 0.2) * smoothstep(3.0, 10.0, th) * (1.0 - stain * 0.6);
        vec3 hangC = tri(tLayC, 4.0, vHWP, tw, 0.2) * vec3(0.32, 0.52, 0.2) * (0.75 + 0.5 * tN3);
        // moss and ferns cling to ledges
        float moss = max(smoothstep(0.55, 0.85, tNg.y + (tN1 - 0.5) * 0.3) * smoothstep(3.0, 8.0, th), hang * 0.9);
        rockC = mix(rockC, mix(vec3(0.13, 0.2, 0.07) * (0.7 + 0.6 * tN3), hangC, hang), moss * 0.88);
        // from afar a crag on a forested peak is dark wet basalt half hidden under ferns, not a pale smear
        rockC = mix(rockC, mix(vec3(0.06, 0.062, 0.055), vec3(0.045, 0.07, 0.03), smoothstep(0.35, 0.65, tN2)) * (0.75 + 0.5 * tN3), tFade * 0.7);
        vec3 rubbleC = lay2(tLayC, 2.0, vHWP.xz * 0.3, 0.3) * vec3(1.05, 0.95, 0.86);
        // living coral seen through water: browns and ochres, with patches of violet and sea-green
        float cl = lum(lay2(tLayC, 2.0, vHWP.xz * 0.55, 0.3));
        vec3 coralC = mix(vec3(0.21, 0.15, 0.09), vec3(0.42, 0.33, 0.2), tN3);
        coralC = mix(coralC, vec3(0.3, 0.2, 0.24), 0.35 * smoothstep(0.66, 0.82, hNoise(vHWP.xz * 0.09 + 3.0)));
        coralC = mix(coralC, vec3(0.13, 0.27, 0.22), smoothstep(0.66, 0.84, hNoise(vHWP.xz * 0.07 + 9.0)));
        // a reef seen from above is the darkest thing in the lagoon
        coralC *= (0.55 + 1.1 * cl) * 0.72;

        col = sandC * wSand + grassC * wGrass + soilC * wSoil + forestC * wForest + pathC * wPath + rockC * wRock;
        col = mix(col, wetC, wetZ * wSand);
        // fallen fronds, husks and leaf litter under the palms, broken by patches of clean sand
        // dry fronds and husks are grey-brown, and on open sand they lie in scraps, not in a stain
        float blobs = smoothstep(0.38, 0.62, tN3 * 0.55 + hNoise(vHWP.xz * 0.45) * 0.45);
        blobs *= mix(1.0, smoothstep(0.45, 0.7, hNoise(vHWP.xz * 1.7 + 4.0) * 0.6 + hNoise(vHWP.xz * 5.1) * 0.4), wSand);
        // in grass the fronds lie in scraps through the blades, not in sheets across the slope: past a few tens of
        // metres only their average shade is left
        float scraps = mix(smoothstep(0.58, 0.8, hNoise(vHWP.xz * 0.9 + 2.0) * 0.6 + hNoise(vHWP.xz * 2.7) * 0.4), 0.15, smoothstep(15.0, 60.0, vDist)) * 0.7;
        float litter = smoothstep(0.15, 0.55, tVg.g) * mix(blobs, scraps, wGrass) * (1.0 - wRock) * (1.0 - wetZ);
        vec3 litterC = lay2(tLayC, 4.0, vHWP.xz * 0.24, 0.4);
        // dried fronds and husks go grey-brown in the sun
        litterC = mix(litterC, vec3(lum(litterC)) * vec3(1.15, 1.0, 0.85), 0.45) * mix(vec3(1.0), vec3(0.85, 0.82, 0.78), wSand);
        col = mix(col, litterC, litter * 0.8);
        tCanopy = clamp(max(tVg.r, tVg.g * 0.75) * 1.3 - 0.15, 0.0, 1.0) * (1.0 - tFade) * (1.0 - wRock);
        col = mix(col, rubbleC, rubble);
        col = mix(col, coralC, coralK);
        // the knolls' flanks are rubble and dead heads, darker than the open sand: without it the sand on a flank
        // facing the sun reads from the air as a white rim around every knoll
        float flank = smoothstep(0.05, 0.22, tSlope) * under * smoothstep(-8.0, -2.0, th) * (1.0 - coralK);
        col = mix(col, mix(rubbleC * 0.7, coralC, 0.45), flank * 0.8);
        // past the drawn understory, the floor under the trees is seedlings and shrubs, not bare litter
        float shrubK = smoothstep(30.0, 80.0, vDist) * (1.0 - tFade) * smoothstep(0.25, 0.6, tVg.r) * (1.0 - wRock);
        vec3 shrubC = mix(vec3(0.05, 0.085, 0.03), vec3(0.09, 0.13, 0.045), tN3) * (0.75 + 0.5 * hNoise(vHWP.xz * 0.15));
        col = mix(col, shrubC, shrubK * 0.75);
        // far away the ground under trees is the canopy itself, and what shows of it between the drawn crowns is the
        // shade under them: darker than any crown, or the forest reads as trees dotted over a lawn
        vec3 canopy = mix(vec3(0.02, 0.042, 0.016), vec3(0.04, 0.068, 0.024), tN2) * (0.8 + 0.4 * tN3);
        col = mix(col, canopy, tFade * max(tVg.r, tVg.g * 0.6) * (1.0 - wRock * 0.8));
        diffuseColor.rgb = col;
        rough = mix(0.92, 0.3, wetZ * wSand);
        rough = mix(rough, 0.12, film * wSand);
        rough = mix(rough, 0.8, wRock);
        rough = mix(rough, 0.95, coralK);
        `
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = rough;`
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        {
          vec3 tnS = sandN;
          vec3 tnG = ((texture(tLayN, vec3(vHWP.xz * 0.3, 3.0)).rgb * 2.0 - 1.0) * wGrass
                   + (texture(tLayN, vec3(vHWP.xz * 0.27, 4.0)).rgb * 2.0 - 1.0) * wForest
                   + (texture(tLayN, vec3(vHWP.xz * 0.25, 5.0)).rgb * 2.0 - 1.0) * (wSoil + wPath)) * (1.0 - 0.75 * tBank);
          vec3 tnR = (texture(tLayN, vec3(vHWP.zy * 0.08, 6.0 + (1.0 - basalt))).rgb * 2.0 - 1.0) * tw.x
                   + (texture(tLayN, vec3(vHWP.xz * 0.08, 6.0 + (1.0 - basalt))).rgb * 2.0 - 1.0) * tw.y
                   + (texture(tLayN, vec3(vHWP.xy * 0.08, 6.0 + (1.0 - basalt))).rgb * 2.0 - 1.0) * tw.z;
          // sand ripples underwater, smoothing out in the swash
          float rip = sin(dot(vHWP.xz, vec2(0.83, 0.55)) * 2.4 + hNoise(vHWP.xz * 0.3) * 4.0);
          vec3 tnU = vec3(cos(dot(vHWP.xz, vec2(0.83, 0.55)) * 2.4) * 0.35 * under, 0.0, 0.0);
          vec3 d = (tnS * (wSand * (1.0 - wetZ * 0.7)) + tnG * 0.8 + tnR * wRock * 1.3) * (1.0 - tFade * 0.7);
          vec3 tnC = texture(tLayN, vec3(vHWP.xz * 0.55, 2.0)).rgb * 2.0 - 1.0;
          d += tnC * coralK * 1.6;
          vec3 Nw = normalize(tNg + vec3(d.x, 0.0, d.y) * 0.55 + vec3(tnU.x * 0.83, 0.0, tnU.x * 0.55) * (1.0 - coralK));
          normal = normalize((viewMatrix * vec4(Nw, 0.0)).xyz);
        }
        `
      );
  };
  mat.customProgramCacheKey = () => 'terrain-v11';

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.castShadow = false;

  // ---------------------------------------------------------------- min/max pyramid for culling
  const ROOT = LEAF * 2 ** (LEVELS - 1);
  const rootX = -ROOT / 2, rootZ = -ROOT / 2;
  const leafN = ROOT / LEAF;
  const mm = [];
  {
    const mn = new Float32Array(leafN * leafN), mx = new Float32Array(leafN * leafN);
    for (let j = 0; j < leafN; j++) for (let i = 0; i < leafN; i++) {
      let lo = 1e9, hi = -1e9;
      for (let b = 0; b <= 4; b++) for (let a = 0; a <= 4; a++) {
        const h = hf.heightAt(rootX + (i + a / 4) * LEAF, rootZ + (j + b / 4) * LEAF);
        lo = Math.min(lo, h); hi = Math.max(hi, h);
      }
      mn[j * leafN + i] = lo - 2; mx[j * leafN + i] = hi + 2;
    }
    mm.push({ n: leafN, mn, mx });
    for (let l = 1; l < LEVELS; l++) {
      const p = mm[l - 1], n = p.n / 2;
      const mn2 = new Float32Array(n * n), mx2 = new Float32Array(n * n);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const a = (j * 2) * p.n + i * 2;
        mn2[j * n + i] = Math.min(p.mn[a], p.mn[a + 1], p.mn[a + p.n], p.mn[a + p.n + 1]);
        mx2[j * n + i] = Math.max(p.mx[a], p.mx[a + 1], p.mx[a + p.n], p.mx[a + p.n + 1]);
      }
      mm.push({ n, mn: mn2, mx: mx2 });
    }
  }

  const frustum = new THREE.Frustum();
  const box = new THREE.Box3();
  const m4 = new THREE.Matrix4();
  const arr = nodeAttr.array;
  let count = 0;
  let cam;
  const distToBox = (bx0, by0, bz0, bx1, by1, bz1) => {
    const p = cam.position;
    const dx = Math.max(bx0 - p.x, 0, p.x - bx1), dy = Math.max(by0 - p.y, 0, p.y - by1), dz = Math.max(bz0 - p.z, 0, p.z - bz1);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };
  const add = (x, z, size, lod) => {
    if (count >= MAXN) return;
    const k = count * 4;
    arr[k] = x; arr[k + 1] = z; arr[k + 2] = size; arr[k + 3] = lod;
    count++;
  };
  let under = false;
  const select = (i, j, lod) => {
    const size = LEAF * 2 ** lod;
    const x0 = rootX + i * size, z0 = rootZ + j * size;
    const L = mm[lod];
    const lo = L.mn[j * L.n + i], hi = L.mx[j * L.n + i];
    // deep seabed is invisible through the water from above
    if (!under && hi < -48) return;
    box.min.set(x0, lo, z0); box.max.set(x0 + size, hi, z0 + size);
    if (!frustum.intersectsBox(box)) return;
    if (lod === 0) { add(x0, z0, size, 0); return; }
    const d = distToBox(x0, lo, z0, x0 + size, hi, z0 + size);
    if (d > R0 * 2 ** (lod - 1)) { add(x0, z0, size, lod); return; }
    for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) select(i * 2 + a, j * 2 + b, lod - 1);
  };

  function update(camera) {
    cam = camera;
    under = camera.position.y < 0.5;
    m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(m4);
    count = 0;
    select(0, 0, LEVELS - 1);
    geo.instanceCount = count;
    nodeAttr.needsUpdate = true;
    nodeAttr.clearUpdateRanges();
    nodeAttr.addUpdateRange(0, count * 4);
    return count;
  }

  return { mesh, update, material: mat };
}
