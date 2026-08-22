/**
 * Opening someone else's SQLite database without being able to write to it.
 *
 * The user's `zotero.sqlite` is their only copy of a decade of work, and CONCEPT §6 says Zotero
 * stays read-only until M1 is confirmed. "Read-only" here is not a convention that the importer
 * happens to observe; it is four independent mechanisms, any one of which would be enough, applied
 * together because the cost of them is a few microseconds and the cost of getting it wrong is the
 * library:
 *
 * 1. **A copy.** By default the file — and its `-wal` and `-shm` companions, if Zotero left them —
 *    is copied into a temporary directory and the copy is what gets opened. The original is touched
 *    by exactly one operation, `fs.copyFile`, which opens it `O_RDONLY`. This also removes the one
 *    real hazard of reading in place: a hot journal makes SQLite want to recover on open, recovery
 *    is a write, and a read-only handle then fails — or, worse, an in-place handle succeeds.
 * 2. **`readonly: true`.** SQLite opens the file `O_RDONLY` and refuses every write statement at
 *    the VFS layer.
 * 3. **`PRAGMA query_only = 1`.** Refused at the statement layer as well, and asserted afterwards
 *    rather than assumed.
 * 4. **A statement allow-list.** `ReadOnlyDatabase` exposes no method that can run anything but a
 *    `SELECT`, a `WITH … SELECT` or a read-only `PRAGMA`, and better-sqlite3's own
 *    `statement.readonly` flag is checked on every prepare.
 *
 * The digest of the source file is taken before and after the run, so the report can state — rather
 * than promise — that nothing moved.
 */
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import Database from 'better-sqlite3';
import type { Database as SqliteDatabase, Statement } from 'better-sqlite3';

/** What a caller may ask a read-only handle to run. Anything else is refused before SQLite sees it. */
const READ_ONLY_STATEMENT = /^\s*(?:select\b|with\b|pragma\s+[a-z_]+\s*(?:;|$))/iu;

/** Statements that are shaped like a `PRAGMA` but set something. */
const PRAGMA_ASSIGNMENT = /^\s*pragma\b[^;]*=/iu;

export interface OpenReadOnlyOptions {
  /**
   * Copy the file to a temporary directory and open the copy. Default true, and the default is the
   * recommendation: a live Zotero holds a lock and may have left a hot WAL, and neither is safe to
   * read in place.
   */
  copy?: boolean;
  /** Where the copy goes. A fresh temporary directory when absent. */
  copyInto?: string;
}

/** What the source file looked like, so a change to it can be detected rather than assumed absent. */
export interface SourceFingerprint {
  path: string;
  byteSize: number;
  /** Millisecond mtime, as the filesystem reports it. */
  modifiedAt: string;
  /** SHA-256 over the whole file. The one claim worth making about "we did not touch it". */
  sha256: string;
}

export const fingerprintFile = (path: string): SourceFingerprint => {
  const stats = statSync(path);
  const hash = createHash('sha256');
  const handle = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const read = readSync(handle, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(handle);
  }
  return {
    path,
    byteSize: stats.size,
    modifiedAt: new Date(stats.mtimeMs).toISOString(),
    sha256: hash.digest('hex'),
  };
};

export class ReadOnlyViolationError extends Error {
  constructor(statement: string) {
    super(
      `Refused to run '${statement.trim().slice(0, 120)}' against a source database. This handle ` +
        'is read-only by construction (CONCEPT §6: Zotero stays read-only until M1 is confirmed).',
    );
    this.name = 'ReadOnlyViolationError';
  }
}

/**
 * A SQLite handle that cannot write, wrapping a copy of a file it also cannot write.
 *
 * The class exposes `all`, `get` and `pluck` and nothing else. There is no `exec`, no `prepare`
 * returning a raw statement and no escape hatch, because an escape hatch is what someone reaches
 * for at four in the morning.
 */
export class ReadOnlyDatabase {
  private readonly connection: SqliteDatabase;

  private readonly cache = new Map<string, Statement>();

  private readonly temporaryDirectory: string | null;

  /** The file actually opened: the copy when copying, the original otherwise. */
  readonly openedPath: string;

