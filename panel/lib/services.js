import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import mysql from 'mysql2/promise';
import { P } from './paths.js';
import { getState, saveState, getSecrets, saveSecrets, svcState } from './state.js';
import { run, runOk, sleep, portFree, waitForPort, processTable, killTree, randomPassword } from './util.js';
import { writeNginxConfig, writePhpIni, writeMyIni, writeFpmConf, mariadbSocket, phpPortBase } from './config.js';
import { nodeRuntime } from './tooling.js';
import { IS_WIN, IS_LINUX } from './platform.js';
import { nginxBin, mariaBin, mariaBaseDir, phpServerBin, phpUsesFpm } from './bins.js';

const IS_ROOT = process.getuid?.() === 0;

// Process names that prove a recorded PID still belongs to the service (guards against PID reuse).
// Unix names vary: Debian's php-fpm8.4, Next's "next-server" title, MariaDB's older mysqld.
const NAME_MATCH = IS_WIN
  ? { nginx: (n) => n === 'nginx.exe', mariadb: (n) => n === 'mariadbd.exe', php: (n) => n === 'php-cgi.exe', app: (n) => n === 'node.exe' }
  : { nginx: (n) => n.startsWith('nginx'), mariadb: (n) => n.startsWith('mariadbd') || n.startsWith('mysqld'), php: (n) => n.startsWith('php'), app: (n) => n.startsWith('node') || n.startsWith('next') };
const kindOf = (key) => (key.startsWith('php-') ? 'php' : key.startsWith('app-') ? 'app' : key);
const owns = (key, entry) => Boolean(entry) && NAME_MATCH[kindOf(key)](entry.name);
const appSite = (key) => getState().sites.find((s) => `app-${s.name}` === key);

// Start a process that outlives the panel, like a daemon on a VPS.
function spawnDaemon(exe, args, logFile, extraEnv = {}, cwd = path.dirname(exe)) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, 'a');
  const child = spawn(exe, args, {
    cwd,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, ...extraEnv },
  });
  child.unref();
  fs.closeSync(out);
  return child.pid;
}

export function serviceKeys() {
  const st = getState();
  const keys = [];
  if (st.components.nginx) keys.push('nginx');
  if (st.components.mariadb) keys.push('mariadb');
  for (const b of Object.keys(st.components.php)) keys.push(`php-${b}`);
  for (const s of st.sites) if (s.type === 'node') keys.push(`app-${s.name}`);
  return keys;
}

// ---------- nginx ----------
const nginxExe = () => nginxBin();
// -e moves nginx's startup error log off the distro default (/var/log/nginx), which is not writable unprivileged.
function nginxArgs(extra = []) {
  return ['-p', P.nginxPrefix + path.sep, '-c', path.join(P.nginxConf, 'nginx.conf'), '-e', path.join(P.logs, 'nginx-error.log'), ...extra];
}

export async function nginxTest() {
  writeNginxConfig();
  const r = await run(nginxExe(), nginxArgs(['-t']), { cwd: path.dirname(nginxExe()) });
  return { ok: r.code === 0, output: (r.stderr + r.stdout).trim() };
}

async function startNginx() {
  const { httpPort, lan } = getState().settings;
  const t = await nginxTest();
  if (!t.ok) throw new Error(`nginx config test failed:\n${t.output}`);
  if (IS_LINUX && httpPort < 1024 && !IS_ROOT) {
    throw new Error(`Port ${httpPort} needs root on Linux. Use 8080 in Settings, or allow it once with: sudo setcap cap_net_bind_service=+ep ${nginxExe()}`);
  }
  if (!(await portFree(httpPort, lan ? '0.0.0.0' : '127.0.0.1'))) {
    throw new Error(`Port ${httpPort} is already in use (${IS_WIN ? 'IIS, Skype' : 'a system nginx/Apache'} or another web server?). Change the HTTP port in Settings.`);
  }
  const pidFile = path.join(P.nginxPrefix, 'logs', 'nginx.pid');
  fs.rmSync(pidFile, { force: true }); // a stale file from a crash would be read as the new PID
  // Windows nginx never daemonizes; on unix keep it in the foreground of its own detached process group.
  spawnDaemon(nginxExe(), nginxArgs(IS_WIN ? [] : ['-g', 'daemon off;']), path.join(P.logs, 'nginx-console.log'));
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (pid) return [pid];
    }
  }
  throw new Error('nginx did not write a PID file; see logs/nginx-error.log');
}

async function stopNginx(pids) {
  await run(nginxExe(), nginxArgs(['-s', 'quit']), { cwd: path.dirname(nginxExe()) });
  await waitGone(pids, 5000);
  for (const pid of pids) await killTree(pid).catch(() => {});
  fs.rmSync(path.join(P.nginxPrefix, 'logs', 'nginx.pid'), { force: true });
}

