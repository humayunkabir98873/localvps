import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { P, httpError } from './paths.js';
import { getState, saveState } from './state.js';
import { writeNginxConfig, siteUrl, siteRoot, siteWebroot, writeLandingPage } from './config.js';
import { reloadNginx, isRunning, start as startService, stop as stopService } from './services.js';
import { createDatabase, dropDatabase } from './db.js';
import { download, extractArchive, portFree } from './util.js';
import { IS_WIN } from './platform.js';
import { startJob } from './jobs.js';
import { ensureComposer, runPhp, runNpx, setEnvValues, composerPhar, requireNode } from './tooling.js';

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

// template -> how the site runs. Node sites are reverse-proxied by nginx to their own dev server.
export const TEMPLATES = {
  blank: { type: 'php', label: 'Blank PHP site' },
  wordpress: { type: 'php', label: 'WordPress', needsDb: true },
  laravel: { type: 'php', label: 'Laravel', needsDb: true },
  nextjs: { type: 'node', label: 'Next.js' },
};

export const siteType = (s) => s.type || 'php';
export const appServiceKey = (name) => `app-${name}`;

export function listSites() {
  return getState().sites.map((s) => ({
    ...s,
    type: siteType(s),
    url: siteUrl(s.name),
    path: siteRoot(s),
    webrootPath: siteType(s) === 'php' ? siteWebroot(s) : null,
  }));
}

function findSite(name) {
  const s = getState().sites.find((x) => x.name === name);
  if (!s) throw httpError(404, `Site ${name} not found`);
  return s;
}

async function applyConfig() {
  writeNginxConfig();
  try { await reloadNginx(); } catch (e) { throw httpError(500, e.message); }
}

const dbNameFor = (name) => `${name.replace(/-/g, '_')}_db`.slice(0, 64);
const dbUserFor = (name) => name.replace(/-/g, '_').slice(0, 32);

async function nextAppPort() {
  const used = new Set(getState().sites.map((s) => s.appPort).filter(Boolean));
  for (let p = 3100; p < 3400; p++) {
    if (!used.has(p) && (await portFree(p))) return p;
  }
  throw httpError(409, 'No free app port between 3100 and 3399');
}

const BLANK_INDEX = (name) => `<?php
// ${name}.localhost — replace this file with your app.
$db = file_exists(__DIR__ . '/../db.local.php') ? require __DIR__ . '/../db.local.php' : null;
?><!doctype html>
<html lang="en"><head><meta charset="utf-8"><title><?= htmlspecialchars('${name}') ?></title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:10vh auto;padding:0 20px;color:#1d2330}code{background:#f1f3f7;padding:2px 6px;border-radius:4px}</style>
</head><body>
<h1>${name}.localhost works</h1>
<p>PHP <?= PHP_VERSION ?> on <?= PHP_OS_FAMILY ?>. Web root: <code><?= htmlspecialchars(__DIR__) ?></code></p>
<?php if ($db): ?>
<p>Database <code><?= htmlspecialchars($db['name']) ?></code>:
<?php try { new PDO("mysql:host={$db['host']};port={$db['port']};dbname={$db['name']}", $db['user'], $db['password']); echo 'connected ✔'; }
      catch (Throwable $e) { echo 'not reachable — ' . htmlspecialchars($e->getMessage()); } ?></p>
<?php endif; ?>
</body></html>
`;

