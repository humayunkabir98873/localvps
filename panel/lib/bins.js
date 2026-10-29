// Where each stack binary lives. Windows components are vendor zips under runtime/ with a fixed layout;
// macOS/Linux components come from Homebrew or the system package manager and record explicit paths (`bins`).
import fs from 'node:fs';
import path from 'node:path';
import { getState } from './state.js';
import { P } from './paths.js';
import { IS_WIN } from './platform.js';

const comps = () => getState().components;

export const nginxBin = () => comps().nginx.bins?.nginx || path.join(comps().nginx.path, 'nginx.exe');
// Directory holding mime.types and fastcgi_params.
export const nginxConfDir = () => comps().nginx.confDir || path.join(comps().nginx.path, 'conf');

const phpRec = (branch) => comps().php[branch];
export const phpCliBin = (branch) => phpRec(branch).bins?.cli || path.join(phpRec(branch).path, 'php.exe');
// Windows serves PHP through php-cgi worker pools; macOS/Linux use php-fpm.
export const phpUsesFpm = (branch) => Boolean(phpRec(branch)?.bins?.fpm);
export const phpServerBin = (branch) => phpRec(branch).bins?.fpm || path.join(phpRec(branch).path, 'php-cgi.exe');
// Base php.ini to derive ours from (may be null on unix if the distro ships none).
export function phpIniBase(branch) {
  const rec = phpRec(branch);
  if (!rec.bins) return path.join(rec.path, 'php.ini-development');
  return rec.bins.ini && fs.existsSync(rec.bins.ini) ? rec.bins.ini : null;
}

// A folder whose `php` is exactly this branch: Debian's /usr/bin/php follows update-alternatives,
// so unix gets a per-branch symlink folder to put first on PATH.
export function phpBinDir(branch) {
  if (IS_WIN || !phpRec(branch)?.bins) return phpRec(branch).path;
  const dir = path.join(P.runtime, 'shims', `php-${branch}`);
  const link = path.join(dir, 'php');
  const target = phpCliBin(branch);
  let current = null;
  try { current = fs.readlinkSync(link); } catch { /* missing */ }
  if (current !== target) {
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(link, { force: true });
    fs.symlinkSync(target, link);
  }
  return dir;
}

const MARIA_WIN = { server: 'mariadbd.exe', installDb: 'mariadb-install-db.exe', client: 'mariadb.exe', dump: 'mariadb-dump.exe' };
export function mariaBin(kind) {
  const rec = comps().mariadb;
  if (rec.bins) {
    if (!rec.bins[kind]) throw new Error(`MariaDB ${kind} binary was not found; reinstall the MariaDB client package`);
    return rec.bins[kind];
  }
  return path.join(rec.path, 'bin', MARIA_WIN[kind]);
}
export const mariaBaseDir = () => comps().mariadb.basedir || comps().mariadb.path;
export const mariaClientDir = () => path.dirname(mariaBin('client'));