export async function reloadNginx() {
  const s = svcState('nginx');
  if (!(await isRunning('nginx'))) return { reloaded: false };
  const t = await nginxTest();
  if (!t.ok) throw new Error(`nginx config test failed, keeping the old config running:\n${t.output}`);
  await runOk(nginxExe(), nginxArgs(['-s', 'reload']), { cwd: path.dirname(nginxExe()) });
  s.error = null;
  return { reloaded: true };
}

// ---------- MariaDB ----------

export function mariadbInitialized() {
  return fs.existsSync(path.join(P.mariadbData, 'mysql'));
}

async function initMariadb() {
  const secrets = getSecrets();
  const port = getState().settings.mariadbPort;
  if (fs.existsSync(P.mariadbData) && fs.readdirSync(P.mariadbData).length) {
    throw new Error(`${P.mariadbData} is not empty but has no system tables. Move it away and start again.`);
  }
  secrets.mariadbRoot = secrets.mariadbRoot || randomPassword(24);
  if (IS_WIN) {
    await runOk(mariaBin('installDb'), [`--datadir=${P.mariadbData}`, `--password=${secrets.mariadbRoot}`, `--port=${port}`]);
    secrets.mariadbRootSet = true;
  } else {
    // The unix installer has no --password: start with a passwordless root, then lock it on first start.
    await runOk(mariaBin('installDb'), [
      '--no-defaults', `--datadir=${P.mariadbData}`, `--basedir=${mariaBaseDir()}`,
      '--auth-root-authentication-method=normal', '--skip-test-db', ...(IS_ROOT ? ['--user=root'] : []),
    ]);
    secrets.mariadbRootSet = false;
  }
  saveSecrets();
}

// Set the generated root password (unix first start) over the local socket, and allow root over TCP
// from loopback, which the panel uses.
async function secureRoot() {
  const pw = getSecrets().mariadbRoot;
  const c = await mysql.createConnection({ socketPath: mariadbSocket(), user: 'root', password: '' });
  try {
    await c.query("ALTER USER 'root'@'localhost' IDENTIFIED BY ?", [pw]);
    for (const host of ['127.0.0.1', '::1']) {
      await c.query("CREATE USER IF NOT EXISTS 'root'@? IDENTIFIED BY ?", [host, pw]);
      await c.query("GRANT ALL PRIVILEGES ON *.* TO 'root'@? WITH GRANT OPTION", [host]);
    }
    await c.query('FLUSH PRIVILEGES');
  } finally {
    await c.end().catch(() => {});
  }
  getSecrets().mariadbRootSet = true;
  saveSecrets();
}

async function startMariadb() {
  const { mariadbPort, lan } = getState().settings;
  if (!mariadbInitialized()) await initMariadb();
  if (!(await portFree(mariadbPort, lan ? '0.0.0.0' : '127.0.0.1'))) {
    throw new Error(`Port ${mariadbPort} is already in use (another MySQL/MariaDB?). Change the MariaDB port in Settings.`);
  }
  const ini = writeMyIni();
  const args = [`--defaults-file=${ini}`, ...(IS_WIN ? ['--console'] : IS_ROOT ? ['--user=root'] : [])];
  const pid = spawnDaemon(mariaBin('server'), args, path.join(P.logs, 'mariadb-console.log'));
  if (!(await waitForPort(mariadbPort, '127.0.0.1', 30000))) {
    throw new Error('MariaDB did not start listening within 30s; see logs/mariadb.err');
  }
  if (getSecrets().mariadbRootSet === false) await secureRoot();
  return [pid];
}

export function rootConnectionOptions(extra = {}) {
  return {
    host: '127.0.0.1',
    port: getState().settings.mariadbPort,
    user: 'root',
    password: getSecrets().mariadbRoot,
    ...extra,
  };
}

async function stopMariadb(pids) {
  try {
    const c = await mysql.createConnection(rootConnectionOptions({ connectTimeout: 3000 }));
    await c.query('SHUTDOWN');
    await c.end().catch(() => {});
  } catch { /* fall through to the hard stop */ }
  if (!(await waitGone(pids, 15000))) for (const pid of pids) await killTree(pid).catch(() => {});
}

// ---------- PHP: php-cgi pools (Windows) / php-fpm (macOS, Linux) ----------
const phpExe = (branch) => phpServerBin(branch);

function spawnPhpWorker(branch, i, ini) {
  const port = phpPortBase(branch) + i;
  return spawnDaemon(phpExe(branch), ['-b', `127.0.0.1:${port}`, '-c', ini],
    path.join(P.logs, `php-${branch}-cgi.log`),
    // php-cgi otherwise exits after 500 requests; the watchdog would restart it but this avoids churn.
    { PHP_FCGI_MAX_REQUESTS: '0', PHPRC: path.dirname(ini) });
}

