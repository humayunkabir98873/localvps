// macOS and Linux providers. php.net, nginx.org and MariaDB publish no ready-made binaries for these
// systems, so the stack comes from Homebrew (macOS) or the distro package manager (Linux). LocalVPS
// still runs its own nginx/php-fpm/mariadbd processes with its own configs, ports and data directory.
import fs from 'node:fs';
import path from 'node:path';
import { IS_MAC, which } from './platform.js';
import { run } from './util.js';

const exists = (p) => Boolean(p) && fs.existsSync(p);
const first = (...cands) => cands.flat().find(exists) || null;

async function output(bin, args) {
  const r = await run(bin, args).catch(() => null);
  return r ? `${r.stdout}\n${r.stderr}` : '';
}

let brewPrefixCache;
export async function brewPrefix() {
  if (brewPrefixCache !== undefined) return brewPrefixCache;
  const brew = brewBin();
  brewPrefixCache = brew ? (await output(brew, ['--prefix'])).trim().split('\n')[0] || null : null;
  return brewPrefixCache;
}
export const brewBin = () => first(which('brew'), '/opt/homebrew/bin/brew', '/usr/local/bin/brew');

// ---------- package manager ----------
function osRelease() {
  try {
    return Object.fromEntries(fs.readFileSync('/etc/os-release', 'utf8').split('\n')
      .map((l) => l.match(/^(\w+)=["']?(.*?)["']?$/)).filter(Boolean).map((m) => [m[1], m[2]]));
  } catch { return {}; }
}

export function packageManager() {
  if (IS_MAC) return brewBin() ? { id: 'brew', label: 'Homebrew' } : null;
  const os = osRelease();
  // Ubuntu and its derivatives (Mint, Pop!_OS) use the ondrej PPA; Debian and others use sury.
  const ubuntuLike = os.ID === 'ubuntu' || /\bubuntu\b/.test(os.ID_LIKE || '');
  if (which('apt-get')) return { id: 'apt', label: 'apt', distro: ubuntuLike ? 'ubuntu' : 'debian', name: os.PRETTY_NAME };
  if (which('dnf')) return { id: 'dnf', label: 'dnf', name: os.PRETTY_NAME };
  if (which('pacman')) return { id: 'pacman', label: 'pacman', name: os.PRETTY_NAME };
  return null;
}

// apt installs start system-wide services on 80/3306; LocalVPS runs its own, so they are switched off.
const disable = (unit) => `(sudo systemctl disable --now ${unit} 2>/dev/null || true)`;
const PHP_EXTS = ['fpm', 'cli', 'mysql', 'curl', 'gd', 'intl', 'mbstring', 'xml', 'zip', 'bcmath', 'sqlite3'];

function aptPhpRepo(distro) {
  if (distro === 'ubuntu') {
    return 'sudo apt-get install -y software-properties-common && sudo add-apt-repository -y ppa:ondrej/php';
  }
  return 'sudo apt-get install -y curl ca-certificates lsb-release'
    + ' && sudo curl -fsSLo /usr/share/keyrings/sury-php.gpg https://packages.sury.org/php/apt.gpg'
    + ' && echo "deb [signed-by=/usr/share/keyrings/sury-php.gpg] https://packages.sury.org/php/ $(lsb_release -sc) main" | sudo tee /etc/apt/sources.list.d/sury-php.list'
    + ' && sudo apt-get update';
}

// Linux: the panel cannot sudo, so each item carries the command the user runs in the panel's terminal.
export function linuxCatalog(pm) {
  if (!pm) return { nginx: { error: 'No supported package manager (apt, dnf or pacman) found' }, php: [], mariadb: [] };
  if (pm.id === 'apt') {
    const phpBranches = ['8.5', '8.4', '8.3', '8.2'];
    return {
      nginx: [{ type: 'nginx', branch: 'system', version: 'distribution package', command: `sudo apt-get update && sudo apt-get install -y nginx && ${disable('nginx')}` }],
      php: phpBranches.map((b) => {
        const pkgs = [...PHP_EXTS, ...(Number.parseFloat(b) < 8.5 ? ['opcache'] : [])].map((e) => `php${b}-${e}`).join(' ');
        return { type: 'php', branch: b, version: `${b}.x (${pm.distro === 'ubuntu' ? 'ondrej/php PPA' : 'packages.sury.org'})`, command: `sudo apt-get update && ${aptPhpRepo(pm.distro)} && sudo apt-get install -y ${pkgs} && ${disable(`php${b}-fpm`)}` };
      }),
      mariadb: [{ type: 'mariadb', branch: 'system', version: 'distribution package', command: `sudo apt-get update && sudo apt-get install -y mariadb-server mariadb-client && ${disable('mariadb')}` }],
    };
  }
  if (pm.id === 'dnf') {
    return {
      nginx: [{ type: 'nginx', branch: 'system', version: 'distribution package', command: 'sudo dnf install -y nginx' }],
      php: [{ type: 'php', branch: 'system', version: 'distribution default', command: 'sudo dnf install -y php-fpm php-cli php-mysqlnd php-gd php-intl php-mbstring php-xml php-pdo php-sodium php-opcache php-bcmath' }],
      mariadb: [{ type: 'mariadb', branch: 'system', version: 'distribution package', command: 'sudo dnf install -y mariadb-server mariadb' }],
    };
  }
  return {
    nginx: [{ type: 'nginx', branch: 'system', version: 'distribution package', command: 'sudo pacman -S --needed --noconfirm nginx' }],
    php: [{ type: 'php', branch: 'system', version: 'distribution default', command: 'sudo pacman -S --needed --noconfirm php php-fpm php-gd php-intl php-sqlite' }],
    mariadb: [{ type: 'mariadb', branch: 'system', version: 'distribution package', command: 'sudo pacman -S --needed --noconfirm mariadb' }],
  };
}

// macOS: Homebrew formulae, installed by the panel itself (brew never needs sudo).
const BREW_FORMULAE = {
  nginx: [{ formula: 'nginx', branch: 'stable' }],
  php: [{ formula: 'php' }, { formula: 'php@8.4' }, { formula: 'php@8.3' }, { formula: 'php@8.2' }],
  mariadb: [{ formula: 'mariadb@11.8', lts: true }, { formula: 'mariadb@11.4', lts: true }, { formula: 'mariadb' }],
};

export async function brewCatalog() {
  const out = {};
  for (const [type, list] of Object.entries(BREW_FORMULAE)) {
    out[type] = (await Promise.all(list.map(async (f) => {
      try {
        const r = await fetch(`https://formulae.brew.sh/api/formula/${f.formula}.json`);
        if (!r.ok) return null;
        const d = await r.json();
        if (d.disabled) return null;
        const version = d.versions.stable;
        const branch = f.branch || (type === 'php' ? version.split('.').slice(0, 2).join('.') : f.formula.replace(/^mariadb@?/, '') || version.split('.').slice(0, 2).join('.'));
        return { type, branch, version, formula: f.formula, lts: f.lts || false, file: `brew install ${f.formula}` };
      } catch { return null; }
    }))).filter(Boolean);
  }
  return out;
}

// ---------- detection ----------
export async function detectNginx() {
  const prefix = IS_MAC ? await brewPrefix() : null;
  const bin = first(prefix && `${prefix}/bin/nginx`, which('nginx'), '/usr/sbin/nginx', '/usr/bin/nginx');
  if (!bin) return null;
  const v = await output(bin, ['-V']);
  const confPath = v.match(/--conf-path=(\S+)/)?.[1];
  const confDir = first(confPath && path.dirname(confPath), prefix && `${prefix}/etc/nginx`, '/etc/nginx');
  return {
    version: v.match(/nginx\/([\d.]+)/)?.[1] || '?',
    source: prefix && bin.startsWith(prefix) ? 'brew' : 'system',
    bins: { nginx: bin }, confDir, path: path.dirname(bin),
  };
}

export async function detectPhp() {
  const prefix = IS_MAC ? await brewPrefix() : null;
  const cands = [];
  if (prefix && exists(`${prefix}/opt`)) {
    for (const d of fs.readdirSync(`${prefix}/opt`).filter((n) => /^php(@\d+\.\d+)?$/.test(n))) {
      cands.push({ fpm: `${prefix}/opt/${d}/sbin/php-fpm`, cli: `${prefix}/opt/${d}/bin/php`, source: 'brew', iniFor: (b) => `${prefix}/etc/php/${b}/php.ini` });
    }
  }
  for (const dir of ['/usr/sbin', '/usr/bin']) {
    if (!exists(dir)) continue;
    for (const n of fs.readdirSync(dir)) {
      const m = n.match(/^php-fpm(\d+\.\d+)?$/);
      if (!m) continue;
      cands.push({
        fpm: path.join(dir, n),
        cli: first(m[1] && `/usr/bin/php${m[1]}`, '/usr/bin/php', which('php')),
        source: 'system',
        iniFor: (b) => first(`/usr/lib/php/${b}/php.ini-development`, `/etc/php/${b}/fpm/php.ini`, '/etc/php.ini', '/etc/php/php.ini'),
      });
    }
  }
  const found = {};
  for (const c of cands) {
    if (!exists(c.fpm) || !exists(c.cli)) continue;
    const version = (await output(c.fpm, ['-v'])).match(/PHP (\d+\.\d+\.\d+)/)?.[1];
    if (!version) continue;
    const branch = version.split('.').slice(0, 2).join('.');
    if (found[branch]) continue;
    found[branch] = { version, branch, source: c.source, bins: { fpm: c.fpm, cli: c.cli, ini: c.iniFor(branch) }, path: path.dirname(c.cli) };
  }
  return found;
}

export async function detectMariadb() {
  const prefix = IS_MAC ? await brewPrefix() : null;
  const brewServers = prefix && exists(`${prefix}/opt`)
    ? fs.readdirSync(`${prefix}/opt`).filter((n) => /^mariadb(@[\d.]+)?$/.test(n)).map((n) => `${prefix}/opt/${n}/bin/mariadbd`)
    : [];
  const server = first(prefix && `${prefix}/bin/mariadbd`, brewServers, which('mariadbd'), '/usr/sbin/mariadbd', '/usr/libexec/mariadbd', '/usr/bin/mariadbd', which('mysqld'), '/usr/sbin/mysqld');
  if (!server) return null;
  const real = fs.realpathSync(server);
  const basedir = path.dirname(path.dirname(real));
  const sib = (name) => path.join(basedir, 'bin', name);
  const v = await output(server, ['--version']);
  return {
    version: v.match(/Ver\s+([\d.]+)/)?.[1] || '?',
    source: prefix && real.startsWith(fs.realpathSync(prefix)) ? 'brew' : 'system',
    basedir,
    bins: {
      server,
      installDb: first(sib('mariadb-install-db'), path.join(basedir, 'scripts', 'mariadb-install-db'), which('mariadb-install-db'), which('mysql_install_db')),
      client: first(sib('mariadb'), which('mariadb'), which('mysql')),
      dump: first(sib('mariadb-dump'), which('mariadb-dump'), which('mysqldump')),
    },
    path: basedir,
  };
}

export async function detectAll() {
  const [nginx, php, mariadb] = await Promise.all([detectNginx(), detectPhp(), detectMariadb()]);
  return { nginx, php, mariadb };
}
