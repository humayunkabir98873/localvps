import fs from 'node:fs';
import path from 'node:path';
import { P, httpError } from './paths.js';
import { getState, saveState } from './state.js';
import { download, extractArchive, runOk } from './util.js';
import { startJob, hasRunning } from './jobs.js';
import { IS_WIN, IS_MAC, PLATFORM_LABEL } from './platform.js';
import { packageManager, linuxCatalog, brewCatalog, brewBin, detectAll } from './unix.js';

const PHP_FEED = 'https://downloads.php.net/~windows/releases/releases.json';
const PHP_BASE = 'https://downloads.php.net/~windows/releases/';
const MARIADB_API = 'https://downloads.mariadb.org/rest-api/mariadb/';
const NGINX_PAGE = 'https://nginx.org/en/download.html';
const CACERT = 'https://curl.se/ca/cacert.pem';
const NODE_DIST = 'https://nodejs.org/dist/';
const NODE_INDEX = `${NODE_DIST}index.json`;

let cache = { at: 0, data: null };

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} returned ${r.status}`);
  return r.json();
}

// ---------- Windows: official vendor zips ----------
async function phpCatalog() {
  const feed = await getJson(PHP_FEED);
  const out = [];
  for (const [branch, info] of Object.entries(feed)) {
    // NTS builds are the right choice for php-cgi/FastCGI behind nginx.
    const key = Object.keys(info).find((k) => k.startsWith('nts-') && k.endsWith('-x64'));
    if (!key || !info[key].zip) continue;
    out.push({
      type: 'php', branch, version: info.version,
      file: info[key].zip.path, size: info[key].zip.size,
      url: PHP_BASE + info[key].zip.path, sha256: info[key].zip.sha256,
      build: key,
    });
  }
  return out.sort((a, b) => Number.parseFloat(b.branch) - Number.parseFloat(a.branch));
}

async function mariadbCatalog() {
  const majors = await getJson(MARIADB_API);
  const stable = majors.major_releases.filter((m) => m.release_status === 'Stable').slice(0, 5);
  const out = [];
  await Promise.all(stable.map(async (m) => {
    try {
      const d = await getJson(`${MARIADB_API}${m.release_id}/`);
      const latest = Object.keys(d.releases)[0];
      const f = d.releases[latest].files.find((x) => /winx64\.zip$/.test(x.file_name) && !/debug/.test(x.file_name));
      if (!f) return;
      out.push({
        type: 'mariadb', branch: m.release_id, version: latest,
        lts: m.release_support_type === 'Long Term Support',
        file: f.file_name,
        url: f.file_download_url.replace(/^http:/, 'https:'),
        sha256: f.checksum?.sha256sum,
      });
    } catch { /* one branch failing should not hide the others */ }
  }));
  return out.sort((a, b) => Number.parseFloat(b.branch) - Number.parseFloat(a.branch));
}

async function nginxCatalog() {
  const r = await fetch(NGINX_PAGE);
  const html = await r.text();
  const versions = [...new Set([...html.matchAll(/nginx-(\d+)\.(\d+)\.(\d+)\.zip/g)].map((m) => m.slice(1, 4).map(Number)))];
  versions.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
  const pick = (pred) => versions.find(pred);
  const mainline = pick((v) => v[1] % 2 === 1);
  const stable = pick((v) => v[1] % 2 === 0);
  return [stable && { label: 'stable', v: stable }, mainline && { label: 'mainline', v: mainline }]
    .filter(Boolean)
    .map(({ label, v }) => {
      const version = v.join('.');
      return {
        type: 'nginx', branch: label, version,
        file: `nginx-${version}.zip`, url: `https://nginx.org/download/nginx-${version}.zip`,
        sha256: null, // nginx.org publishes PGP signatures only; the hash is recorded but not verified
      };
    });
}

// ---------- Node.js: official builds on every OS ----------
const NODE_ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const NODE_TARGET = IS_WIN
  ? { key: `win-${NODE_ARCH}-zip`, file: (tag) => `node-${tag}-win-${NODE_ARCH}.zip` }
  : IS_MAC
    ? { key: `osx-${NODE_ARCH}-tar`, file: (tag) => `node-${tag}-darwin-${NODE_ARCH}.tar.gz` }
    : { key: `linux-${NODE_ARCH}`, file: (tag) => `node-${tag}-linux-${NODE_ARCH}.tar.gz` };

