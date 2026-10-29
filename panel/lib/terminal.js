import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';
import { P } from './paths.js';
import { getState, getSecrets } from './state.js';
import { toolEnv, composerDir, nodeRuntime } from './tooling.js';
import { writePhpIni } from './config.js';
import { SYSTEM32, IS_WIN } from './platform.js';

// node-pty is a native addon, so it is never bundled: load it from node_modules next to the app,
// which also works inside the packaged exe (whose own require only sees built-in modules).
const require = createRequire(path.join(P.root, 'localvps.js'));
const pty = require('node-pty');

const MAX_SESSIONS = 12;
const sessions = new Set();

const GIT_BASH = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']
  .find((p) => fs.existsSync(p));

function findPwsh() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const exe = path.join(dir, 'pwsh.exe');
    if (dir && fs.existsSync(exe)) return exe;
  }
  return null;
}
const PWSH = findPwsh();

// The user's login shell first, then the common ones that exist. A login shell would normally re-read
// profile files that may reset PATH, so unix shells start interactive but not as login shells.
function unixShells() {
  const list = [];
  const add = (file, label) => {
    if (fs.existsSync(file) && !list.some((s) => fs.realpathSync(s.file) === fs.realpathSync(file))) {
      list.push({ id: path.basename(file), label, file, args: ['-i'] });
    }
  };
  if (process.env.SHELL) add(process.env.SHELL, `${path.basename(process.env.SHELL)} (login shell)`);
  for (const [file, label] of [['/bin/zsh', 'zsh'], ['/bin/bash', 'bash'], ['/usr/bin/fish', 'fish'], ['/bin/sh', 'sh']]) add(file, label);
  return list;
}

export function availableShells() {
  if (!IS_WIN) return unixShells();
  return [
    { id: 'powershell', label: PWSH ? 'PowerShell 7' : 'PowerShell', file: PWSH || path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'] },
    { id: 'cmd', label: 'Command Prompt', file: path.join(SYSTEM32, 'cmd.exe'), args: [] },
    GIT_BASH && { id: 'bash', label: 'Git Bash', file: GIT_BASH, args: ['--login', '-i'] },
  ].filter(Boolean);
}

function siteFor(name) {
  return getState().sites.find((s) => s.name === name) || null;
}

// Shown in the UI toolbar: ConPTY clears the screen when the shell starts, so a printed banner would vanish.
function toolsOnPath(site) {
  const st = getState();
  const tools = [];
  const php = site?.php || st.settings.defaultPhp;
  if (php && st.components.php[php]) tools.push(`php ${st.components.php[php].version}`);
  if (fs.existsSync(composerDir())) tools.push('composer');
  if (st.components.mariadb) tools.push(`mariadb ${st.components.mariadb.version}`);
  const node = nodeRuntime();
  if (node) tools.push(`node ${node.version}`, 'npm', 'npx');
  return tools;
}

// The terminal is a full shell on this PC, so the upgrade is held to the same rules as the API:
// loopback Host, same-origin Origin (blocks cross-site WebSocket hijacking) and the panel token.
export function attachTerminal(server, getAllowedHosts) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const host = req.headers.host || '';
    const reject = (code, msg) => { socket.end(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`); };
    if (url.pathname !== '/api/terminal') return reject(404, 'Not Found');
    if (!getAllowedHosts().has(host)) return reject(421, 'Misdirected Request');
    if (req.headers.origin !== `http://${host}`) return reject(403, 'Forbidden');
    if (sessions.size >= MAX_SESSIONS) return reject(429, 'Too Many Terminals');
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, url.searchParams));
  });
}

function onConnection(ws, params) {
  let term = null;
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
  const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), 5000);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!term) {
      if (msg.type !== 'auth' || msg.token !== getSecrets().panelToken) { ws.close(4003, 'bad token'); return; }
      clearTimeout(authTimer);
      try { term = startSession(params, send, ws); } catch (e) { send({ type: 'error', message: e.message }); ws.close(); }
      return;
    }
    if (msg.type === 'input' && typeof msg.data === 'string') term.write(msg.data);
    else if (msg.type === 'resize') {
      const cols = Math.max(10, Math.min(500, Number(msg.cols) || 80));
      const rows = Math.max(5, Math.min(200, Number(msg.rows) || 24));
      try { term.resize(cols, rows); } catch { /* process may have exited */ }
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (term) { sessions.delete(term); try { term.kill(); } catch { /* already gone */ } }
  });
}

function startSession(params, send, ws) {
  const shells = availableShells();
  const shell = shells.find((s) => s.id === params.get('shell')) || shells[0];
  const site = params.get('site') ? siteFor(params.get('site')) : null;
  if (params.get('site') && !site) throw new Error(`Site ${params.get('site')} not found`);
  const cwd = site ? path.join(P.www, site.name) : P.www;
  const php = site?.php || getState().settings.defaultPhp;
  if (php && getState().components.php[php]) writePhpIni(php);

  const env = toolEnv(php);
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.LOCALVPS_SITE = site?.name || '';

  const cols = Math.max(10, Math.min(500, Number(params.get('cols')) || 100));
  const rows = Math.max(5, Math.min(200, Number(params.get('rows')) || 30));
  const term = pty.spawn(shell.file, shell.args, { name: 'xterm-256color', cols, rows, cwd, env, ...(IS_WIN ? { useConpty: true } : {}) });
  sessions.add(term);

  send({ type: 'ready', shell: shell.label, cwd, pid: term.pid, tools: toolsOnPath(site) });
  term.onData((data) => send({ type: 'output', data }));
  term.onExit(({ exitCode }) => {
    sessions.delete(term);
    send({ type: 'exit', code: exitCode });
    ws.close(1000, 'shell exited');
  });
  return term;
}

export const terminalCount = () => sessions.size;
