// Builds a portable release for the platform this runs on:
//   Windows -> dist/LocalVPS-<version>-win-x64.zip      (LocalVPS.exe)
//   Linux   -> dist/LocalVPS-<version>-linux-x64.tar.gz (localvps)
//   macOS   -> dist/LocalVPS-<version>-macos-arm64.tar.gz (localvps, ad-hoc signed)
//
//   npm run build
//
// The executable is a Node single-executable application: the panel is bundled with esbuild into one
// CommonJS file, turned into a SEA blob, and injected into a copy of the node binary running this script.
// node-pty is a native addon and cannot live inside the blob, so its runtime files ship beside it.
// Cross-building is not supported (the injected node must match the target), so CI builds on each OS.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const { inject } = require('postject');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const OS_NAME = IS_WIN ? 'win' : IS_MAC ? 'macos' : 'linux';
const ARCH = process.arch;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(ROOT, 'dist');
const APP = path.join(DIST, 'LocalVPS');
const EXE_NAME = IS_WIN ? 'LocalVPS.exe' : 'localvps';
const EXE = path.join(APP, EXE_NAME);
const ARCHIVE = path.join(DIST, `LocalVPS-${pkg.version}-${OS_NAME}-${ARCH}.${IS_WIN ? 'zip' : 'tar.gz'}`);
const TAR = IS_WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const step = (msg) => console.log(`\n\x1b[1;34m==> ${msg}\x1b[0m`);

step(`Building LocalVPS ${pkg.version} for ${OS_NAME}-${ARCH} with node ${process.version}`);
fs.rmSync(BUILD, { recursive: true, force: true });
fs.rmSync(APP, { recursive: true, force: true });
fs.rmSync(ARCHIVE, { force: true });
fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(APP, { recursive: true });