// Latest release of each of the three newest LTS lines, hash taken from that release's SHASUMS256.txt.
async function nodeCatalog() {
  const releases = await getJson(NODE_INDEX);
  const picks = [];
  for (const r of releases) {
    const major = r.version.slice(1).split('.')[0];
    if (!r.lts || !r.files.includes(NODE_TARGET.key) || picks.some((p) => p.branch === major)) continue;
    picks.push({ branch: major, version: r.version.slice(1), lts: true, codename: r.lts, tag: r.version });
    if (picks.length === 3) break;
  }
  return Promise.all(picks.map(async (p) => {
    const file = NODE_TARGET.file(p.tag);
    const sums = await (await fetch(`${NODE_DIST}${p.tag}/SHASUMS256.txt`)).text();
    const sha256 = sums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, f]) => f === file)?.[0];
    return { type: 'node', branch: p.branch, version: p.version, lts: p.lts, codename: p.codename, file, url: `${NODE_DIST}${p.tag}/${file}`, sha256 };
  }));
}

// ---------- catalog ----------
// Cached briefly: the dashboard polls it, and finding the package manager spawns `which`.
let providerCache = { at: 0, value: null };
export function providerInfo() {
  if (IS_WIN) return { platform: PLATFORM_LABEL, provider: 'vendor', label: 'official Windows builds' };
  if (providerCache.value && Date.now() - providerCache.at < 60_000) return providerCache.value;
  const pm = packageManager();
  const value = { platform: PLATFORM_LABEL, provider: IS_MAC ? 'brew' : 'system', packageManager: pm, label: IS_MAC ? (pm ? 'Homebrew' : 'Homebrew (not installed)') : pm ? `${pm.label}${pm.name ? ` on ${pm.name}` : ''}` : 'no package manager found' };
  providerCache = { at: Date.now(), value };
  return value;
}

export async function catalog(force = false) {
  if (!force && cache.data && Date.now() - cache.at < 3600_000) return cache.data;
  const val = (r) => (r.status === 'fulfilled' ? r.value : { error: r.reason.message });
  let data;
  if (IS_WIN) {
    const [php, mariadb, nginx, node] = await Promise.allSettled([phpCatalog(), mariadbCatalog(), nginxCatalog(), nodeCatalog()]);
    data = { php: val(php), mariadb: val(mariadb), nginx: val(nginx), node: val(node) };
  } else {
    const [stack, node] = await Promise.allSettled([IS_MAC ? brewCatalog() : Promise.resolve(linuxCatalog(packageManager())), nodeCatalog()]);
    const s = stack.status === 'fulfilled' ? stack.value : { php: { error: stack.reason.message }, mariadb: { error: stack.reason.message }, nginx: { error: stack.reason.message } };
    data = { ...s, node: val(node) };
    await detectComponents().catch(() => {});
  }
  cache = { at: Date.now(), data: { ...data, provider: providerInfo() } };
  return cache.data;
}

export function installed() {
  return getState().components;
}

// macOS/Linux: register whatever Homebrew or the package manager has installed.
export async function detectComponents() {
  if (IS_WIN) return getState().components;
  const found = await detectAll();
  const st = getState();
  st.components.nginx = found.nginx;
  st.components.mariadb = found.mariadb;
  st.components.php = found.php;
  const branches = Object.keys(found.php).sort((a, b) => Number.parseFloat(b) - Number.parseFloat(a));
  if (!st.settings.defaultPhp || !found.php[st.settings.defaultPhp]) {
    st.settings.defaultPhp = branches.find((b) => b === '8.4') || branches[0] || null;
  }
  saveState();
  return st.components;
}

export function phpDir(branch) { return path.join(P.runtime, 'php', branch); }

