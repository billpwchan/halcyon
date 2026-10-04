import * as THREE from 'three';
import { U } from './core/shared.js';
import { Pipeline } from './core/pipeline.js';
import { fs } from './core/gpu.js';
import { loadTextures, loadArray } from './core/assets.js';
import { Heightfield } from './world/heightfield.js';
import { buildVegMap } from './world/vegmap.js';
import { loadMassif } from './world/massif.js';
import { createTerrain, LAYERS } from './world/terrain.js';
import { Sky } from './world/sky.js';
import { OceanSim } from './world/oceansim.js';
import { createOcean, Ripples } from './world/ocean.js';
import { Environment } from './env/environment.js';
import { createVegetation } from './veg/vegetation.js';
import { createGrass } from './veg/grass.js';
import { createBuilt } from './world/built.js';
import { createParticles } from './life/particles.js';
import { createFireflies } from './life/fireflies.js';
import { createFish } from './life/fish.js';
import { createCoral } from './world/coral.js';
import { createFauna } from './life/fauna.js';
import { createPlayer } from './player/player.js';
import { initModels, streamHd } from './core/models.js';
import { createUI, bootProgress } from './ui/ui.js';
import { createAudio } from './audio/audio.js';

const params = new URLSearchParams(location.search);

async function boot() {
  const canvas = document.getElementById('c');
  const pipe = new Pipeline(canvas);
  const renderer = pipe.renderer;
  initModels(renderer);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.15, 40000);
  const t0 = performance.now();
  // a clone without the asset bundle says how to get it, instead of failing somewhere in the middle of the boot
  // the Accept header keeps the Vite dev server from answering a missing file with index.html
  const probe = await fetch('./assets/models/massif_h.json', { method: 'HEAD', headers: { Accept: 'application/json' } });
  if (!probe.ok || !(probe.headers.get('content-type') || '').includes('json')) {
    await bootProgress(0, 'Assets missing: run npm run assets, then reload');
    return;
  }
  await bootProgress(0.06, 'Raising the reef');

  const [tex, layC, layN] = await Promise.all([
    loadTextures(renderer),
    // the ground is seen from a walker's eye: 2K layers on desktop, 1K where memory is tight
    loadArray(LAYERS, 'c', matchMedia('(pointer: coarse)').matches ? 1024 : 2048),
    loadArray(LAYERS, 'n', matchMedia('(pointer: coarse)').matches ? 1024 : 2048),
  ]);
  const tTex = performance.now();
  await bootProgress(0.3, 'Shaping the island');
  const hf = new Heightfield(renderer);
  hf.generate(await loadMassif());
  U.tHeight.value = hf.tHeight;
  U.tCoast.value = hf.tCoast;
  U.tHorizon.value = hf.rtHorizon.texture;
  U.tWeather.value = hf.tWeather;
  const tGen = performance.now();
  const veg = buildVegMap(hf);
  U.tVegMap.value = veg.tex;
  const tVeg = performance.now();

  await bootProgress(0.42, 'Filling the lagoon');
  const sky = new Sky(renderer);
  scene.add(sky.mesh);
  const terrain = createTerrain(hf, veg.tex, layC, layN);
  scene.add(terrain.mesh);
  const oceanSim = new OceanSim(renderer);
  const ripples = new Ripples(renderer);
  const ocean = createOcean(renderer, oceanSim, ripples);
  scene.add(ocean.mesh);
  console.log(`[ha] tex ${(tTex - t0) | 0}ms gen ${(tGen - tTex) | 0}ms veg ${(tVeg - tGen) | 0}ms`);
  await bootProgress(0.55, 'Growing forty thousand plants');
  const mobile = matchMedia('(pointer: coarse)').matches;
  const density = params.has('veg') ? +params.get('veg') : 1;
  const plants = density > 0 ? await createVegetation(renderer, hf, veg, tex, { mobile, density, gallery: params.has('gallery') ? { x: +params.get('gallery').split(',')[0], z: +params.get('gallery').split(',')[1] } : null }) : { group: new THREE.Group(), update() {} };
  scene.add(plants.group);
  const grass = createGrass(layC);
  if (density > 0) scene.add(grass.group);
  await bootProgress(0.75, 'Building the village');
  const tB = performance.now();
  const built = await createBuilt(renderer, hf, tex);
  scene.add(built.group, built.fx);
  console.log(`[ha] built ${(performance.now() - tB) | 0}ms`);
  await bootProgress(0.86, 'Waking the whales');
  const tF = performance.now();
  const particles = createParticles();
  const fireflies = createFireflies(hf);
  scene.add(fireflies.mesh);
  scene.add(particles.mesh);
  const [fish, fauna, coral] = await Promise.all([createFish(hf), createFauna(hf, particles), createCoral(hf)]);
  scene.add(fish.group, fauna.group, coral.group);
  console.log(`[ha] life ${(performance.now() - tF) | 0}ms, ${fish.sites.length} fish schools`);

  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -80; sc.right = 80; sc.top = 80; sc.bottom = -80; sc.near = 1; sc.far = 900;
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.05;
  scene.add(sun, sun.target);

  const env = new Environment();
  if (params.has('h')) { env.setHours(parseFloat(params.get('h'))); env.auto = params.has('run'); }
  if (params.has('w')) { env.setWeather(params.get('w'), true); env.autoWeather = false; }
  env.update(0);

  pipe.onResize = (W, H) => sky.setSize(W, H);
  const resize = () => {
    pipe.resize();
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  if (params.has('scale')) { pipe.scale = +params.get('scale'); pipe.lockScale = true; }
  resize();

  // ---------------------------------------------------------------- the player
  const cam = params.get('cam')?.split(',').map(Number) || [168, 6, 700];
  const look = params.get('look')?.split(',').map(Number) || [0, 60, 0];
  camera.position.set(cam[0], cam[1], cam[2]);
  camera.lookAt(look[0], look[1], look[2]);
  camera.updateMatrixWorld();
  const player = await createPlayer({ camera, canvas, hf, ripples, particles, built, coral });
  scene.add(player.boatMesh);
  const audio = createAudio({ env, player, camera, hf, fauna });
  const ui = createUI({ env, player, camera, audio, onEnter: () => { audio.start(); player.tour.speed = 1; } });
  if (params.has('noui')) document.getElementById('ui').style.display = 'none';
  // straight in for links that place the camera, and for tests; otherwise the tour drifts behind the title
  if (params.has('cam') || params.has('auto')) { ui.enter(); }
  else {
    // the title plays over first light; entering, the day begins
    if (!params.has('h')) env.setHours(5.85);
    player.setMode('tour'); player.tour.speed = 0.55;
  }
  // every material compiled while the title is still up: a coral, a boat or a fish level met for the first time later
  // would otherwise stall the frame that shows it. Compiled against the opaque target, so the variants (linear output,
  // no tone mapping) are the ones the frames use.
  await bootProgress(0.95, 'Mixing the colours');
  const tC = performance.now();
  renderer.setRenderTarget(pipe.rtOpaque);
  await renderer.compileAsync(scene, camera);
  renderer.setRenderTarget(null);
  // and every texture they sample goes up to the GPU now: a map first met mid-flight is decoded, uploaded and
  // mipmapped inside the frame that draws it (50-80 ms for a 2K image). The shader uniforms hold the patched
  // materials' own textures.
  const maps = new Set();
  const take = (v) => { if (v?.isTexture && !v.isRenderTargetTexture && v.version > 0) maps.add(v); };
  scene.traverse((o) => {
    for (const m of o.material ? [o.material].flat() : []) {
      for (const v of Object.values(m)) take(v);
      for (const u of Object.values(renderer.properties.get(m).uniforms || m.uniforms || {})) take(u?.value);
    }
  });
  for (const t of maps) renderer.initTexture(t);
  console.log(`[ha] shaders ${(performance.now() - tC) | 0}ms, ${renderer.info.programs.length} programs, ${maps.size} maps`);
  bootProgress(1, 'Ready');
  setTimeout(() => ui.ready(), 300);

  let last = performance.now();
  let time = 0;
  const cpu = { frame: 0, render: 0 };
  function frame(now) {
    requestAnimationFrame(frame);
    const c0 = performance.now();
    const dtMs = Math.min(now - last, 100);
    last = now;
    const dt = dtMs / 1000;
    time += dt;
    pipe.govern(dtMs);
    U.uTime.value = time;
    env.update(dt);

    player.update(dt);
    ui.update(dt);
    audio.update(dt);
    // near plane rides with altitude: depth precision where it is needed, from the beach to the clouds
    const alt = camera.position.y - Math.max(hf.heightAt(camera.position.x, camera.position.z), 0);
    const near = Math.min(Math.max(Math.abs(alt) * 0.012, 0.1), 25);
    if (Math.abs(near - camera.near) > camera.near * 0.1) { camera.near = near; camera.updateProjectionMatrix(); }
    camera.updateMatrixWorld();
    U.uCamUnder.value = camera.position.y < 0 ? 1 : 0;

    // shadow box follows the camera, snapped to shadow texels
    const L = U.uSunDir.value;
    const step = 160 / 2048;
    const tx = Math.round(camera.position.x / step) * step, tz = Math.round(camera.position.z / step) * step;
    sun.target.position.set(tx, 0, tz);
    sun.position.set(tx + L.x * 400, L.y * 400, tz + L.z * 400);
    sun.color.setRGB(U.uSunCol.value.x, U.uSunCol.value.y, U.uSunCol.value.z, THREE.LinearSRGBColorSpace);
    sun.target.updateMatrixWorld();
    sky.setLight(env.cloudDir, env.cloudCol, env.cloudAmb);
    sky.domeMat.uniforms.uMoonPhase.value = env.moonPhase;
    sky.domeMat.uniforms.uRainbow.value = env.rainbow;
    sky.domeMat.uniforms.uCirrus.value = env.cur.cirrus;

    plants.update(camera, sun.target.position);
    grass.update(camera, hf, veg);
    built.update(camera, dt, env);
    fauna.update(camera, dt);
    fish.update(camera);
    coral.update(camera);
    streamHd(scene, camera, time);
    particles.update(dt, camera);
    fireflies.update();
    terrain.update(camera);
    ocean.update(camera, pipe);
    const c1 = performance.now();
    pipe.render(scene, camera, { sky, ocean, oceanSim, ripples, hf }, {
      dt, shaftK: 0.6 * (1 - env.night), under: camera.position.y < 0, exposure: env.exposure, nightK: env.night,
      forceSky: time < 0.5, forceHorizon: time < 0.5, sun,
    });
    const c2 = performance.now();
    cpu.frame += (c2 - c0 - cpu.frame) * 0.05;
    cpu.render += (c2 - c1 - cpu.render) * 0.05;
  }
  requestAnimationFrame(frame);
  window.__ha = { cpu, THREE, fs, pipe, env, camera, hf, terrain, ocean, oceanSim, sky, veg, plants, grass, built, fauna, fish, coral, particles, player, ui, audio, scene, U };
}

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;left:12px;bottom:12px;color:#f88;font:12px monospace;z-index:9">${e.stack || e}</pre>`);
});
