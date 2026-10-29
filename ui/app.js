// LocalVPS control panel — vanilla JS, no build step.
const TOKEN = document.querySelector('meta[name="panel-token"]').content;

// ---------- helpers ----------
async function api(method, url, body, { raw } = {}) {
  const opts = { method, headers: { 'x-panel-token': TOKEN } };
  if (body instanceof Blob || body instanceof File) { opts.body = body; opts.headers['content-type'] = 'application/octet-stream'; }
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  const res = await fetch(url, opts);
  if (raw) { if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText); return res; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}
const GET = (u) => api('GET', u);
const POST = (u, b = {}) => api('POST', u, b);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// replaceChildren would render null/false as text, so filter them out.
const fill = (el, ...c) => el.replaceChildren(...c.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false));

const fmtBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};
const fmtDuration = (s) => {
  s = Math.floor(s);
  const d = Math.floor(s / 86400); const hh = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${hh}h` : hh ? `${hh}h ${m}m` : m ? `${m}m` : `${s}s`;
};
const ago = (iso) => fmtDuration((Date.now() - new Date(iso).getTime()) / 1000) + ' ago';
const hue = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);

function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}` }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 8000 : 4000);
}

async function act(btn, fn, okMsg) {
  const label = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
  try {
    const r = await fn();
    if (okMsg) toast(okMsg, 'ok');
    return r;
  } catch (e) {
    // Errors surface as a toast; callers just refresh afterwards.
    toast(e.message, 'err');
    return undefined;
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = label; }
  }
}

function modal({ title, body, foot, wide, onClose }) {
  const root = document.getElementById('modal-root');
  const close = () => { backdrop.remove(); onClose?.(); };
  const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (e) => { if (e.target === backdrop) close(); } },
    h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog' },
      h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', type: 'button', onclick: close, 'aria-label': 'Close' }, '✕')),
      h('div', { class: 'modal-body' }, body),
      foot ? h('div', { class: 'modal-foot' }, foot) : null));
  root.append(backdrop);
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  backdrop.querySelector('input,select,textarea')?.focus();
  return { close, el: backdrop };
}

function confirmModal(title, message, { danger = true, confirmText = 'Confirm', extra } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; m.close(); resolve(v); } };
    const ok = h('button', { class: danger ? 'danger' : '', type: 'button', onclick: () => finish(true) }, confirmText);
    const m = modal({
      title,
      body: h('div', { class: 'stack' }, h('p', { style: { margin: 0 } }, message), extra || null),
      foot: [h('button', { class: 'ghost', type: 'button', onclick: () => finish(false) }, 'Cancel'), ok],
      onClose: () => finish(false),
    });
  });
}

// Live job log in a modal; resolves with the finished job.
function watchJob(jobId, title) {
  return new Promise((resolve) => {
    const logEl = h('pre', { class: 'code', style: { minHeight: '260px' } });
    const bar = h('i', { style: { width: '0%' } });
    const status = h('span', { class: 'pill info' }, h('span', { class: 'spinner' }), 'Running');
    const m = modal({ title, wide: true, body: h('div', { class: 'stack' }, h('div', { class: 'row' }, status), h('div', { class: 'bar' }, bar), logEl) });
    let since = 0;
    const tick = async () => {
      if (!m.el.isConnected) return;
      let j;
      try { j = await GET(`/api/jobs/${jobId}?since=${since}`); } catch (e) { logEl.textContent += `\n${e.message}`; return; }
      since = j.logLength;
      if (j.log.length) { logEl.textContent += (logEl.textContent ? '\n' : '') + j.log.join('\n'); logEl.scrollTop = logEl.scrollHeight; }
      bar.style.width = j.progress != null ? `${Math.round(j.progress * 100)}%` : (j.status === 'running' ? '100%' : '100%');
      bar.parentElement.style.opacity = j.progress != null || j.status !== 'running' ? 1 : 0.4;
      if (j.status === 'running') { setTimeout(tick, 700); return; }
      status.className = `pill ${j.status === 'done' ? 'ok' : 'err'}`;
      status.textContent = j.status === 'done' ? 'Completed' : 'Failed';
      resolve(j);
    };
    tick();
  });
}

async function startJobAndWatch(promise, title) {
  const r = await promise;
  const j = await watchJob(r.job, title);
  refreshShell();
  return j;
}

async function downloadFile(rel) {
  const res = await api('GET', `/api/download?file=${encodeURIComponent(rel)}`, undefined, { raw: true });
  const blob = await res.blob();
  const a = h('a', { href: URL.createObjectURL(blob), download: rel.split('/').pop() });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---------- icons ----------
const ICONS = {
  dashboard: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
  services: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  sites: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  databases: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  deploy: '<path d="M12 3v12M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  components: '<path d="M21 16V8l-9-5-9 5v8l9 5zM3.3 7.5 12 12l8.7-4.5M12 22V12"/>',
  logs: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
};
const icon = (name) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  s.innerHTML = ICONS[name];
  return s;
};

// ---------- shell ----------
const PAGES = [
  ['dashboard', 'Dashboard'], ['services', 'Services'], ['sites', 'Sites'], ['terminal', 'Terminal'], ['databases', 'Databases'],
  ['deploy', 'Export & Deploy'], ['components', 'Components'], ['logs', 'Logs'], ['settings', 'Settings'],
];
let overview = null;
let pollTimer = null;
let currentPage = null;

function renderNav() {
  const nav = document.getElementById('nav');
  nav.replaceChildren(...PAGES.map(([id, label]) => {
    let count = null;
    if (overview && id === 'sites') count = overview.sites.length;
    if (overview && id === 'services') count = `${overview.services.filter((s) => s.running).length}/${overview.services.length}`;
    return h('a', { href: `#/${id}`, class: currentPage === id ? 'active' : '' }, icon(id), label, count !== null ? h('span', { class: 'count' }, count) : null);
  }));
}

async function refreshShell() {
  try { overview = await GET('/api/overview'); } catch (e) { document.getElementById('health-pill').className = 'pill err'; document.getElementById('health-pill').textContent = 'Panel unreachable'; return; }
  document.getElementById('host-name').textContent = overview.system.host;
  const svcs = overview.services;
  const up = svcs.filter((s) => s.running).length;
  const pill = document.getElementById('health-pill');
  if (!svcs.length) { pill.className = 'pill warn'; pill.textContent = 'Setup needed'; }
  else if (up === svcs.length) { pill.className = 'pill ok'; pill.replaceChildren(h('span', { class: 'dot ok' }), 'All services running'); }
  else if (up === 0) { pill.className = 'pill'; pill.replaceChildren(h('span', { class: 'dot' }), 'Stopped'); }
  else { pill.className = 'pill warn'; pill.replaceChildren(h('span', { class: 'dot warn' }), `${up}/${svcs.length} running`); }
  renderNav();
}

const views = {};
// A view can register teardown (e.g. closing a terminal session) that runs when the user navigates away.
let leaveHandler = null;
const onLeave = (fn) => { leaveHandler = fn; };
async function navigate() {
  const page = (location.hash.replace(/^#\/?/, '').split('/')[0]) || 'dashboard';
  currentPage = views[page] ? page : 'dashboard';
  clearInterval(pollTimer);
  try { leaveHandler?.(); } finally { leaveHandler = null; }
  document.getElementById('page-title').textContent = PAGES.find((p) => p[0] === currentPage)[1];
  document.querySelector('.sidebar').classList.remove('open');
  renderNav();
  const view = document.getElementById('view');
  fill(view, h('div', { class: 'empty' }, h('span', { class: 'spinner' })));
  try { await views[currentPage](view); } catch (e) { fill(view, h('div', { class: 'card empty' }, e.message)); }
}

function poll(fn, ms = 3000) {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden && !document.querySelector('.modal-backdrop')) fn(); }, ms);
}

