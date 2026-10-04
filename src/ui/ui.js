// The interface: intro, a single glass dock (sun dial, modes, weather, sound, photo, info), compass, place titles.
import { U } from '../core/shared.js';
import { MODES } from '../player/player.js';
import { WEATHERS } from '../env/environment.js';

const CREDITS = [
  ['Humpback whale', 'K9239', '5a6a09f1c27e4d0f890f2a30c10d7a81', 'CC BY 4.0'],
  ['Bottlenose dolphin', 'popcornbag', '4bb04fa58d6846938e07bb38507e3f3a', 'CC BY 4.0'],
  ['Flatback sea turtle', 'DigitalLife3D', '442372b7f02b4730882d41d959726156', 'CC BY 4.0'],
  ['Manta ray', 'faerbogdan99', 'cee021520e274e2f90f0de23728b698b', 'CC BY 4.0'],
  ['Blacktip reef shark', 'nandupofficial', '8bcd4d861bd84e87b2832e83c9cb898b', 'CC BY 4.0'],
  ['Seagull', 'FreddyFoxFreddy', 'f3fa166ff6bd4ffe8133f6f6eed74d64', 'CC BY 4.0'],
  ['Freshwater crab', 'ffishAsia & floraZia', '35559c2236d04c1a80ccbe08cae863c6', 'CC0'],
  ["Marr’s fusilier", 'ffishAsia & floraZia', 'e7a0627d230d48a587d45a359f61e96f', 'CC0'],
  ['Dash-and-dot goatfish', 'ffishAsia & floraZia', '7bcab613023c4ecb94a0d25ce3dac6e5', 'CC0'],
  ['Steephead parrotfish', 'ffishAsia & floraZia', '9026105871bd49069936b6ac569e5c85', 'CC0'],
  ['Blue-striped angelfish', 'ffishAsia & floraZia', 'a5c0bb6877184e698c1992e5ce1a69d0', 'CC0'],
  ['Porites coral', 'therlab', 'c68ad1a0a150487db1207627fc2deceb', 'CC BY 4.0'],
  ['Pocillopora coral', 'therlab', '2c193de29f7f4f88baf4d9075c07403f', 'CC BY 4.0'],
  ['Brain coral', 'wattinstitution', 'ec4b103c02c541998246dc30d4e45139', 'CC BY 4.0'],
  ['Coral head, Okinawa', 'YYouzhen', 'e170488423964924b6bf344c00332cf0', 'CC BY 4.0'],
  ['Staghorn coral', 'pixforge.id', 'ede640745c16457a9345ef1fa9e8d4d4', 'CC BY 4.0'],
  ['Table coral', 'qqman', 'afca6f9fa7844c8da8f00c5ad654c626', 'CC BY 4.0'],
  ['Bamboo house', 'COSdelque', '2dc6d034f0ba4b0694872d032dd7bd56', 'CC BY 4.0'],
  ['Fishing hut', 'Artyooooom', '2cf0b8aaa09b456cbad002d28599e753', 'CC BY 4.0'],
  ['Tiki counter', 'KristaPolito', 'e92b5682574a43aab2ef40e0087f5847', 'CC BY 4.0'],
  ['Lighthouse', 'aresdavide94', 'ad450ca49c0c4ef3831059039191509a', 'CC BY 4.0'],
  ['Dhow', 'agt14032013', '5217bd7dffdf4928823e5e489e40617c', 'CC BY 4.0'],
  ['Fishing boat', 'Godot2000', 'cc4200e4018843f28ddca72adc61e887', 'CC BY 4.0'],
  ['Old boat', 'donnichols', 'a9ce4ca0cac14f448c72bb94ad193437', 'CC BY 4.0'],
  ['Rowboat', 'donnichols', '627ba38e06aa4536b90706a8626c74d4', 'CC BY 4.0'],
  ['Christmas palm 19', 'PlantCatalog', 'c8d3fe57d9d44ba08e8b828c2c00aeb6', 'CC BY 4.0'],
  ['Christmas palm 23', 'PlantCatalog', '95018fe3e1a6481897c34c8b6bffd4b7', 'CC BY 4.0'],
  ['Christmas palm 25', 'PlantCatalog', '62d691bead104be18524cfc3e6d612df', 'CC BY 4.0'],
  ['Alexander palm 15', 'PlantCatalog', '14b08e6a079c4c81b33a9cdcdf349338', 'CC BY 4.0'],
  ['Common fig tree 9', 'PlantCatalog', '7285c0c46fb44d17a2283f436e9271bf', 'CC BY 4.0'],
  ['Common fig tree 15', 'PlantCatalog', '09bafab7b44344e2ac86c094b463e502', 'CC BY 4.0'],
  ['Hong Kong orchid tree 14', 'PlantCatalog', '8dff5c2f9f82413d8054c79648681471', 'CC BY 4.0'],
  ['Royal poinciana 4', 'PlantCatalog', 'bc8f364e13d0430fa3d7eb78ea5a5634', 'CC BY 4.0'],
  ['Royal poinciana 12', 'PlantCatalog', 'bb281d3414104b50abc35e4d633deaba', 'CC BY 4.0'],
  ['Frangipani tree 24', 'PlantCatalog', '96249508de644780ad0990d84e6fd6ac', 'CC BY 4.0'],
  ['Cabbage tree 14', 'PlantCatalog', '3141378c324343a1ad6cb17aaa23778f', 'CC BY 4.0'],
  ['Chinese hibiscus 8', 'PlantCatalog', 'd8e34b4a6ca547c7a21409eca1148357', 'CC BY 4.0'],
  ['Chinese hibiscus 5', 'PlantCatalog', 'a7c0dec54ef3461e9119c9217ca056e7', 'CC BY 4.0'],
  ["Turk's cap mallow 8", 'PlantCatalog', '508fdc22ac234da490dd140ab643e256', 'CC BY 4.0'],
  ['Japanese sago palm 5', 'PlantCatalog', '76ef787eb1644874a1ebc97416665ab4', 'CC BY 4.0'],
  ['Japanese sago palm 30', 'PlantCatalog', '3758781068984a40918c18f85b70ea46', 'CC BY 4.0'],
  ['Butterfly palm 24', 'PlantCatalog', '8c0089ea866940549bdee238e53063ed', 'CC BY 4.0'],
  ['Bamboo palm 12', 'PlantCatalog', '49ae1849391a44b18c5701ca5d8d3985', 'CC BY 4.0'],
  ['Common polypody fern 5', 'PlantCatalog', '1e673c2b22eb41e9b12b6a3ca8ef8ae9', 'CC BY 4.0'],
  ['Banana tree', '1.Quad', '3b658ecad29f4d9a9606dbf8fea7c9bb', 'CC BY 4.0'],
  ['Tropical plants pack', 'mozzarellaARC', '2f093afb792742438f0f7ba7eaab90f0', 'CC BY 4.0'],
  ['Alocasia', 'metasculptures', '568898ca19c9496e904287c4ad704838', 'CC BY 4.0'],
];

