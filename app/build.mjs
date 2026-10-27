// Builds the webOS app into ./dist (index.html + launcher + user script + assets).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const version = process.env.APP_VERSION || pkg.version;
const out = 'dist';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'webOSUserScripts'), { recursive: true });

const common = {
  bundle: true,
  minify: true,
  legalComments: 'none',
  target: ['chrome79'],
  format: 'iife',
  define: { __APP_VERSION__: JSON.stringify(version) },
  loader: { '.css': 'text' },
  logLevel: 'info'
};

await build({ ...common, entryPoints: ['src/launcher.js'], outfile: path.join(out, 'index.js') });
await build({ ...common, entryPoints: ['src/main.js'], outfile: path.join(out, 'webOSUserScripts', 'userScript.js') });

for (const f of fs.readdirSync('assets')) fs.copyFileSync(path.join('assets', f), path.join(out, f));
const appinfo = JSON.parse(fs.readFileSync('assets/appinfo.json', 'utf8'));
appinfo.version = version;
fs.writeFileSync(path.join(out, 'appinfo.json'), JSON.stringify(appinfo, null, 2));
console.log('built', appinfo.id, version);
