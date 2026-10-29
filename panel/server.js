import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { P, ensureDirs, httpError, safeJoin, IS_SEA } from './lib/paths.js';
import { loadState, getState, saveState, getSecrets } from './lib/state.js';
import * as components from './lib/components.js';
import * as services from './lib/services.js';
import * as sites from './lib/sites.js';
import * as db from './lib/db.js';
import * as exporter from './lib/exporter.js';
import { getJob, listJobs, isStartedJob } from './lib/jobs.js';
import { tailFile, dirSize } from './lib/util.js';
import { IS_WIN, openPath, openUrl, openExternalShell } from './lib/platform.js';
import { writeNginxConfig } from './lib/config.js';
import { toolEnv, nodeRuntime } from './lib/tooling.js';
import { attachTerminal, availableShells } from './lib/terminal.js';

ensureDirs();
loadState();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// ---------- routing ----------
const routes = [];
const route = (method, pattern, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, re, keys, handler, rawBody: Boolean(opts.rawBody) });
};

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

async function readBody(req, limit = 1 << 20) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw httpError(413, 'Request body too large');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw httpError(400, 'Invalid JSON'); }
}

// ---------- system stats ----------
let lastCpu = os.cpus();
let cpuPct = 0;
setInterval(() => {
  const now = os.cpus();
  let idle = 0;
  let total = 0;
  now.forEach((c, i) => {
    const p = lastCpu[i]?.times || c.times;
    const t = (o) => o.user + o.nice + o.sys + o.idle + o.irq;
    idle += c.times.idle - p.idle;
    total += t(c.times) - t(p);
  });
  cpuPct = total ? Math.round(100 * (1 - idle / total)) : 0;
  lastCpu = now;
}, 2000).unref();

