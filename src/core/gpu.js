// Small helpers for fullscreen shader passes and render targets.
import * as THREE from 'three';

export const FS_VERT = /* glsl */ `
  varying vec2 vUv;
  void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

export class FullScreen {
  constructor() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.mesh = new THREE.Mesh(geo, null);
    this.mesh.frustumCulled = false;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  render(renderer, material, target) {
    this.mesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.mesh, this.camera);
  }
}

export const fs = new FullScreen();

export function pass(frag, uniforms = {}, opts = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: FS_VERT,
    fragmentShader: frag,
    uniforms,
    depthTest: false,
    depthWrite: false,
    glslVersion: opts.glsl3 ? THREE.GLSL3 : null,
    ...opts.extra,
  });
}

export function rt(w, h, o = {}) {
  const t = new THREE.WebGLRenderTarget(w, h, {
    type: o.type ?? THREE.HalfFloatType,
    format: o.format ?? THREE.RGBAFormat,
    depthBuffer: o.depth ?? false,
    minFilter: o.min ?? THREE.LinearFilter,
    magFilter: o.mag ?? THREE.LinearFilter,
    wrapS: o.wrap ?? THREE.ClampToEdgeWrapping,
    wrapT: o.wrapT ?? o.wrap ?? THREE.ClampToEdgeWrapping,
    generateMipmaps: o.mips ?? false,
    count: o.count ?? 1,
    samples: o.samples ?? 0,
  });
  return t;
}

// read a float RGBA target back to the CPU in horizontal strips, so no single call stalls for long
export function readFloat(renderer, target, w, h) {
  const out = new Float32Array(w * h * 4);
  const strip = Math.max(1, Math.floor(262144 / w));
  for (let y = 0; y < h; y += strip) {
    const n = Math.min(strip, h - y);
    const buf = new Float32Array(w * n * 4);
    renderer.readRenderTargetPixels(target, 0, y, w, n, buf);
    out.set(buf, y * w * 4);
  }
  return out;
}
