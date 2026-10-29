import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { P, httpError } from './paths.js';
import { getState, getSecrets } from './state.js';
import { rootConnectionOptions } from './services.js';
import { runOk, randomPassword, portOpen } from './util.js';
import { mariaBin } from './bins.js';

const SYSTEM_DBS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const IDENT = /^[A-Za-z0-9_]{1,64}$/;

export function checkIdent(name, what = 'name') {
  if (!IDENT.test(name || '')) throw httpError(400, `Invalid ${what}: use letters, digits and underscore (max 64)`);
  return name;
}

async function connect(extra) {
  if (!getState().components.mariadb) throw httpError(409, 'MariaDB is not installed');
  await requireUp();
  return mysql.createConnection(rootConnectionOptions({ connectTimeout: 5000, ...extra }));
}

// A port probe is milliseconds; asking tasklist.exe would add ~0.5s to every query.
async function requireUp() {
  if (!(await portOpen(getState().settings.mariadbPort))) throw httpError(409, 'MariaDB is not running. Start it on the Services page.');
}

async function withConn(fn, extra) {
  const c = await connect(extra);
  try { return await fn(c); } finally { await c.end().catch(() => {}); }
}

export function listDatabases() {
  return withConn(async (c) => {
    const [rows] = await c.query(`
      SELECT s.SCHEMA_NAME AS name, s.DEFAULT_COLLATION_NAME AS collation,
             COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) AS bytes,
             COUNT(t.TABLE_NAME) AS tables
      FROM information_schema.SCHEMATA s
      LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
      GROUP BY s.SCHEMA_NAME, s.DEFAULT_COLLATION_NAME ORDER BY s.SCHEMA_NAME`);
    const sites = getState().sites;
    return rows.map((r) => ({
      ...r,
      bytes: Number(r.bytes),
      tables: Number(r.tables),
      system: SYSTEM_DBS.has(r.name),
      site: sites.find((s) => s.db?.name === r.name)?.name || null,
    }));
  });
}

export function listUsers() {
  return withConn(async (c) => {
    const [rows] = await c.query("SELECT User AS user, Host AS host FROM mysql.user WHERE User <> '' AND is_role = 'N' ORDER BY User");
    return rows;
  });
}

export async function createDatabase({ name, user, password }) {
  checkIdent(name, 'database name');
  if (user) checkIdent(user, 'user name');
  const pw = user ? (password || randomPassword(20)) : null;
  await withConn(async (c) => {
    await c.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    if (user) {
      // Both host forms so the app can connect via "localhost" or "127.0.0.1".
      for (const host of ['localhost', '127.0.0.1']) {
        await c.query('CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?', [user, host, pw]);
        await c.query(`GRANT ALL PRIVILEGES ON \`${name}\`.* TO ?@?`, [user, host]);
      }
    }
  });
  return { name, user: user || null, password: pw };
}

export async function dropDatabase(name, { dropUser } = {}) {
  checkIdent(name, 'database name');
  if (SYSTEM_DBS.has(name)) throw httpError(400, 'Refusing to drop a system database');
  await withConn(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS \`${name}\``);
    if (dropUser) {
      checkIdent(dropUser, 'user name');
      await c.query('DROP USER IF EXISTS ?@?, ?@?', [dropUser, 'localhost', dropUser, '127.0.0.1']);
    }
  });
}

// SQL console. Root access to a local dev database is the point here, so statements run unfiltered.
export async function runQuery({ db, sql }) {
  if (db) checkIdent(db, 'database name');
  if (!sql || !sql.trim()) throw httpError(400, 'Empty query');
  const started = Date.now();
  return withConn(async (c) => {
    const [res, fields] = await c.query({ sql, rowsAsArray: true });
    const ms = Date.now() - started;
    const toResult = (r, f) => {
      if (Array.isArray(r)) {
        return {
          columns: (f || []).map((x) => x.name),
          rows: r.slice(0, 1000).map((row) => row.map((v) => (Buffer.isBuffer(v) ? `0x${v.toString('hex').slice(0, 64)}` : v instanceof Date ? v.toISOString() : v))),
          total: r.length,
          truncated: r.length > 1000,
        };
      }
      return { affectedRows: r.affectedRows, insertId: r.insertId, info: r.info || '' };
    };
    // With several statements mysql2 returns one fields entry per statement (an array, or undefined for non-SELECTs).
    const multi = Array.isArray(fields) && fields.length > 0 && (fields[0] === undefined || Array.isArray(fields[0]));
    const results = multi ? res.map((r, i) => toResult(r, fields[i])) : [toResult(res, fields)];
    return { ms, results };
  }, { database: db || undefined, multipleStatements: true });
}

// Client tools read the password from a temp option file so it never appears on a command line.
function withOptionFile(fn) {
  const file = path.join(P.tmp, `client-${crypto.randomBytes(6).toString('hex')}.cnf`);
  const st = getState();
  fs.writeFileSync(file, `[client]\nuser=root\npassword="${getSecrets().mariadbRoot}"\nhost=127.0.0.1\nport=${st.settings.mariadbPort}\n`, { mode: 0o600 });
  return Promise.resolve().then(() => fn(file)).finally(() => fs.rmSync(file, { force: true }));
}


export async function dumpDatabase(name, outFile) {
  checkIdent(name, 'database name');
  await requireUp();
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await withOptionFile(async (cnf) => {
    const r = await runOk(mariaBin('dump'), [
      `--defaults-extra-file=${cnf}`, '--single-transaction', '--routines', '--triggers', '--events',
      '--default-character-set=utf8mb4', `--result-file=${outFile}`, name,
    ]);
    return r;
  });
  return outFile;
}

export async function importSql(name, sqlFile) {
  checkIdent(name, 'database name');
  await requireUp();
  await withOptionFile((cnf) => runOk(mariaBin('client'), [`--defaults-extra-file=${cnf}`, '--default-character-set=utf8mb4', name], { inputFile: sqlFile }));
}
