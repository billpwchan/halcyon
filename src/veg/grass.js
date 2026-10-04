// Grass blades near the camera: real geometry, not alpha cards, so tiled GPUs can still reject hidden pixels.
// Two rings of square patches follow the camera; each patch is one instance of a baked blade field, and where
// the ground wants grass (vegmap) is decided per blade in the vertex shader, so the field follows the map exactly.
// Three rings, each sparser with wider blades than the last, out to 60 m where the terrain's grass texture takes
// over. A blade's colour comes from the ground texture at its root, so the field and the ground agree.
import * as THREE from 'three';
import { patch } from '../core/shared.js';
import { VILLAGE } from '../world/layout.js';

const RINGS = [
  { patch: 2, n: 30, radius: 14, width: 0.02, height: 1.0, flat: 0.85 },
  { patch: 4, n: 30, radius: 32, width: 0.045, height: 1.0, flat: 0.8 },
  { patch: 8, n: 24, radius: 60, width: 0.1, height: 0.95, flat: 0.85 },
];
const SEGS = 4;

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

// one patch: n x n jittered blades, each a tapered strip of SEGS segments ending in a point
function patchGeometry(ring, seed) {
  const r = rng(seed);
  const { patch: P, n } = ring;
  const pos = [], blade = [], idx = [];
  const sp = P / n;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const bx = (i + 0.15 + r() * 0.7) * sp, bz = (j + 0.15 + r() * 0.7) * sp;
    const b = [bx, bz, r(), r()];
    const base = pos.length / 3;
    for (let s = 0; s < SEGS; s++) {
      const t = s / SEGS;
      pos.push(-0.5, t, 0, 0.5, t, 0);
      blade.push(...b, ...b);
    }
    pos.push(0, 1, 0);
    blade.push(...b);
    for (let s = 0; s < SEGS - 1; s++) {
      const a = base + s * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    const a = base + (SEGS - 1) * 2;
    idx.push(a, a + 1, a + 2);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aBlade', new THREE.Float32BufferAttribute(blade, 4));
  // the vertex shader writes the normal; without the attribute three would shade every blade flat, by its face
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
  g.setIndex(idx);
  return g;
}

const VERT_HEAD = /* glsl */ `
attribute vec4 aBlade; // position in the patch (m), two randoms
attribute vec3 iTile;  // patch origin xz, unused
uniform vec4 uRing;    // inner fade start, inner fade end (0 for the first ring), outer fade start, outer fade end
uniform vec3 uBlade;   // width, height scale, how far the normal leans on the ground's (far rings shade flatter)
uniform vec3 uPlayer;  // pushes blades aside
uniform highp sampler2DArray tLayC;
varying vec3 vGr;      // height along the blade, colour variation, dryness
varying vec3 vGround;  // ground colour at the root
varying float vSide;   // across the blade, -0.5..0.5
varying float vTall;   // 0 lawn, 1 tuft
vec2 gUv(vec2 xz){ return (xz - uHF.xy) / uHF.z; }
float gDensity(vec2 xz, out float gy, out float dry, out float tall){
  vec2 uv = gUv(xz);
  vec4 hd = texture(tHeight, uv);
  vec4 vm = texture(tVegMap, uv);
  gy = hd.r;
  // a lawn where the map says grass; under the palms only in patches, between the litter
  float lawn = vm.b * 1.2 * (1.0 - vm.r * 0.85);
  float tufts = vm.g * smoothstep(0.48, 0.68, hNoise(xz * 0.11 + 4.0)) * 0.9;
  float d = clamp(max(lawn, tufts), 0.0, 1.0) * (1.0 - vm.a);
  // a lawn is cropped short; only the tufts among the palms and on the beach crest stand tall
  tall = max(smoothstep(0.0, 0.25, tufts - lawn), smoothstep(10.0, 30.0, gy));
  // past the village's kept grass it grows rank, standing tall in its clumps (terrain.js draws the same patches)
  float rank = smoothstep(${(VILLAGE.r * 0.8).toFixed(1)}, ${(VILLAGE.r * 1.5).toFixed(1)}, length(xz - vec2(${VILLAGE.x.toFixed(1)}, ${VILLAGE.z.toFixed(1)})));
  tall = max(tall, rank * smoothstep(0.45, 0.7, hNoise(xz * 0.16 - 2.0) * 0.5 + hNoise(xz * 0.7 + 5.0) * 0.5));
  d *= 1.0 - smoothstep(0.2, 0.6, hd.b);
  // the upper beach gets only scattered tufts of beach grass
  d *= mix(0.12, 1.0, smoothstep(2.3, 3.8, gy)) * smoothstep(0.9, 1.4, gy);
  dry = vm.g * (1.0 - smoothstep(3.0, 8.0, gy)) * 0.6;
  return d;
}
`;

// computes the blade in world space; the normal is set here because the vertex hook runs after beginnormal
const BEGIN_NORMAL = /* glsl */ `
  vec2 gxz = iTile.xy + aBlade.xy;
  float gy, gDry, gTall;
  float gD = gDensity(gxz, gy, gDry, gTall);
  float gDist = distance(cameraPosition.xz, gxz);
  float gFade = smoothstep(uRing.x, uRing.y, gDist) * (1.0 - smoothstep(uRing.z, uRing.w, gDist));
  if (uRing.y <= 0.0) gFade = 1.0 - smoothstep(uRing.z, uRing.w, gDist);
  // clumps: taller, denser tussocks with shorter grass between
  float gClump = hNoise(gxz * 0.35);
  // thin grass grows as separate tufts at full density, shorter at their edges, not as evenly spaced blades
  float gPn = hNoise(gxz * 0.45) * 0.65 + hNoise(gxz * 1.6 + 3.0) * 0.35;
  // a lawn fills in evenly and only thins at its margins; tufts stand apart
  float gIn = gD * 1.25 - 0.08 - gPn * mix(0.35, 1.0, gTall);
  float gKeep = step(0.0, gIn) * step(aBlade.z, 0.55 + 0.45 * gD);
  float gLen = mix(0.04 + 0.08 * aBlade.w * aBlade.w, 0.2 + 0.36 * aBlade.w * aBlade.w, gTall) * mix(0.85 + 0.3 * gClump, 0.55 + 0.8 * gClump, gTall);
  float gH = gLen * (0.45 + 0.55 * smoothstep(0.0, 0.2, gIn)) * uBlade.y * gFade * gKeep;
  float gYaw = aBlade.w * 37.0 + aBlade.z * 11.0;
  vec3 gF = vec3(cos(gYaw), 0.0, sin(gYaw));
  // blades seen edge-on vanish: turn them part way toward the camera
  vec3 gToCam = normalize(vec3(cameraPosition.x - gxz.x, 0.0, cameraPosition.z - gxz.y) + 1e-4);
  gF = normalize(mix(gF, gToCam, 0.45 * abs(dot(gF, vec3(-gToCam.z, 0.0, gToCam.x)))));
  vec3 gSide = vec3(-gF.z, 0.0, gF.x);
  float gT = position.y;
  // lean, wind and the player's push all bend the blade quadratically along its height
  vec2 wd = uWind.xy;
  float gGust = 0.5 + 0.5 * sin(dot(gxz, wd) * 0.12 - uTime * 2.1 + hNoise(gxz * 0.05) * 6.0);
  vec3 gBend = gF * (0.25 + 0.55 * aBlade.z) * mix(0.6, 1.0, gTall) + vec3(wd.x, 0.0, wd.y) * uWind.z * (0.25 + 0.75 * gGust) * 0.55;
  gBend += vec3(wd.x, 0.0, wd.y) * sin(uTime * 5.3 + aBlade.z * 30.0) * 0.05 * uWind.z;
  vec2 gAway = gxz - uPlayer.xz;
  float gPush = smoothstep(1.4, 0.2, length(gAway)) * step(abs(uPlayer.y - gy), 2.0);
  gBend += vec3(normalize(gAway + 1e-4).x, -0.6, normalize(gAway + 1e-4).y) * gPush * 1.4;
  vec3 gUp = vec3(0.0, 1.0, 0.0);
  vec3 gP = vec3(gxz.x, gy, gxz.y) + gUp * gH * gT + gBend * gH * gT * gT;
  gP += gSide * position.x * uBlade.x * mix(0.7, 1.3, gTall) * (1.0 - gT * gT * 0.9) * (0.7 + 0.6 * aBlade.z) * step(0.001, gH);
  // a rounded blade, leaning on the ground normal so the field shades like the ground it grows from
  vec3 gN = normalize(cross(gSide, gUp + 2.0 * gBend * gT) + gSide * position.x * 1.2);
  objectNormal = normalize(mix(gN, gUp, uBlade.z));
  vSide = position.x;
  vGr = vec3(gT, aBlade.z * 0.6 + gClump * 0.4, gDry + aBlade.w * aBlade.w * 0.25);
  // the lawn's colour at the blade's root, tinted as the terrain tints it, so blade and ground are one surface
  vec3 gGc = textureLod(tLayC, vec3(gxz * 0.3, 3.0), 2.0).rgb;
  vGround = mix(gGc * vec3(0.62, 0.92, 0.5), gGc * vec3(0.8, 0.9, 0.62), smoothstep(0.3, 0.8, hNoise(gxz * 0.012))) * (0.85 + 0.3 * hNoise(gxz * 0.21));
  // a lawn stays green to the tip; only the tufts dry to straw
  // on the hills the ground is scrub, darker and olive (terrain.js)
  vGround *= mix(vec3(1.0), vec3(0.62, 0.66, 0.5), smoothstep(10.0, 35.0, gy));
  vGr.z = max(vGr.z * mix(0.35, 1.0, gTall), gTall * 0.35);
  vTall = gTall;
`;

export function createGrass(layC) {
  const group = new THREE.Group();
  group.name = 'grass';
  const player = new THREE.Vector3(0, -999, 0);
  const rings = RINGS.map((ring, ri) => {
    const geo = patchGeometry(ring, 91 + ri);
    const maxTiles = Math.ceil(((ring.radius * 2) / ring.patch + 2) ** 2);
    const tiles = new THREE.InstancedBufferAttribute(new Float32Array(maxTiles * 3), 3);
    tiles.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iTile', tiles);
    geo.instanceCount = 0;
    const inner = ri === 0 ? [0, 0] : [RINGS[ri - 1].radius - 5, RINGS[ri - 1].radius];
    const mat = patch(new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.75, metalness: 0 }), {
      key: 'grass',
      wet: 0.5,
      uniforms: {
        uRing: { value: new THREE.Vector4(inner[0], inner[1], ring.radius - (ri === RINGS.length - 1 ? 12 : 5), ring.radius) },
        uBlade: { value: new THREE.Vector3(ring.width, ring.height, ring.flat) },
        uPlayer: { value: player },
        tLayC: { value: layC },
      },
      vertexHead: VERT_HEAD,
      fragHead: 'varying vec3 vGr; varying vec3 vGround; varying float vSide; varying float vTall;',
      hooks: {
        beginNormal: BEGIN_NORMAL,
        vertex: 'transformed = gP;',
        map: /* glsl */ `
          // from the ground's own colour at the root to a lighter, yellower tip
          vec3 gTip = vGround * mix(vec3(1.0, 1.15, 0.9), vec3(1.2, 1.2, 0.85), vGr.y * vGr.y);
          vec3 gc = mix(vGround * mix(vec3(0.97, 1.0, 0.95), vec3(0.8, 0.9, 0.8), vTall), gTip, smoothstep(0.0, 1.0, vGr.x));
          gc = mix(gc, vec3(0.42, 0.34, 0.15) * (0.6 + 0.6 * vGr.x), clamp(vGr.z, 0.0, 1.0) * 0.7);
          // a paler midrib and darker margins
          gc *= mix(0.95, 0.8, vTall) + mix(0.1, 0.3, vTall) * smoothstep(0.5, 0.0, abs(vSide));
          diffuseColor.rgb = gc;`,
        preLight: 'vec3 hSunT = vec3(0.0);',
        light: /* glsl */ `
          {
            // the base of the field sits in its own shade; light passes through the blades from behind
            float gAo = mix(mix(0.88, 0.6, vTall), 1.0, smoothstep(0.0, 0.8, vGr.x));
            irradiance *= gAo;
            reflectedLight.directDiffuse *= mix(mix(0.92, 0.75, vTall), 1.0, vGr.x);
            reflectedLight.indirectSpecular *= 0.25 * gAo;
            vec3 hV = normalize(cameraPosition - vHWP);
            float hBack = pow(max(dot(-hV, uSunDir), 0.0), 3.0);
            reflectedLight.directDiffuse += diffuseColor.rgb * vec3(1.0, 1.15, 0.5) * hSunT * (0.25 + 1.2 * hBack) * vGr.x * 0.3183;
          }`,
      },
      onShader: (sh) => {
        // a blade's normal leans on the ground's: three flips it on back faces, which would point it into the
        // ground and leave half the field black. Flip it back.
        sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n\tnormal *= faceDirection;');
        const fs = sh.fragmentShader;
        const a = fs.indexOf('directionalLight = directionalLights[ i ];');
        if (a < 0) return;
        const b = fs.indexOf('RE_Direct(', a);
        sh.fragmentShader = fs.slice(0, b) + 'hSunT = directLight.color;\n\t\t' + fs.slice(b);
      },
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.name = 'grass' + ri;
    group.add(mesh);
    return { ring, geo, tiles, mesh };
  });

  const frustum = new THREE.Frustum();
  const m4 = new THREE.Matrix4();
  const box = new THREE.Box3();
  function update(camera, hf, veg) {
    m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(m4);
    const cx = camera.position.x, cz = camera.position.z;
    for (const R of rings) {
      const { patch: P, radius } = R.ring;
      // grass is not drawn when the camera is far above it
      const ground = Math.max(hf.heightAt(cx, cz), 0);
      if (camera.position.y - ground > radius) { R.geo.instanceCount = 0; R.mesh.visible = false; continue; }
      const i0 = Math.floor((cx - radius) / P), i1 = Math.floor((cx + radius) / P);
      const j0 = Math.floor((cz - radius) / P), j1 = Math.floor((cz + radius) / P);
      const a = R.tiles.array;
      let n = 0;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x0 = i * P, z0 = j * P;
        const dx = Math.max(x0 - cx, 0, cx - x0 - P), dz = Math.max(z0 - cz, 0, cz - z0 - P);
        if (dx * dx + dz * dz > radius * radius) continue;
        // skip patches with no grass anywhere near them
        let g = 0, ymin = 1e9, ymax = -1e9;
        for (let b = 0; b <= 2; b++) for (let c = 0; c <= 2; c++) {
          const x = x0 + (c * P) / 2, z = z0 + (b * P) / 2;
          g = Math.max(g, veg.at(veg.grass, x, z), veg.at(veg.palm, x, z) * 0.35);
          const y = hf.heightAt(x, z);
          ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
        }
        if (g < 0.02 || ymax < 0.9) continue;
        box.min.set(x0 - 1, ymin - 1, z0 - 1);
        box.max.set(x0 + P + 1, ymax + 2, z0 + P + 1);
        if (!frustum.intersectsBox(box)) continue;
        a[n * 3] = x0; a[n * 3 + 1] = z0; a[n * 3 + 2] = 0;
        n++;
      }
      R.geo.instanceCount = n;
      R.mesh.visible = n > 0;
      R.tiles.clearUpdateRanges();
      R.tiles.addUpdateRange(0, n * 3);
      R.tiles.needsUpdate = true;
    }
  }
  return {
    group,
    update,
    player,
    stats: () => rings.map((R) => R.geo.instanceCount),
  };
}