const ICON = {
  play: '<svg viewBox="0 0 10 10"><path d="M2 1l7 4-7 4z"/></svg>',
  pause: '<svg viewBox="0 0 10 10"><path d="M2 1h2v8H2zM6 1h2v8H6z"/></svg>',
  auto: '<svg viewBox="0 0 24 24"><path d="M19.5 12a7.5 7.5 0 0 1-13 5.1M4.5 12a7.5 7.5 0 0 1 13-5.1"/><path d="M17.5 3.6v3.4h-3.4M6.5 20.4V17h3.4"/></svg>',
  clear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.6"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M5.6 18.4l1.6-1.6M16.8 7.2l1.6-1.6"/></svg>',
  trade: '<svg viewBox="0 0 24 24"><circle cx="9" cy="9" r="3"/><path d="M9 3.2v1.4M3.2 9h1.4M4.9 4.9l1 1M13.1 4.9l-1 1"/><path d="M8.5 19h9a3.2 3.2 0 0 0 .4-6.4 4.6 4.6 0 0 0-8.7 1.2A2.6 2.6 0 0 0 8.5 19z"/></svg>',
  overcast: '<svg viewBox="0 0 24 24"><path d="M7 18.5h10.5a3.5 3.5 0 0 0 .3-7 5.2 5.2 0 0 0-9.9-1.2A4 4 0 0 0 7 18.5z"/></svg>',
  squall: '<svg viewBox="0 0 24 24"><path d="M7 14.5h10.5a3.5 3.5 0 0 0 .3-7 5.2 5.2 0 0 0-9.9-1.2A4 4 0 0 0 7 14.5z"/><path d="M8.5 17.5l-1 2.5M12.5 17.5l-1 2.5M16.5 17.5l-1 2.5"/></svg>',
  sound: '<svg viewBox="0 0 24 24"><path d="M3 12h1.5M6.5 8.5v7M10 5.5v13M13.5 8v8M17 10v4M20.5 11.2v1.6"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M3 12h18"/></svg>',
  photo: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 4l3.5 6M20 12l-6.9.1M16 18.9l-3.5-6M4.1 13.4L11 13M8 5.1l3.5 6"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.1"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
};
const LABEL = { walk: 'Walk', swim: 'Swim', sail: 'Sail', fly: 'Fly', tour: 'Tour' };
const HINTS = {
  walk: '<b>WASD</b> walk &middot; <b>Shift</b> run &middot; <b>Space</b> jump &middot; <b>Drag</b> look',
  swim: '<b>WASD</b> swim &middot; <b>C</b> dive &middot; <b>Drag</b> look',
  dive: '<b>W</b> swim where you look &middot; <b>Space</b> rise &middot; <b>C</b> sink',
  sail: '<b>W</b> sail &middot; <b>A D</b> steer &middot; <b>S</b> back water &middot; <b>Wheel</b> zoom',
  fly: '<b>WASD</b> fly &middot; <b>Space C</b> up, down &middot; <b>Shift</b> fast &middot; <b>Wheel</b> speed',
  tour: '<b>Any key</b> or <b>drag</b> to take over',
};

