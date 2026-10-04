// Where every built thing stands, in x/z only, deterministic. Heights are resolved at runtime against the heightfield,
// and the vegetation map clears the footprints, so houses never sit inside a tree.
import { ROAD, PIER, BAR, BUNGALOW_ARC, LIGHTHOUSE } from './layout.js';

const rng = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// point and unit tangent at arc length s along a polyline
export function along(pts, s) {
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
    const l = Math.hypot(bx - ax, bz - az);
    if (s <= l || i === pts.length - 1) {
      const t = Math.min(s / l, 1);
      return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, tx: (bx - ax) / l, tz: (bz - az) / l };
    }
    s -= l;
  }
}
export const polyLength = (pts) => pts.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);

function buildPlan() {
  const r = rng(20261002);
  const houses = [];
  const lamps = [];
  const L = polyLength(ROAD);
  // the street: houses on both sides, the seaward row looking at the lagoon, the inland row at the road
  for (const side of [-1, 1]) {
    let s = 14 + r() * 8;
    while (s < L - 10) {
      const p = along(ROAD, s);
      const nx = -p.tz, nz = p.tx; // points seaward (+z) along this road
      const gap = (x) => Math.abs(x - PIER.x) < 15 || (side > 0 && (Math.abs(x - BAR.x) < 17 || Math.abs(x - BUNGALOW_ARC.cx) < 13));
      if (!gap(p.x)) {
        const kind = side > 0 ? (r() < 0.75 ? 'house' : 'hut') : r() < 0.5 ? 'house' : 'hut';
        const off = side > 0 ? 14.5 + r() * 2.5 : 15 + r() * 7;
        const x = p.x + nx * off * side, z = p.z + nz * off * side;
        // models face +z; seaward houses look out, inland ones turn to the road
        const face = Math.atan2(nx, nz) + (side > 0 ? 0 : Math.PI);
        houses.push({ kind, x, z, yaw: face + (r() - 0.5) * 0.3, s: kind === 'hut' ? 0.9 + r() * 0.25 : 0.85 + r() * 0.2, r: kind === 'hut' ? 5 : 6.5 });
      }
      s += 21 + r() * 8;
    }
  }
  // porch lights on about half the houses, beside the door
  houses.forEach((h) => {
    if (r() < 0.5) return;
    const d = h.r * h.s * 0.85, side = r() < 0.5 ? -1 : 1;
    lamps.push({ x: h.x + Math.sin(h.yaw) * d + Math.cos(h.yaw) * side * 1.6, z: h.z + Math.cos(h.yaw) * d - Math.sin(h.yaw) * side * 1.6, kind: 'porch', y: h.kind === 'hut' ? 2.1 : 3.9 });
  });
  // street lamps every ~45 m, alternating sides, a little off the road edge
  for (let s = 20, i = 0; s < L - 5; s += 42 + r() * 8, i++) {
    const p = along(ROAD, s);
    const side = i % 2 ? 1 : -1;
    lamps.push({ x: p.x - p.tz * 3.2 * side, z: p.z + p.tx * 3.2 * side, kind: 'post' });
  }

  // pier lamps: alternate sides every 30 m, a pair at the head
  const pier = { ...PIER, lamps: [] };
  for (let z = PIER.z0 + 28, i = 0; z < PIER.z1 - 12; z += 30, i++) pier.lamps.push({ x: PIER.x + (i % 2 ? 1 : -1) * (PIER.w / 2 - 0.15), z });
  pier.lamps.push({ x: PIER.x - PIER.headW / 2 + 0.4, z: PIER.z1 - 0.4 }, { x: PIER.x + PIER.headW / 2 - 0.4, z: PIER.z1 - 0.4 });

  // overwater bungalows on spurs off the curved walk
  const A = BUNGALOW_ARC;
  const bungalows = [];
  for (let i = 0; i < A.n; i++) {
    const a = ((A.a0 + ((A.a1 - A.a0) * i) / (A.n - 1)) * Math.PI) / 180;
    const dx = Math.cos(a), dz = Math.sin(a);
    bungalows.push({ x: A.cx + dx * A.rb, z: A.cz + dz * A.rb, yaw: Math.atan2(dx, dz), spur: [[A.cx + dx * A.r, A.cz + dz * A.r], [A.cx + dx * (A.rb - 5.5), A.cz + dz * (A.rb - 5.5)]] });
  }
  const arc = [];
  for (let i = 0; i <= 28; i++) {
    const a = ((A.a0 + ((A.a1 - A.a0) * i) / 28) * Math.PI) / 180;
    arc.push([A.cx + Math.cos(a) * A.r, A.cz + Math.sin(a) * A.r]);
  }
  const walk = { spine: [[A.cx, 372.5], [A.cx, A.cz + A.r]], arc, w: 2.4, deck: 2.0 };
  bungalows.forEach((b, i) => i % 2 === 0 && lamps.push({ x: (b.spur[0][0] + b.spur[1][0]) / 2, z: (b.spur[0][1] + b.spur[1][1]) / 2, kind: 'walk' }));

  // the beach bar's terrace: string-light poles in front, toward the water
  const bar = { ...BAR, poles: [[-7.5, 7], [7.5, 7], [-5, 13.5], [5, 13.5]].map(([dx, dz]) => ({ x: BAR.x + dx, z: BAR.z + dz })) };

  // boats: work boats pulled up on the sand, the dhow moored at the pier head
  const boats = [
    { kind: 'skiff', x: 140, z: 383, yaw: 2.9, beached: true },
    { kind: 'dinghy', x: 206, z: 385, yaw: 3.3, beached: true },
    { kind: 'rowboat', x: 236, z: 384, yaw: 3.05, beached: true },
    { kind: 'rowboat', x: 118, z: 380, yaw: 1.4, beached: true },
    { kind: 'dinghy', x: 121.8, z: 381, yaw: 1.55, beached: true },
    { kind: 'skiff', x: 74, z: 381, yaw: 1.7, beached: true },
    { kind: 'dhow', x: PIER.x - PIER.headW / 2 - 3.2, z: PIER.z1 - 4, yaw: 0.05, beached: false },
  ];

  const light = { ...LIGHTHOUSE };
  const footprints = [
    ...houses.map((h) => ({ x: h.x, z: h.z, r: h.r * h.s })),
    { x: BAR.x, z: BAR.z, r: 9 },
    { x: light.x, z: light.z, r: 9 },
    ...bar.poles.map((p) => ({ x: p.x, z: p.z, r: 1.5 })),
  ];
  return { houses, lamps, pier, bungalows, walk, bar, boats, light, footprints };
}

export const PLAN = buildPlan();