export async function createSite({ name, php, template = 'blank', createDb = false }) {
  const st = getState();
  const tpl = TEMPLATES[template];
  if (!tpl) throw httpError(400, `Unknown template ${template}`);
  if (!NAME.test(name || '')) throw httpError(400, 'Site name: lowercase letters, digits and dashes (max 40)');
  if (name === 'localhost' || st.sites.some((s) => s.name === name)) throw httpError(409, 'A site with that name already exists');
  if (!st.components.nginx) throw httpError(400, 'Install nginx first (Components page)');
  if (tpl.type === 'php') {
    php = php || st.settings.defaultPhp;
    if (!st.components.php[php]) throw httpError(400, 'Install a PHP version first (Components page)');
  } else {
    php = null;
    requireNode();
  }
  const wantDb = tpl.needsDb || createDb;
  if (wantDb && !(await isRunning('mariadb'))) throw httpError(409, 'Start MariaDB first: this site needs a database');
  const root = path.join(P.www, name);
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw httpError(409, `${root} already exists and is not empty`);

  const site = {
    name, type: tpl.type, php, template,
    webroot: tpl.type === 'php' ? 'public' : null,
    enabled: true, aliases: [], extraNginx: '', createdAt: new Date().toISOString(), db: null,
  };

  const makeDb = async (ctx) => {
    if (!wantDb) return;
    site.db = await createDatabase({ name: dbNameFor(name), user: dbUserFor(name) });
    site.db.host = '127.0.0.1';
    ctx?.log(`Created database ${site.db.name} and user ${site.db.user}`);
  };

  // If scaffolding fails halfway, remove what was created so the name can be reused.
  const cleanup = async () => {
    fs.rmSync(root, { recursive: true, force: true });
    if (site.db) await dropDatabase(site.db.name, { dropUser: site.db.user }).catch(() => {});
  };

  const finish = async (ctx) => {
    st.sites.push(site);
    saveState();
    if (site.type === 'node') {
      ctx?.log(`Starting the Next.js dev server on 127.0.0.1:${site.appPort}`);
      await startService(appServiceKey(name));
    }
    await applyConfig();
    return { name, url: siteUrl(name) };
  };

  if (template === 'blank') {
    fs.mkdirSync(path.join(root, 'public'), { recursive: true });
    await makeDb();
    writeDbLocal(site);
    fs.writeFileSync(path.join(root, 'public', 'index.php'), BLANK_INDEX(name));
    return finish();
  }

  const titles = { wordpress: 'WordPress', laravel: 'Laravel', nextjs: 'Next.js' };
  return startJob('site', `Create ${titles[template]} site ${name}`, async (ctx) => {
    try {
      if (template === 'wordpress') await scaffoldWordPress(site, root, ctx, makeDb);
      else if (template === 'laravel') await scaffoldLaravel(site, root, ctx, makeDb);
      else if (template === 'nextjs') await scaffoldNext(site, root, ctx, makeDb);
    } catch (err) {
      ctx.log('Cleaning up the partial site');
      await cleanup();
      throw err;
    }
    const out = await finish(ctx);
    ctx.log(`Open ${out.url}${template === 'wordpress' ? ' to finish the WordPress install' : ''}`);
    return out;
  });
}

async function scaffoldWordPress(site, root, ctx, makeDb) {
  ctx.log('Downloading WordPress from wordpress.org');
  // GNU tar on Linux cannot read zips, so unix takes the .tar.gz edition.
  const ext = IS_WIN ? 'zip' : 'tar.gz';
  const archive = path.join(P.tmp, `wordpress-${Date.now()}.${ext}`);
  const sha1 = (await (await fetch(`https://wordpress.org/latest.${ext}.sha1`)).text()).trim();
  await download(`https://wordpress.org/latest.${ext}`, archive, { sha1, onProgress: (g, t) => ctx.progress(t ? g / t : null) });
  ctx.log('SHA-1 verified');
  await extractArchive(archive, path.join(root, 'public'));
  fs.rmSync(archive, { force: true });
  await makeDb(ctx);
  writeWpConfig(site);
  ctx.log('Wrote wp-config.php with fresh salts');
}

async function scaffoldLaravel(site, root, ctx, makeDb) {
  await ensureComposer(ctx);
  ctx.log(`Running composer create-project laravel/laravel (PHP ${site.php}); this takes a minute or two`);
  await runPhp(site.php, [composerPhar(), 'create-project', 'laravel/laravel', root, '--prefer-dist', '--no-interaction', '--no-progress'],
    { cwd: P.www, onData: (d) => ctx.log(d) });
  await makeDb(ctx);
  const port = getState().settings.mariadbPort;
  setEnvValues(path.join(root, '.env'), {
    APP_NAME: site.name,
    APP_URL: siteUrl(site.name).replace(/\/$/, ''),
    DB_CONNECTION: 'mysql',
    DB_HOST: '127.0.0.1',
    DB_PORT: String(port),
    DB_DATABASE: site.db.name,
    DB_USERNAME: site.db.user,
    DB_PASSWORD: site.db.password,
  });
  ctx.log('Configured .env for MariaDB');
  ctx.log('Running migrations');
  await runPhp(site.php, ['artisan', 'migrate', '--force', '--no-interaction'], { cwd: root, onData: (d) => ctx.log(d) });
}