// ---------- Dashboard ----------
views.dashboard = async (view) => {
  const render = async () => {
    await refreshShell();
    const o = overview;
    const s = o.system;
    const memUsed = s.memTotal - s.memFree;
    const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
    const statCard = (label, value, sub, p) => h('div', { class: 'card stat' },
      h('div', { class: 'label' }, label), h('div', { class: 'value' }, value),
      p != null ? h('div', { class: `bar ${p > 90 ? 'err' : p > 75 ? 'warn' : ''}` }, h('i', { style: { width: `${p}%` } })) : null,
      h('div', { class: 'muted small', style: { marginTop: '8px' } }, sub));
    const running = o.services.filter((x) => x.running).length;

    fill(view, 
      o.setupNeeded ? h('div', { class: 'banner' },
        h('div', {}, h('h2', {}, 'Set up your local server'), h('div', { class: 'muted' }, {
          vendor: 'Install nginx, PHP and MariaDB from their official sources. Downloads are hash-verified where the publisher provides hashes.',
          brew: 'Installs nginx, PHP and MariaDB with Homebrew, and Node.js from nodejs.org. LocalVPS then runs its own copies with their own configs and data.',
          system: `Installs nginx, PHP and MariaDB with ${o.provider.label} (you confirm the sudo command in the terminal), and Node.js from nodejs.org.`,
        }[o.provider.provider])),
        h('div', { class: 'actions' }, h('button', { type: 'button', onclick: (e) => quickSetup(e.currentTarget) }, 'Install recommended stack'))) : null,
      h('div', { class: 'grid cols-4' },
        statCard('CPU', `${s.cpuPct}%`, `${s.cpus} cores · ${s.cpuModel?.replace(/\s+/g, ' ').slice(0, 34) || ''}`, s.cpuPct),
        statCard('Memory', fmtBytes(memUsed), `of ${fmtBytes(s.memTotal)}`, pct(memUsed, s.memTotal)),
        statCard('Disk', s.disk ? fmtBytes(s.disk.total - s.disk.free) : '—', s.disk ? `${fmtBytes(s.disk.free)} free` : '', s.disk ? pct(s.disk.total - s.disk.free, s.disk.total) : null),
        statCard('Services', `${running}/${o.services.length}`, `Up ${fmtDuration(s.uptime)} · ${s.platform}`, null)),
      h('div', { class: 'grid cols-2 section' },
        h('div', { class: 'card flush' },
          h('div', { class: 'card-head', style: { padding: '16px 18px 0' } }, h('h2', {}, 'Services'), h('div', { class: 'actions' }, h('a', { href: '#/services' }, 'Manage →'))),
          o.services.length ? o.services.map((x) => h('div', { class: 'list-item' },
            h('span', { class: `dot ${x.running ? 'ok' : x.error ? 'err' : ''}` }),
            h('div', {}, h('div', {}, x.label), h('div', { class: 'muted small' }, `${x.version} · port ${x.port}`)),
            h('div', { class: 'spacer' }),
            x.running ? h('span', { class: 'muted small' }, fmtBytes(x.memKB * 1024)) : null,
            svcButton(x)))
            : h('div', { class: 'empty' }, 'No components installed yet.')),
        h('div', { class: 'card flush' },
          h('div', { class: 'card-head', style: { padding: '16px 18px 0' } }, h('h2', {}, 'Sites'), h('div', { class: 'actions' }, h('a', { href: '#/sites' }, 'All sites →'))),
          o.sites.length ? o.sites.slice(0, 6).map((site) => h('div', { class: 'list-item' },
            avatar(site.name),
            h('div', { style: { minWidth: 0 } }, h('a', { href: site.url, target: '_blank', rel: 'noopener' }, `${site.name}.localhost`), h('div', { class: 'muted small' }, `${site.type === 'node' ? 'Next.js' : `PHP ${site.php}`}${site.db ? ' · DB' : ''}${site.enabled === false ? ' · disabled' : ''}`))))
            : h('div', { class: 'empty' }, 'No sites yet. ', h('a', { href: '#/sites' }, 'Create one')))),
      o.jobs.length ? h('div', { class: 'card flush section' },
        h('div', { class: 'card-head', style: { padding: '16px 18px 0' } }, h('h2', {}, 'Recent activity')),
        o.jobs.map((j) => h('div', { class: 'list-item selectable', onclick: () => watchJob(j.id, j.title) },
          h('span', { class: `pill ${j.status === 'done' ? 'ok' : j.status === 'failed' ? 'err' : 'info'}` }, j.status),
          h('div', {}, j.title), h('div', { class: 'spacer' }), h('span', { class: 'muted small' }, ago(new Date(j.started).toISOString()))))) : null,
    );
  };
  await render();
  poll(render, 4000);
};

function avatar(name) {
  return h('div', { class: 'avatar', style: { background: `hsl(${hue(name)} 65% 50%)` } }, name[0].toUpperCase());
}

function svcButton(x) {
  return x.running
    ? h('button', { class: 'ghost small', type: 'button', onclick: (e) => act(e.currentTarget, () => POST(`/api/services/${x.key}/stop`), `${x.label} stopped`).then(navigate) }, 'Stop')
    : h('button', { class: 'small', type: 'button', onclick: (e) => act(e.currentTarget, () => POST(`/api/services/${x.key}/start`), `${x.label} started`).then(navigate) }, 'Start');
}

async function quickSetup(btn) {
  btn.disabled = true;
  try {
    const cat = await GET('/api/components/catalog');
    await refreshShell();
    const inst = overview.components;
    if (overview.provider.provider !== 'vendor' && !overview.provider.packageManager) {
      throw new Error(overview.provider.provider === 'brew' ? 'Install Homebrew from https://brew.sh first, then try again.' : 'No supported package manager found. Install nginx, php-fpm and mariadb-server, then use Components → Detect installed.');
    }
    const plan = [];
    if (!inst.nginx && Array.isArray(cat.nginx)) plan.push({ type: 'nginx', item: cat.nginx[0], label: `nginx ${cat.nginx[0].version}` });
    if (!Object.keys(inst.php).length && Array.isArray(cat.php)) {
      const p = cat.php.find((x) => x.branch === '8.4') || cat.php[0];
      plan.push({ type: 'php', item: p, label: `PHP ${p.version}` });
    }
    if (!inst.mariadb && Array.isArray(cat.mariadb)) {
      const m = cat.mariadb.find((x) => x.lts) || cat.mariadb[0];
      plan.push({ type: 'mariadb', item: m, label: `MariaDB ${m.version}` });
    }
    // Node.js powers Next.js sites and npm; a source checkout can fall back to the panel's own node.
    if (!inst.node && !overview.nodeRuntime && Array.isArray(cat.node)) {
      const n = cat.node.find((x) => x.branch === '24') || cat.node[0];
      plan.push({ type: 'node', item: n, label: `Node.js ${n.version}` });
    }
    // Linux: everything needing sudo goes into one command for the terminal; downloads still run as jobs.
    const sudoSteps = plan.filter((p) => p.item.command);
    for (const p of plan.filter((x) => !x.item.command)) {
      const j = await startJobAndWatch(POST('/api/components/install', { type: p.type, branch: p.item.branch }), `Installing ${p.label}`);
      if (j.status !== 'done') throw new Error(`${p.label} failed: ${j.error}`);
      document.querySelector('.modal-backdrop')?.remove();
    }
    if (sudoSteps.length) {
      commandModal('Install nginx, PHP and MariaDB', sudoSteps.map((p) => p.item.command).join(' && '));
      return;
    }
    const r = await POST('/api/services/all/start');
    const errs = Object.entries(r.errors || {});
    if (errs.length) toast(errs.map(([k, v]) => `${k}: ${v}`).join('\n'), 'err');
    else toast('Stack installed and running', 'ok');
  } catch (e) { toast(e.message, 'err'); } finally { btn.disabled = false; navigate(); }
}

