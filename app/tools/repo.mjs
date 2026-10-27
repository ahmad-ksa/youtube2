// Usage: node tools/repo.mjs <ipkFile> <outDir>
// Writes the Homebrew Channel manifest + repository index (apps.json) for the built ipk.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [ipk, out] = process.argv.slice(2);
const REPO = 'ahmad-ksa/youtube2';
const RAW = `https://raw.githubusercontent.com/${REPO}/repo`;
const m = path.basename(ipk).match(/^(.+)_(\d+\.\d+\.\d+)_all\.ipk$/);
if (!m) throw new Error('bad ipk name ' + ipk);
const [, id, version] = m;
const ipkName = path.basename(ipk);
fs.mkdirSync(out, { recursive: true });

const manifest = {
  id,
  version,
  type: 'web',
  title: 'YouTube LG',
  appDescription: 'مشغل يوتيوب بأعلى جودة بدون إعلانات (مثل SmartTube)',
  iconUri: `${RAW}/icon.png`,
  sourceUrl: `https://github.com/${REPO}`,
  rootRequired: false,
  ipkUrl: `https://github.com/${REPO}/releases/download/v${version}/${ipkName}`,
  ipkHash: { sha256: crypto.createHash('sha256').update(fs.readFileSync(ipk)).digest('hex') }
};
fs.writeFileSync(path.join(out, `${id}.manifest.json`), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(out, 'apps.json'), JSON.stringify({
  paging: { page: 1, count: 1, maxPage: 1, itemsTotal: 1 },
  packages: [{
    id, title: manifest.title, iconUri: manifest.iconUri,
    manifestUrl: `${RAW}/${id}.manifest.json`, manifest,
    category: 'multimedia', shortDescription: manifest.appDescription, version
  }]
}, null, 2));
console.log('repo files written', id, version);