async function scaffoldNext(site, root, ctx, makeDb) {
  site.appPort = await nextAppPort();
  ctx.log('Running create-next-app (TypeScript, App Router, Tailwind, ESLint); npm install takes a minute or two');
  await runNpx(['--yes', 'create-next-app@latest', root, '--ts', '--app', '--tailwind', '--eslint', '--src-dir',
    '--import-alias', '@/*', '--use-npm', '--disable-git', '--yes'],
  { cwd: P.www, onData: (d) => ctx.log(d), env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', CI: '1' } });
  pinTurbopackRoot(root);
  ctx.log('Pinned turbopack.root to the project folder');
  await makeDb(ctx);
  if (site.db) {
    const port = getState().settings.mariadbPort;
    setEnvValues(path.join(root, '.env.local'), {
      DATABASE_URL: `mysql://${site.db.user}:${site.db.password}@127.0.0.1:${port}/${site.db.name}`,
    });
    ctx.log('Wrote DATABASE_URL to .env.local');
  }
}

// The panel's own package-lock.json in a parent folder makes Next infer F:\local-server as the
// workspace root, so Turbopack would watch logs and DB files. Pin the root to the project itself.
export function pinTurbopackRoot(root) {
  const file = ['next.config.ts', 'next.config.mjs', 'next.config.js'].map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
  if (!file) return;
  let cfg = fs.readFileSync(file, 'utf8');
  if (/turbopack\s*:\s*{[^]*?\broot\s*:/.test(cfg)) return;
  if (/turbopack\s*:\s*{/.test(cfg)) cfg = cfg.replace(/turbopack\s*:\s*{/, 'turbopack: {\n    root: __dirname,');
  else cfg = cfg.replace(/(const nextConfig[^=]*=\s*{)/, '$1\n  turbopack: { root: __dirname },');
  fs.writeFileSync(file, cfg);
}

// db.local.php sits outside the web root so credentials are never served.
function writeDbLocal(site) {
  if (!site.db) return;
  const port = getState().settings.mariadbPort;
  fs.writeFileSync(path.join(siteRoot(site), 'db.local.php'), `<?php
// Local database credentials generated by LocalVPS (not web-accessible).
return [
    'host' => '127.0.0.1',
    'port' => ${port},
    'name' => '${site.db.name}',
    'user' => '${site.db.user}',
    'password' => '${site.db.password}',
];
`);
}

function writeWpConfig(site) {
  const dir = siteWebroot(site);
  let cfg = fs.readFileSync(path.join(dir, 'wp-config-sample.php'), 'utf8');
  const port = getState().settings.mariadbPort;
  cfg = cfg
    .replace("'database_name_here'", `'${site.db.name}'`)
    .replace("'username_here'", `'${site.db.user}'`)
    .replace("'password_here'", `'${site.db.password}'`)
    .replace("'localhost'", `'127.0.0.1:${port}'`);
  cfg = cfg.replace(/'put your unique phrase here'/g, () => `'${crypto.randomBytes(48).toString('base64').replace(/['\\]/g, 'x')}'`);
  fs.writeFileSync(path.join(dir, 'wp-config.php'), cfg);
}

export async function updateSite(name, patch) {
  const st = getState();
  const site = findSite(name);
  const isPhp = siteType(site) === 'php';
  if (patch.php !== undefined && isPhp) {
    if (!st.components.php[patch.php]) throw httpError(400, `PHP ${patch.php} is not installed`);
    site.php = patch.php;
  }
  if (patch.enabled !== undefined) site.enabled = Boolean(patch.enabled);
  if (patch.webroot !== undefined && isPhp) {
    const wr = String(patch.webroot).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (wr.includes('..')) throw httpError(400, 'Invalid web root');
    site.webroot = wr || '.';
  }
  if (patch.appPort !== undefined && !isPhp) {
    const p = Number(patch.appPort);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) throw httpError(400, 'App port must be 1024–65535');
    if (st.sites.some((s) => s !== site && s.appPort === p)) throw httpError(409, `Port ${p} is used by another site`);
    if (p !== site.appPort) {
      const wasRunning = await isRunning(appServiceKey(name));
      if (wasRunning) await stopService(appServiceKey(name));
      site.appPort = p;
      saveState();
      if (wasRunning) await startService(appServiceKey(name));
    }
  }
  if (patch.aliases !== undefined) {
    const list = (Array.isArray(patch.aliases) ? patch.aliases : String(patch.aliases).split(/[\s,]+/)).filter(Boolean);
    for (const a of list) if (!/^[a-z0-9.-]+$/i.test(a)) throw httpError(400, `Invalid alias ${a}`);
    site.aliases = list;
  }
  if (patch.extraNginx !== undefined) {
    if ((patch.extraNginx.match(/{/g) || []).length !== (patch.extraNginx.match(/}/g) || []).length) {
      throw httpError(400, 'Unbalanced braces in extra nginx directives');
    }
    site.extraNginx = String(patch.extraNginx);
  }
  saveState();
  await applyConfig();
  return site;
}

export async function deleteSite(name, { deleteFiles = false, dropDb = false } = {}) {
  const st = getState();
  const site = findSite(name);
  if (siteType(site) === 'node') {
    await stopService(appServiceKey(name)).catch(() => {});
    delete st.services[appServiceKey(name)];
  }
  if (dropDb && site.db) await dropDatabase(site.db.name, { dropUser: site.db.user });
  st.sites = st.sites.filter((s) => s !== site);
  saveState();
  if (deleteFiles) fs.rmSync(siteRoot(site), { recursive: true, force: true });
  await applyConfig();
  writeLandingPage();
}

export function getSiteConfig(name) {
  findSite(name);
  const file = path.join(P.nginxConf, 'sites', `${name}.conf`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Site is disabled or its PHP version is not installed';
}

export { findSite };
