import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
  {
    src: 'shared/sync-core.js',
    dests: ['extension/lib/sync-core.js', 'docs/js/sync-core.js'],
  },
  {
    src: 'shared/gist-client.js',
    dests: ['extension/lib/gist-client.js', 'docs/js/gist-client.js'],
  },
  {
    src: 'shared/qr.js',
    dests: ['extension/lib/qr.js'],
  },
];

const checkOnly = process.argv.includes('--check');
let mismatchCount = 0;

for (const { src, dests } of TARGETS) {
  const srcPath = path.join(ROOT, src);
  const content = fs.readFileSync(srcPath, 'utf8');
  for (const dest of dests) {
    const destPath = path.join(ROOT, dest);
    if (checkOnly) {
      const existing = fs.existsSync(destPath) ? fs.readFileSync(destPath, 'utf8') : null;
      if (existing !== content) {
        console.error(`Out of sync: ${dest} != ${src}`);
        mismatchCount += 1;
      }
    } else {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, content, 'utf8');
      console.log(`Synced ${src} -> ${dest}`);
    }
  }
}

if (checkOnly && mismatchCount > 0) {
  process.exit(1);
}