// boot progress, before anything else exists
export function bootProgress(f, label) {
  const bar = document.querySelector('.intro-bar i'), st = document.querySelector('.intro-stage');
  if (bar) bar.style.transform = `scaleX(${f})`;
  if (st && label) st.textContent = label;
  return new Promise((r) => requestAnimationFrame(() => r()));
}

const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const pad = (n) => String(n).padStart(2, '0');

export function createUI({ env, player, camera, audio, onEnter }) {
  const root = document.getElementById('ui');
  const intro = document.getElementById('intro');
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch) root.classList.add('touch');

  root.append(h(`<div class="mark text-shadow"><div class="mark-word">Hal<i>c</i>yon</div><div class="mark-place"></div></div>`));
  const placeEl = root.querySelector('.mark-place');

  // compass: a strip of ticks slid under a fixed notch
  const PX = 1.6;
  const strip = h('<div class="compass-strip"></div>');
  const card = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  let marks = '';
  for (let d = -360; d <= 720; d += 15) {
    const x = (d + 360) * PX;
    const n = ((d % 360) + 360) % 360;
    if (card[n] !== undefined) marks += `<em style="left:${x}px">${card[n]}</em>`;
    else if (n % 45 === 0) marks += `<em class="minor" style="left:${x}px">${n}</em><span class="m" style="left:${x}px"></span>`;
    else marks += `<span style="left:${x}px"></span>`;
  }
  strip.innerHTML = marks;
  const compassBox = h('<div class="compass-box glass"><div class="compass"></div><div class="compass-deg"></div></div>');
  compassBox.querySelector('.compass').append(strip);
  root.append(compassBox);
  const degEl = compassBox.querySelector('.compass-deg');

  // ---------------------------------------------------------------- dock
  const dock = h(`<nav class="dock glass" aria-label="Controls"></nav>`);
  const clock = h(`<div class="seg clock">
      <div class="dial" title="Drag the sun to set the time">
        <svg viewBox="0 0 76 46"><path class="arc-day" d="M8 38 A30 30 0 0 1 68 38"/><path class="arc-night" d="M8 38 A30 30 0 0 0 68 38"/><line class="horizon" x1="2" y1="38" x2="74" y2="38"/><circle class="moon" r="3.2"/><circle class="sun" r="4"/></svg>
      </div>
      <div class="clock-read"><div class="clock-time">--:--</div><div class="clock-phase"></div></div>
      <button class="play" type="button" aria-label="Pause time"></button>
    </div>`);
  const modes = h('<div class="seg modes"><i class="mode-ink"></i></div>');
  MODES.forEach((m, i) => modes.append(h(`<button class="mode" type="button" data-mode="${m}">${LABEL[m]}<kbd>${i + 1}</kbd></button>`)));
  const weather = h('<div class="seg icons weather-seg"></div>');
  [['auto', 'Weather follows the day'], ...Object.entries(WEATHERS).map(([k, v]) => [k, v.label])].forEach(([k, tip]) => weather.append(h(`<button class="ibtn" type="button" data-w="${k}" data-tip="${tip}" aria-label="${tip}">${ICON[k]}</button>`)));
  const icons = h(`<div class="seg icons">
      <button class="ibtn keep" type="button" data-act="sound" data-tip="Sound (M)" aria-label="Sound">${ICON.sound}</button>
      <button class="ibtn" type="button" data-act="photo" data-tip="Photo mode (H)" aria-label="Photo mode">${ICON.photo}</button>
      <button class="ibtn keep" type="button" data-act="info" data-tip="About and controls (I)" aria-label="About">${ICON.info}</button>
    </div>`);
  dock.append(clock, modes, weather, icons);
  root.append(dock);
  const corner = h(`<div class="corner"><button class="ibtn glass" type="button" data-act="sound" aria-label="Sound">${ICON.sound}</button><button class="ibtn glass" type="button" data-act="info" aria-label="About">${ICON.info}</button></div>`);
  root.append(corner);
  const hint = h('<div class="hint text-shadow gone"></div>');
  root.append(hint);
  const arrive = h('<div class="arrive text-shadow"><div class="arrive-k"></div><h2 class="arrive-t"></h2><p class="arrive-s"></p></div>');
  root.append(arrive);
  const toast = h('<div class="toast glass"></div>');
  root.append(toast);

  const panel = h(`<aside class="panel glass" aria-label="About Halcyon">
      <h2>Hal<i>c</i>yon</h2>
      <p>One atoll through one day. The sun keeps real time across a 36-minute day, the weather turns on its own, and everything you see is drawn live: the sea, the reef, forty thousand plants, the creatures that live here.</p>
      <h3>Moving</h3>
      <div class="keys">
        <kbd>1 – 5</kbd><span>Walk, swim, sail, fly, tour</span>
        <kbd>W A S D</kbd><span>Move; arrows work too</span>
        <kbd>Drag</kbd><span>Look around; double-click to lock the mouse</span>
        <kbd>Shift</kbd><span>Run, swim hard, fly fast</span>
        <kbd>Space / C</kbd><span>Jump or rise / dive or sink</span>
        <kbd>[ &nbsp;]</kbd><span>Half an hour back or on; T pauses time</span>
        <kbd>H</kbd><span>Photo mode: the interface steps aside</span>
        <kbd>M</kbd><span>Sound on or off</span>
        <kbd>I</kbd><span>This panel</span>
      </div>
      <h3>Things to find</h3>
      <p>Whales blow beyond the reef to the south and west; now and then one breaches. A dolphin pod runs the lagoon past the pier head. Turtles graze under the bungalows, rays circle inside the pass, and after dark the swash and every wake light up.</p>
      <h3>Models</h3>
      <ul class="credits">${CREDITS.map(([n, a, id, lic]) => `<li><span><a href="https://sketchfab.com/3d-models/${id}" target="_blank" rel="noopener">${n}</a></span><span>${a} &middot; ${lic}</span></li>`).join('')}</ul>
      <h3>Also</h3>
      <ul class="credits">
        <li><span>Surfaces</span><span>Poly Haven &middot; CC0</span></li>
        <li><span>Terrain</span><span>Mount Halcyon is &#x14C;lomana, O&#x2BB;ahu, at 0.68 scale &middot; USGS 3DEP lidar, public domain</span></li>
        <li><span>Changes</span><span>Models above reduced and re-textured</span></li>
        <li><span>Engine</span><span>three.js</span></li>
        <li><span>Source</span><span><a href="https://github.com/billpwchan/halcyon" target="_blank" rel="noopener">github.com/billpwchan/halcyon</a> &middot; MIT</span></li>
        <li><span>After</span><span><a href="https://x.com/dangreenheck" target="_blank" rel="noopener">TIDEWATER</a> by Dan Greenheck</span></li>
      </ul>
    </aside>`);
  root.append(panel);
  if (touch) {
    intro.querySelector('.intro-foot').innerHTML = 'Sound on, if you can &middot; Drag to look &middot; Stick to move';
    panel.querySelector('.keys').innerHTML = `
        <kbd>Stick</kbd><span>Move; push it all the way to run</span>
        <kbd>Drag</kbd><span>Look around, anywhere on the screen</span>
        <kbd>&uarr; &darr;</kbd><span>Rise and sink, flying or under water</span>
        <kbd>Clock</kbd><span>Pause to hold the hour you like</span>`;
  }

  // touch: a stick for moving, up and down buttons, drag anywhere else to look
  const stick = h('<div class="stick glass"><i></i></div>');
  const updown = h(`<div class="updown"><button class="glass" type="button" data-u="1" aria-label="Up">${ICON.up}</button><button class="glass" type="button" data-u="-1" aria-label="Down">${ICON.down}</button></div>`);
  root.append(stick, updown);

  // ---------------------------------------------------------------- behaviour
  const ink = modes.querySelector('.mode-ink');
  const setInk = () => {
    root.classList.toggle('can-rise', ['fly', 'swim', 'dive'].includes(player.mode));
    const m = player.mode === 'dive' ? 'swim' : player.mode;
    const b = modes.querySelector(`[data-mode="${m}"]`);
    modes.querySelectorAll('.mode').forEach((x) => x.classList.toggle('on', x === b));
    if (!b) return;
    ink.style.width = `${b.offsetWidth - 26}px`;
    ink.style.transform = `translateX(${b.offsetLeft + 13}px)`;
  };
  let hintT = 0;
  const showHint = (m) => { hint.innerHTML = HINTS[m] || ''; hint.classList.remove('gone'); hintT = 7; };
  modes.addEventListener('click', (e) => { const b = e.target.closest('.mode'); if (b) player.setMode(b.dataset.mode); });
  const prevOnMode = player.onMode;
  player.onMode = (m, prev) => { prevOnMode?.(m, prev); setInk(); showHint(m); audio?.mode(m); };

  const setWeatherBtns = () => weather.querySelectorAll('.ibtn').forEach((b) => b.classList.toggle('on', env.autoWeather ? b.dataset.w === 'auto' : b.dataset.w === env.weather));
  weather.addEventListener('click', (e) => {
    const b = e.target.closest('.ibtn');
    if (!b) return;
    if (b.dataset.w === 'auto') env.autoWeather = true;
    else { env.autoWeather = false; env.setWeather(b.dataset.w); }
    setWeatherBtns();
  });

  const play = clock.querySelector('.play');
  const setPlay = () => { play.innerHTML = env.auto ? ICON.pause : ICON.play; play.setAttribute('aria-label', env.auto ? 'Pause time' : 'Let time run'); };
  play.addEventListener('click', () => { env.auto = !env.auto; setPlay(); });

  // the dial: drag the sun around its path
  const dial = clock.querySelector('.dial');
  const sunEl = dial.querySelector('.sun'), moonEl = dial.querySelector('.moon');
  let dragging = false, wasAuto = false;
  const dialTo = (ev) => {
    const r = dial.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * 76 - 38, y = ((ev.clientY - r.top) / r.height) * 46 - 38;
    let a = Math.atan2(-y, x); // pi at sunrise (left), 0 at sunset (right)
    let hrs = 6 + ((Math.PI - a) / Math.PI) * 12;
    hrs = ((hrs % 24) + 24) % 24;
    env.setHours(hrs);
  };
  dial.addEventListener('pointerdown', (ev) => { dragging = true; wasAuto = env.auto; env.auto = false; dial.setPointerCapture(ev.pointerId); dialTo(ev); });
  dial.addEventListener('pointermove', (ev) => dragging && dialTo(ev));
  dial.addEventListener('pointerup', () => { dragging = false; env.auto = wasAuto; });

  let photo = false;
  const setPhoto = (on) => {
    photo = on;
    root.classList.toggle('photo', on);
    icons.querySelector('[data-act="photo"]').classList.toggle('on', on);
    flash(on ? 'Photo mode &middot; H to return' : '');
  };
  let toastT = 0;
  const flash = (msg) => { toast.innerHTML = msg; toast.classList.toggle('show', !!msg); toastT = 3.5; };
  const togglePanel = (on = !panel.classList.contains('open')) => {
    panel.classList.toggle('open', on);
    root.classList.toggle('panel-open', on);
    root.querySelectorAll('[data-act="info"]').forEach((b) => b.classList.toggle('on', on));
  };
  const setSound = () => root.querySelectorAll('[data-act="sound"]').forEach((b) => { b.innerHTML = audio?.muted ? ICON.mute : ICON.sound; });
  for (const el of [icons, corner]) el.addEventListener('click', (e) => {
    const b = e.target.closest('.ibtn');
    if (!b) return;
    if (b.dataset.act === 'photo') setPhoto(!photo);
    if (b.dataset.act === 'info') togglePanel();
    if (b.dataset.act === 'sound') { audio?.toggle(); setSound(); }
  });

  window.addEventListener('keydown', (e) => {
    if (!entered) { if (e.key === 'Enter' && !enterBtn.disabled) enter(); return; }
    const k = e.key.toLowerCase();
    if (k >= '1' && k <= '5') player.setMode(MODES[+k - 1]);
    else if (k === 'h') setPhoto(!photo);
    else if (k === 'i') togglePanel();
    else if (k === 'm') { audio?.toggle(); setSound(); }
    else if (k === 't') { env.auto = !env.auto; setPlay(); }
    else if (k === '[' || k === ']') env.setHours((env.hours + (k === ']' ? 0.5 : -0.5) + 24) % 24);
    else if (k === 'escape') { if (photo) setPhoto(false); togglePanel(false); }
  });

  if (touch) {
    let sid = null, c0 = null;
    const knob = stick.querySelector('i');
    stick.addEventListener('pointerdown', (e) => { sid = e.pointerId; c0 = stick.getBoundingClientRect(); stick.setPointerCapture(sid); });
    stick.addEventListener('pointermove', (e) => {
      if (e.pointerId !== sid) return;
      const dx = (e.clientX - (c0.left + c0.width / 2)) / 50, dy = (e.clientY - (c0.top + c0.height / 2)) / 50;
      const l = Math.max(1, Math.hypot(dx, dy));
      player.input.mx = dx / l; player.input.mz = -dy / l;
      player.input.run = Math.hypot(dx, dy) > 1.3;
      knob.style.transform = `translate(${(dx / l) * 36}px, ${(dy / l) * 36}px)`;
    });
    const end = () => { sid = null; player.input.mx = player.input.mz = 0; player.input.run = false; knob.style.transform = ''; };
    stick.addEventListener('pointerup', end);
    stick.addEventListener('pointercancel', end);
    updown.querySelectorAll('button').forEach((b) => {
      b.addEventListener('pointerdown', () => { player.input.up = +b.dataset.u; });
      b.addEventListener('pointerup', () => { player.input.up = 0; });
      b.addEventListener('pointerleave', () => { player.input.up = 0; });
    });
    const canvas = document.getElementById('c');
    const looks = new Map();
    canvas.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') looks.set(e.pointerId, [e.clientX, e.clientY]); });
    canvas.addEventListener('pointermove', (e) => {
      const p = looks.get(e.pointerId);
      if (!p) return;
      player.input.look[0] += (e.clientX - p[0]) * 1.4; player.input.look[1] += (e.clientY - p[1]) * 1.4;
      p[0] = e.clientX; p[1] = e.clientY;
    });
    const lend = (e) => looks.delete(e.pointerId);
    canvas.addEventListener('pointerup', lend);
    canvas.addEventListener('pointercancel', lend);
  }

  // ---------------------------------------------------------------- intro
  const enterBtn = intro.querySelector('.intro-enter');
  const bar = intro.querySelector('.intro-bar i');
  const stage = intro.querySelector('.intro-stage');
  let entered = false;
  function progress(f, label) {
    bar.style.transform = `scaleX(${f})`;
    if (label) stage.textContent = label;
  }
  function ready() {
    progress(1, 'Ready');
    intro.classList.add('ready');
    enterBtn.disabled = false;
    enterBtn.focus({ preventScroll: true });
  }
  function enter() {
    if (entered) return;
    entered = true;
    intro.classList.add('leaving');
    setTimeout(() => intro.remove(), 2400);
    root.classList.add('on');
    setInk();
    setPlay();
    setWeatherBtns();
    setSound();
    showHint(player.mode);
    onEnter?.();
  }
  enterBtn.addEventListener('click', enter);

  // ---------------------------------------------------------------- per frame
  let lastMin = -1, placeT = 0, curPoi = null, poiT = 0, arriveT = 0;
  const seen = new Map();
  function phase() {
    const el = (Math.asin(Math.max(-1, Math.min(1, U.uTrueSun.value.y))) * 180) / Math.PI;
    const hr = env.hours;
    if (el > 30) return hr < 10.5 ? 'Morning' : hr < 14.5 ? 'Midday' : 'Afternoon';
    if (el > 8) return hr < 12 ? 'Morning' : 'Late afternoon';
    if (el > 0) return 'Golden hour';
    if (el > -4) return hr < 12 ? 'Sunrise' : 'Sunset';
    if (el > -12) return 'Blue hour';
    return U.uBiolum.value > 0.5 ? 'Night &middot; the sea glows' : 'Night';
  }
  function update(dt) {
    if (!entered) return;
    // clock and dial
    const hrs = env.hours;
    const min = Math.floor(hrs * 60);
    if (min !== lastMin) {
      lastMin = min;
      clock.querySelector('.clock-time').textContent = `${pad(Math.floor(hrs) % 24)}:${pad(min % 60)}`;
      clock.querySelector('.clock-phase').innerHTML = phase();
      const a = Math.PI - ((hrs - 6) / 12) * Math.PI;
      sunEl.setAttribute('cx', 38 + Math.cos(a) * 30);
      sunEl.setAttribute('cy', 38 - Math.sin(a) * 30);
      moonEl.setAttribute('cx', 38 - Math.cos(a) * 30);
      moonEl.setAttribute('cy', 38 + Math.sin(a) * 30);
      sunEl.style.opacity = Math.sin(a) > -0.05 ? 1 : 0.25;
      moonEl.style.opacity = Math.sin(a) < 0.05 ? 0.9 : 0;
    }
    // compass
    const me = camera.matrixWorld.elements;
    const hd = ((Math.atan2(-me[8], me[10]) * 180) / Math.PI + 360) % 360;
    strip.style.transform = `translate3d(${110 - (hd + 360) * PX}px,0,0)`;
    // readouts at a few hertz
    placeT -= dt;
    if (placeT <= 0) {
      placeT = 0.25;
      degEl.textContent = `${String(Math.round(hd) % 360).padStart(3, '0')}°`;
      const pl = player.place();
      const y = camera.position.y;
      const name = pl.poi ? pl.poi.name : y > 180 ? 'Above Halcyon' : player.floorAt(camera.position.x, camera.position.z) > 0.5 ? 'Inland' : 'Open water';
      let read;
      if (player.mode === 'dive') read = `Depth ${(-y).toFixed(1)} m`;
      else if (player.mode === 'swim') read = 'At the surface';
      else if (player.mode === 'sail') read = `${(Math.abs(player.boat.v) * 1.944).toFixed(1)} kn`;
      else read = `${Math.max(0, y - Math.max(player.floorAt(camera.position.x, camera.position.z), 0)).toFixed(0)} m up`;
      placeEl.innerHTML = `<b>${name}</b> &nbsp;&middot;&nbsp; ${read}`;
      // a place announces itself once you have been in it a moment, and not again for a while
      const id = pl.poi?.id || null;
      if (id !== curPoi) { curPoi = id; poiT = 0; }
      else if (id) {
        poiT += 0.25;
        if (poiT > 1.2 && arriveT <= 0 && (!seen.has(id) || performance.now() - seen.get(id) > 90000)) {
          seen.set(id, performance.now());
          showArrive(pl.poi);
        }
      }
    }
    if (arriveT > 0) {
      arriveT -= dt;
      if (arriveT < 1.6 && !arrive.classList.contains('leave')) arrive.classList.add('leave');
      if (arriveT <= 0) arrive.classList.remove('show', 'leave');
    }
    if (hintT > 0) { hintT -= dt; if (hintT <= 0) hint.classList.add('gone'); }
    if (toastT > 0) { toastT -= dt; if (toastT <= 0 && !photo) toast.classList.remove('show'); if (toastT <= 0 && photo) toast.classList.remove('show'); }
  }
  function showArrive(p) {
    arrive.classList.remove('show', 'leave');
    arrive.querySelector('.arrive-k').textContent = ['Arriving', 'You are at', 'Here'][Math.floor(Math.random() * 3)];
    const t = arrive.querySelector('.arrive-t');
    // words reveal in turn; the second word leans into italic
    t.innerHTML = p.name.split(' ').map((w, i) => `<span style="transition-delay:${0.1 + i * 0.14}s${i === 1 ? ';font-style:italic' : ''}">${w}${i < p.name.split(' ').length - 1 ? ' ' : ''}</span>`).join('');
    arrive.querySelector('.arrive-s').textContent = p.sub;
    void arrive.offsetWidth;
    arrive.classList.add('show');
    arriveT = 7;
  }
  window.addEventListener('resize', setInk);
  return { progress, ready, enter, update, get entered() { return entered; } };
}
