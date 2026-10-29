# LocalVPS

A local server stack for **Windows, macOS and Linux**, in the spirit of XAMPP, with a modern web control panel. It gives you per-site PHP versions, one-click WordPress, Laravel and Next.js sites, a database manager, an in-browser terminal, and one-click export to a real Linux VPS.

LocalVPS runs real nginx, PHP and MariaDB processes, each with its own configs, ports and data. Every site gets its own hostname (`http://name.localhost`), so there are no hosts-file edits and no admin rights needed.

## Download

Get the package for your system from **[Releases](https://github.com/humayunkabir98873/localvps/releases)**:

| System | Package | Start |
|---|---|---|
| Windows 10/11 x64 | `LocalVPS-<version>-win-x64.zip` | unzip, double-click `LocalVPS.exe` |
| Linux x64 (glibc 2.35+, e.g. Ubuntu 22.04+, Debian 12+) | `LocalVPS-<version>-linux-x64.tar.gz` | `tar -xzf …` then `./localvps` |
| macOS (Apple Silicon) | `LocalVPS-<version>-macos-arm64.tar.gz` | `tar -xzf …` then `./localvps` |

The control panel opens at `http://127.0.0.1:7171/`. On the Dashboard, click **Install recommended stack**. The executables aren't code-signed:

- **Windows:** SmartScreen may ask you to confirm (More info → Run anyway).
- **macOS:** right-click → Open the first time, or run `xattr -dr com.apple.quarantine .` in the folder.

`SHA256SUMS.txt` in each release lists the package checksums.

## Where the stack comes from

php.net, nginx.org and MariaDB only publish ready-made binaries for Windows, so each OS uses its natural source:

| | Windows | macOS | Linux |
|---|---|---|---|
| nginx, PHP, MariaDB | Official vendor zips, SHA-256 checked where published | Homebrew (`brew install` run by the panel) | apt / dnf / pacman. The panel types the `sudo` command into its terminal; you press Enter. |
| PHP runs as | php-cgi worker pools | php-fpm | php-fpm |
| Multiple PHP versions | yes | yes (`php`, `php@8.4`, …) | yes on apt (ondrej PPA / sury), distro default on dnf/pacman |
| Node.js (Next.js, npm) | nodejs.org, SHA-256 checked | nodejs.org | nodejs.org |
| Default HTTP port | 80 | 80 | 8080 (ports below 1024 need root) |

- **Linux:** package installs also switch off the system-wide nginx, MariaDB and php-fpm services, so they don't compete for ports.
- **Uninstall:** LocalVPS never removes Homebrew or system packages.

## Features

| Page | What it does |
|---|---|
| Dashboard | CPU, RAM, disk, service health, recent activity |
| Services | Start/stop/restart nginx, MariaDB, the PHP pools and Next.js dev servers. Shows PIDs, memory and uptime. A watchdog restarts crashed services. |
| Sites | Templates for **Blank PHP**, **WordPress**, **Laravel** and **Next.js** on `name.localhost`. Per-site PHP version, web root, extra hostnames and custom nginx directives. |
| Terminal | In-browser shell per site (xterm.js + a real PTY) with the stack's `php`, `composer`, `mariadb`, `node` and `npm` on PATH, plus framework quick commands |
| Databases | Create/drop databases and users, SQL console, `.sql` import/export, root credentials |
| Export & Deploy | Bundle a site for any Ubuntu/Debian VPS, or deploy it over SSH with optional Let's Encrypt HTTPS |
| Components | Install, switch or detect stack components |
| Logs | Tail and filter nginx, PHP, MariaDB, app and per-site logs |
| Settings | Ports, LAN access, IPv6, PHP workers, default PHP, autostart |

### Site templates

| Template | What happens |
|---|---|
| Blank PHP | `public/index.php`; optional DB with credentials in `db.local.php` outside the web root |
| WordPress | Latest release (SHA-1 checked), its own DB, `wp-config.php` with fresh salts |
| Laravel | `composer create-project laravel/laravel`, `.env` pointed at MariaDB, migrations run (PHP 8.3+) |
| Next.js | `create-next-app` (TypeScript, App Router, Tailwind). Runs `next dev` behind nginx with WebSocket upgrade, so hot reload works. |

### Export to a VPS

Each export is a `.tar.gz` containing the site files, a database dump, a Linux nginx config, and `provision.sh`. The script:

- installs nginx, MariaDB and the matching PHP, or Node 22 LTS for Next.js
- deploys the files and recreates the database with the **same name, user and password**
- handles WordPress URLs (wp-cli)
- handles Laravel's production `.env` and migrations
- builds Next.js and runs it as a systemd service
- optionally sets up certbot HTTPS

```bash
mkdir bundle && tar -xzf site-….tar.gz -C bundle && cd bundle
sudo bash provision.sh --domain example.com --email you@example.com
```

## Security defaults

- **Panel:** binds to 127.0.0.1 only, checks the Host header (DNS-rebinding guard), and requires a per-install token on every API call. The terminal WebSocket also checks Origin.
- **Services:** nginx, PHP and MariaDB bind to loopback unless you turn on LAN access.
- **Databases:** MariaDB root gets a random password; each site gets its own DB user.
- **Web server:** nginx blocks dotfiles (`.env`, `.git`).

## Run from source

Requires Node.js 22+.

```bash
git clone https://github.com/humayunkabir98873/localvps.git
cd localvps
npm install
npm start
```

Use `start.cmd` (Windows) or `./start.sh` (macOS/Linux) to also open the browser. On Linux, `npm install` compiles `node-pty`, which needs `python3`, `make` and `g++`.

## Build packages

```bash
npm run build          # package for the OS you are on, into dist/
npm run build:linux    # Linux package from any OS, using Docker
```

`scripts/build.mjs` builds the package in these steps:

1. esbuild bundles the panel into one file.
2. The bundle becomes a [Node single-executable application](https://nodejs.org/api/single-executable-applications.html) injected into the running `node` binary.
3. The UI and `node-pty`'s native files are copied beside it.
4. A smoke test starts the result.
5. The output is zipped (Windows) or tarred (macOS/Linux).

Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds all three platforms on GitHub's runners and publishes the release.

## Layout

```
panel/          Node daemon: HTTP API, service manager, terminal
  lib/platform.js   OS differences (processes, shells, open)
  lib/unix.js       Homebrew/apt/dnf/pacman providers and detection
  lib/bins.js       where each stack binary lives per OS
ui/             Control panel (vanilla JS, no build step)
scripts/        Package builds
runtime/ data/ conf/ www/ exports/   created at runtime (git-ignored)
```

## License

[MIT](LICENSE)
