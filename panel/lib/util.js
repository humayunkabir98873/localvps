import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { IS_WIN, SYSTEM32, TAR } from './platform.js';

export { SYSTEM32, TAR };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function run(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d; opts.onData?.(String(d)); });
    child.stderr?.on('data', (d) => { stderr += d; opts.onData?.(String(d)); });
    if (opts.input) child.stdin.end(opts.input);
    if (opts.inputFile) fs.createReadStream(opts.inputFile).pipe(child.stdin);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export async function runOk(cmd, args, opts) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    throw new Error(`${path.basename(cmd)} exited with ${r.code}: ${(r.stderr || r.stdout).trim().slice(-2000)}`);
  }
  return r;
}

export function randomPassword(len = 20) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

export function portOpen(port, host = '127.0.0.1', timeout = 500) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export async function waitForPort(port, host, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await portOpen(port, host)) return true;
    await sleep(300);
  }
  return false;
}

// Download with progress and optional hash verification. Writes to dest only once the hash matches.
export async function download(url, dest, { sha256, sha1, onProgress } = {}) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const h256 = crypto.createHash('sha256');
  const h1 = crypto.createHash('sha1');
  let got = 0;
  let lastReport = 0;
  const tmp = dest + '.part';
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    h256.update(chunk); h1.update(chunk);
    got += chunk.length;
    if (onProgress && Date.now() - lastReport > 250) { lastReport = Date.now(); onProgress(got, total); }
  });
  await pipeline(body, fs.createWriteStream(tmp));
  onProgress?.(got, total);
  const actual256 = h256.digest('hex');
  const actual1 = h1.digest('hex');
  if (sha256 && actual256.toLowerCase() !== sha256.toLowerCase()) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`SHA-256 mismatch for ${path.basename(dest)}: expected ${sha256}, got ${actual256}`);
  }
  if (sha1 && actual1.toLowerCase() !== sha1.toLowerCase()) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`SHA-1 mismatch for ${path.basename(dest)}`);
  }
  fs.renameSync(tmp, dest);
  return { sha256: actual256, bytes: got, verified: Boolean(sha256 || sha1) };
}

// Extract a .zip (Windows/macOS bsdtar) or .tar.gz/.tar.xz into dest.
// If the archive has a single top-level folder, its contents are hoisted.
export async function extractArchive(archive, dest) {
  const staging = dest + '.extract';
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  await runOk(TAR, ['-xf', archive, '-C', staging]);
  const entries = fs.readdirSync(staging);
  const src = entries.length === 1 && fs.statSync(path.join(staging, entries[0])).isDirectory()
    ? path.join(staging, entries[0]) : staging;
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  fs.rmSync(staging, { recursive: true, force: true });
}
export const extractZip = extractArchive;

export function tailFile(file, lines = 200) {
  if (!fs.existsSync(file)) return '';
  const size = fs.statSync(file).size;
  const readBytes = Math.min(size, 256 * 1024);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(readBytes);
  fs.readSync(fd, buf, 0, readBytes, size - readBytes);
  fs.closeSync(fd);
  return buf.toString('utf8').split(/\r?\n/).slice(-lines).join('\n');
}

// One tasklist/ps call gives liveness, image name and resident memory for every PID.
// tasklist.exe takes a few hundred ms, so concurrent callers within a second share one result.
let tableCache = { at: 0, promise: null };
// After starting or stopping something, the cached snapshot is stale.
export function invalidateProcessTable() { tableCache = { at: 0, promise: null }; }
export function processTable() {
  if (tableCache.promise && Date.now() - tableCache.at < 1000) return tableCache.promise;
  tableCache = { at: Date.now(), promise: IS_WIN ? readTasklist() : readPs() };
  return tableCache.promise;
}

async function readTasklist() {
  const r = await run(path.join(SYSTEM32, 'tasklist.exe'), ['/FO', 'CSV', '/NH']);
  const map = new Map();
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^"([^"]*)","(\d+)","[^"]*","[^"]*","([^"]*)"/);
    if (m) map.set(Number(m[2]), { name: m[1].toLowerCase(), memKB: Number(m[3].replace(/[^\d]/g, '')) || 0 });
  }
  return map;
}

// macOS prints the full executable path as comm, Linux the (15-char) name; keep the basename.
async function readPs() {
  const r = await run('ps', ['-A', '-o', 'pid=,rss=,comm=']);
  const map = new Map();
  for (const line of r.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (m) map.set(Number(m[1]), { name: path.basename(m[3]).toLowerCase(), memKB: Number(m[2]) || 0 });
  }
  return map;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export async function killTree(pid) {
  if (IS_WIN) {
    await run(path.join(SYSTEM32, 'taskkill.exe'), ['/PID', String(pid), '/T', '/F']);
    return;
  }
  // Services are spawned detached, so each leads its own process group: signal the group, then the PID.
  const signal = (sig) => {
    try { process.kill(-pid, sig); } catch { /* not a group leader */ }
    try { process.kill(pid, sig); } catch { /* already gone */ }
  };
  signal('SIGTERM');
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(150);
  if (alive(pid)) signal('SIGKILL');
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { total += fs.statSync(p).size; } catch { /* ignore */ } }
    }
  }
  return total;
}