function diskInfo() {
  try {
    const s = fs.statfsSync(P.root);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch { return null; }
}

// ---------- routes ----------
route('GET', '/api/overview', async () => {
  const st = getState();
  const svc = await services.statusAll();
  return {
    system: {
      host: os.hostname(), platform: `${os.type()} ${os.release()}`,
      cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, cpuPct,
      memTotal: os.totalmem(), memFree: os.freemem(), uptime: os.uptime(),
      disk: diskInfo(), node: process.version,
    },
    services: svc,
    sites: sites.listSites(),
    components: st.components,
    provider: components.providerInfo(),
    nodeRuntime: nodeRuntime(),
    packaged: IS_SEA,
    settings: st.settings,
    jobs: listJobs().slice(0, 5),
    setupNeeded: !st.components.nginx || !st.components.mariadb || !Object.keys(st.components.php).length,
  };
});

// Services
route('GET', '/api/services', () => services.statusAll());
route('POST', '/api/services/all/:action', async ({ params }) => {
  if (params.action === 'start') return { errors: await services.startAll() };
  if (params.action === 'stop') { await services.stopAll(); return { ok: true }; }
  throw httpError(400, 'Unknown action');
});
route('POST', '/api/services/:key/:action', async ({ params }) => {
  const { key, action } = params;
  if (!services.serviceKeys().includes(key)) throw httpError(404, `Unknown service ${key}`);
  if (action === 'start') await services.start(key);
  else if (action === 'stop') await services.stop(key);
  else if (action === 'restart') await services.restart(key);
  else if (action === 'reload' && key === 'nginx') return services.reloadNginx();
  else throw httpError(400, 'Unknown action');
  return { ok: true };
});
route('GET', '/api/nginx/test', () => services.nginxTest());

// Components
route('GET', '/api/components/catalog', ({ query }) => components.catalog(query.get('refresh') === '1'));
route('POST', '/api/components/install', async ({ body }) => components.installComponent(body));
// macOS/Linux: pick up what Homebrew or the package manager installed.
route('POST', '/api/components/detect', async () => {
  await components.detectComponents();
  if (getState().components.nginx) writeNginxConfig();
  return { components: getState().components };
});
route('POST', '/api/components/remove', async ({ body }) => {
  const key = body.type === 'php' ? `php-${body.branch}` : body.type;
  if (services.serviceKeys().includes(key) && (await services.isRunning(key))) throw httpError(409, 'Stop the service first');
  components.removeComponent(body);
  if (getState().components.nginx) writeNginxConfig();
  return { ok: true };
});

// Sites
route('GET', '/api/sites', () => sites.listSites());
route('POST', '/api/sites', async ({ body }) => sites.createSite(body));
route('PATCH', '/api/sites/:name', async ({ params, body }) => sites.updateSite(params.name, body));
route('DELETE', '/api/sites/:name', async ({ params, query }) => {
  await sites.deleteSite(params.name, { deleteFiles: query.get('files') === '1', dropDb: query.get('db') === '1' });
  return { ok: true };
});
route('GET', '/api/sites/:name/config', ({ params }) => ({ config: sites.getSiteConfig(params.name) }));
route('POST', '/api/sites/:name/open-folder', ({ params }) => {
  openPath(path.join(P.www, sites.findSite(params.name).name));
  return { ok: true };
});

// Separate terminal window with the stack's tools on PATH, like SSHing into the box.
route('POST', '/api/shell', ({ body }) => {
  const cwd = body.site ? path.join(P.www, sites.findSite(body.site).name) : P.www;
  try { openExternalShell(cwd, toolEnv(body.php)); } catch (e) { throw httpError(409, e.message); }
  return { ok: true };
});

// In-browser terminal: sessions run over the /api/terminal WebSocket (see lib/terminal.js).
route('GET', '/api/terminal/shells', () => availableShells().map(({ id, label }) => ({ id, label })));

// Databases
route('GET', '/api/db', async () => ({ databases: await db.listDatabases(), users: await db.listUsers() }));
route('POST', '/api/db', async ({ body }) => db.createDatabase(body));
route('DELETE', '/api/db/:name', async ({ params, query }) => { await db.dropDatabase(params.name, { dropUser: query.get('user') || undefined }); return { ok: true }; });
route('POST', '/api/db/query', async ({ body }) => db.runQuery(body));
route('GET', '/api/db/root-password', () => ({ password: getSecrets().mariadbRoot || null, port: getState().settings.mariadbPort }));
route('POST', '/api/db/:name/export', async ({ params }) => {
  const file = path.join(P.exports, 'db', `${db.checkIdent(params.name)}-${Date.now()}.sql`);
  await db.dumpDatabase(params.name, file);
  return { file: path.relative(P.exports, file).replace(/\\/g, '/') };
});
route('POST', '/api/db/:name/import', async ({ params, req }) => {
  db.checkIdent(params.name);
  const tmp = path.join(P.tmp, `import-${Date.now()}.sql`);
  await pipeline(req, fs.createWriteStream(tmp));
  try { await db.importSql(params.name, tmp); } finally { fs.rmSync(tmp, { force: true }); }
  return { ok: true };
}, { rawBody: true });

// Export / deploy
route('GET', '/api/exports', () => exporter.listExports());
route('POST', '/api/exports', async ({ body }) => exporter.exportSite(body));
route('DELETE', '/api/exports/:id', ({ params }) => { exporter.deleteExport(params.id); return { ok: true }; });
route('GET', '/api/servers', () => exporter.listServers());
route('POST', '/api/servers', ({ body }) => exporter.saveServer(body));
route('DELETE', '/api/servers/:id', ({ params }) => { exporter.deleteServer(params.id); return { ok: true }; });
route('POST', '/api/servers/:id/test', ({ params }) => exporter.testServer(params.id));
route('POST', '/api/deploy', ({ body }) => exporter.deploySite(body));

// Jobs
route('GET', '/api/jobs', () => listJobs());
route('GET', '/api/jobs/:id', ({ params, query }) => {
  const j = getJob(params.id, Number(query.get('since')) || 0);
  if (!j) throw httpError(404, 'Job not found');
  return j;
});

// Logs
function logFiles() {
  const out = [];
  const add = (dir, prefix = '') => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      if (st.isFile()) out.push({ key: prefix + f, size: st.size, mtime: st.mtime.toISOString() });
    }
  };
  add(P.logs);
  add(path.join(P.logs, 'sites'), 'sites/');
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
}
route('GET', '/api/logs', () => logFiles());
route('GET', '/api/logs/tail', ({ query }) => {
  const file = safeJoin(P.logs, query.get('file') || '');
  return { content: tailFile(file, Math.min(Number(query.get('lines')) || 300, 5000)) };
});
route('DELETE', '/api/logs', ({ query }) => {
  const file = safeJoin(P.logs, query.get('file') || '');
  if (fs.existsSync(file)) fs.truncateSync(file, 0);
  return { ok: true };
});

