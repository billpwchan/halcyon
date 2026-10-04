// Time of day and weather. Computes the sun and moon for a tropical latitude, their colour after the air,
// exposure, and drives every shared uniform. Weather moves between states with eased transitions.
import * as THREE from 'three';
import { U } from '../core/shared.js';

const LAT = (-16.5 * Math.PI) / 180;
const DECL = (-8 * Math.PI) / 180; // late October
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

// direction to a body with hour angle H (radians), declination d, at latitude LAT; north = -z, east = +x
function bodyDir(H, d, out) {
  const sinAlt = Math.sin(LAT) * Math.sin(d) + Math.cos(LAT) * Math.cos(d) * Math.cos(H);
  const alt = Math.asin(sinAlt);
  const cosAz = (Math.sin(d) - Math.sin(alt) * Math.sin(LAT)) / (Math.cos(alt) * Math.cos(LAT) + 1e-9);
  let az = Math.acos(Math.min(1, Math.max(-1, cosAz))); // from north, toward east
  if (Math.sin(H) > 0) az = 2 * Math.PI - az;
  out.set(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
  return out;
}

// transmittance of sunlight through the air (Rayleigh, Mie, ozone) by relative air mass
function transmittance(y, haze, out) {
  const z = Math.acos(Math.min(1, Math.max(-0.2, y)));
  const zd = (z * 180) / Math.PI;
  const m = zd < 96 ? 1 / (Math.cos(z) + 0.50572 * Math.pow(Math.max(96.07995 - zd, 0.1), -1.6364)) : 60;
  const tr = [0.0464, 0.1085, 0.2648], to = [0.0098, 0.0282, 0.0013], tm = 0.0053 * 1.11 * haze * 1.4;
  out.set(Math.exp(-m * (tr[0] + to[0] + tm)), Math.exp(-m * (tr[1] + to[1] + tm)), Math.exp(-m * (tr[2] + to[2] + tm)));
  return out;
}

export const WEATHERS = {
  clear: { cover: 0.22, cirrus: 0.35, wind: 0.55, swell: 0.85, rain: 0, haze: 0.9, label: 'Clear' },
  trade: { cover: 0.42, cirrus: 0.6, wind: 0.75, swell: 1.0, rain: 0, haze: 1.0, label: 'Trade clouds' },
  overcast: { cover: 0.74, cirrus: 0.2, wind: 0.95, swell: 1.25, rain: 0, haze: 1.6, label: 'Overcast' },
  squall: { cover: 0.92, cirrus: 0.0, wind: 1.45, swell: 1.9, rain: 1, haze: 2.4, label: 'Squall' },
};

export class Environment {
  constructor() {
    this.hours = 7.0;
    this.timeScale = 1 / 90; // game hours per real second (a day lasts 36 minutes)
    this.auto = true;
    this.weather = 'trade';
    this.autoWeather = true;
    this.cur = { ...WEATHERS.trade };
    this.target = WEATHERS.trade;
    this.rainbow = 0;
    this.flash = 0;
    this.nextFlash = 4;
    this.nextWeather = 240;
    this.day = 0;
    this.sun = new THREE.Vector3();
    this.moon = new THREE.Vector3();
    this.sunCol = new THREE.Vector3();
    this.moonCol = new THREE.Vector3();
    this.light = new THREE.Vector3();
    this.lightCol = new THREE.Vector3();
    this.cloudDir = new THREE.Vector3(0, 1, 0);
    this.cloudCol = new THREE.Vector3();
    this.cloudAmb = 1;
    this.exposure = 1;
    this.night = 0;
    this.cloudOff = new THREE.Vector2(0, 0);
    this._t = new THREE.Vector3();
    this.onThunder = null;
    this.lampOn = 0;
    this.moonPhase = 0.42; // 0 new, 0.5 full
  }

  setHours(h) { this.hours = ((h % 24) + 24) % 24; }
  setWeather(name, instant) {
    if (!WEATHERS[name]) return;
    const was = this.weather;
    this.weather = name;
    this.target = WEATHERS[name];
    if (instant) Object.assign(this.cur, this.target);
    // a squall that clears with the sun out leaves a rainbow behind
    if (was === 'squall' && name !== 'squall') this.rainbowTimer = 70;
  }

  update(dt, rng = Math.random) {
    if (this.auto) {
      this.hours += dt * this.timeScale;
      if (this.hours >= 24) { this.hours -= 24; this.day++; }
    }
    // weather: slow approach toward the target; the auto cycle sends a squall through now and then
    const k = 1 - Math.exp(-dt / 14);
    for (const key of ['cover', 'cirrus', 'wind', 'swell', 'haze']) this.cur[key] = lerp(this.cur[key], this.target[key], k);
    this.cur.rain = lerp(this.cur.rain, this.target.rain * smooth(0.7, 0.88, this.cur.cover), 1 - Math.exp(-dt / 8));
    if (this.autoWeather) {
      this.nextWeather -= dt;
      if (this.nextWeather <= 0) {
        const order = this.weather === 'squall' ? ['trade', 'clear'] : this.weather === 'overcast' ? ['squall', 'trade'] : ['trade', 'clear', 'overcast', 'trade'];
        const next = order[Math.floor(rng() * order.length)];
        this.setWeather(next);
        this.nextWeather = next === 'squall' ? 110 + rng() * 60 : 260 + rng() * 240;
      }
    }
    if (this.rainbowTimer > 0) this.rainbowTimer -= dt;

    // sun and moon
    const H = ((this.hours - 12) / 24) * 2 * Math.PI;
    bodyDir(H, DECL, this.sun);
    // the moon trails the sun by its phase
    bodyDir(H - this.moonPhase * 2 * Math.PI, DECL + 0.05, this.moon);
    const sy = this.sun.y;
    transmittance(sy, this.cur.haze, this._t);
    const horizonFade = smooth(-0.06, 0.04, sy);
    this.sunCol.copy(this._t).multiplyScalar(4.2 * horizonFade);
    const moonUp = smooth(-0.04, 0.08, this.moon.y);
    const moonLit = 0.25 + 0.75 * Math.sin(this.moonPhase * Math.PI);
    transmittance(Math.max(this.moon.y, 0.01), this.cur.haze, this._t);
    this.moonCol.set(0.55, 0.68, 1.0).multiply(this._t).multiplyScalar(0.11 * moonUp * moonLit);
    // dominant light: whichever is brighter
    const sunE = this.sunCol.x + this.sunCol.y + this.sunCol.z, moonE = this.moonCol.x + this.moonCol.y + this.moonCol.z;
    const useSun = sunE > moonE || sy > -0.02;
    this.light.copy(useSun ? this.sun : this.moon);
    if (this.light.y < 0.02) this.light.y = 0.02;
    this.light.normalize();
    this.lightCol.copy(useSun ? this.sunCol : this.moonCol);
    // overcast takes the direct light
    this.lightCol.multiplyScalar(1 - 0.72 * smooth(0.55, 0.95, this.cur.cover));
    // clouds a couple of kilometres up see the sun before the ground does, through the longest, reddest air;
    // moonlit cloud stays dim grey, or it glows like day against the dark land
    const cloudSun = smooth(-0.075, 0.02, sy);
    transmittance(Math.max(sy + 0.03, 0.004), this.cur.haze, this._t);
    const cs = this._t.multiplyScalar(4.2 * cloudSun), csE = cs.x + cs.y + cs.z;
    const overK = 1 - 0.5 * smooth(0.55, 0.95, this.cur.cover);
    if (csE > moonE * 0.35) { this.cloudDir.copy(this.sun); this.cloudCol.copy(cs).multiplyScalar(overK); }
    else { this.cloudDir.copy(this.moon); this.cloudCol.copy(this.moonCol).multiplyScalar(0.35 * overK); }
    // skylight on the clouds falls off like the sky itself: a fifth at sunrise, a twentieth three degrees before
    const ak = smooth(-0.1, 0.25, sy);
    this.cloudAmb = lerp(0.02, 1, ak * ak);
    this.night = 1 - smooth(-0.16, 0.02, sy);
    this.lampOn = 1 - smooth(-0.02, 0.1, sy) * (1 - smooth(0.7, 0.95, this.cur.cover) * 0.6);
    // exposure follows the light, with a little lift for night vision
    const dayK = smooth(-0.1, 0.25, sy);
    this.exposure = lerp(7.5, 1.0, dayK) * lerp(1.0, 1.45, smooth(0.5, 0.95, this.cur.cover) * dayK);
    this.exposure *= lerp(1, 1.18, smooth(0.3, 0.02, Math.abs(sy - 0.06)) * dayK);

    // lightning
    this.flash = Math.max(0, this.flash - dt * 7);
    if (this.cur.rain > 0.5) {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0) {
        this.flash = 1 + rng() * 1.5;
        this.nextFlash = 3 + rng() * 9;
        const a = rng() * Math.PI * 2;
        U.uFlashDir.value.set(Math.cos(a), 0.25 + rng() * 0.3, Math.sin(a)).normalize();
        this.onThunder?.(0.6 + rng() * 2.5, this.flash);
      }
    }
    // rainbow: sun behind, low enough, rain still in the air or just passed
    const rainAir = Math.max(this.cur.rain, this.rainbowTimer > 0 ? Math.min(1, this.rainbowTimer / 30) : 0);
    this.rainbow = lerp(this.rainbow, rainAir * smooth(0.0, 0.08, sy) * smooth(0.72, 0.4, sy) * (1 - smooth(0.85, 0.98, this.cur.cover)), 1 - Math.exp(-dt / 4));

    // wind carries the clouds
    const wd = U.uWind.value;
    this.cloudOff.x += wd.x * dt * 9 * (0.6 + this.cur.wind);
    this.cloudOff.y += wd.y * dt * 9 * (0.6 + this.cur.wind);

    // shared uniforms
    U.uTrueSun.value.copy(this.sun);
    U.uMoonDir.value.copy(this.moon);
    U.uSunDir.value.copy(this.light);
    U.uSunCol.value.copy(this.lightCol);
    U.uNight.value = this.night;
    U.uDay.value = dayK;
    U.uCover.value = this.cur.cover;
    U.uRain.value = this.cur.rain;
    U.uWet.value = lerp(U.uWet.value, Math.max(this.cur.rain, this.rainbowTimer > 0 ? 0.6 : 0), 1 - Math.exp(-dt / (this.cur.rain > 0.2 ? 6 : 40)));
    U.uSwell.value = this.cur.swell;
    U.uHaze.value = this.cur.haze;
    U.uFlash.value = this.flash;
    U.uLampOn.value = this.lampOn;
    U.uBiolum.value = smooth(0.55, 0.95, this.night) * (1 - this.cur.rain * 0.5);
    U.uCloudOff.value.copy(this.cloudOff);
    wd.z = this.cur.wind;
  }
}
