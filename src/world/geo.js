// Small procedural geometry: boxes and cylinders accumulated into one indexed geometry, UVs in metres.
import * as THREE from 'three';

export class Builder {
  constructor() {
    this.p = [];
    this.n = [];
    this.uv = [];
    this.c = [];
    this.idx = [];
  }
  vert(p, n, u, v, c) {
    this.p.push(p[0], p[1], p[2]);
    this.n.push(n[0], n[1], n[2]);
    this.uv.push(u, v);
    this.c.push(c[0], c[1], c[2]);
    return this.p.length / 3 - 1;
  }
  // box centred at (cx, cy, cz), size (sx, sy, sz), turned by yaw about y; uv offset per box for variety
  box(cx, cy, cz, sx, sy, sz, yaw = 0, col = [1, 1, 1], uvs = 0.5, uo = [0, 0], pitch = 0) {
    const cy_ = Math.cos(yaw), sy_ = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    // local x right, y up, z forward; pitch tilts about local x
    const tr = (x, y, z) => {
      const y1 = y * cp - z * sp, z1 = y * sp + z * cp;
      return [cx + x * cy_ + z1 * sy_, cy + y1, cz - x * sy_ + z1 * cy_];
    };
    const rn = (x, y, z) => {
      const y1 = y * cp - z * sp, z1 = y * sp + z * cp;
      return [x * cy_ + z1 * sy_, y1, -x * sy_ + z1 * cy_];
    };
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    // faces: normal, then two axes spanning it (u, v) with their half extents
    const F = [
      [[1, 0, 0], [0, 0, -1], hz, [0, 1, 0], hy, hx],
      [[-1, 0, 0], [0, 0, 1], hz, [0, 1, 0], hy, hx],
      [[0, 1, 0], [1, 0, 0], hx, [0, 0, -1], hz, hy],
      [[0, -1, 0], [1, 0, 0], hx, [0, 0, 1], hz, hy],
      [[0, 0, 1], [1, 0, 0], hx, [0, 1, 0], hy, hz],
      [[0, 0, -1], [-1, 0, 0], hx, [0, 1, 0], hy, hz],
    ];
    for (const [n, a, ha, b, hb, hn] of F) {
      const base = [];
      for (const [i, j] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const lx = n[0] * hn + a[0] * ha * i + b[0] * hb * j;
        const ly = n[1] * hn + a[1] * ha * i + b[1] * hb * j;
        const lz = n[2] * hn + a[2] * ha * i + b[2] * hb * j;
        // the longer axis of the face runs along u, so planks take the grain lengthwise
        const long = ha >= hb;
        const u = (long ? ha * i : hb * j) * uvs + uo[0], v = (long ? hb * j : ha * i) * uvs + uo[1];
        base.push(this.vert(tr(lx, ly, lz), rn(n[0], n[1], n[2]), u, v, col));
      }
      this.idx.push(base[0], base[1], base[2], base[0], base[2], base[3]);
    }
  }
  // cylinder between two points
  cyl(a, b, r, seg = 8, col = [1, 1, 1], uvs = 0.5, r1 = r) {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
    const ax = B.clone().sub(A);
    const len = ax.length();
    ax.normalize();
    const t = Math.abs(ax.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(ax, t).normalize(), w = new THREE.Vector3().crossVectors(ax, u);
    const start = this.p.length / 3;
    for (let i = 0; i <= seg; i++) {
      const th = (i / seg) * Math.PI * 2;
      const n = u.clone().multiplyScalar(Math.cos(th)).addScaledVector(w, Math.sin(th));
      this.vert(A.clone().addScaledVector(n, r).toArray(), n.toArray(), (i / seg) * Math.PI * 2 * r * uvs * 2, 0, col);
      this.vert(B.clone().addScaledVector(n, r1).toArray(), n.toArray(), (i / seg) * Math.PI * 2 * r * uvs * 2, len * uvs, col);
    }
    for (let i = 0; i < seg; i++) {
      const k = start + i * 2;
      this.idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}
