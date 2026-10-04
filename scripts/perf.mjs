// Headed frame-time measurement and screenshots at the real display setup (1920x1080 @2x by default).
// usage: node scripts/perf.mjs '<json>'
//   { "url": "...", "w": 1920, "h": 1080, "dpr": 2, "wait": 8,
//     "steps": [ { "eval": "js", "measure": 4, "shot": "name.png", "sleep": 2 } ], "out": "dir" }
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const arg = process.argv[2] || '{}';
const cfg = JSON.parse(arg.startsWith('@') ? (await import('node:fs')).readFileSync(arg.slice(1), 'utf8') : arg);
const out = cfg.out || join(process.cwd(), '.cache', 'shots');
mkdirSync(out, { recursive: true });
const exe = join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

const browser = await chromium.launch({
  headless: cfg.headless ?? false,
  executablePath: exe,
  args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--window-size=${cfg.w || 1920},${(cfg.h || 1080) + 90}`,
    // unlocked frame rate: frame time then measures the real cost instead of snapping to vsync
    ...(cfg.novsync ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []), ...(cfg.args || [])],
});
const ctx = await browser.newContext({ viewport: { width: cfg.w || 1920, height: cfg.h || 1080 }, deviceScaleFactor: cfg.dpr || 2, isMobile: !!cfg.mobile, hasTouch: !!cfg.mobile });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => { const t = m.text(); if (cfg.allLogs || /\[ha\]|rror|WARN|warn|ERROR/.test(t)) logs.push(`${m.type()}: ${t}`.slice(0, cfg.logLen || 1500)); });
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
page.on('crash', () => { logs.push('CRASH'); if (cfg.dumpOnCrash) console.log(logs.join('\n')); });
if (cfg.stream) page.on('console', (m) => { if (/\[ha\]/.test(m.text())) console.log('stream: ' + m.text()); });
const t0 = Date.now();
await page.goto(cfg.url || 'http://127.0.0.1:5280/', { waitUntil: 'load' });
for (const [sec, name] of cfg.early || []) { await page.waitForTimeout(sec * 1000); await page.screenshot({ path: join(out, name) }); }
let ready = true;
try { await page.waitForFunction(() => window.__ha, null, { timeout: cfg.timeout || 90000 }); } catch { ready = false; }
const bootMs = Date.now() - t0;
await page.waitForTimeout((cfg.wait ?? 6) * 1000);

const results = [];
if (ready) for (const s of cfg.steps || [{ measure: 4, shot: 'shot.png' }]) {
  if (cfg.trace) console.error(`[step +${((Date.now() - t0) / 1000).toFixed(1)}s] ${s.label || (s.eval || '').slice(0, 60) || (s.sleep ? 'sleep ' + s.sleep : '')}`);
  if (s.eval) results.push({ eval: await page.evaluate(s.eval).catch((e) => 'ERR ' + e.message) });
  if (s.click) await page.click(s.click);
  if (s.key) await page.keyboard.press(s.key);
  if (s.down) await page.keyboard.down(s.down);
  if (s.up) await page.keyboard.up(s.up);
  if (s.mouse) await page.mouse.move(...s.mouse);
  if (s.sleep) await page.waitForTimeout(s.sleep * 1000);
  if (s.measure) {
    const r = await page.evaluate(async (sec) => {
      const t = [];
      let last = performance.now();
      const start = last, end = last + sec * 1000;
      // frames over 20 ms and the render scale in each second: tells a governor settling apart from steady stutter
      const tl = Array.from({ length: Math.ceil(sec) }, () => [0, 0]);
      await new Promise((res) => {
        // n is the frame's start time, which can precede start
        const f = (n) => {
          const dt = n - last; t.push(dt); last = n;
          const b = tl[Math.min(tl.length - 1, Math.max(0, Math.floor((n - start) / 1000)))];
          if (dt > 20) b[0]++;
          b[1] = +window.__ha.pipe.scale.toFixed(2);
          if (n < end) requestAnimationFrame(f); else res();
        };
        requestAnimationFrame(f);
      });
      t.sort((a, b) => a - b);
      const q = (p) => +t[Math.min(t.length - 1, Math.floor(p * t.length))].toFixed(1);
      const ha = window.__ha;
      const info = ha.pipe.renderer.info;
      const mean = t.reduce((a, b) => a + b, 0) / t.length;
      return { n: t.length, mean: +mean.toFixed(2), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1), over20: +((t.filter((x) => x > 20).length / t.length) * 100).toFixed(1), scale: +ha.pipe.scale.toFixed(2), W: ha.pipe.W, H: ha.pipe.H, calls: info.render.calls, tris: info.render.triangles, programs: info.programs.length, tl: tl.map(([m, sc]) => `${m}@${sc}`).join(' ') };
    }, s.measure);
    results.push({ step: s.label || s.eval || 'measure', ...r });
  }
  if (s.shot) await page.screenshot({ path: join(out, s.shot), ...(s.clip ? { clip: { x: s.clip[0], y: s.clip[1], width: s.clip[2], height: s.clip[3] } } : {}) });
}
else await page.screenshot({ path: join(out, 'boot-fail.png') });
console.log(JSON.stringify({ ready, bootMs, results, logs: logs.slice(-(cfg.nlogs || 20)) }, null, 1));
await browser.close();