// ---------- Services ----------
views.services = async (view) => {
  const render = async () => {
    const list = await GET('/api/services');
    await refreshShell();
    if (!list.length) {
      fill(view, h('div', { class: 'card empty' }, 'Nothing installed yet. ', h('a', { href: '#/components' }, 'Install components')));
      return;
    }
    fill(view, 
      h('div', { class: 'section-head' }, h('div', { class: 'muted' }, 'Services run as background processes and keep running if the panel closes. A watchdog restarts crashed services.'),
        h('div', { class: 'actions' }, h('button', { class: 'ghost', type: 'button', onclick: () => POST('/api/shell', {}).then(() => toast('Shell opened in a new window')) }, '>_ Open shell'))),
      h('div', { class: 'stack' }, list.map((x) => h('div', { class: 'card svc' },
        h('div', { class: 'svc-icon' }, x.key === 'nginx' ? 'NX' : x.key === 'mariadb' ? 'DB' : 'PHP'),
        h('div', {},
          h('div', { class: 'row' }, h('strong', {}, x.label), h('span', { class: `pill ${x.running ? 'ok' : x.error ? 'err' : ''}` }, h('span', { class: `dot ${x.running ? 'ok' : x.error ? 'err' : ''}` }), x.running ? 'Running' : x.error ? 'Error' : 'Stopped')),
          h('div', { class: 'svc-meta' },
            h('span', {}, `v${x.version}`), h('span', {}, `port ${x.port}`),
            x.workers ? h('span', {}, `workers ${x.workers}`) : null,
            x.running ? h('span', {}, `PID ${x.pids.join(', ')}`) : null,
            x.running ? h('span', {}, `RAM ${fmtBytes(x.memKB * 1024)}`) : null,
            x.startedAt ? h('span', {}, `up ${fmtDuration((Date.now() - x.startedAt) / 1000)}`) : null)),
        h('div', { class: 'row' },
          x.key === 'nginx' && x.running ? h('button', { class: 'ghost small', type: 'button', onclick: (e) => act(e.currentTarget, () => POST('/api/services/nginx/reload'), 'nginx reloaded') }, 'Reload') : null,
          x.key === 'nginx' ? h('button', { class: 'ghost small', type: 'button', onclick: (e) => act(e.currentTarget, async () => { const t = await GET('/api/nginx/test'); modal({ title: t.ok ? 'Config OK' : 'Config error', body: h('pre', { class: 'code' }, t.output) }); }) }, 'Test config') : null,
          x.running ? h('button', { class: 'ghost small', type: 'button', onclick: (e) => act(e.currentTarget, () => POST(`/api/services/${x.key}/restart`), `${x.label} restarted`).then(render) }, 'Restart') : null,
          svcButtonRefresh(x, render)),
        x.error ? h('div', { class: 'svc-error' }, x.error) : null))),
    );
  };
  await render();
  poll(render, 3000);
};

function svcButtonRefresh(x, render) {
  return x.running
    ? h('button', { class: 'ghost small', type: 'button', onclick: (e) => act(e.currentTarget, () => POST(`/api/services/${x.key}/stop`), `${x.label} stopped`).then(render, render) }, 'Stop')
    : h('button', { class: 'small', type: 'button', onclick: (e) => act(e.currentTarget, () => POST(`/api/services/${x.key}/start`), `${x.label} started`).then(render, render) }, 'Start');
}

// ---------- Sites ----------
views.sites = async (view) => {
  await refreshShell();
  const sites = await GET('/api/sites');
  const phpVersions = Object.keys(overview.components.php);
  fill(view, 
    h('div', { class: 'section-head' },
      h('div', { class: 'muted' }, 'Each site gets its own hostname: ', h('code', {}, 'name.localhost'), ' — no hosts-file edits needed.'),
      h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => newSiteModal(phpVersions) }, '+ New site'))),
    sites.length
      ? h('div', { class: 'grid cols-3' }, sites.map((s) => siteCard(s)))
      : h('div', { class: 'card empty' }, h('p', {}, 'No sites yet.'), h('button', { type: 'button', onclick: () => newSiteModal(phpVersions) }, 'Create your first site')),
  );
};

