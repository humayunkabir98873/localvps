// Builds the Linux release from any OS with Docker: copies the sources (not node_modules or local data)
// into a node:24-bookworm container, runs `npm ci` there (which compiles node-pty for Linux) and
// `npm run build`, and copies the archive back into dist/.
//
//   npm run build:linux
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const IMAGE = process.env.LOCALVPS_BUILD_IMAGE || 'node:24-bookworm';
fs.mkdirSync(DIST, { recursive: true });

const script = [
  'set -e',
  'mkdir -p /work',
  // Same exclusions as .gitignore: build from what would be committed.
  'tar -C /src --exclude=./node_modules --exclude=./data --exclude=./runtime --exclude=./www --exclude=./conf --exclude=./exports --exclude=./build --exclude=./dist --exclude=./.git -cf - . | tar -C /work -xf -',
  'cd /work',
  'npm ci --no-audit --no-fund --foreground-scripts',
  'npm run build',
  'cp dist/*.tar.gz /out/',
].join(' && ');

console.log(`Building the Linux release in ${IMAGE}…`);
execFileSync('docker', [
  'run', '--rm',
  '-v', `${ROOT}:/src:ro`,
  '-v', `${DIST}:/out`,
  IMAGE, 'bash', '-c', script,
], { stdio: 'inherit' });
console.log(`Done: ${fs.readdirSync(DIST).filter((f) => f.includes('linux')).map((f) => path.join('dist', f)).join(', ')}`);
