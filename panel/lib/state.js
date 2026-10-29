import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { P } from './paths.js';
import { DEFAULT_HTTP_PORT } from './platform.js';

const STATE_FILE = path.join(P.data, 'state.json');
const SECRETS_FILE = path.join(P.data, 'secrets.json');

const DEFAULTS = {
  settings: {
    panelPort: 7171,
    httpPort: DEFAULT_HTTP_PORT, // 8080 on Linux, where ports below 1024 need root
    lan: false,          // false = everything binds to loopback only
    ipv6: true,          // also listen on [::1] so *.localhost works when the browser picks IPv6
    phpPoolSize: 3,
    defaultPhp: null,
    mariadbPort: 3306,
    autostart: true,
  },
  components: { php: {}, mariadb: null, nginx: null, node: null },
  services: {},          // key -> { desired: 'running'|'stopped', pids: [], error }
  sites: [],
  servers: [],
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

let state;
let secrets;

export function loadState() {
  const raw = readJson(STATE_FILE, {});
  state = {
    ...structuredClone(DEFAULTS),
    ...raw,
    settings: { ...DEFAULTS.settings, ...(raw.settings || {}) },
    components: { ...DEFAULTS.components, ...(raw.components || {}) },
  };
  secrets = readJson(SECRETS_FILE, {});
  if (!secrets.panelToken) {
    secrets.panelToken = crypto.randomBytes(24).toString('hex');
    saveSecrets();
  }
  return state;
}

export const getState = () => state;
export const getSecrets = () => secrets;

export function saveState() { writeJsonAtomic(STATE_FILE, state); }
export function saveSecrets() { writeJsonAtomic(SECRETS_FILE, secrets); }

export function svcState(key) {
  if (!state.services[key]) state.services[key] = { desired: 'stopped', pids: [], error: null };
  return state.services[key];
}