function siteCard(s) {
  return h('div', { class: 'card site-card' },
    h('div', { class: 'title' }, avatar(s.name),
      h('div', { style: { minWidth: 0 } }, h('strong', {}, s.name), h('div', { class: 'url' }, h('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.url))),
      h('span', { class: 'spacer' }),
      h('span', { class: `pill ${s.enabled === false ? '' : 'ok'}` }, s.enabled === false ? 'Disabled' : 'Live')),
    h('div', { class: 'row' },
      s.type === 'node'
        ? h('span', { class: 'pill info' }, `Node · :${s.appPort}`)
        : h('span', { class: 'pill info' }, `PHP ${s.php}`),
      TEMPLATE_INFO[s.template] && s.template !== 'blank' ? h('span', { class: 'pill' }, TEMPLATE_INFO[s.template].label) : null,
      s.db ? h('span', { class: 'pill' }, `DB ${s.db.name}`) : null),
    h('div', { class: 'foot' },
      h('button', { class: 'small', type: 'button', onclick: () => window.open(s.url, '_blank', 'noopener') }, 'Open'),
      h('button', { class: 'ghost small', type: 'button', onclick: () => POST(`/api/sites/${s.name}/open-folder`) }, 'Folder'),
      h('button', { class: 'ghost small', type: 'button', onclick: () => { location.hash = `#/terminal/${s.name}`; } }, 'Terminal'),
      s.type === 'node' ? h('button', { class: 'ghost small', type: 'button', onclick: (e) => act(e.currentTarget, () => POST(`/api/services/app-${s.name}/restart`), `${s.name} dev server restarted`) }, 'Restart app') : null,
      h('button', { class: 'ghost small', type: 'button', onclick: () => siteSettingsModal(s) }, 'Settings'),
      h('button', { class: 'ghost small', type: 'button', onclick: () => { location.hash = `#/deploy/${s.name}`; } }, 'Deploy')));
}

const TEMPLATE_INFO = {
  blank: { label: 'Blank PHP', badge: 'PHP', color: '#7a86b8', php: true, db: 'optional', desc: 'An index.php to start from. Optional MySQL database.' },
  wordpress: { label: 'WordPress', badge: 'WP', color: '#3b82c4', php: true, db: 'always', desc: 'Latest release (SHA-1 verified), its own database and wp-config.php with fresh salts.' },
  laravel: { label: 'Laravel', badge: 'L', color: '#f05340', php: true, db: 'always', minPhp: 8.3, desc: 'composer create-project, .env wired to MariaDB, migrations run. Needs PHP 8.3+.' },
  nextjs: { label: 'Next.js', badge: 'N', color: '#111827', php: false, db: 'optional', desc: 'create-next-app (TypeScript, App Router, Tailwind). Runs as a dev server with hot reload behind nginx.' },
};

function newSiteModal(phpVersions) {
  if (!overview.components.nginx) {
    toast('Install nginx first (Components page)', 'err');
    return;
  }
  let template = phpVersions.length ? 'blank' : 'nextjs';
  const name = h('input', { placeholder: 'my-app', autocomplete: 'off' });
  const php = h('select', {});
  const createDb = h('input', { type: 'checkbox' });
  const dbLabel = h('span', {}, 'Create a MySQL database and user');
  const dbRow = h('label', { class: 'check' }, createDb, dbLabel);
  const phpField = h('label', { class: 'field' }, 'PHP version', php);
  const desc = h('div', { class: 'hint' });
  const preview = h('div', { class: 'hint' }, 'URL: —');
  name.addEventListener('input', () => {
    name.value = name.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    preview.textContent = name.value ? `URL: http://${name.value}.localhost${overview.settings.httpPort === 80 ? '' : ':' + overview.settings.httpPort}/` : 'URL: —';
  });

  const tiles = h('div', { class: 'tpl-grid' });
  const submit = h('button', { type: 'button' }, 'Create site');
  const apply = () => {
    const info = TEMPLATE_INFO[template];
    [...tiles.children].forEach((t) => t.classList.toggle('selected', t.dataset.tpl === template));
    phpField.style.display = info.php ? '' : 'none';
    // Only offer PHP versions the template supports, newest first.
    const ok = phpVersions.filter((v) => !info.minPhp || Number.parseFloat(v) >= info.minPhp).sort((a, b) => Number.parseFloat(b) - Number.parseFloat(a));
    php.replaceChildren(...ok.map((v) => h('option', { value: v, selected: v === overview.settings.defaultPhp }, `PHP ${v}`)));
    const phpMissing = info.php && !ok.length;
    const nodeMissing = !info.php && !overview.nodeRuntime;
    dbRow.style.display = info.db === 'optional' ? '' : 'none';
    dbLabel.textContent = template === 'nextjs' ? 'Create a MySQL database (DATABASE_URL in .env.local)' : 'Create a MySQL database and user';
    desc.textContent = phpMissing
      ? `Install PHP ${info.minPhp || ''}${info.minPhp ? '+' : ''} on the Components page first.`
      : nodeMissing ? 'Install Node.js on the Components page first.' : info.desc;
    submit.disabled = phpMissing || nodeMissing;
  };
  for (const [key, info] of Object.entries(TEMPLATE_INFO)) {
    tiles.append(h('button', { type: 'button', class: 'tpl', 'data-tpl': key, onclick: () => { template = key; apply(); } },
      h('span', { class: 'tpl-badge', style: { background: info.color } }, info.badge),
      h('span', { class: 'tpl-name' }, info.label)));
  }
  apply();

  const m = modal({
    title: 'New site',
    wide: true,
    body: h('div', { class: 'form' },
      h('label', { class: 'field' }, 'Site name', name, preview),
      h('div', { class: 'field' }, 'Template', tiles, desc),
      phpField,
      dbRow),
    foot: [h('button', { class: 'ghost', type: 'button', onclick: () => m.close() }, 'Cancel'), submit],
  });
  submit.addEventListener('click', () => act(submit, async () => {
    const r = await POST('/api/sites', { name: name.value, php: TEMPLATE_INFO[template].php ? php.value : undefined, template, createDb: createDb.checked });
    m.close();
    if (r.job) await watchJob(r.job, `Creating ${name.value}`);
    else toast(`Site ready: ${r.url}`, 'ok');
    navigate();
  }));
  name.focus();
}

async function siteSettingsModal(s) {
  const phpVersions = Object.keys(overview.components.php);
  const php = h('select', {}, phpVersions.map((v) => h('option', { value: v, selected: v === s.php }, `PHP ${v}`)));
  const enabled = h('input', { type: 'checkbox', checked: s.enabled !== false });
  const webroot = h('input', { value: s.webroot || 'public' });
  const appPort = h('input', { type: 'number', value: s.appPort || '' });
  const isNode = s.type === 'node';
  const dbHint = { blank: 'Also saved to db.local.php next to the web root (not web-accessible).', laravel: 'Also set in the project\'s .env.', wordpress: 'Also set in wp-config.php.', nextjs: 'Also set as DATABASE_URL in .env.local.' }[s.template];
  const aliases = h('input', { value: (s.aliases || []).join(' '), placeholder: 'e.g. shop.localhost api.my-app.localhost' });
  const extra = h('textarea', { rows: 5, placeholder: 'location /api { ... }' }, s.extraNginx || '');
  const confView = h('pre', { class: 'code' }, 'Loading…');
  GET(`/api/sites/${s.name}/config`).then((r) => { confView.textContent = r.config; }).catch((e) => { confView.textContent = e.message; });
  const tabs = h('div', { class: 'tabs' });
  const general = h('div', { class: 'form' },
    isNode
      ? h('label', { class: 'field' }, 'App port (Next.js dev server, proxied by nginx)', appPort)
      : h('div', { class: 'form cols-2' }, h('label', { class: 'field' }, 'PHP version', php), h('label', { class: 'field' }, 'Web root (inside the site folder)', webroot)),
    h('label', { class: 'field' }, 'Extra hostnames', aliases),
    h('label', { class: 'field' }, 'Extra nginx directives (inside server { })', extra),
    h('label', { class: 'check' }, enabled, 'Site enabled'),
    s.db ? h('div', { class: 'card', style: { background: 'var(--panel-2)' } }, h('h3', {}, 'Database'),
      h('dl', { class: 'kv' }, h('dt', {}, 'Host'), h('dd', {}, `127.0.0.1:${overview.settings.mariadbPort}`), h('dt', {}, 'Database'), h('dd', {}, s.db.name), h('dt', {}, 'User'), h('dd', {}, s.db.user), h('dt', {}, 'Password'), h('dd', {}, s.db.password)),
      dbHint ? h('div', { class: 'hint', style: { marginTop: '8px' } }, dbHint) : null) : null,
    h('dl', { class: 'kv' }, h('dt', {}, 'Folder'), h('dd', {}, s.path), h('dt', {}, 'Created'), h('dd', {}, new Date(s.createdAt).toLocaleString())));
  const panes = { General: general, 'nginx config': confView };
  const holder = h('div', {});
  const show = (k) => { holder.replaceChildren(panes[k]); [...tabs.children].forEach((b) => b.classList.toggle('active', b.textContent === k)); };
  Object.keys(panes).forEach((k) => tabs.append(h('button', { type: 'button', onclick: () => show(k) }, k)));
  show('General');
  const save = h('button', { type: 'button' }, 'Save');
  const del = h('button', { class: 'danger', type: 'button' }, 'Delete site');
  const m = modal({ title: `${s.name} settings`, wide: true, body: [tabs, holder], foot: [del, h('span', { class: 'spacer' }), h('button', { class: 'ghost', type: 'button', onclick: () => m.close() }, 'Close'), save] });
  save.addEventListener('click', () => act(save, async () => {
    const patch = isNode
      ? { appPort: appPort.value, enabled: enabled.checked, aliases: aliases.value, extraNginx: extra.value }
      : { php: php.value, enabled: enabled.checked, webroot: webroot.value, aliases: aliases.value, extraNginx: extra.value };
    await api('PATCH', `/api/sites/${s.name}`, patch);
    m.close(); navigate();
  }, 'Site updated'));
  del.addEventListener('click', async () => {
    const files = h('input', { type: 'checkbox' });
    const dbx = h('input', { type: 'checkbox' });
    const ok = await confirmModal(`Delete ${s.name}?`, 'The site is removed from nginx. Optionally delete its files and database too.', {
      confirmText: 'Delete',
      extra: h('div', { class: 'stack' }, h('label', { class: 'check' }, files, `Delete files in ${s.path}`), s.db ? h('label', { class: 'check' }, dbx, `Drop database ${s.db.name} and its user`) : null),
    });
    if (!ok) return;
    await act(null, () => api('DELETE', `/api/sites/${s.name}?files=${files.checked ? 1 : 0}&db=${dbx.checked ? 1 : 0}`), 'Site deleted');
    m.close(); navigate();
  });
}

// ---------- Terminal ----------
const QUICK_COMMANDS = {
  laravel: ['php artisan migrate', 'php artisan route:list', 'php artisan make:controller ', 'php artisan make:model -m ', 'composer require ', 'php artisan tinker'],
  nextjs: ['npm install ', 'npm run build', 'npm run lint', 'npm outdated', 'npx shadcn@latest init'],
  wordpress: ['php -v', 'composer init'],
  blank: ['php -v', 'composer init', 'composer require '],
  _: ['php -v', 'node -v', 'composer --version'],
};

let xtermLib = null;
async function loadXterm() {
  if (xtermLib) return xtermLib;
  if (!document.querySelector('link[data-xterm]')) {
    document.head.append(h('link', { rel: 'stylesheet', href: '/vendor/xterm.css', 'data-xterm': '1' }));
  }
  const [{ Terminal }, { FitAddon }] = await Promise.all([import('/vendor/xterm.mjs'), import('/vendor/addon-fit.mjs')]);
  xtermLib = { Terminal, FitAddon };
  return xtermLib;
}

views.terminal = async (view) => {
  await refreshShell();
  const sites = overview.sites;
  const wanted = decodeURIComponent(location.hash.split('/')[2] || '');
  const site = sites.find((s) => s.name === wanted) || null;
  const [shells, { Terminal, FitAddon }] = await Promise.all([GET('/api/terminal/shells'), loadXterm()]);

  let shellId = (() => { try { return localStorage.getItem('localvps-shell'); } catch { return null; } })() || shells[0].id;
  if (!shells.some((s) => s.id === shellId)) shellId = shells[0].id;

  const siteSel = h('select', { style: { width: 'auto' } },
    h('option', { value: '' }, 'www (all sites)'),
    sites.map((s) => h('option', { value: s.name, selected: s === site }, `${s.name}.localhost`)));
  siteSel.addEventListener('change', () => { location.hash = siteSel.value ? `#/terminal/${siteSel.value}` : '#/terminal'; });
  const shellSel = h('select', { style: { width: 'auto' } }, shells.map((s) => h('option', { value: s.id, selected: s.id === shellId }, s.label)));
  const status = h('span', { class: 'pill' }, 'Connecting…');
  const toolsLine = h('div', { class: 'muted small mono term-tools' });
  const host = h('div', { class: 'term-host' });
  const chips = h('div', { class: 'row' });

  const term = new Terminal({
    cursorBlink: true,
    fontFamily: getComputedStyle(document.body).getPropertyValue('--mono'),
    fontSize: 13,
    scrollback: 5000,
    allowProposedApi: false,
    theme: { background: '#0b0e14', foreground: '#e6e9ef', cursor: '#7aa2ff', selectionBackground: '#2b5cff55' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  let ws = null;
  const send = (obj) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
  const setStatus = (text, kind) => { status.className = `pill ${kind || ''}`; status.textContent = text; };

  const connect = () => {
    ws?.close();
    term.reset();
    setStatus('Connecting…');
    const q = new URLSearchParams({ shell: shellId, cols: term.cols, rows: term.rows });
    if (site) q.set('site', site.name);
    ws = new WebSocket(`ws://${location.host}/api/terminal?${q}`);
    const sock = ws;
    sock.onopen = () => sock.send(JSON.stringify({ type: 'auth', token: TOKEN }));
    sock.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'output') term.write(msg.data);
      else if (msg.type === 'ready') {
        setStatus(`${msg.shell} · PID ${msg.pid}`, 'ok');
        toolsLine.textContent = `${msg.cwd}  ·  on PATH: ${msg.tools.join(', ')}`;
        term.focus();
        // A command handed over from Components (Linux sudo installs) is typed, never run: the user presses Enter.
        let pending = null;
        try { pending = sessionStorage.getItem(PENDING_CMD); sessionStorage.removeItem(PENDING_CMD); } catch { /* storage unavailable */ }
        if (pending) {
          setTimeout(() => send({ type: 'input', data: pending }), 600);
          toast('Command typed into the terminal: press Enter to run it, then enter your password if sudo asks.');
        }
      }
      else if (msg.type === 'exit') { setStatus(`Exited (${msg.code})`); term.write('\r\n\x1b[2m[process exited — press Restart for a new session]\x1b[0m\r\n'); }
      else if (msg.type === 'error') { setStatus('Error', 'err'); term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`); }
    };
    sock.onclose = (ev) => { if (sock === ws && status.textContent.startsWith('Connecting')) setStatus(`Closed${ev.reason ? `: ${ev.reason}` : ''}`, 'err'); else if (sock === ws && !status.textContent.startsWith('Exited')) setStatus('Disconnected'); };
  };

  term.onData((data) => send({ type: 'input', data }));
  term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));

  shellSel.addEventListener('change', () => {
    shellId = shellSel.value;
    try { localStorage.setItem('localvps-shell', shellId); } catch { /* storage unavailable */ }
    connect();
  });

  const runCmd = (cmd) => {
    // Commands ending in a space are typed for the user to finish; complete ones run immediately.
    send({ type: 'input', data: cmd.endsWith(' ') ? cmd : `${cmd}\r` });
    term.focus();
  };
  for (const cmd of QUICK_COMMANDS[site?.template] || QUICK_COMMANDS._) {
    chips.append(h('button', { class: 'chip', type: 'button', title: cmd.endsWith(' ') ? 'Types the command so you can finish it' : 'Runs now', onclick: () => runCmd(cmd) }, cmd.trim() + (cmd.endsWith(' ') ? ' …' : '')));
  }

  fill(view,
    h('div', { class: 'term-toolbar' },
      siteSel, shellSel, status,
      h('span', { class: 'spacer' }),
      site ? h('a', { href: site.url, target: '_blank', rel: 'noopener', class: 'small' }, `Open ${site.name}.localhost ↗`) : null,
      h('button', { class: 'ghost small', type: 'button', onclick: () => { term.clear(); term.focus(); } }, 'Clear'),
      h('button', { class: 'ghost small', type: 'button', onclick: () => connect() }, 'Restart'),
      h('button', { class: 'ghost small', type: 'button', title: 'Open the same environment in a separate window', onclick: () => POST('/api/shell', { site: site?.name, php: site?.php || undefined }).then(() => toast('Opened in a new window')) }, 'Pop out')),
    toolsLine,
    h('div', { class: 'card flush term-card' }, host),
    h('div', { class: 'term-foot' }, h('span', { class: 'muted small' }, 'Quick commands:'), chips));

  term.open(host);
  fit.fit();
  const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* not visible */ } });
  ro.observe(host);
  connect();

  onLeave(() => { ro.disconnect(); ws?.close(); term.dispose(); });
};

// ---------- Databases ----------
views.databases = async (view) => {
  await refreshShell();
  if (!overview.components.mariadb) { fill(view, h('div', { class: 'card empty' }, 'MariaDB is not installed. ', h('a', { href: '#/components' }, 'Install it'))); return; }
  let data;
  try { data = await GET('/api/db'); } catch (e) {
    fill(view, h('div', { class: 'card empty' }, h('p', {}, e.message),
      h('button', { type: 'button', onclick: (ev) => act(ev.currentTarget, () => POST('/api/services/mariadb/start'), 'MariaDB started').then(navigate) }, 'Start MariaDB')));
    return;
  }
  let selected = data.databases.find((d) => !d.system)?.name || '';
  const dbSelect = h('select', {}, h('option', { value: '' }, '(no default database)'), data.databases.map((d) => h('option', { value: d.name }, d.name)));
  dbSelect.value = selected;
  const sql = h('textarea', { rows: 7, placeholder: 'SELECT * FROM ...;   (Ctrl+Enter to run)' });
  const out = h('div', { class: 'stack' });
  const runBtn = h('button', { type: 'button' }, 'Run');
  const runQuery = () => act(runBtn, async () => {
    const r = await POST('/api/db/query', { db: dbSelect.value, sql: sql.value });
    out.replaceChildren(h('div', { class: 'muted small' }, `${r.results.length} result${r.results.length > 1 ? 's' : ''} · ${r.ms} ms`), ...r.results.map(renderResult));
  });
  runBtn.addEventListener('click', runQuery);
  sql.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runQuery(); } });

  const list = h('div', { class: 'card flush' },
    h('div', { class: 'card-head', style: { padding: '14px 16px 0' } }, h('h2', {}, 'Databases'),
      h('div', { class: 'actions' }, h('button', { class: 'small', type: 'button', onclick: newDbModal }, '+ New'))),
    data.databases.map((d) => h('div', {
      class: `list-item selectable ${d.name === selected ? 'selected' : ''}`,
      onclick: (e) => { selected = d.name; dbSelect.value = d.name; sql.value = `SHOW TABLE STATUS;`; [...list.querySelectorAll('.list-item')].forEach((x) => x.classList.remove('selected')); e.currentTarget.classList.add('selected'); runQuery(); },
    },
    h('div', { style: { minWidth: 0 } }, h('div', {}, d.name, d.system ? h('span', { class: 'muted small' }, ' · system') : null),
      h('div', { class: 'muted small' }, `${d.tables} tables · ${fmtBytes(d.bytes)}${d.site ? ` · site ${d.site}` : ''}`)),
    h('div', { class: 'spacer' }),
    d.system ? null : dbMenu(d))));

  const creds = h('button', { class: 'ghost small', type: 'button', onclick: async () => {
    const r = await GET('/api/db/root-password');
    modal({ title: 'MariaDB root credentials', body: h('div', { class: 'stack' }, h('dl', { class: 'kv' }, h('dt', {}, 'Host'), h('dd', {}, `127.0.0.1:${r.port}`), h('dt', {}, 'User'), h('dd', {}, 'root'), h('dt', {}, 'Password'), h('dd', {}, r.password)),
      h('div', { class: 'hint' }, 'Generated at install and stored in data/secrets.json. MariaDB only listens on 127.0.0.1 unless LAN access is enabled.')) });
  } }, 'Root credentials');

  fill(view, h('div', { class: 'split' }, h('div', { class: 'stack' }, list,
    h('div', { class: 'card' }, h('h3', {}, 'Users'), h('div', { class: 'stack small mono' }, data.users.map((u) => h('div', {}, `${u.user}@${u.host}`))))),
  h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'SQL console'), h('div', { class: 'actions' }, creds)),
    h('div', { class: 'stack' }, h('div', { class: 'row' }, h('div', { style: { flex: 1 } }, dbSelect), runBtn), sql, out))));
  if (selected) { sql.value = 'SHOW TABLE STATUS;'; }
};

function renderResult(r) {
  if (!r.columns) return h('div', { class: 'pill ok' }, `${r.affectedRows} row(s) affected${r.insertId ? ` · insert id ${r.insertId}` : ''}${r.info ? ` · ${r.info}` : ''}`);
  return h('div', { class: 'card flush results' },
    h('table', {}, h('thead', {}, h('tr', {}, r.columns.map((c) => h('th', {}, c)))),
      h('tbody', {}, r.rows.length ? r.rows.map((row) => h('tr', {}, row.map((v) => h('td', { class: v === null ? 'null' : '', title: v === null ? '' : String(v) }, v === null ? 'NULL' : String(v))))) : h('tr', {}, h('td', { colspan: r.columns.length, class: 'muted' }, 'Empty set')))),
    r.truncated ? h('div', { class: 'muted small', style: { padding: '8px 12px' } }, `Showing 1000 of ${r.total} rows`) : null);
}

function dbMenu(d) {
  const stop = (fn) => (e) => { e.stopPropagation(); fn(e); };
  const fileInput = h('input', { type: 'file', accept: '.sql', style: { display: 'none' } });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    if (!f) return;
    act(null, () => api('POST', `/api/db/${d.name}/import`, f), `Imported ${f.name} into ${d.name}`).then(navigate);
  });
  return h('div', { class: 'row', onclick: (e) => e.stopPropagation() },
    fileInput,
    h('button', { class: 'icon-btn small', type: 'button', title: 'Export .sql', onclick: stop((e) => act(e.currentTarget, async () => { const r = await POST(`/api/db/${d.name}/export`); await downloadFile(r.file); }, `Exported ${d.name}`)) }, '⤓'),
    h('button', { class: 'icon-btn small', type: 'button', title: 'Import .sql', onclick: stop(() => fileInput.click()) }, '⤒'),
    h('button', { class: 'icon-btn small', type: 'button', title: 'Drop database', onclick: stop(async () => {
      if (!(await confirmModal(`Drop ${d.name}?`, 'All tables and data in this database are permanently deleted.', { confirmText: 'Drop database' }))) return;
      act(null, () => api('DELETE', `/api/db/${d.name}`), `Dropped ${d.name}`).then(navigate);
    }) }, '🗑'));
}

function newDbModal() {
  const name = h('input', { placeholder: 'app_db' });
  const user = h('input', { placeholder: 'optional, e.g. app_user' });
  const submit = h('button', { type: 'button' }, 'Create');
  const m = modal({
    title: 'New database',
    body: h('div', { class: 'form' }, h('label', { class: 'field' }, 'Database name', name), h('label', { class: 'field' }, 'Create user with full access (password is generated)', user)),
    foot: [h('button', { class: 'ghost', type: 'button', onclick: () => m.close() }, 'Cancel'), submit],
  });
  submit.addEventListener('click', () => act(submit, async () => {
    const r = await POST('/api/db', { name: name.value, user: user.value || undefined });
    m.close();
    if (r.user) modal({ title: 'Database created', body: h('dl', { class: 'kv' }, h('dt', {}, 'Database'), h('dd', {}, r.name), h('dt', {}, 'User'), h('dd', {}, r.user), h('dt', {}, 'Password'), h('dd', {}, r.password)) });
    navigate();
  }, 'Database created'));
}

// ---------- Export & Deploy ----------
views.deploy = async (view) => {
  await refreshShell();
  const preselect = location.hash.split('/')[2] || '';
  const [servers, exportsList] = await Promise.all([GET('/api/servers'), GET('/api/exports')]);
  const sites = overview.sites;

  const siteSel = h('select', {}, sites.map((s) => h('option', { value: s.name, selected: s.name === preselect }, s.name)));
  const includeDb = h('input', { type: 'checkbox', checked: true });
  const serverSel = h('select', {}, servers.length ? servers.map((s) => h('option', { value: s.id }, `${s.name} (${s.user}@${s.host})`)) : h('option', { value: '' }, 'Add a server first'));
  const domain = h('input', { placeholder: 'example.com (blank = server IP)' });
  const email = h('input', { placeholder: 'you@example.com — enables HTTPS via Let\'s Encrypt' });

  const exportBtn = h('button', { class: 'ghost', type: 'button', disabled: !sites.length }, 'Build bundle only');
  exportBtn.addEventListener('click', () => act(exportBtn, async () => {
    await startJobAndWatch(POST('/api/exports', { name: siteSel.value, includeDb: includeDb.checked }), `Exporting ${siteSel.value}`);
    navigate();
  }));
  const deployBtn = h('button', { type: 'button', disabled: !sites.length || !servers.length }, 'Deploy to server');
  deployBtn.addEventListener('click', async () => {
    const srv = servers.find((s) => s.id === serverSel.value);
    const ok = await confirmModal('Deploy to a live server?', `This uploads ${siteSel.value} to ${srv.user}@${srv.host} and runs provision.sh with root rights: it installs nginx, PHP and MariaDB packages, writes /var/www/${siteSel.value} and an nginx site${email.value ? ', and requests a Let\'s Encrypt certificate' : ''}.`, { danger: false, confirmText: 'Deploy' });
    if (!ok) return;
    act(deployBtn, () => startJobAndWatch(POST('/api/deploy', { name: siteSel.value, serverId: serverSel.value, domain: domain.value, email: email.value, includeDb: includeDb.checked }), `Deploying ${siteSel.value}`));
  });

  fill(view, 
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Ship a site to a real VPS')),
        sites.length ? h('div', { class: 'form' },
          h('div', { class: 'form cols-2' }, h('label', { class: 'field' }, 'Site', siteSel), h('label', { class: 'field' }, 'Target server', serverSel)),
          h('label', { class: 'field' }, 'Domain', domain),
          h('label', { class: 'field' }, 'Email for HTTPS (optional)', email),
          h('label', { class: 'check' }, includeDb, 'Include database (same name, user and password on the server)'),
          h('div', { class: 'row' }, deployBtn, exportBtn),
          h('div', { class: 'hint' }, 'The bundle contains your files, a database dump, an nginx config and provision.sh for Ubuntu 22.04/24.04 or Debian 12. "Build bundle only" lets you copy it to any server yourself.'))
          : h('div', { class: 'empty' }, 'Create a site first.')),
      h('div', { class: 'card flush' },
        h('div', { class: 'card-head', style: { padding: '16px 18px 0' } }, h('h2', {}, 'Servers'), h('div', { class: 'actions' }, h('button', { class: 'small', type: 'button', onclick: () => serverModal() }, '+ Add server'))),
        servers.length ? servers.map((s) => h('div', { class: 'list-item' },
          h('div', { class: 'svc-icon', style: { width: '34px', height: '34px' } }, '⌁'),
          h('div', {}, h('div', {}, s.name), h('div', { class: 'muted small mono' }, `${s.user}@${s.host}:${s.port}`)),
          h('div', { class: 'spacer' }),
          h('button', { class: 'ghost small', type: 'button', onclick: (e) => act(e.currentTarget, async () => { const r = await POST(`/api/servers/${s.id}/test`); modal({ title: r.ok ? 'Connection OK' : 'Connection failed', body: h('pre', { class: 'code' }, r.output || '(no output)') }); }) }, 'Test'),
          h('button', { class: 'ghost small', type: 'button', onclick: () => serverModal(s) }, 'Edit'),
          h('button', { class: 'danger small', type: 'button', onclick: async () => { if (await confirmModal(`Remove ${s.name}?`, 'Only the saved connection is removed; nothing changes on the server.', { confirmText: 'Remove' })) { await api('DELETE', `/api/servers/${s.id}`); navigate(); } } }, 'Remove')))
          : h('div', { class: 'empty' }, 'No servers yet. Deploys use SSH key authentication (Windows OpenSSH).'))),
    h('div', { class: 'card flush section' },
      h('div', { class: 'card-head', style: { padding: '16px 18px 0' } }, h('h2', {}, 'Export bundles')),
      exportsList.length ? h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Bundle'), h('th', {}, 'Size'), h('th', {}, 'Created'), h('th', {}))),
        h('tbody', {}, exportsList.map((x) => h('tr', {},
          h('td', { class: 'mono' }, x.file), h('td', {}, fmtBytes(x.size)), h('td', { class: 'muted' }, ago(x.createdAt)),
          h('td', { class: 'actions' },
            h('button', { class: 'ghost small', type: 'button', onclick: (e) => act(e.currentTarget, () => downloadFile(x.file)) }, 'Download'),
            h('button', { class: 'danger small', type: 'button', onclick: async () => { await api('DELETE', `/api/exports/${x.id}`); navigate(); } }, 'Delete'))))))
        : h('div', { class: 'empty' }, 'No bundles yet.')),
  );
};

function serverModal(s = {}) {
  const name = h('input', { value: s.name || '', placeholder: 'production' });
  const host = h('input', { value: s.host || '', placeholder: '203.0.113.10 or vps.example.com' });
  const port = h('input', { value: s.port || 22, type: 'number' });
  const user = h('input', { value: s.user || 'root' });
  const keyPath = h('input', { value: s.keyPath || '', placeholder: 'C:\\Users\\you\\.ssh\\id_ed25519 (blank = ssh-agent/default key)' });
  const save = h('button', { type: 'button' }, 'Save');
  const m = modal({
    title: s.id ? 'Edit server' : 'Add server',
    body: h('div', { class: 'form' },
      h('label', { class: 'field' }, 'Name', name),
      h('div', { class: 'form cols-2' }, h('label', { class: 'field' }, 'Host', host), h('label', { class: 'field' }, 'SSH port', port)),
      h('label', { class: 'field' }, 'User (root, or a user with passwordless sudo)', user),
      h('label', { class: 'field' }, 'Private key file', keyPath),
      h('div', { class: 'hint' }, 'Passwords are never stored. Add your public key to the server\'s ~/.ssh/authorized_keys first.')),
    foot: [h('button', { class: 'ghost', type: 'button', onclick: () => m.close() }, 'Cancel'), save],
  });
  save.addEventListener('click', () => act(save, async () => {
    await POST('/api/servers', { id: s.id, name: name.value, host: host.value, port: port.value, user: user.value, keyPath: keyPath.value });
    m.close(); navigate();
  }, 'Server saved'));
}

// ---------- Components ----------
views.components = async (view) => {
  await refreshShell();
  fill(view, h('div', { class: 'card empty' }, h('span', { class: 'spinner' }), ' Fetching release catalogs from nginx.org, windows.php.net, mariadb.org and nodejs.org…'));
  const cat = await GET('/api/components/catalog');
  await refreshShell(); // the catalog call re-detects Homebrew/system packages on macOS and Linux
  const inst = overview.components;
  const prov = overview.provider;
  const SOURCE = { brew: 'via Homebrew', system: `system package (${prov.packageManager?.label || 'OS'})` };
  const installedRow = (type, rec, label) => h('div', { class: 'list-item' },
    h('span', { class: 'dot ok' }),
    h('div', { style: { minWidth: 0 } }, h('div', {}, `${label} ${rec.version}`), h('div', { class: 'muted small mono' }, rec.bins ? Object.values(rec.bins).filter(Boolean)[0] : rec.path)),
    h('div', { class: 'spacer' }),
    rec.source
      ? h('span', { class: 'pill info' }, SOURCE[rec.source])
      : h('span', { class: `pill ${rec.verified ? 'ok' : 'warn'}`, title: rec.sha256 }, rec.verified ? 'hash verified' : 'unverified hash'),
    // Homebrew/system packages are managed by their package manager, not removed from here.
    rec.source ? null : h('button', { class: 'danger small', type: 'button', onclick: async () => {
      if (!(await confirmModal(`Remove ${label} ${rec.version}?`, `Deletes ${rec.path}. Data (databases, sites) is kept.`, { confirmText: 'Remove' }))) return;
      act(null, () => POST('/api/components/remove', { type, branch: rec.branch }), 'Removed').then(navigate);
    } }, 'Remove'));
  const install = (btn, type, x, label) => act(btn, async () => {
    const r = await POST('/api/components/install', { type, branch: x.branch });
    if (r.command) { commandModal(`Install ${label}`, r.command); return; }
    await watchJob(r.job, `Installing ${label} ${x.version}`);
    navigate();
  });
  const available = (type, list, isInstalled, label) => {
    if (!Array.isArray(list)) return h('div', { class: 'empty' }, `Catalog unavailable: ${list?.error}`);
    return list.map((x) => h('div', { class: 'list-item' },
      h('div', { style: { minWidth: 0 } }, h('div', {}, `${label} ${x.version}`, x.lts ? h('span', { class: 'pill info', style: { marginLeft: '8px' } }, 'LTS') : null, type === 'nginx' && x.branch !== 'system' ? h('span', { class: 'pill', style: { marginLeft: '8px' } }, x.branch) : null),
        h('div', { class: 'muted small mono', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, x.command ? x.command.split(' && ').filter((c) => c.includes('install')).pop() : x.file)),
      h('div', { class: 'spacer' }),
      isInstalled(x) ? h('span', { class: 'pill ok' }, 'Installed')
        : h('button', { class: 'small', type: 'button', onclick: (e) => install(e.currentTarget, type, x, label) }, x.command ? 'Install…' : inst[type] && type !== 'php' && !x.formula ? 'Switch to this' : 'Install')));
  };
  // Vendor zips and Node match by exact version; Homebrew/system packages by what is registered.
  const has = (type) => (x) => {
    if (type === 'php') return x.branch === 'system' ? Object.keys(inst.php).length > 0 : Boolean(inst.php[x.branch]) && (prov.provider !== 'vendor' || inst.php[x.branch].version === x.version);
    if (prov.provider !== 'vendor' && type !== 'node') return Boolean(inst[type]) && (x.branch === 'system' || !x.formula || (inst[type].version || '').startsWith(x.branch === 'stable' ? '' : x.branch));
    return inst[type]?.version === x.version;
  };
  const intro = {
    vendor: 'Official Windows builds, downloaded straight from each project. PHP and MariaDB are SHA-256 verified; nginx publishes only PGP signatures.',
    brew: prov.packageManager ? 'nginx, PHP and MariaDB come from Homebrew; LocalVPS runs its own copies with its own configs and data. Node.js is downloaded from nodejs.org (SHA-256 checked).' : 'Homebrew is required on macOS. Install it from https://brew.sh, then refresh this page.',
    system: prov.packageManager ? `nginx, PHP and MariaDB come from ${prov.label}. Installing needs sudo, so LocalVPS opens the command in its terminal for you to run; it then runs its own copies (system services are switched off). Node.js is downloaded from nodejs.org.` : 'No supported package manager (apt, dnf or pacman) was found. Install nginx, php-fpm and mariadb-server yourself, then press Detect installed.',
  }[prov.provider];
  const section = (title, desc, installedEls, availableEls) => h('div', { class: 'card flush section' },
    h('div', { style: { padding: '16px 18px 4px' } }, h('h2', {}, title), h('div', { class: 'muted small' }, desc)),
    installedEls.length ? [h('h3', { style: { padding: '10px 18px 0' } }, 'Installed'), ...installedEls] : null,
    h('h3', { style: { padding: '10px 18px 0' } }, 'Available'), availableEls);

  fill(view, 
    h('div', { class: 'row' }, h('div', { class: 'muted', style: { flex: 1, minWidth: '260px' } }, intro),
      prov.provider !== 'vendor' ? h('button', { class: 'ghost small', type: 'button', onclick: (e) => act(e.currentTarget, () => POST('/api/components/detect'), 'Detection finished').then(navigate) }, 'Detect installed') : null,
      h('button', { class: 'ghost small', type: 'button', onclick: (e) => act(e.currentTarget, () => GET('/api/components/catalog?refresh=1')).then(navigate) }, 'Refresh catalog')),
    section('Web server · nginx', 'Serves every site on name.localhost and proxies PHP over FastCGI.',
      inst.nginx ? [installedRow('nginx', inst.nginx, 'nginx')] : [],
      available('nginx', cat.nginx, has('nginx'), 'nginx')),
    section('PHP', prov.provider === 'vendor'
      ? 'Install several versions side by side and pick one per site. Non-thread-safe x64 builds run as php-cgi worker pools.'
      : 'Install several versions side by side and pick one per site. Each runs as its own php-fpm pool.',
    Object.values(inst.php).map((r) => installedRow('php', r, 'PHP')),
    available('php', cat.php, has('php'), 'PHP')),
    section('Database · MariaDB', 'Root password is generated at first start; listens on 127.0.0.1 only by default.',
      inst.mariadb ? [installedRow('mariadb', inst.mariadb, 'MariaDB')] : [],
      available('mariadb', cat.mariadb, has('mariadb'), 'MariaDB')),
    section('Runtime · Node.js', overview.nodeRuntime && !overview.nodeRuntime.managed
      ? `Runs Next.js sites, npm and npx. Currently using the system Node ${overview.nodeRuntime.version}; install one here to pin it inside LocalVPS.`
      : 'Runs Next.js sites, npm and npx. SHA-256 checked against nodejs.org\'s SHASUMS256.txt.',
    inst.node ? [installedRow('node', inst.node, 'Node.js')] : [],
    available('node', cat.node, has('node'), 'Node.js')),
  );
};

// Linux installs need sudo, which only the user can type: show the command and hand it to the terminal.
const PENDING_CMD = 'localvps-pending-cmd';
function runInTerminal(command) {
  try { sessionStorage.setItem(PENDING_CMD, command); } catch { /* storage unavailable */ }
  location.hash = '#/terminal';
}

function commandModal(title, command) {
  const m = modal({
    title,
    wide: true,
    body: h('div', { class: 'stack' },
      h('p', { style: { margin: 0 } }, 'This needs administrator rights, so run it yourself. LocalVPS can type it into its terminal for you; press Enter there and type your password when sudo asks.'),
      h('pre', { class: 'code' }, command.split(' && ').join(' &&\n  ')),
      h('div', { class: 'hint' }, 'When it finishes, come back here and press "Detect installed".')),
    foot: [
      h('button', { class: 'ghost', type: 'button', onclick: () => navigator.clipboard.writeText(command).then(() => toast('Copied'), () => toast('Copy failed', 'err')) }, 'Copy'),
      h('button', { class: 'ghost', type: 'button', onclick: () => act(null, () => POST('/api/components/detect'), 'Detection finished').then(() => { m.close(); navigate(); }) }, 'Detect installed'),
      h('button', { type: 'button', onclick: () => { m.close(); runInTerminal(command); } }, 'Open in terminal'),
    ],
  });
}

// ---------- Logs ----------
views.logs = async (view) => {
  const files = await GET('/api/logs');
  let current = files[0]?.key || '';
  const pre = h('pre', { class: 'code logview' }, files.length ? '' : 'No logs yet.');
  const follow = h('input', { type: 'checkbox', checked: true });
  const filter = h('input', { placeholder: 'Filter lines…', style: { maxWidth: '240px' } });
  let raw = '';
  const paint = () => {
    const q = filter.value.toLowerCase();
    pre.textContent = q ? raw.split('\n').filter((l) => l.toLowerCase().includes(q)).join('\n') : raw;
    if (follow.checked) pre.scrollTop = pre.scrollHeight;
  };
  filter.addEventListener('input', paint);
  const load = async () => {
    if (!current) return;
    raw = (await GET(`/api/logs/tail?file=${encodeURIComponent(current)}&lines=500`)).content || '(empty)';
    paint();
  };
  const list = h('div', { class: 'card flush' }, files.map((f) => h('div', {
    class: `list-item selectable ${f.key === current ? 'selected' : ''}`,
    onclick: (e) => { current = f.key; [...list.children].forEach((c) => c.classList.remove('selected')); e.currentTarget.classList.add('selected'); title.textContent = f.key; load(); },
  }, h('div', { style: { minWidth: 0 } }, h('div', { class: 'mono', style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, f.key), h('div', { class: 'muted small' }, `${fmtBytes(f.size)} · ${ago(f.mtime)}`)))));
  const title = h('h2', { class: 'mono' }, current);
  fill(view, h('div', { class: 'split' }, list,
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, title, h('div', { class: 'actions' }, filter, h('label', { class: 'check small' }, follow, 'Follow'),
        h('button', { class: 'ghost small', type: 'button', onclick: async () => { await api('DELETE', `/api/logs?file=${encodeURIComponent(current)}`); load(); } }, 'Clear'))),
      pre)));
  await load();
  poll(() => { if (follow.checked) load(); }, 2500);
};

// ---------- Settings ----------
views.settings = async (view) => {
  const { settings: s, paths, usage } = await GET('/api/settings');
  await refreshShell();
  const num = (v) => h('input', { type: 'number', value: v });
  const httpPort = num(s.httpPort);
  const mariadbPort = num(s.mariadbPort);
  const panelPort = num(s.panelPort);
  const pool = num(s.phpPoolSize);
  const lan = h('input', { type: 'checkbox', checked: s.lan });
  const ipv6 = h('input', { type: 'checkbox', checked: s.ipv6 });
  const autostart = h('input', { type: 'checkbox', checked: s.autostart });
  const defaultPhp = h('select', {}, h('option', { value: '' }, '—'), Object.keys(overview.components.php).map((v) => h('option', { value: v, selected: v === s.defaultPhp }, `PHP ${v}`)));
  const save = h('button', { type: 'button' }, 'Save settings');
  save.addEventListener('click', () => act(save, async () => {
    const r = await api('PUT', '/api/settings', {
      httpPort: httpPort.value, mariadbPort: mariadbPort.value, panelPort: panelPort.value, phpPoolSize: pool.value,
      lan: lan.checked, ipv6: ipv6.checked, autostart: autostart.checked, defaultPhp: defaultPhp.value,
    });
    const errs = Object.entries(r.errors || {});
    if (errs.length) toast(errs.map(([k, v]) => `${k}: ${v}`).join('\n'), 'err');
    else toast(`Saved${r.restarted.length ? ` · restarted ${r.restarted.join(', ')}` : ''}`, 'ok');
    if (r.panelRestartNeeded) toast(`Restart the panel (start.cmd) to move it to port ${r.settings.panelPort}`);
  }));
  fill(view, h('div', { class: 'grid cols-2' },
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Network')),
      h('div', { class: 'form' },
        h('div', { class: 'form cols-2' },
          h('label', { class: 'field' }, 'HTTP port', httpPort, h('span', { class: 'hint' }, overview.provider.provider === 'system' ? 'Linux needs root for ports below 1024, so 8080 is the default.' : '80 gives clean URLs; use 8080 if another web server holds 80.')),
          h('label', { class: 'field' }, 'MariaDB port', mariadbPort)),
        h('div', { class: 'form cols-2' },
          h('label', { class: 'field' }, 'Panel port', panelPort, h('span', { class: 'hint' }, 'Takes effect after restarting the panel.')),
          h('label', { class: 'field' }, 'PHP workers per version', pool, h('span', { class: 'hint' }, 'Concurrent PHP requests (1–9).'))),
        h('label', { class: 'check' }, lan, 'LAN access — serve sites and MariaDB on all interfaces (test from your phone; Windows Firewall will ask)'),
        h('label', { class: 'check' }, ipv6, 'Also listen on IPv6 loopback ([::1])'),
        h('label', { class: 'check' }, autostart, 'Start services automatically when the panel starts'),
        h('label', { class: 'field' }, 'Default PHP (used for new sites and http://localhost)', defaultPhp),
        h('div', {}, save))),
    h('div', { class: 'stack' },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Storage')),
        h('dl', { class: 'kv' },
          h('dt', {}, 'Install folder'), h('dd', {}, paths.root),
          h('dt', {}, 'Sites (www)'), h('dd', {}, `${paths.www} · ${fmtBytes(usage.www)}`),
          h('dt', {}, 'Binaries'), h('dd', {}, fmtBytes(usage.runtime)),
          h('dt', {}, 'Data (DB, logs)'), h('dd', {}, fmtBytes(usage.data)),
          h('dt', {}, 'Exports'), h('dd', {}, paths.exports))),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Security defaults')),
        h('ul', { class: 'muted', style: { margin: 0, paddingLeft: '18px' } },
          h('li', {}, 'Panel listens on 127.0.0.1 only, checks the Host header, and requires a per-install token.'),
          h('li', {}, 'nginx, PHP and MariaDB bind to loopback unless LAN access is on.'),
          h('li', {}, 'MariaDB root gets a random password; site databases get their own users.'),
          h('li', {}, 'Dotfiles are blocked in nginx; DB credentials live outside the web root.'))))));
};

// ---------- boot ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('localvps-theme', t); } catch { /* storage unavailable */ }
}
let savedTheme = null;
try { savedTheme = localStorage.getItem('localvps-theme'); } catch { /* ignore */ }
applyTheme(savedTheme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
document.getElementById('theme-toggle').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
document.getElementById('menu-btn').addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('open'));
document.getElementById('start-all').addEventListener('click', (e) => act(e.currentTarget, async () => {
  const r = await POST('/api/services/all/start');
  const errs = Object.entries(r.errors || {});
  if (errs.length) toast(errs.map(([k, v]) => `${k}: ${v}`).join('\n'), 'err'); else toast('All services started', 'ok');
}).finally(navigate));
document.getElementById('stop-all').addEventListener('click', (e) => act(e.currentTarget, () => POST('/api/services/all/stop'), 'All services stopped').finally(navigate));
window.addEventListener('hashchange', navigate);
navigate();
