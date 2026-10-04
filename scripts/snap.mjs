// Evaluate an async expression in the running app that resolves to a data URL, and save it as a file.
// usage: node scripts/snap.mjs <out.png> '<expression>' [url]
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
const [out, expr, url = 'http://127.0.0.1:5280/?h=10'] = process.argv.slice(2);
const exe = join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const browser = await chromium.launch({ headless: false, executablePath: exe, args: ['--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 800, height: 450 } })).newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(url);
await page.waitForFunction(() => window.__ha, null, { timeout: 90000 });
const dataUrl = await page.evaluate(expr);
writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
console.log('saved', out);
await browser.close();
