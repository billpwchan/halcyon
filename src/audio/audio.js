// The sound of the place, made live: surf by distance to the break, wind, palms, birds by day and crickets by night,
// rain and thunder, the hush under water with whale song, footsteps, the hull, and a little music at the bar after dark.
import { U } from '../core/shared.js';
import { PLAN } from '../world/plan.js';

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function createAudio({ env, player, camera, hf, fauna }) {
  let ctx = null, started = false;
  const A = { muted: false };
  let master, under, dry, verb, nodes = {};

  function noiseBuffer(sec, color) {
    const n = Math.floor(ctx.sampleRate * sec);
    const b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      let b0 = 0, b1 = 0, b2 = 0, last = 0;
      for (let i = 0; i < n; i++) {
        const w = Math.random() * 2 - 1;
        if (color === 'pink') { b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.16; }
        else if (color === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
        else d[i] = w * 0.5;
      }
    }
    return b;
  }
  const loop = (buf, rate = 1) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate; s.loopStart = Math.random(); s.start(0, Math.random() * buf.duration); return s; };
  const filt = (type, f, q = 0.7) => { const x = ctx.createBiquadFilter(); x.type = type; x.frequency.value = f; x.Q.value = q; return x; };
  const gain = (v = 0) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const chain = (...n) => { for (let i = 1; i < n.length; i++) n[i - 1].connect(n[i]); return n[n.length - 1]; };

  function impulse(sec) {
    const n = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3.2); }
    return b;
  }

  function build() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = gain(0);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 3;
    // everything passes the "under water" filter, wide open in air
    under = filt('lowpass', 20000, 0.5);
    dry = gain(1);
    verb = ctx.createConvolver();
    verb.buffer = impulse(2.8);
    const verbOut = gain(0.35);
    dry.connect(under);
    verb.connect(verbOut).connect(under);
    chain(under, master, comp, ctx.destination);

    const pink = noiseBuffer(6, 'pink'), white = noiseBuffer(3, 'white'), brown = noiseBuffer(6, 'brown');
    // surf: a near swash and a far roar off the reef, each breathing in sets
    nodes.swash = gain(); chain(loop(pink, 0.9), filt('lowpass', 900), filt('highpass', 120), nodes.swash, dry);
    nodes.roar = gain(); chain(loop(brown, 1), filt('lowpass', 420), nodes.roar, dry);
    nodes.roarHi = gain(); chain(loop(pink, 0.6), filt('bandpass', 1300, 0.4), nodes.roarHi, dry);
    // wind and the palms answering it
    nodes.windF = filt('bandpass', 500, 0.6); nodes.wind = gain(); chain(loop(pink, 0.7), nodes.windF, nodes.wind, dry);
    nodes.leaves = gain(); chain(loop(white, 1), filt('highpass', 3200), filt('lowpass', 9000), nodes.leaves, dry);
    nodes.rain = gain(); chain(loop(white, 0.8), filt('highpass', 1400), filt('lowpass', 11000), nodes.rain, dry);
    nodes.rainLow = gain(); chain(loop(pink, 1.1), filt('lowpass', 600), nodes.rainLow, dry);
    // under water: a pressure hum
    nodes.hum = gain(); chain(loop(brown, 0.5), filt('lowpass', 160), nodes.hum, master);
    // the hull in the water
    nodes.hull = gain(); nodes.hullF = filt('bandpass', 700, 0.9); chain(loop(pink, 1.3), nodes.hullF, nodes.hull, dry);
    nodes.buf = { pink, white, brown };
    master.gain.setTargetAtTime(A.muted ? 0 : 0.9, ctx.currentTime, 1.5);
  }

  // ---------------------------------------------------------------- one-shots
  const now = () => ctx.currentTime;
  function chirp(pan, base) {
    // a tropical song: a few quick notes, rising or falling
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    const g = gain(0); chain(g, p, dry); p.connect(verb);
    const notes = 2 + Math.floor(Math.random() * 5), t0 = now() + 0.05;
    const dir = Math.random() < 0.5 ? 1 : -1;
    for (let i = 0; i < notes; i++) {
      const o = ctx.createOscillator(), t = t0 + i * (0.09 + Math.random() * 0.06);
      const f = base * (1 + dir * i * 0.08) * (0.95 + Math.random() * 0.1);
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * (1.25 + Math.random() * 0.4), t + 0.06);
      const e = gain(0); o.connect(e).connect(g);
      e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(0.5, t + 0.012); e.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      o.start(t); o.stop(t + 0.1);
    }
    g.gain.value = 0.09;
  }
  function gull(pan, dist) {
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    const bp = filt('bandpass', 1600, 3), e = gain(0);
    chain(o, bp, e, p, dry); p.connect(verb);
    const t = now() + 0.02, f = 1250 + Math.random() * 300, k = 0.18 / (1 + dist / 25);
    o.frequency.setValueAtTime(f * 1.25, t); o.frequency.exponentialRampToValueAtTime(f * 0.72, t + 0.38);
    e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(k, t + 0.04); e.gain.setValueAtTime(k, t + 0.22); e.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    o.start(t); o.stop(t + 0.5);
  }
  function cricket(pan, k) {
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    const o = ctx.createOscillator(); o.frequency.value = 4300 + Math.random() * 900;
    const e = gain(0); chain(o, e, p, dry);
    const t = now() + 0.02, pulses = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < pulses; i++) { const s = t + i * 0.045; e.gain.setValueAtTime(0, s); e.gain.linearRampToValueAtTime(0.05 * k, s + 0.008); e.gain.linearRampToValueAtTime(0, s + 0.03); }
    o.start(t); o.stop(t + pulses * 0.045 + 0.05);
  }
  function burst(buf, { f = 800, type = 'lowpass', q = 0.7, a = 0.01, d = 0.2, k = 0.3, rate = 1, pan = 0, toVerb = false, delay = 0 }) {
    const s = ctx.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate;
    const e = gain(0), p = ctx.createStereoPanner(); p.pan.value = pan;
    chain(s, filt(type, f, q), e, p, dry);
    if (toVerb) p.connect(verb);
    const t = now() + delay;
    e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(k, t + a); e.gain.exponentialRampToValueAtTime(0.001, t + a + d);
    s.start(t, Math.random() * 1.5); s.stop(t + a + d + 0.1);
  }
  function whaleSong(k) {
    // long falling and rising moans
    const o = ctx.createOscillator(), o2 = ctx.createOscillator(), e = gain(0);
    o.type = 'sine'; o2.type = 'sine';
    const t = now(), f = 180 + Math.random() * 260, dur = 2.5 + Math.random() * 2.5;
    o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * (Math.random() < 0.5 ? 0.55 : 1.6), t + dur);
    o2.frequency.setValueAtTime(f * 2.01, t); o2.frequency.exponentialRampToValueAtTime(f * 2.01 * 0.7, t + dur);
    const g2 = gain(0.25); o2.connect(g2).connect(e);
    o.connect(e); e.connect(verb); e.connect(dry);
    e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(0.12 * k, t + dur * 0.35); e.gain.linearRampToValueAtTime(0, t + dur);
    o.start(t); o2.start(t); o.stop(t + dur + 0.1); o2.stop(t + dur + 0.1);
  }
  // Karplus-Strong pluck for the bar's little tune
  function pluck(freq, k, pan) {
    const n = Math.round(ctx.sampleRate / freq), len = Math.floor(ctx.sampleRate * 1.6);
    const b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    for (let i = n; i < len; i++) d[i] = (d[i - n] + d[i - n + 1]) * 0.4985;
    const s = ctx.createBufferSource(); s.buffer = b;
    const e = gain(k), p = ctx.createStereoPanner(); p.pan.value = pan;
    chain(s, filt('lowpass', 2600), e, p, dry); p.connect(verb);
    s.start();
  }
  const SCALE = [0, 2, 4, 7, 9, 12, 14, 16];
  const CHORDS = [[0, 4, 7], [-3, 0, 4], [5, 9, 12], [7, 11, 14]];
  let barStep = 0, barT = 0;

  // ---------------------------------------------------------------- events from the world
  if (fauna) fauna.onEvent = (type, x, y, z) => {
    if (!started || A.muted) return;
    const d = Math.hypot(x - camera.position.x, z - camera.position.z);
    const pan = Math.max(-1, Math.min(1, ((x - camera.position.x) * Math.cos(player.yaw) - (z - camera.position.z) * Math.sin(player.yaw)) / Math.max(d, 1)));
    const delay = d / 343;
    if (type === 'blow') burst(nodes.buf.pink, { f: 900, d: 1.6, a: 0.05, k: 1.2 / (1 + d / 60), pan, delay, toVerb: true });
    if (type === 'breach') { burst(nodes.buf.brown, { f: 300, d: 3.5, a: 0.02, k: 2.2 / (1 + d / 120), pan, delay }); burst(nodes.buf.pink, { f: 2500, d: 2.2, a: 0.05, k: 0.9 / (1 + d / 120), pan, delay }); }
    if (type === 'splash' && d < 150) burst(nodes.buf.pink, { f: 2200, d: 0.5, k: 0.6 / (1 + d / 20), pan, delay });
  };

  // thunder follows the flash by the time sound takes to cover the distance
  env.onThunder = (delay, k) => {
    if (!started || A.muted) return;
    burst(nodes.buf.brown, { f: 160, d: 5 + k * 2, a: 0.25 + delay * 0.1, k: 0.9 + k * 0.5, delay });
    burst(nodes.buf.pink, { f: 380, d: 2.5, a: 0.04, k: 0.25 * k, delay, toVerb: true });
  };

  // ---------------------------------------------------------------- per frame
  const coast = { d: 0, dx: 0, dz: 0, lag: 0 };
  let birdT = 1, gullT = 2, crickT = 0.5, stepPh = 0, songT = 6, setT = 0, setK = 1;
  const set = (g, v, tc = 0.4) => g.gain.setTargetAtTime(v, ctx.currentTime, tc);
  function update(dt) {
    if (!started || !ctx) return;
    const c = camera.position;
    hf.coastAt(c.x, c.z, coast);
    const ground = hf.heightAt(c.x, c.z);
    const alt = c.y - Math.max(ground, 0);
    const isUnder = c.y < -0.05;
    const air = smooth(260, 20, alt);
    // wave sets: the swell comes in groups
    setT -= dt;
    if (setT <= 0) { setT = 6 + Math.random() * 6; setK = 0.55 + Math.random() * 0.6; }
    const breath = 0.7 + 0.3 * Math.sin(performance.now() * 0.0011) * setK;
    const nearBreak = smooth(420, 15, Math.abs(coast.d));
    const swell = U.uSwell.value;
    set(nodes.roar, (0.18 + 0.9 * nearBreak * (1 - coast.lag * 0.3)) * swell * breath * (0.35 + 0.65 * air) * (isUnder ? 0.6 : 1));
    set(nodes.roarHi, 0.12 * nearBreak * swell * breath * air);
    const swashK = smooth(60, 0, Math.abs(ground - 0)) * smooth(-8, 2, ground);
    set(nodes.swash, (0.08 + 0.4 * swashK) * breath * air);
    const wind = U.uWind.value.z;
    nodes.windF.frequency.setTargetAtTime(380 + wind * 300 + smooth(20, 300, alt) * 400, ctx.currentTime, 0.8);
    set(nodes.wind, (0.05 + 0.18 * wind + 0.25 * smooth(30, 400, alt)) * (isUnder ? 0 : 1), 0.8);
    const veg = ground > 0.8 ? smooth(40, 4, alt) : 0;
    set(nodes.leaves, 0.05 * veg * wind * (0.6 + 0.4 * breath), 0.6);
    const rain = U.uRain.value;
    set(nodes.rain, 0.22 * rain * (isUnder ? 0 : 1), 1);
    set(nodes.rainLow, 0.18 * rain, 1);
    set(nodes.hum, isUnder ? 0.35 : 0, 0.3);
    under.frequency.setTargetAtTime(isUnder ? 420 : 20000, ctx.currentTime, 0.12);
    // the hull: louder with way on
    const sailing = player.mode === 'sail';
    const bv = sailing ? Math.abs(player.boat.v) : 0;
    set(nodes.hull, sailing ? 0.05 + bv * 0.05 : 0, 0.3);
    nodes.hullF.frequency.setTargetAtTime(500 + bv * 120, ctx.currentTime, 0.3);

    const day = 1 - env.night, nightK = env.night;
    // birds in the trees by day, gulls near the water
    birdT -= dt;
    if (birdT <= 0) { birdT = 0.6 + Math.random() * 3.5 / Math.max(0.2, veg * day + 0.05); if (veg * day > 0.15 && !isUnder) chirp(Math.random() * 1.6 - 0.8, 2400 + Math.random() * 2800); }
    gullT -= dt;
    if (gullT <= 0) {
      gullT = 2 + Math.random() * 6;
      let best = 1e9, bx = 0;
      for (const b of fauna?.birds || []) { const d = b.node.position.distanceTo(c); if (d < best) { best = d; bx = b.node.position.x - c.x; } }
      if (best < 120 && day > 0.3 && !isUnder) gull(Math.max(-1, Math.min(1, bx / 40)), best);
    }
    crickT -= dt;
    if (crickT <= 0) { crickT = 0.08 + Math.random() * 0.3; if (nightK > 0.4 && ground > 0.5 && alt < 60 && !isUnder) cricket(Math.random() * 1.8 - 0.9, nightK * smooth(60, 5, alt)); }
    // whale song under water, when one is in the area
    songT -= dt;
    if (songT <= 0) {
      songT = 4 + Math.random() * 6;
      const near = Math.min(...(fauna?.whales || []).map((w) => w.node.position.distanceTo(c)));
      if (isUnder && near < 1500) whaleSong(smooth(1500, 200, near));
    }
    // footsteps: sand thuds, deck knocks
    if (player.mode === 'walk') {
      const v = Math.hypot(player.vel.x, player.vel.z);
      const prev = stepPh;
      stepPh += dt * v * 0.55;
      if (v > 0.5 && Math.floor(stepPh) !== Math.floor(prev)) {
        const deck = player.floorAt(c.x, c.z) > ground + 0.3;
        burst(deck ? nodes.buf.white : nodes.buf.pink, deck ? { f: 320, type: 'bandpass', q: 2.5, d: 0.09, k: 0.32 } : { f: 700, d: 0.14, k: 0.16, rate: 0.7 });
      }
    }
    // a slow tune at the bar after dark
    const dBar = Math.hypot(c.x - PLAN.bar.x, c.z - PLAN.bar.z);
    if (nightK > 0.5 && dBar < 90 && !isUnder) {
      barT -= dt;
      if (barT <= 0) {
        barT = 0.36;
        const ch = CHORDS[Math.floor(barStep / 8) % 4];
        const root = 196 * Math.pow(2, ch[barStep % 3] / 12) * (barStep % 8 === 7 ? 2 : 1);
        const k = 0.16 * smooth(90, 8, dBar);
        pluck(root, k, 0);
        if (barStep % 4 === 0) pluck(98 * Math.pow(2, ch[0] / 12), k * 0.8, -0.2);
        if (Math.random() < 0.25) pluck(392 * Math.pow(2, SCALE[Math.floor(Math.random() * SCALE.length)] / 12), k * 0.5, 0.3);
        barStep++;
      }
    }
  }

  A.start = () => {
    if (!ctx) build();
    ctx.resume();
    started = true;
  };
  A.toggle = () => {
    A.muted = !A.muted;
    if (ctx) master.gain.setTargetAtTime(A.muted ? 0 : 0.9, ctx.currentTime, 0.3);
  };
  A.mode = (m) => {
    if (!ctx || A.muted) return;
    // a soft tick: the world acknowledges the change
    const o = ctx.createOscillator(), e = gain(0);
    o.frequency.value = m === 'dive' ? 520 : 880;
    chain(o, e, master);
    const t = now();
    e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(0.05, t + 0.01); e.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.start(t); o.stop(t + 0.3);
    if (m === 'dive' || m === 'swim') burst(nodes.buf.pink, { f: 1400, d: 0.6, k: 0.35 });
  };
  A.update = update;
  return A;
}
