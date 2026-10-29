import fs from 'node:fs';
import path from 'node:path';
import { P, IS_SEA, httpError } from './paths.js';
import { IS_WIN } from './platform.js';
import { phpCliBin, phpBinDir, mariaClientDir, nginxBin } from './bins.js';
import { getState } from './state.js';
import { download, runOk } from './util.js';
import { writePhpIni } from './config.js';

const COMPOSER_URL = 'https://getcomposer.org/download/latest-stable/composer.phar';
export const composerDir = () => path.join(P.runtime, 'composer');
export const composerPhar = () => path.join(composerDir(), 'composer.phar');

// Composer is fetched on first use (SHA-256 checked) and gets a composer.bat shim for the panel's shell.
export async function ensureComposer(ctx) {
  if (fs.existsSync(composerPhar())) return composerPhar();
  fs.mkdirSync(composerDir(), { recursive: true });
  const sha256 = (await (await fetch(`${COMPOSER_URL}.sha256`)).text()).trim().split(/\s+/)[0];
  ctx?.log('Downloading Composer from getcomposer.org');
  await download(COMPOSER_URL, composerPhar(), { sha256 });
  ctx?.log('Composer SHA-256 verified');
  if (IS_WIN) fs.writeFileSync(path.join(composerDir(), 'composer.bat'), '@php "%~dp0composer.phar" %*\r\n');
  else fs.writeFileSync(path.join(composerDir(), 'composer'), '#!/bin/sh\nexec php "$(dirname "$0")/composer.phar" "$@"\n', { mode: 0o755 });
  return composerPhar();
}

// PHP CLI with the same php.ini the site's FastCGI/fpm pool uses.
export function phpCli(branch) {
  const ini = writePhpIni(branch);
  return { exe: phpCliBin(branch), args: ['-c', ini] };
}

export const composerEnv = () => ({ COMPOSER_HOME: path.join(P.data, 'composer'), COMPOSER_NO_INTERACTION: '1' });

export function runPhp(branch, args, opts = {}) {
  const { exe, args: base } = phpCli(branch);
  return runOk(exe, [...base, ...args], { ...opts, env: { ...process.env, ...composerEnv(), ...(opts.env || {}) } });
}

// Node for sites and npm: the managed Node.js component, else (running from source) the panel's own node.
// The packaged LocalVPS.exe cannot stand in for node.exe: it always runs the embedded panel.
// Official Node layouts: Windows has node.exe and node_modules\npm at the top; macOS/Linux use bin/ and lib/.
export function nodeRuntime() {
  const rec = getState().components.node;
  if (rec) {
    const dir = IS_WIN ? rec.path : path.join(rec.path, 'bin');
    return { exe: path.join(dir, IS_WIN ? 'node.exe' : 'node'), dir, home: rec.path, version: rec.version, managed: true };
  }
  if (!IS_SEA) {
    const dir = path.dirname(process.execPath);
    return { exe: process.execPath, dir, home: IS_WIN ? dir : path.dirname(dir), version: process.version.slice(1), managed: false };
  }
  return null;
}

export function requireNode() {
  const rt = nodeRuntime();
  if (!rt) throw httpError(409, 'Install Node.js on the Components page first');
  return rt;
}

// npm/npx are .cmd files on Windows, which Node will not spawn without a shell; run their JS entry points directly.
const npmCli = (rt, name) => path.join(rt.home, ...(IS_WIN ? [] : ['lib']), 'node_modules', 'npm', 'bin', name);
export function runNpx(args, opts = {}) {
  const rt = requireNode();
  return runOk(rt.exe, [npmCli(rt, 'npx-cli.js'), ...args], { ...opts, env: { ...toolEnv(), ...(opts.env || {}) } });
}
export function runNpm(args, opts = {}) {
  const rt = requireNode();
  return runOk(rt.exe, [npmCli(rt, 'npm-cli.js'), ...args], { ...opts, env: { ...toolEnv(), ...(opts.env || {}) } });
}

// Environment for shells and terminals: the stack's php, composer, mariadb, nginx and node first on PATH.
export function toolEnv(phpBranch) {
  const st = getState();
  const php = phpBranch && st.components.php[phpBranch] ? phpBranch : st.settings.defaultPhp;
  const dirs = [];
  if (php && st.components.php[php]) dirs.push(phpBinDir(php));
  if (fs.existsSync(composerDir())) dirs.push(composerDir());
  if (st.components.mariadb) { try { dirs.push(mariaClientDir()); } catch { /* client tools missing */ } }
  if (st.components.nginx) dirs.push(path.dirname(nginxBin()));
  const node = nodeRuntime();
  if (node) dirs.push(node.dir);
  const env = { ...process.env, ...composerEnv(), PATH: [...dirs, process.env.PATH].join(path.delimiter) };
  // Windows env keys are case-insensitive; drop a duplicate "Path" so the new PATH wins.
  for (const k of Object.keys(env)) if (k !== 'PATH' && k.toUpperCase() === 'PATH') delete env[k];
  if (php && st.components.php[php]) env.PHPRC = path.join(P.conf, 'php', php);
  return env;
}

// Set KEY=value in a dotenv file, uncommenting an existing "# KEY=" line when present.
export function setEnvValues(file, values) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`^#?\\s*${key}=.*$`, 'm');
    const line = `${key}=${value}`;
    text = re.test(text) ? text.replace(re, line) : `${text.replace(/\n?$/, '\n')}${line}\n`;
  }
  fs.writeFileSync(file, text);
}
