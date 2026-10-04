// Downloads the prebuilt runtime assets (models, plants, surfaces and the mountain's relief, about 560 MB) from the
// GitHub release and unpacks them into public/assets. The pipelines that make them (models.mjs, flora.mjs,
// massif.mjs, textures.mjs) need the raw sources and a few native tools; this is the quick way in.
// usage: npm run assets [-- --force]
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';

const TAG = 'v1.0.0';
const NAME = 'halcyon-assets-1.tar';
const SHA256 = '257bd45086fc4ab8e7da0f8fd1191b8778ead5426897dc93be2efef725e1e5f0';
const URL = `https://github.com/billpwchan/halcyon/releases/download/${TAG}/${NAME}`;
const STAMP = 'public/assets/.bundle';
const TMP = '.cache/' + NAME;

if (!process.argv.includes('--force') && existsSync(STAMP) && readFileSync(STAMP, 'utf8').trim() === SHA256) {
  console.log('Assets are up to date.');
  process.exit(0);
}
mkdirSync('.cache', { recursive: true });

const mb = (n) => (n / 1048576).toFixed(0);
async function download() {
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${URL}`);
  const total = +res.headers.get('content-length') || 0;
  const hash = createHash('sha256');
  const out = createWriteStream(TMP + '.part');
  let got = 0, shown = -1;
  for await (const chunk of Readable.fromWeb(res.body)) {
    hash.update(chunk);
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    got += chunk.length;
    const pct = total ? Math.floor((got / total) * 100) : 0;
    if (pct !== shown && process.stdout.isTTY) { shown = pct; process.stdout.write(`\r  ${mb(got)} / ${mb(total)} MB  ${pct}%`); }
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  if (process.stdout.isTTY) process.stdout.write('\n');
  return hash.digest('hex');
}

const cached = existsSync(TMP) && statSync(TMP).size > 0;
let sum;
if (cached) {
  const h = createHash('sha256');
  h.update(readFileSync(TMP));
  sum = h.digest('hex');
}
if (sum !== SHA256) {
  console.log(`Downloading ${NAME} from the ${TAG} release…`);
  for (let i = 1; ; i++) {
    try { sum = await download(); break; } catch (e) {
      if (i === 3) { console.error(`Download failed: ${e.message}`); process.exit(1); }
      console.log(`  retrying (${e.message})`);
    }
  }
  if (sum !== SHA256) { rmSync(TMP + '.part', { force: true }); console.error('Checksum mismatch: the download is incomplete or altered.'); process.exit(1); }
  renameSync(TMP + '.part', TMP);
}

console.log('Unpacking into public/assets…');
for (const d of ['models', 'flora', 'tex']) rmSync(`public/assets/${d}`, { recursive: true, force: true });
// tar reads this archive on macOS, Linux and Windows 10+ alike
execFileSync('tar', ['-xf', TMP, '-C', 'public'], { stdio: 'inherit' });
writeFileSync(STAMP, SHA256 + '\n');
rmSync(TMP);
console.log('Done. Start the island with: npm run dev');
