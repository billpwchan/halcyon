// Frame orchestration: sky + clouds -> shadow -> opaque (MSAA HDR) -> resolve with depth -> water -> effects -> post.
// Owns the render scale and the frame-time governor.
import * as THREE from 'three';
import { Post } from './post.js';
import { fs, pass, rt } from './gpu.js';
import { U } from './shared.js';
import { AmbientOcclusion } from './ao.js';
import { LAYER_WATER } from '../world/ocean.js';

export const LAYER_FX = 2; // transparent effects drawn after the water

export class Pipeline {
  constructor(canvas) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, depth: true, alpha: false, preserveDrawingBuffer: false });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.autoClear = false;
    renderer.info.autoReset = false;
    renderer.setPixelRatio(1);
    this.renderer = renderer;
    this.canvas = canvas;

    this.makeTargets(4, 4);
    // stands in for last frame's depth on the frame after the targets are rebuilt: "nothing covers the sky"
    this.farDepth = new THREE.DataTexture(new Float32Array([1, 1, 1, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    this.farDepth.needsUpdate = true;
    this.post = new Post(renderer);

    this.ao = new AmbientOcclusion();
    this.aoOn = !matchMedia('(pointer: coarse)').matches;
    this.white = new THREE.DataTexture(new Float32Array([1, 1e5, 0, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    this.white.needsUpdate = true;
    this.copyMat = new THREE.ShaderMaterial({
      uniforms: { tColor: { value: null }, tDepth: { value: null }, tAO: { value: this.white }, uAOTexel: { value: new THREE.Vector2(1, 1) }, uNearFar: { value: new THREE.Vector2(0.1, 1000) }, uAOOn: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `precision highp float; uniform sampler2D tColor, tDepth, tAO; uniform vec2 uAOTexel, uNearFar; uniform float uAOOn; varying vec2 vUv;
        void main(){ vec4 c = texture2D(tColor, vUv);
          // a single Inf or NaN would spread across the whole frame through the bloom chain
          c.rgb = (any(isnan(c.rgb)) || any(isinf(c.rgb))) ? vec3(0.0) : clamp(c.rgb, 0.0, 6e4);
          float z = texture2D(tDepth, vUv).x;
          if (uAOOn > 0.5 && z < 1.0) {
            // upsampled from half resolution by depth, so occlusion stays on its own side of every silhouette
            float n = uNearFar.x, f = uNearFar.y;
            float d = 2.0 * n * f / (f + n - (z * 2.0 - 1.0) * (f - n));
            vec2 hp = vUv / uAOTexel - 0.5, b = floor(hp), t = hp - b;
            float acc = 0.0, w = 0.0, best = 1.0, bd = 1e9;
            for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
              vec2 s = texture2D(tAO, (b + vec2(i, j) + 0.5) * uAOTexel).rg;
              float bw = (i == 0 ? 1.0 - t.x : t.x) * (j == 0 ? 1.0 - t.y : t.y);
              float dd = abs(s.g - d);
              float k = bw * max(0.0, 1.0 - dd / (d * 0.04 + 0.04)) + 1e-5 * bw;
              acc += s.r * k; w += k;
              if (dd < bd) { bd = dd; best = s.r; }
            }
            c.rgb *= w > 1e-3 ? acc / w : best;
          }
          gl_FragColor = c; gl_FragDepth = z; }`,
      depthTest: true,
      depthWrite: true,
      depthFunc: THREE.AlwaysDepth,
    });

    // animated caustics, tiling, one small pass per frame
    this.rtCaustics = rt(512, 512, { type: THREE.UnsignedByteType, wrap: THREE.RepeatWrapping, mips: true, min: THREE.LinearMipmapLinearFilter });
    this.causticsMat = pass(/* glsl */ `
      precision highp float; varying vec2 vUv; uniform float uTime;
      void main(){
        const float TAU = 6.28318530718;
        vec2 p = mod(vUv * TAU, TAU) - 250.0;
        vec2 i = p; float c = 1.0; float inten = 0.005;
        for (int n = 0; n < 5; n++){
          float t = uTime * (1.0 - (3.5 / float(n + 1)));
          i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
          c += 1.0 / length(vec2(p.x / (sin(i.x + t) / inten), p.y / (cos(i.y + t) / inten)));
        }
        c /= 5.0;
        c = 1.17 - pow(c, 1.4);
        float v = pow(abs(c), 8.0);
        gl_FragColor = vec4(vec3(clamp(v, 0.0, 1.0)), 1.0);
      }`, { uTime: { value: 0 } });
    U.tCaustics.value = this.rtCaustics.texture;

    this.scale = 1;
    this.maxScale = 1;
    this.minScale = 0.45;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.frameTimes = new Float32Array(90);
    this.ftIdx = 0;
    this.ftCount = 0;
    this.cooldown = 2;
    this.lockScale = false;
    this.probeWait = 2;
    this.preProbe = 1;
    this.probing = false;
    this.step = 1.1; // how far the next probe reaches; halves after each failure
    this.settle = 0;
    this.settleRun = 0;
    this.clean = 0;
    this.lastProbe = -1e9;
    this.trialFrom = 0;
    this.missHold = 0;
    this.sFrames = this.sMisses = 0;
    this.settleLen = 0;
    this.trialMiss = 0;
    this.holdScale = 0;
    this.holdFor = 20;
    this.clock = 0;
    this._sorted = new Float32Array(90);
    this.frame = 0;
    this.sunUv = new THREE.Vector2();
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.cssW = w; this.cssH = h;
    this.renderer.setSize(Math.round(w * this.dpr), Math.round(h * this.dpr), false);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.applyScale();
  }

  // Targets with depth textures are rebuilt rather than resized: a resized depth texture that gets sampled before
  // its framebuffer is set up again leaves that framebuffer incomplete, and every later frame renders black.
  makeTargets(W, H) {
    for (const t of [this.rtOpaque, this.rtMain]) if (t) { t.depthTexture.dispose(); t.dispose(); }
    const depthA = new THREE.DepthTexture(W, H);
    depthA.type = THREE.UnsignedIntType;
    this.rtOpaque = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: 4, depthBuffer: true, depthTexture: depthA, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    const depthB = new THREE.DepthTexture(W, H);
    depthB.type = THREE.UnsignedIntType;
    this.rtMain = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: true, depthTexture: depthB, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    this.mainFresh = true;
  }

  applyScale() {
    const W = Math.max(2, Math.round(this.cssW * this.dpr * this.scale));
    const H = Math.max(2, Math.round(this.cssH * this.dpr * this.scale));
    if (W === this.W && H === this.H) return;
    this.W = W; this.H = H;
    this.makeTargets(W, H);
    this.post.setSize(W, H);
    this.ao.setSize(W, H);
    this.copyMat.uniforms.uAOTexel.value.set(1 / Math.ceil(W / 2), 1 / Math.ceil(H / 2));
    this.onResize?.(W, H);
  }

  // Under vsync every frame reads as the refresh interval however much headroom the GPU has, so the scale steps
  // down on missed frames and, after a run of clean ones, probes back up; a failed probe returns to where it was,
  // halves its next step and doubles its wait. A step down for a trickle of misses alone (most frames on time) is a
  // trial: unless the next window comes out all but clean, they were never about pixels (a stall, the GPU's own
  // clocking, the step's own rebuilt targets), so the scale goes back and a trickle is ignored for a while, longer
  // after each such trial.
  govern(dtMs) {
    if (this.lockScale) return;
    this.clock += dtMs / 1000;
    // reallocating the targets stalls a few frames; those say nothing about the new scale, so they are not counted.
    // Counting starts after a run of clean frames. A probe that cannot produce that run within its settle time has
    // already failed; any other change just starts counting when the time runs out
    if (this.settle > 0) {
      this.settle -= dtMs / 1000;
      this.settleRun = dtMs < 19.5 ? this.settleRun + 1 : 0;
      // a third of the frames late once the reallocation stall has passed: this scale is still too much, and sitting out
      // the rest of the settle time and then a full window would only prolong the stutter
      if (this.settleLen - this.settle > 0.5) { this.sFrames++; if (dtMs > 21) this.sMisses++; }
      if (this.sFrames >= 24 && this.sMisses > this.sFrames * 0.35) {
        if (this.probing) return this.probeFailed();
        this.trialFrom = 0;
        this.setScale(this.scale * 0.88);
        return;
      }
      if (this.settleRun < 15) {
        if (this.settle <= 0 && this.probing) this.probeFailed();
        return;
      }
      this.settle = 0;
    }
    this.frameTimes[this.ftIdx] = dtMs;
    this.ftIdx = (this.ftIdx + 1) % this.frameTimes.length;
    this.ftCount = Math.min(this.ftCount + 1, this.frameTimes.length);
    this.cooldown -= dtMs / 1000;
    if (this.ftCount < 45) return;
    const n = this.ftCount;
    const arr = this._sorted.subarray(0, n);
    arr.set(this.frameTimes.subarray(0, n));
    arr.sort();
    // a GPU short of time for this many pixels misses most frames under vsync, not a few: a quarter of the window late
    // is too slow; a trickle (more than 3%) still reads as stutter, and is tried against a step down
    const p75 = arr[Math.floor(n * 0.75)];
    let misses = 0;
    for (let i = n - 1; i >= 0 && arr[i] > 21; i--) misses++;
    // the target is 60 fps whatever the display; rAF timestamps jitter by a couple of ms around 16.7
    // a hold (below) is for stutter a lower scale did not cure. A tenth of the frames late anywhere but the scale that
    // set the hold is worth a try regardless; at that scale it would only repeat the failed step
    const heavy = misses > n * 0.1 && Math.abs(this.scale - this.holdScale) > 0.005;
    const slow = p75 > 19.5, trickle = misses > n * 0.03 && (this.clock > this.missHold || heavy);
    const over = slow || trickle;
    this.clean = dtMs > 21 ? 0 : this.clean + dtMs / 1000;
    if (this.cooldown > 0) return;
    if (this.probing) {
      // the first full window after a probe decides it
      if (over) return this.probeFailed();
      this.probing = false;
      this.step = 1.1;
    } else if (this.trialFrom) {
      // and the first full window after a trial step down decides that
      const from = this.trialFrom;
      this.trialFrom = 0;
      // the step down is undone only if it did not cut the misses: then they are not the GPU's
      if (!slow && misses > n * 0.015 && misses / n > this.trialMiss * 0.6) {
        this.missHold = this.clock + this.holdFor;
        this.holdScale = from;
        this.holdFor = Math.min(120, this.holdFor * 2);
        this.setScale(from);
      }
    } else if (slow) {
      this.setScale(this.scale * 0.88);
    } else if (trickle) {
      const from = this.scale;
      if (this.setScale(this.scale * 0.88)) { this.trialFrom = from; this.trialMiss = misses / n; }
    } else if (this.scale < this.maxScale && this.clean > this.probeWait && this.step > 1.015) {
      this.preProbe = this.scale;
      if (this.setScale(this.scale * this.step)) {
        this.probing = true;
        this.lastProbe = this.clock;
      }
    } else if (this.clock - this.lastProbe > 30) {
      // long enough at this scale that conditions may have changed: allow full-size probes again
      this.probeWait = Math.max(2, this.probeWait * 0.9);
      if (this.step < 1.1 && this.clock - this.lastProbe > 60) { this.step = 1.1; this.lastProbe = this.clock; }
    }
  }
  probeFailed() {
    this.probing = false;
    this.probeWait = Math.min(60, this.probeWait * 2);
    this.step = 1 + (this.step - 1) * 0.5;
    this.setScale(this.preProbe);
  }
  setScale(s) {
    const next = Math.min(this.maxScale, Math.max(this.minScale, s));
    if (Math.abs(next - this.scale) <= 0.005) return false;
    const down = next < this.scale;
    this.scale = next;
    this.applyScale();
    this.ftCount = 0;
    this.ftIdx = 0;
    this.clean = 0;
    this.settleRun = 0;
    this.sFrames = this.sMisses = 0;
    this.settle = this.settleLen = down ? 2.5 : 1.0;
    this.cooldown = down ? 1.0 : 1.5;
    return true;
  }

  // world: { sky, ocean, oceanSim, ripples, hf } ; opts: { dt, shaftK, under, drops, exposure, nightK }
  render(scene, camera, world, opts) {
    const r = this.renderer;
    r.info.reset();
    this.frame++;
    // per-frame simulation passes
    this.causticsMat.uniforms.uTime.value = U.uTime.value * 0.55;
    fs.render(r, this.causticsMat, this.rtCaustics);
    world.oceanSim.update(opts.dt, U.uSwell.value, opts.foamK ?? 1);
    world.ripples.update(opts.dt, camera.position.x, camera.position.z);
    world.hf.updateHorizon(U.uSunDir.value, opts.forceHorizon);
    world.sky.updatePanorama(camera, opts.forceSky);
    // visible clouds, skipping pixels covered by last frame's geometry
    world.sky.updateClouds(camera, this.mainFresh ? this.farDepth : this.rtMain.depthTexture);
    this.mainFresh = false;
    r.shadowMap.needsUpdate = true;

    // opaque world, multisampled
    camera.layers.mask = 1;
    r.setRenderTarget(this.rtOpaque);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
    r.render(scene, camera);

    // occlusion of the ambient light, from the opaque depth, applied in the resolve below
    const cmu = this.copyMat.uniforms;
    const aoTex = this.aoOn && opts.sun && !opts.under && opts.sun.shadow.map ? this.ao.render(r, this.rtOpaque.depthTexture, camera, opts.sun) : null;
    cmu.uAOOn.value = aoTex ? 1 : 0;
    cmu.tAO.value = aoTex || this.white;
    cmu.uNearFar.value.set(camera.near, camera.far);

    // resolve into the single-sample target with its depth; water and effects go on top
    this.copyMat.uniforms.tColor.value = this.rtOpaque.texture;
    this.copyMat.uniforms.tDepth.value = this.rtOpaque.depthTexture;
    r.setRenderTarget(this.rtMain);
    r.clear(true, true, false);
    fs.render(r, this.copyMat, this.rtMain);

    const ou = world.ocean.uniforms;
    ou.tScene.value = this.rtOpaque.texture;
    ou.tDepth.value = this.rtOpaque.depthTexture;
    ou.uRes.value.set(this.W, this.H);
    ou.uNearFar.value.set(camera.near, camera.far);
    camera.layers.mask = (1 << LAYER_WATER) | (1 << LAYER_FX);
    r.setRenderTarget(this.rtMain);
    r.render(scene, camera);
    camera.layers.mask = 1;

    // post
    const post = this.post;
    const bloom = post.bloom(this.rtMain);
    // the reference is a sunlit view at the time of day's own exposure; at night the eye opens up less
    post.adapt(opts.dt, 0.33 / opts.exposure, 2.1 - 0.9 * opts.nightK);
    const sd = U.uTrueSun.value;
    const sp = this._v.copy(sd).multiplyScalar(1000).add(camera.position).project(camera);
    const facing = sd.dot(camera.getWorldDirection(this._v2)) > 0 && sd.y > -0.05;
    const sunUv = this.sunUv.set(sp.x * 0.5 + 0.5, sp.y * 0.5 + 0.5);
    let shaftTex = post.mips[post.levels - 1].texture;
    const cu = post.composite.uniforms;
    if (facing && opts.shaftK > 0.01 && !opts.under) {
      shaftTex = post.shafts(this.rtMain.texture, this.rtMain.depthTexture, sunUv, this.W / this.H);
      cu.uShaft.value = opts.shaftK;
    } else cu.uShaft.value = opts.under ? opts.shaftK * 0.6 + 0.15 : 0;
    cu.uSunUv.value.copy(facing ? sunUv : this._v.set(-9, -9, 0));
    cu.uAspect.value = this.W / this.H;
    cu.uExposure.value = opts.exposure;
    cu.uNightK.value = opts.nightK;
    cu.uUnder.value = opts.under ? 1 : 0;
    cu.uNearFar.value.set(camera.near, camera.far);
    cu.uDrops.value = opts.drops || 0;
    cu.uTime.value = U.uTime.value;
    post.final(this.rtMain.texture, bloom, shaftTex, this.rtMain.depthTexture);
  }
}