// Windows/Node: download job. macOS: `brew install` job. Linux: returns the sudo command for the terminal.
export async function installComponent({ type, branch }) {
  if (hasRunning('install')) throw httpError(409, 'Another install is already running');
  const cat = await catalog();
  const list = cat[type];
  if (!Array.isArray(list)) throw httpError(502, `Catalog for ${type} unavailable: ${list?.error}`);
  const item = list.find((x) => x.branch === branch);
  if (!item) throw httpError(404, `${type} ${branch} not found in catalog`);

  if (item.command) return { command: item.command, note: 'Run this in the terminal, then press "Detect installed".' };

  if (item.formula) {
    const brew = brewBin();
    if (!brew) throw httpError(409, 'Homebrew is not installed. Install it from https://brew.sh and reload this page.');
    return startJob('install', `brew install ${item.formula}`, async (ctx) => {
      ctx.log(`$ brew install ${item.formula}`);
      await runOk(brew, ['install', item.formula], { onData: (d) => ctx.log(d), env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', NONINTERACTIVE: '1' } });
      const comps = await detectComponents();
      const ok = type === 'php' ? comps.php[branch] : comps[type];
      if (!ok) throw new Error(`${item.formula} installed but LocalVPS could not find its binaries`);
      ctx.log(`Registered ${type} ${ok.version}`);
      return ok;
    });
  }

  return startJob('install', `Install ${type} ${branch}`, async (ctx) => {
    const dlDir = path.join(P.tmp, 'downloads');
    fs.mkdirSync(dlDir, { recursive: true });
    const archive = path.join(dlDir, item.file);
    ctx.log(`Downloading ${item.url}`);
    const dl = await download(item.url, archive, {
      sha256: item.sha256,
      onProgress: (got, total) => ctx.progress(total ? got / total : null),
    });
    ctx.log(dl.verified ? `SHA-256 verified: ${dl.sha256}` : `SHA-256 (not verified, publisher gives PGP only): ${dl.sha256}`);

    const dest = type === 'php' ? phpDir(branch) : path.join(P.runtime, type, item.version);
    ctx.log(`Extracting to ${dest}`);
    await extractArchive(archive, dest);
    fs.rmSync(archive, { force: true });

    const st = getState();
    const record = { version: item.version, branch, path: dest, sha256: dl.sha256, verified: dl.verified, installedAt: new Date().toISOString() };
    if (type === 'php') {
      st.components.php[branch] = record;
      if (!st.settings.defaultPhp) st.settings.defaultPhp = branch;
      await ensureCaBundle(ctx);
    } else {
      const prev = st.components[type];
      st.components[type] = record;
      if (prev && prev.path !== dest) ctx.log(`Previous ${type} ${prev.version} kept at ${prev.path}; remove it from Components if unused.`);
    }
    saveState();
    return record;
  });
}

// Windows PHP (curl/openssl) needs a CA bundle for outbound HTTPS, e.g. WordPress updates.
// macOS/Linux PHP builds use the system trust store.
async function ensureCaBundle(ctx) {
  const dest = path.join(P.runtime, 'cacert.pem');
  if (fs.existsSync(dest)) return;
  const shaText = await (await fetch(`${CACERT}.sha256`)).text();
  const sha256 = shaText.trim().split(/\s+/)[0];
  ctx.log('Downloading Mozilla CA bundle from curl.se');
  await download(CACERT, dest, { sha256 });
}

// Homebrew/system packages are only unregistered; LocalVPS never uninstalls system software.
const ownedByLocalVps = (rec) => !rec.bins;

export function removeComponent({ type, branch }) {
  const st = getState();
  if (type === 'php') {
    const rec = st.components.php[branch];
    if (!rec) throw httpError(404, 'Not installed');
    if (st.sites.some((s) => s.php === branch)) throw httpError(409, `Sites still use PHP ${branch}`);
    if (ownedByLocalVps(rec)) fs.rmSync(rec.path, { recursive: true, force: true });
    delete st.components.php[branch];
    if (st.settings.defaultPhp === branch) st.settings.defaultPhp = Object.keys(st.components.php)[0] || null;
  } else {
    const rec = st.components[type];
    if (!rec) throw httpError(404, 'Not installed');
    if (type === 'node' && st.sites.some((s) => s.type === 'node')) throw httpError(409, 'Next.js sites still use Node.js');
    if (ownedByLocalVps(rec)) fs.rmSync(rec.path, { recursive: true, force: true });
    st.components[type] = null;
  }
  saveState();
}
