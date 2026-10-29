# LocalVPS: a free, open-source XAMPP alternative for Windows, macOS and Linux

**LocalVPS** is a local PHP development server with a modern web control panel. It installs **nginx, PHP (8.2 to 8.5), MariaDB and Node.js** and runs them for you. Every site gets its own address like `http://my-app.localhost`, with:

- one-click **WordPress**, **Laravel** and **Next.js** templates
- a database manager
- an in-browser terminal
- one-click export to a real Linux VPS

If you came here looking for **XAMPP for Mac**, **XAMPP for Linux**, or an **XAMPP alternative with current PHP versions**, this is it.

**[Website](https://humayunkabir98873.github.io/localvps/)** · **[Download](https://github.com/humayunkabir98873/localvps/releases/latest)** · **[Moving from XAMPP](https://humayunkabir98873.github.io/localvps/migrate-from-xampp/)**

## Why LocalVPS instead of XAMPP?

| | XAMPP (as of October 2026) | LocalVPS |
|---|---|---|
| Windows | ✅ PHP 8.3 / 8.4 / 8.5 | ✅ PHP 8.2 – 8.5, several versions side by side |
| macOS | ⚠️ No longer on the download page; last build PHP 8.2.4 (April 2023) | ✅ Apple Silicon, current PHP via Homebrew |
| Linux | ⚠️ No longer on the download page; last build PHP 8.2.12 (November 2023) | ✅ apt, dnf or pacman; PHP 8.2 – 8.5 on Debian/Ubuntu |
| Web server | Apache | nginx (the same as most production VPSs) |
| One site per hostname | Manual vhosts and hosts-file edits | Automatic `name.localhost`, no admin rights |
| PHP version per site | One PHP for everything | Pick per site |
| WordPress / Laravel / Next.js | Install by hand | One-click templates |
| Database admin defaults | phpMyAdmin logs in as root with an empty password | Random root password; separate user per site |
| Ship to a server | Not included | Export bundle or SSH deploy with HTTPS (Let's Encrypt) |
| Bundled extras | FileZilla FTP 0.9, Mercury Mail, Tomcat 8.5 | Only what you use: nginx, PHP, MariaDB, Node.js |

How LocalVPS works: it runs real nginx, PHP and MariaDB processes, each with its own configs, ports and data, inside its own folder. There are no hosts-file edits and nothing to configure by hand.

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

## FAQ

**Is LocalVPS free?**
Yes. It's open source under the MIT license, with no paid tier and no account.

**Is there an XAMPP for Mac with PHP 8.4?**
The official XAMPP download page no longer lists macOS; the newest macOS build on its SourceForge mirror is PHP 8.2.4 from April 2023. LocalVPS runs on Apple Silicon Macs with current PHP versions installed through Homebrew.

**Does it work on Linux?**
Yes. LocalVPS supports Ubuntu, Debian and other apt systems with PHP 8.2–8.5, plus Fedora (dnf) and Arch (pacman) with their default PHP. Sites run on port 8080 by default, so no root is needed.

**Can I use it without internet?**
Yes, once the stack is installed. Internet is only needed to download components and site templates (WordPress, Laravel, Next.js).

**Which is better, WAMP, XAMPP or LocalVPS?**
WAMP and XAMPP bundle Apache with one PHP version. LocalVPS uses nginx and gives every site its own PHP version and hostname, then exports the site to a real server. Pick whichever matches how you deploy.

**How do I move my sites from XAMPP?**
Create a Blank PHP site, copy your `htdocs` project into `www/<site>/public`, and import your `.sql` dump on the Databases page. The [migration guide](https://humayunkabir98873.github.io/localvps/migrate-from-xampp/) has the details.

**Can I run XAMPP and LocalVPS at the same time?**
Yes, if they use different ports. Change LocalVPS's HTTP and MariaDB ports in Settings, e.g. 8080 and 3307.

## License

[MIT](LICENSE)

XAMPP is a trademark of Apache Friends. LocalVPS is an independent project and isn't affiliated with or endorsed by Apache Friends; XAMPP is mentioned only for comparison.
