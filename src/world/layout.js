// The island plan, in metres. Water level is y = 0, north is -z, east is +x.
// Everything that has to agree between the GPU height generator, the CPU samplers and the placement code lives here.

export const HF = {
  size: 3600, // heightfield side, metres
  res: 2048, // texels per side
  origin: -1800, // world x/z of texel (0,0) corner
};
HF.texel = HF.size / HF.res;

// main island: union of rotated ellipses, carved by bays
export const LOBES = [
  // cx, cz, rx, rz, rot
  [0, 0, 560, 400, 0.15],
  [330, -130, 310, 230, -0.3],
  [-330, 70, 270, 250, 0.4],
  [110, 250, 290, 190, 0.0],
  [-120, -250, 300, 200, 0.2],
];
export const BAYS = [
  // cx, cz, rx, rz, rot  (subtracted)
  [195, 520, 230, 120, 0.05],
  [-150, -470, 150, 90, -0.2],
  [560, 120, 120, 90, 0.5],
];
// barrier reef ring
export const REEF = { cx: -40, cz: 70, rx: 1300, rz: 1110, half: 30 };
export const PASS = { a: (160 * Math.PI) / 180, half: (5.2 * Math.PI) / 180 };
// motus on the ring: angle from, angle to (deg), half width (m), crest height (m)
export const MOTUS = [
  [290, 334, 62, 2.4],
  [350, 384, 55, 2.1],
  [38, 74, 60, 2.3],
  [98, 118, 45, 1.9],
  [222, 256, 52, 2.2],
];

export const ringPoint = (a, rOff = 0) => {
  const nx = Math.cos(a), nz = Math.sin(a);
  return [REEF.cx + (REEF.rx + rOff) * nx, REEF.cz + (REEF.rz + rOff) * nz];
};

// Built places (metres). The beach runs east-west at z ≈ 395 in front of the village plain (z 260–350, about 3 m up).
// the mountain (scripts/massif.mjs): summit at x, z; turned by theta, scaled uniformly, baked over x0..x1, z0..z1
export const MASSIF = { x: -70, z: -150, theta: -2.7227, scale: 0.68, x0: -900, x1: 900, z0: -900, z1: 760 };

export const VILLAGE = { x: 190, z: 325, r: 160 };
export const ROAD = [[28, 344], [80, 337], [130, 334], [168, 336], [210, 339], [260, 335], [305, 338], [352, 347]];
export const PIER = { x: 168, z0: 369, z1: 598, w: 3.2, deck: 1.9, headW: 18, headD: 9 };
export const BAR = { x: 98, z: 364, yaw: 0 };
// overwater bungalows on a fan of spurs off a curved boardwalk; the spine leaves the beach at the arc centre
export const BUNGALOW_ARC = { cx: 310, cz: 388, r: 62, rb: 76, a0: 35, a1: 145, n: 6 };
// the pass light stands on its own basalt stack north of the pass
const lh = ringPoint((175 * Math.PI) / 180, 0);
export const LIGHTHOUSE = { x: lh[0], z: lh[1], top: 9.5 };

// footpaths, each a polyline of [x, z]; width in metres
export const PATHS = [
  // up the peak by switchbacks routed over the lidar relief (no stretch steeper than about 32 degrees), and a branch west
  { w: 2.4, pts: [[168, 336], [150, 310], [120, 294], [44, 218], [8, 218], [12, 210], [-84, 210], [-76, 206], [-84, 206], [-76, 202], [-88, 202], [-80, 198], [-112, 198], [-104, 194], [-112, 194], [-104, 186], [-116, 186], [-128, 178], [-120, 178], [-128, 174], [-116, 170], [-132, 158], [-124, 158], [-132, 154], [-128, 154], [-136, 142], [-128, 146], [-136, 130], [-116, 138], [-124, 126], [-116, 130], [-84, 126], [-96, 118], [-92, 114], [-100, 106], [-92, 98], [-104, 90], [-96, 86], [-84, 66], [-88, 70], [-92, 66], [-92, 50], [-88, 54], [-72, 46], [-56, 54], [-48, 50]] },
  { w: 2.2, pts: [[-128, 178], [-144, 178], [-192, 154], [-236, 154], [-252, 162], [-280, 162], [-276, 166], [-284, 166], [-280, 170], [-308, 170], [-300, 174], [-308, 174], [-300, 178], [-312, 178], [-304, 182], [-336, 182], [-360, 190]] },
  { w: 3.4, pts: ROAD },
  { w: 2.4, pts: [[118, 292], [170, 280], [230, 260], [290, 230], [340, 220]] },
  { w: 2.6, pts: [[168, 336], [168, 371]] },
  { w: 2.2, pts: [[310, 338], [310, 374]] },
  { w: 2.2, pts: [[98, 336], [98, 358]] },
];

// the lookout on the peak's southern shoulder, 180 m up, and the way its view faces (toward the harbour)
export const LOOKOUT = { x: -50, z: 50, dx: 0.461, dz: 0.887 };

// flattened pads (village lots, bar, lighthouse) — cx, cz, radius, strength
export const PADS = [
  [175, 390, 150, 0.85],
  [98, 364, 16, 0.9],
  [LOOKOUT.x, LOOKOUT.z, 18, 1.0],
];

// points of interest, for titles and the tour (y = eye height above ground or water)
export const POIS = [
  { id: 'harbour', name: 'Halcyon Harbour', sub: 'Where the pier meets the lagoon', x: 168, z: 520, r: 120 },
  { id: 'village', name: 'Saltwater Village', sub: 'One road along the sand, and no hurry', x: 190, z: 340, r: 120 },
  { id: 'peak', name: 'Mount Halcyon', sub: 'Knife-edge ridges under rainforest, three hundred metres over the lagoon', x: -70, z: -150, r: 220 },
  { id: 'lagoon', name: 'The Inner Lagoon', sub: 'Six metres of light over white sand', x: -420, z: 620, r: 260 },
  { id: 'pass', name: 'Kingfisher Pass', sub: 'The one gap in the reef', x: ringPoint(PASS.a)[0], z: ringPoint(PASS.a)[1], r: 160 },
  { id: 'light', name: 'Pass Light', sub: 'Every nine seconds, since 1912', x: LIGHTHOUSE.x, z: LIGHTHOUSE.z, r: 90 },
  { id: 'motu', name: 'Palm Cay', sub: 'A sandbar that learned to grow palms', x: ringPoint((56 * Math.PI) / 180)[0], z: ringPoint((56 * Math.PI) / 180)[1], r: 200 },
  { id: 'deep', name: 'The Drop-off', sub: 'Where turquoise turns to ink', x: ringPoint((330 * Math.PI) / 180, 300)[0], z: ringPoint((330 * Math.PI) / 180, 300)[1], r: 400 },
];