// Files under exports/ (bundles, SQL dumps)
route('GET', '/api/download', ({ query, res }) => {
  const file = safeJoin(P.exports, query.get('file') || '');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw httpError(404, 'File not found');
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': fs.statSync(file).size,
    'content-disposition': `attachment; filename="${path.basename(file)}"`,
  });
  fs.createReadStream(file).pipe(res);
  return undefined;
});

// Settings
route('GET', '/api/settings', () => ({ settings: getState().settings, paths: { root: P.root, www: P.www, exports: P.exports }, usage: { www: dirSize(P.www), runtime: dirSize(P.runtime), data: dirSize(P.data) } }));
route('PUT', '/api/settings', async ({ body }) => {
  const st = getState();
  const s = st.settings;
  const before = { ...s };
  const int = (v, lo, hi, name) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw httpError(400, `${name} must be ${lo}–${hi}`);
    return n;
  };
  if (body.httpPort !== undefined) s.httpPort = int(body.httpPort, 1, 65535, 'HTTP port');
  if (body.mariadbPort !== undefined) s.mariadbPort = int(body.mariadbPort, 1, 65535, 'MariaDB port');
  if (body.panelPort !== undefined) s.panelPort = int(body.panelPort, 1024, 65535, 'Panel port');
  if (body.phpPoolSize !== undefined) s.phpPoolSize = int(body.phpPoolSize, 1, 9, 'PHP workers');
  for (const k of ['lan', 'ipv6', 'autostart']) if (body[k] !== undefined) s[k] = Boolean(body[k]);
  if (body.defaultPhp !== undefined) {
    if (body.defaultPhp && !st.components.php[body.defaultPhp]) throw httpError(400, 'PHP version not installed');
    s.defaultPhp = body.defaultPhp || null;
  }
  saveState();
  // Restart whatever the change affects so the new settings take effect immediately.
  const restart = new Set();
  if (['httpPort', 'lan', 'ipv6', 'defaultPhp'].some((k) => before[k] !== s[k])) restart.add('nginx');
  if (['mariadbPort', 'lan'].some((k) => before[k] !== s[k])) restart.add('mariadb');
  if (before.phpPoolSize !== s.phpPoolSize) { restart.add('nginx'); for (const b of Object.keys(st.components.php)) restart.add(`php-${b}`); }
  const errors = {};
  if (st.components.nginx) writeNginxConfig();
  for (const k of restart) {
    if (services.serviceKeys().includes(k) && (await services.isRunning(k))) {
      try { await services.restart(k); } catch (e) { errors[k] = e.message; }
    }
  }
  return { settings: s, restarted: [...restart], errors, panelRestartNeeded: before.panelPort !== s.panelPort };
});

// ---------- server ----------
const settings = getState().settings;
let PORT = Number(process.env.LOCALVPS_PORT) || settings.panelPort;
let ALLOWED_HOSTS = new Set();

