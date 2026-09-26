/** Copies static assets (ExtendScript prelude) into dist/ after tsc. Cross-platform. */
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'dist', 'bridge'), { recursive: true });
cpSync(
  join(root, 'src', 'bridge', 'prelude.jsx.txt'),
  join(root, 'dist', 'bridge', 'prelude.jsx.txt')
);
console.log('[build] copied prelude.jsx.txt -> dist/bridge/');