  /** The file the caller named, before any copy. */
  readonly sourcePath: string;

  private closed = false;

  constructor(sourcePath: string, options: OpenReadOnlyOptions = {}) {
    if (!existsSync(sourcePath)) {
      throw new Error(`No SQLite database at '${sourcePath}'.`);
    }
    this.sourcePath = sourcePath;

    if (options.copy === false) {
      this.temporaryDirectory = null;
      this.openedPath = sourcePath;
    } else {
      const into = options.copyInto ?? mkdtempSync(join(tmpdir(), 'recueil-zotero-read-'));
      this.temporaryDirectory = options.copyInto === undefined ? into : null;
      const target = join(into, basename(sourcePath));
      copyFileSync(sourcePath, target);
      // A `-wal` left behind by a running Zotero holds committed transactions the main file does
      // not; copying it keeps the copy consistent, and the `-shm` is rebuilt from it on open.
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(`${sourcePath}${suffix}`)) copyFileSync(`${sourcePath}${suffix}`, `${target}${suffix}`);
      }
      this.openedPath = target;
    }

    this.connection = new Database(this.openedPath, { readonly: true, fileMustExist: true });
    this.connection.pragma('query_only = 1');

    const queryOnly = this.connection.pragma('query_only', { simple: true });
    if (queryOnly !== 1 && queryOnly !== true) {
      this.connection.close();
      throw new Error(
        `Refusing to read '${sourcePath}': SQLite did not accept PRAGMA query_only, so this handle ` +
          'cannot be proven read-only.',
      );
    }
    if (!this.connection.readonly) {
      this.connection.close();
      throw new Error(`Refusing to read '${sourcePath}': the handle opened writable.`);
    }
  }

  /** Every row. */
  all<TRow>(sql: string, parameters: readonly unknown[] = []): TRow[] {
    return this.statement(sql).all(...(parameters as unknown[])) as TRow[];
  }

  /** The first row, or undefined. */
  get<TRow>(sql: string, parameters: readonly unknown[] = []): TRow | undefined {
    return this.statement(sql).get(...(parameters as unknown[])) as TRow | undefined;
  }

  /** The first column of the first row. */
  pluck<TValue>(sql: string, parameters: readonly unknown[] = []): TValue | undefined {
    const statement = this.statement(sql);
    statement.pluck(true);
    try {
      return statement.get(...(parameters as unknown[])) as TValue | undefined;
    } finally {
      statement.pluck(false);
    }
  }

  /** Whether the opened database has a table of this name. Importers must tolerate old schemas. */
  hasTable(name: string): boolean {
    return (
      this.get<{ name: string }>("select name from sqlite_master where type = 'table' and name = ?", [
        name,
      ]) !== undefined
    );
  }

  /** Whether a table has a column of this name. Zotero adds and removes columns across versions. */
  hasColumn(table: string, column: string): boolean {
    if (!this.hasTable(table)) return false;
    return this.all<{ name: string }>(`pragma table_info(${quoteIdentifier(table)})`).some(
      (row) => row.name === column,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cache.clear();
    this.connection.close();
    if (this.temporaryDirectory !== null) rmSync(this.temporaryDirectory, { recursive: true, force: true });
  }

  private statement(sql: string): Statement {
    const cached = this.cache.get(sql);
    if (cached !== undefined) return cached;

    if (PRAGMA_ASSIGNMENT.test(sql) || !READ_ONLY_STATEMENT.test(sql)) {
      throw new ReadOnlyViolationError(sql);
    }
    const prepared = this.connection.prepare(sql);
    // better-sqlite3's own judgement, which knows about statements the regular expression does not.
    if (!prepared.readonly) throw new ReadOnlyViolationError(sql);
    this.cache.set(sql, prepared);
    return prepared;
  }
}

/**
 * `pragma table_info(x)` takes an identifier, not a bound parameter, so the identifier is quoted
 * here rather than interpolated raw. Table names come from `sqlite_master`, but a quoting rule that
 * depends on where its input came from is not a quoting rule.
 */
const quoteIdentifier = (name: string): string => `"${name.replace(/"/gu, '""')}"`;
