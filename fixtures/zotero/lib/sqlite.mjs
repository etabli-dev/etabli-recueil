/*
 * Recueil — fixtures
 * Copyright (C) 2026 the Recueil authors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * A two-line SQLite façade over whichever driver this checkout can offer.
 *
 * `better-sqlite3` is a dependency of `@recueil/core`, so in a normal `pnpm install` it is present
 * under `packages/core/node_modules` and resolves from there. `fixtures/` is deliberately not a
 * workspace package — it holds data, not code that ships — so it has no `node_modules` of its own
 * and cannot declare the dependency itself.
 *
 * `node:sqlite` is the fallback. It needs no install at all but is only unflagged from Node 23,
 * so on the Node 22 LTS the project targets it is reachable only under `--experimental-sqlite`.
 * Preferring `better-sqlite3` therefore means the generator runs on a plain `node` invocation on
 * both versions.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/** Where `better-sqlite3` may plausibly live, in the order worth trying. */
const RESOLVE_FROM = [
  path.join(REPO_ROOT, 'packages', 'core'),
  path.join(REPO_ROOT, 'packages', 'schemas'),
  REPO_ROOT,
  HERE,
];

/**
 * A prepared-statement-free interface, because the generator only ever runs statements and reads
 * rows back for the count assertions.
 *
 * @typedef {object} Db
 * @property {(sql: string) => void} exec               run one or more statements, no parameters
 * @property {(sql: string, params?: unknown[]) => void} run   run one statement with parameters
 * @property {(sql: string, params?: unknown[]) => Record<string, unknown>[]} all  read rows
 * @property {(sql: string, params?: unknown[]) => unknown} value  read the first column of the first row
 * @property {() => void} close
 * @property {string} driver
 */

/**
 * Open (creating if necessary) a database file.
 *
 * @param {string} file
 * @returns {Db}
 */
export function open(file) {
  // `RECUEIL_FIXTURE_SQLITE` pins the driver, so both paths can be exercised on a machine that has
  // both: `node:sqlite` forces the fallback, `better-sqlite3` makes an unresolvable module an error
  // rather than a silent fallback. Unset, the preference order below applies.
  const forced = process.env.RECUEIL_FIXTURE_SQLITE;
  if (forced === 'node:sqlite') return wrapNodeSqlite(file);
  const better = tryBetterSqlite3();
  if (better) return wrapBetterSqlite3(new better(file));
  if (forced === 'better-sqlite3') {
    throw new Error('RECUEIL_FIXTURE_SQLITE=better-sqlite3 but the module could not be resolved');
  }
  return wrapNodeSqlite(file);
}

/** @returns {any | null} */
function tryBetterSqlite3() {
  for (const from of RESOLVE_FROM) {
    try {
      const require = createRequire(path.join(from, 'noop.cjs'));
      return require('better-sqlite3');
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** @param {any} db @returns {Db} */
function wrapBetterSqlite3(db) {
  db.pragma('journal_mode = delete');
  return {
    driver: 'better-sqlite3',
    exec: (sql) => void db.exec(sql),
    run: (sql, params = []) => void db.prepare(sql).run(...params),
    all: (sql, params = []) => db.prepare(sql).all(...params),
    value: (sql, params = []) => {
      const row = db.prepare(sql).get(...params);
      return row === undefined ? undefined : Object.values(row)[0];
    },
    close: () => db.close(),
  };
}

/** @param {string} file @returns {Db} */
function wrapNodeSqlite(file) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require_node_sqlite());
  } catch (cause) {
    throw new Error(
      'No SQLite driver available. Run `pnpm install` from the repository root so that ' +
        '`better-sqlite3` is installed for @recueil/core, or run this generator on Node 23+ ' +
        '(or Node 22 with --experimental-sqlite) so that `node:sqlite` is reachable.',
      { cause },
    );
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = delete');
  return {
    driver: 'node:sqlite',
    exec: (sql) => void db.exec(sql),
    run: (sql, params = []) => void db.prepare(sql).run(...params.map(coerce)),
    all: (sql, params = []) => db.prepare(sql).all(...params.map(coerce)),
    value: (sql, params = []) => {
      const row = db.prepare(sql).get(...params.map(coerce));
      return row === undefined ? undefined : Object.values(row)[0];
    },
    close: () => db.close(),
  };
}

function require_node_sqlite() {
  const require = createRequire(import.meta.url);
  return require('node:sqlite');
}

/** `node:sqlite` rejects booleans; `better-sqlite3` rejects them too. Normalise for both. */
function coerce(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

/**
 * Zotero's `.sql` files use `;---` as a statement terminator inside `CREATE TRIGGER` bodies,
 * a hack for its own naive splitter (`Zotero.DB.executeSQLFile`). SQLite's own multi-statement
 * executor understands `BEGIN … END` perfectly well, so the marker just has to go.
 *
 * @param {string} sql
 * @returns {string}
 */
export function stripStatementHack(sql) {
  return sql.replace(/;---/g, ';');
}