async function startFpm(branch) {
  const ini = writePhpIni(branch);
  const conf = writeFpmConf(branch);
  const port = phpPortBase(branch);
  if (!(await portFree(port))) throw new Error(`PHP ${branch} port ${port} is already in use`);
  const pid = spawnDaemon(phpExe(branch), ['-F', '-y', conf, '-c', ini, ...(IS_ROOT ? ['-R'] : [])],
    path.join(P.logs, `php-${branch}-fpm-console.log`), { PHPRC: path.dirname(ini) });
  if (!(await waitForPort(port, '127.0.0.1', 8000))) {
    await killTree(pid).catch(() => {});
    throw new Error(`php-fpm ${branch} did not start; see logs/php-${branch}-fpm.log`);
  }
  return [pid];
}

async function startPhp(branch) {
  if (phpUsesFpm(branch)) return startFpm(branch);
  const ini = writePhpIni(branch);
  const pool = getState().settings.phpPoolSize;
  const pids = [];
  for (let i = 0; i < pool; i++) {
    const port = phpPortBase(branch) + i;
    if (!(await portFree(port))) throw new Error(`PHP ${branch} port ${port} is already in use`);
    pids.push(spawnPhpWorker(branch, i, ini));
  }
  if (!(await waitForPort(phpPortBase(branch), '127.0.0.1', 8000))) {
    const log = path.join(P.logs, `php-${branch}-cgi.log`);
    throw new Error(`php-cgi ${branch} did not start. Missing Visual C++ redistributable? See ${log}`);
  }
  return pids;
}

async function stopPids(pids) {
  for (const pid of pids) await killTree(pid).catch(() => {});
  await waitGone(pids, 3000);
}

// ---------- Node app sites (Next.js dev server) ----------
// Spawn next's own JS entry with the panel's node.exe: a stable PID with no cmd.exe/npm wrapper in between.
async function startApp(key) {
  const site = appSite(key);
  if (!site) throw new Error(`No Node site for ${key}`);
  const root = path.join(P.www, site.name);
  const nextBin = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!fs.existsSync(nextBin)) throw new Error(`Next.js is not installed in ${root}. Run "npm install" there (Shell button).`);
  if (!(await portFree(site.appPort))) throw new Error(`App port ${site.appPort} is already in use. Change it in the site's settings.`);
  const node = nodeRuntime();
  if (!node) throw new Error('Install Node.js on the Components page to run Next.js sites');
  const pid = spawnDaemon(node.exe, [nextBin, 'dev', '-p', String(site.appPort), '-H', '127.0.0.1'],
    path.join(P.logs, `app-${site.name}.log`), { NEXT_TELEMETRY_DISABLED: '1', PORT: String(site.appPort) }, root);
  if (!(await waitForPort(site.appPort, '127.0.0.1', 60000))) {
    await killTree(pid).catch(() => {});
    throw new Error(`Next.js did not start listening on ${site.appPort}; see logs/app-${site.name}.log`);
  }
  return [pid];
}

// ---------- generic lifecycle ----------
async function waitGone(pids, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const table = await processTable();
    if (!pids.some((p) => table.has(p))) return true;
    await sleep(250);
  }
  return false;
}

async function alivePids(key, table) {
  const s = svcState(key);
  const t = table || (await processTable());
  return (s.pids || []).filter((p) => owns(key, t.get(p)));
}

export async function isRunning(key, table) {
  return (await alivePids(key, table)).length > 0;
}

const locks = new Map();
async function withLock(key, fn) {
  while (locks.get(key)) await locks.get(key);
  const p = fn().finally(() => locks.delete(key));
  locks.set(key, p.catch(() => {}));
  return p;
}

export function start(key) {
  return withLock(key, async () => {
    const s = svcState(key);
    if (await isRunning(key)) { s.desired = 'running'; saveState(); return; }
    let pids;
    try {
      if (key === 'nginx') pids = await startNginx();
      else if (key === 'mariadb') pids = await startMariadb();
      else if (key.startsWith('php-')) pids = await startPhp(key.slice(4));
      else if (key.startsWith('app-')) pids = await startApp(key);
      else throw new Error(`Unknown service ${key}`);
    } catch (err) {
      s.error = err.message;
      saveState();
      throw err;
    }
    Object.assign(s, { desired: 'running', pids, error: null, startedAt: Date.now() });
    saveState();
  });
}

export function stop(key, { keepDesired = false } = {}) {
  return withLock(key, async () => {
    const s = svcState(key);
    const pids = await alivePids(key);
    if (pids.length) {
      if (key === 'nginx') await stopNginx(pids);
      else if (key === 'mariadb') await stopMariadb(pids);
      else await stopPids(pids);
    }
    s.pids = [];
    if (!keepDesired) s.desired = 'stopped';
    s.error = null;
    saveState();
  });
}