step('Bundling the panel with esbuild');
const bundle = path.join(BUILD, 'localvps.cjs');
await esbuild.build({
  entryPoints: [path.join(ROOT, 'panel', 'server.js')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // Native addon (loaded from disk at runtime) and ws's optional native speedups.
  external: ['node-pty', 'bufferutil', 'utf-8-validate'],
  // paths.js only reads import.meta.url when not packaged; give the bundle a harmless value.
  define: { 'import.meta.url': '"file:///localvps-bundle.cjs"' },
  legalComments: 'none',
  logLevel: 'warning',
});
console.log(`  ${path.relative(ROOT, bundle)} (${(fs.statSync(bundle).size / 1024).toFixed(0)} KB)`);

step('Creating the single-executable blob');
const blob = path.join(BUILD, 'sea-prep.blob');
const seaConfig = path.join(BUILD, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

step(`Injecting into a copy of node ${process.version}`);
fs.copyFileSync(process.execPath, EXE);
fs.chmodSync(EXE, 0o755);
// macOS refuses to run a modified signed binary: strip the signature, inject, then sign ad hoc.
if (IS_MAC) execFileSync('codesign', ['--remove-signature', EXE], { stdio: 'inherit' });
await inject(EXE, 'NODE_SEA_BLOB', fs.readFileSync(blob), { sentinelFuse: SEA_FUSE, ...(IS_MAC ? { machoSegmentName: 'NODE_SEA' } : {}) });
if (IS_MAC) execFileSync('codesign', ['--sign', '-', EXE], { stdio: 'inherit' });

step('Copying the UI and xterm.js');
fs.cpSync(path.join(ROOT, 'ui'), path.join(APP, 'ui'), { recursive: true });
const vendor = path.join(APP, 'ui', 'vendor');
fs.mkdirSync(vendor, { recursive: true });
for (const [from, to] of [
  ['@xterm/xterm/lib/xterm.mjs', 'xterm.mjs'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.mjs', 'addon-fit.mjs'],
]) fs.copyFileSync(path.join(ROOT, 'node_modules', from), path.join(vendor, to));

step('Copying node-pty runtime files');
const ptySrc = path.join(ROOT, 'node_modules', 'node-pty');
const ptyDst = path.join(APP, 'node_modules', 'node-pty');
fs.mkdirSync(ptyDst, { recursive: true });
fs.copyFileSync(path.join(ptySrc, 'package.json'), path.join(ptyDst, 'package.json'));
fs.copyFileSync(path.join(ptySrc, 'LICENSE'), path.join(ptyDst, 'LICENSE'));
fs.cpSync(path.join(ptySrc, 'lib'), path.join(ptyDst, 'lib'), { recursive: true, filter: (f) => !f.endsWith('.map') && !f.endsWith('.test.js') });
const noDebug = (f) => !f.endsWith('.pdb');
const prebuilt = path.join(ptySrc, 'prebuilds', `${process.platform}-${ARCH}`);
if (fs.existsSync(prebuilt)) {
  fs.cpSync(prebuilt, path.join(ptyDst, 'prebuilds', `${process.platform}-${ARCH}`), { recursive: true, filter: noDebug });
  console.log(`  prebuilt binaries: prebuilds/${process.platform}-${ARCH}`);
} else {
  // No prebuild for this platform (Linux): npm compiled it into build/Release during install.
  const release = path.join(ptySrc, 'build', 'Release');
  if (!fs.existsSync(path.join(release, 'pty.node'))) throw new Error(`node-pty has no binary for ${process.platform}-${ARCH}; run "npm ci" with build tools (python3, make, g++) installed`);
  fs.mkdirSync(path.join(ptyDst, 'build', 'Release'), { recursive: true });
  for (const f of fs.readdirSync(release).filter((n) => n.endsWith('.node') || n === 'spawn-helper')) {
    fs.copyFileSync(path.join(release, f), path.join(ptyDst, 'build', 'Release', f));
  }
  console.log('  compiled binaries: build/Release');
}

step('Writing README.txt');
fs.writeFileSync(path.join(APP, 'README.txt'), readme());

step('Smoke test: the executable starts and serves the panel');
await smokeTest();

step(`Packing ${path.relative(ROOT, ARCHIVE)}`);
if (IS_WIN) execFileSync(TAR, ['-a', '-c', '-f', ARCHIVE, '-C', DIST, 'LocalVPS'], { stdio: 'inherit' });
else execFileSync(TAR, ['-czf', ARCHIVE, '-C', DIST, 'LocalVPS'], { stdio: 'inherit' });

const size = (p) => `${(fs.statSync(p).size / 1024 / 1024).toFixed(1)} MB`;
console.log(`\n\x1b[1;32mBuilt\x1b[0m\n  ${path.relative(ROOT, EXE)}  ${size(EXE)}\n  ${path.relative(ROOT, ARCHIVE)}  ${size(ARCHIVE)}`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `archive=${ARCHIVE}\n`);

function readme() {
  const start = IS_WIN
    ? 'Double-click LocalVPS.exe.'
    : IS_MAC
      ? 'Run ./localvps from Terminal in this folder. The first time, macOS may block it because it is not\nnotarized: right-click localvps in Finder, choose Open, then confirm (or run: xattr -dr com.apple.quarantine .).'
      : 'Run ./localvps in this folder.';
  const stack = IS_WIN
    ? 'It downloads nginx, PHP, MariaDB and Node.js from their official sites\n(about 160 MB) into the runtime folder.'
    : IS_MAC
      ? 'It installs nginx, PHP and MariaDB with Homebrew (https://brew.sh is required)\nand downloads Node.js from nodejs.org into the runtime folder.'
      : 'It prepares one sudo command for apt, dnf or pacman (nginx, php-fpm, mariadb),\ntypes it into the panel\'s terminal for you to run, and downloads Node.js from nodejs.org.\nSites default to port 8080 because Linux needs root for ports below 1024.';
  return `LocalVPS ${pkg.version} for ${IS_WIN ? 'Windows' : IS_MAC ? 'macOS' : 'Linux'} (${ARCH})

${start} The control panel opens in your browser at http://127.0.0.1:7171/
(or the next free port). Keep it running while you use the panel; stopping it leaves nginx,
PHP, MariaDB and your Next.js dev servers running. Use "Stop all" in the panel first if you
want everything shut down.

First run: on the Dashboard, click "Install recommended stack". ${stack}

Everything LocalVPS creates stays inside this folder:
  runtime/   downloaded binaries        www/      your sites
  data/      databases, logs, secrets   exports/  deploy bundles
  conf/      generated configs

Options:  ${EXE_NAME} --no-open   (do not open the browser)

${EXE_NAME} is a Node.js ${process.version} single-executable application and is not code-signed${IS_MAC ? '/notarized' : ''}.
Source and issues: https://github.com/humayunkabir98873/localvps
`;
}

// Run the packaged executable on a spare port in a throwaway copy, so the test neither writes into
// dist/ nor collides with a panel already running.
async function smokeTest() {
  const scratch = path.join(BUILD, 'smoke');
  fs.cpSync(APP, scratch, { recursive: true });
  const port = 47171;
  const child = spawn(path.join(scratch, EXE_NAME), ['--no-open'], {
    cwd: scratch, env: { ...process.env, LOCALVPS_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    let page = null;
    for (let i = 0; i < 60 && !page; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const m = out.match(/LocalVPS panel: (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (m) page = await fetch(m[1]).then((r) => r.text()).catch(() => null);
    }
    if (!page || !page.includes('<title>LocalVPS</title>')) throw new Error(`panel did not serve its page. Output:\n${out}`);
    const token = page.match(/name="panel-token" content="([0-9a-f]+)"/)?.[1];
    const base = out.match(/(http:\/\/127\.0\.0\.1:\d+)\//)[1];
    const shells = await fetch(`${base}/api/terminal/shells`, { headers: { 'x-panel-token': token } }).then((r) => r.json());
    const css = await fetch(`${base}/vendor/xterm.css`).then((r) => r.status);
    if (!Array.isArray(shells) || !shells.length) throw new Error(`terminal shells endpoint failed (node-pty not loadable?): ${JSON.stringify(shells)}\n${out}`);
    if (css !== 200) throw new Error('xterm vendor files not served');
    console.log(`  ok: ${base} serves the UI, xterm assets and ${shells.length} terminal shells (node-pty loaded)`);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