// Third-party browser files are served from node_modules by an explicit allowlist, never by path.
// The packaged build copies them into ui/vendor; from source they come straight from node_modules.
const vendorFile = (name, ...nm) => (fs.existsSync(path.join(P.ui, 'vendor', name)) ? path.join(P.ui, 'vendor', name) : path.join(P.root, 'node_modules', ...nm));
const VENDOR = {
  '/vendor/xterm.mjs': vendorFile('xterm.mjs', '@xterm', 'xterm', 'lib', 'xterm.mjs'),
  '/vendor/xterm.css': vendorFile('xterm.css', '@xterm', 'xterm', 'css', 'xterm.css'),
  '/vendor/addon-fit.mjs': vendorFile('addon-fit.mjs', '@xterm', 'addon-fit', 'lib', 'addon-fit.mjs'),
};
MIME['.mjs'] = MIME['.js'];

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  let file = VENDOR[pathname];
  if (!file) {
    try { file = safeJoin(P.ui, rel); } catch { res.writeHead(400).end(); return; }
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(P.ui, 'index.html');
  const ext = path.extname(file);
  let content = fs.readFileSync(file);
  // The token is embedded in the page itself; other origins cannot read it, so they cannot call the API.
  if (ext === '.html') content = content.toString('utf8').replace('__PANEL_TOKEN__', getSecrets().panelToken);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'content-security-policy': `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://${req.headers.host}; frame-ancestors 'none'`,
    'referrer-policy': 'no-referrer',
  });
  res.end(content);
}

const server = http.createServer(async (req, res) => {
  // DNS-rebinding guard: only answer requests addressed to loopback names.
  if (!ALLOWED_HOSTS.has(req.headers.host || '')) {
    res.writeHead(421, { 'content-type': 'text/plain' }).end('Misdirected request');
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!url.pathname.startsWith('/api/')) { serveStatic(req, res, url.pathname); return; }

  // A custom header forces a CORS preflight, which this server never approves, so cross-site pages cannot use the API.
  const token = req.headers['x-panel-token'];
  if (token !== getSecrets().panelToken) { json(res, 401, { error: 'Missing or invalid panel token' }); return; }

  const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
  if (!r) { json(res, 404, { error: 'Not found' }); return; }
  const m = url.pathname.match(r.re);
  const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  try {
    // rawBody routes stream the request themselves (SQL imports can be large).
    const body = !r.rawBody && ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    const out = await r.handler({ params, query: url.searchParams, body, req, res });
    if (out === undefined && res.headersSent) return;
    // Jobs return their full object; the client only needs the id to start polling.
    if (isStartedJob(out)) { json(res, 202, { job: out.id }); return; }
    json(res, 200, out ?? { ok: true });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    if (!res.headersSent) json(res, status, { error: err.message });
  }
});

attachTerminal(server, () => ALLOWED_HOSTS);

// If the configured port is taken (AnyDesk uses 7070, for example), walk up to the next free one.
let attempts = 0;
server.on('error', (err) => {
  if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && attempts++ < 20) {
    console.warn(`Port ${PORT} unavailable (${err.code}), trying ${PORT + 1}`);
    PORT += 1;
    server.listen(PORT, '127.0.0.1');
    return;
  }
  console.error(err);
  process.exit(1);
});

server.on('listening', async () => {
  ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`LocalVPS panel: ${url}`);
  // Double-clicking LocalVPS.exe should land in the panel; from source it is opt-in (start.cmd passes --open).
  if ((IS_SEA || process.argv.includes('--open')) && !process.argv.includes('--no-open')) {
    openUrl(url);
  }
  if (!IS_WIN) await components.detectComponents().catch((e) => console.warn(`Component detection failed: ${e.message}`));
  services.startWatchdog();
  if (getState().components.nginx) writeNginxConfig();
  await services.autostart();
});

server.listen(PORT, '127.0.0.1');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    // Services are independent daemons and keep running, like a VPS without its control panel.
    saveState();
    process.exit(0);
  });
}
