// Everything that differs between Windows, macOS and Linux outside the stack binaries themselves:
// system tool paths, opening folders/URLs, external terminal windows.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';
export const PLATFORM_LABEL = IS_WIN ? 'Windows' : IS_MAC ? 'macOS' : 'Linux';

export const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
// Windows: always System32 bsdtar, because a Git-for-Windows tar earlier on PATH cannot read zips.
export const TAR = IS_WIN ? path.join(SYSTEM32, 'tar.exe') : 'tar';
export const SSH = IS_WIN ? path.join(SYSTEM32, 'OpenSSH', 'ssh.exe') : 'ssh';
export const SCP = IS_WIN ? path.join(SYSTEM32, 'OpenSSH', 'scp.exe') : 'scp';

export const exe = (name) => (IS_WIN ? `${name}.exe` : name);

// Unprivileged processes cannot bind ports below 1024 on Linux; macOS and Windows allow it.
export const DEFAULT_HTTP_PORT = IS_LINUX ? 8080 : 80;

export function which(cmd) {
  const r = spawnSync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() || null : null;
}

const detached = (cmd, args, opts = {}) => {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, ...opts });
  child.on('error', () => {});
  child.unref();
};

export function openPath(target) {
  if (IS_WIN) detached(path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [target]);
  else detached(IS_MAC ? 'open' : 'xdg-open', [target]);
}

export function openUrl(url) {
  if (IS_WIN) detached(path.join(SYSTEM32, 'cmd.exe'), ['/c', 'start', '', url]);
  else detached(IS_MAC ? 'open' : 'xdg-open', [url]);
}

const LINUX_TERMINALS = [
  ['x-terminal-emulator', []], ['gnome-terminal', ['--']], ['konsole', ['-e']], ['xfce4-terminal', ['-x']], ['xterm', ['-e']],
];

// A separate terminal window with the stack's tools on PATH.
export function openExternalShell(cwd, env) {
  if (IS_WIN) {
    detached(path.join(SYSTEM32, 'cmd.exe'), ['/c', 'start', 'LocalVPS shell', 'cmd.exe', '/k', 'echo LocalVPS shell: php, composer, mariadb and node are on PATH.'], { cwd, env, windowsHide: false });
    return;
  }
  const shell = process.env.SHELL || '/bin/bash';
  if (IS_MAC) {
    // Terminal.app does not inherit our environment, so hand it a script that sets PATH and starts a shell.
    const script = path.join(os.tmpdir(), `localvps-shell-${process.pid}-${Date.now()}.command`);
    const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
    fs.writeFileSync(script, `#!/bin/sh\nrm -f ${q(script)}\nexport PATH=${q(env.PATH)}\n${env.PHPRC ? `export PHPRC=${q(env.PHPRC)}\n` : ''}cd ${q(cwd)}\necho "LocalVPS shell: php, composer, mariadb and node are on PATH."\nexec ${q(shell)} -l\n`, { mode: 0o755 });
    detached('open', ['-a', 'Terminal', script]);
    return;
  }
  const found = LINUX_TERMINALS.find(([t]) => which(t));
  if (!found) throw new Error('No terminal emulator found; use the in-panel Terminal instead');
  detached(found[0], [...found[1], shell, '-l'], { cwd, env });
}
