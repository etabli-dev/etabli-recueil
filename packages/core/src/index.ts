/**
 * `@recueil/core` — the data model, the storage layer and the services.
 *
 * Everything above this package is a client of it: the REST API, the CLI, the MCP server and the
 * plugin host all reach the library through the services `createRecueil` returns, and none of them
 * writes SQL. That is what makes P6 ("nothing is UI-only") enforceable rather than aspirational —
 * there is one implementation of "create an item", and every surface calls it.
 */
export * from './errors.js';
export * from './ids.js';
export * from './mime.js';
export * from './normalise.js';
export * from './time.js';

export * as schema from './db/schema.js';
export {
  MEMORY_DATABASE,
  applyPragmas,
  openDatabase,
  resolveDatabaseFile,
} from './db/client.js';
export type { OpenDatabaseOptions, OpenedDatabase, RecueilDatabase, SqliteConnection } from './db/client.js';
export { findMigrationsFolder, migrate } from './db/migrate.js';
export type { MigrateOptions } from './db/migrate.js';

export * from './storage/index.js';
export * from './services/index.js';

import { openDatabase } from './db/client.js';
import type { RecueilDatabase, SqliteConnection } from './db/client.js';
import { migrate } from './db/migrate.js';
import { LocalFsBackend } from './storage/local-fs.js';
import type { StorageBackend } from './storage/backend.js';
import { AuditService } from './services/audit.js';
import { DocumentService } from './services/documents.js';
import { LibraryService } from './services/library.js';
import { ensureLocalUser } from './services/users.js';
import type { UserRow } from './db/schema.js';
import { userActor } from './services/actor.js';
import type { Actor } from './services/actor.js';

export interface CreateRecueilOptions {
  /** `:memory:`, a filesystem path, or a `file:`/`sqlite:` URL (ADR-0003). */
  databaseUrl: string;
  /** Root of the content-addressed store: `<root>/<aa>/<bb>/<sha256>` (ADR-0004). */
  storagePath: string;
  /** Skip the boot-time migration. Only a migration tool that runs them itself should. */
  migrate?: boolean;
  /** Supply a different backend — WebDAV or S3 — instead of the local filesystem. */
  storage?: StorageBackend;
  /** The username of the single local account (§1.4). */
  username?: string;
}

/** Everything a server, a CLI or a test needs, wired together and ready to use. */
export interface Recueil {
  db: RecueilDatabase;
  connection: SqliteConnection;
  storage: StorageBackend;
  audit: AuditService;
  library: LibraryService;
  documents: DocumentService;
  /** The single local account every owned record belongs to in v1. */
  user: UserRow;
  /** An actor for that account, for callers that have no request context of their own. */
  actor: Actor;
  /** Close the database. Idempotent, so a signal handler and a `finally` may both call it. */
  close(): void;
}

/**
 * Open a library.
 *
 * Migrations run on the way in unless told otherwise, because they are idempotent (see
 * `db/migrate.ts`) and because the alternative — a server that starts against a database it does
 * not match — fails later and more confusingly. The single local account is created on the same
 * pass, for the same reason: an empty database is a valid starting state and should need no
 * ceremony.
 */
export const createRecueil = (options: CreateRecueilOptions): Recueil => {
  const { db, connection } = openDatabase({ databaseUrl: options.databaseUrl });

  if (options.migrate !== false) migrate(db);

  const storage = options.storage ?? new LocalFsBackend({ root: options.storagePath });
  const audit = new AuditService(db);
  const user = ensureLocalUser(db, audit, { username: options.username });
  const library = new LibraryService(db, audit, user.id);
  const documents = new DocumentService(db, storage, audit);

  let closed = false;
  return {
    db,
    connection,
    storage,
    audit,
    library,
    documents,
    user,
    actor: userActor(user.id),
    close: () => {
      if (closed) return;
      closed = true;
      connection.close();
    },
  };
};