export async function restart(key) {
  await stop(key, { keepDesired: true });
  await start(key);
}

// Order matters: PHP before nginx so the first request does not hit a dead upstream.
const ORDER = (k) => (k === 'mariadb' ? 0 : k.startsWith('php-') || k.startsWith('app-') ? 1 : 2);

export async function startAll() {
  const errors = {};
  for (const k of serviceKeys().sort((a, b) => ORDER(a) - ORDER(b))) {
    try { await start(k); } catch (e) { errors[k] = e.message; }
  }
  return errors;
}

export async function stopAll() {
  for (const k of serviceKeys().sort((a, b) => ORDER(b) - ORDER(a))) await stop(k).catch(() => {});
}

export async function statusAll() {
  const table = await processTable();
  const st = getState();
  return serviceKeys().map((key) => {
    const s = svcState(key);
    const alive = (s.pids || []).filter((p) => owns(key, table.get(p)));
    // nginx master's workers are separate processes; count every nginx process for memory.
    const memPids = key === 'nginx' ? [...table].filter(([, v]) => owns('nginx', v)).map(([p]) => p) : alive;
    const memKB = memPids.reduce((a, p) => a + (table.get(p)?.memKB || 0), 0);
    let label;
    let version;
    let port;
    if (key === 'nginx') { label = 'nginx'; version = st.components.nginx.version; port = st.settings.httpPort; }
    else if (key === 'mariadb') { label = 'MariaDB'; version = st.components.mariadb.version; port = st.settings.mariadbPort; }
    else if (key.startsWith('app-')) {
      const site = appSite(key);
      label = `${site.name} · Next.js dev`;
      try {
        version = JSON.parse(fs.readFileSync(path.join(P.www, site.name, 'node_modules', 'next', 'package.json'), 'utf8')).version;
      } catch { version = '?'; }
      port = site.appPort;
    } else {
      const b = key.slice(4);
      const fpm = phpUsesFpm(b);
      label = `PHP ${b} (${fpm ? 'php-fpm' : 'FastCGI'})`;
      version = st.components.php[b].version;
      port = fpm ? phpPortBase(b) : `${phpPortBase(b)}–${phpPortBase(b) + st.settings.phpPoolSize - 1}`;
    }
    return {
      key, label, version, port,
      running: alive.length > 0,
      workers: key.startsWith('php-') && !phpUsesFpm(key.slice(4)) ? `${alive.length}/${st.settings.phpPoolSize}` : null,
      pids: alive,
      memKB,
      desired: s.desired,
      error: s.error,
      startedAt: alive.length ? s.startedAt : null,
    };
  });
}

// ---------- watchdog ----------
const restarts = new Map();

export function startWatchdog() {
  setInterval(async () => {
    let table;
    try { table = await processTable(); } catch { return; }
    for (const key of serviceKeys()) {
      const s = svcState(key);
      if (s.desired !== 'running' || locks.get(key)) continue;
      const alive = await alivePids(key, table);
      if (key.startsWith('php-') && !phpUsesFpm(key.slice(4))) {
        const branch = key.slice(4);
        const pool = getState().settings.phpPoolSize;
        if (alive.length === pool) continue;
        // Respawn only the dead workers, keeping their port slots.
        const ini = path.join(P.conf, 'php', branch, 'php.ini');
        const next = [];
        for (let i = 0; i < pool; i++) {
          const pid = s.pids[i];
          if (pid && owns(key, table.get(pid))) { next.push(pid); continue; }
          if (!(await portFree(phpPortBase(branch) + i))) { next.push(pid); continue; }
          if (!throttle(key)) { s.error = 'Workers keep crashing; watchdog paused. See the PHP logs.'; s.desired = 'stopped'; break; }
          next.push(spawnPhpWorker(branch, i, ini));
        }
        s.pids = next;
        saveState();
      } else if (!alive.length) {
        if (!throttle(key)) { s.error = 'Crashed repeatedly; watchdog gave up. Check the logs.'; s.desired = 'stopped'; saveState(); continue; }
        start(key).catch(() => {});
      }
    }
  }, 5000).unref();
}

function throttle(key) {
  const now = Date.now();
  const list = (restarts.get(key) || []).filter((t) => now - t < 60_000);
  list.push(now);
  restarts.set(key, list);
  return list.length <= 5;
}

export async function autostart() {
  const st = getState();
  if (!st.settings.autostart) return;
  for (const k of serviceKeys().sort((a, b) => ORDER(a) - ORDER(b))) {
    if (svcState(k).desired === 'running') await start(k).catch(() => {});
  }
}
