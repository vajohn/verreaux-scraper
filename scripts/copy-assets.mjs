import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const assets = [
  { from: 'src/state/schema.sql', to: 'dist/state/schema.sql' },
];

for (const { from, to } of assets) {
  const src = resolve(root, from);
  const dst = resolve(root, to);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst);
  console.log(`copied ${from} → ${to}`);
}
