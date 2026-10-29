import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isSea } from 'node:sea';

// Packaged as LocalVPS.exe (Node single-executable app), everything lives next to the exe;
// from source, the root is two levels above this file.
export const IS_SEA = isSea();
export const ROOT = IS_SEA
  ? path.dirname(process.execPath)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const j = (...p) => path.join(ROOT, ...p);

export const P = {
  root: ROOT,
  ui: j('ui'),
  runtime: j('runtime'),
  data: j('data'),
  logs: j('data', 'logs'),
  tmp: j('data', 'tmp'),
  mariadbData: j('data', 'mariadb'),
  nginxPrefix: j('data', 'nginx'),
  conf: j('conf'),
  nginxConf: j('conf', 'nginx'),
  www: j('www'),
  exports: j('exports'),
};

// nginx and php.ini on Windows both accept forward slashes, and they avoid escaping trouble.
export const fwd = (p) => p.replace(/\\/g, '/');

export function ensureDirs() {
  for (const d of [P.runtime, P.data, P.logs, P.tmp, path.join(P.tmp, 'sessions'), path.join(P.tmp, 'uploads'),
    P.conf, P.nginxConf, path.join(P.nginxConf, 'sites'), P.www, P.exports,
    path.join(P.nginxPrefix, 'logs'), path.join(P.nginxPrefix, 'temp'), path.join(P.logs, 'sites')]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

// Resolve a user-supplied relative path and refuse anything that escapes `base`.
export function safeJoin(base, rel) {
  const full = path.resolve(base, rel);
  const b = path.resolve(base) + path.sep;
  if (!(full + path.sep).startsWith(b)) throw httpError(400, 'Path escapes allowed directory');
  return full;
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
