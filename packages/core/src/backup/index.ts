/**
 * Backup and restore (CONCEPT.md §5.15).
 *
 * ```ts
 * const backup = await createBackup({
 *   databaseUrl: '/var/lib/recueil/library.sqlite',
 *   storagePath: '/var/lib/recueil/storage',
 *   out: '/var/backups/recueil',
 *   config: redactedConfiguration,
 *   force: true,           // replace last night's snapshot in place
 * });
 *
 * const restored = await restoreBackup({ from: '/var/backups/recueil', into: '/srv/recueil' });
 * ```
 *
 * The on-disk format is documented in `FORMAT.md`, beside this file, in enough detail to be
 * implemented by something that is not Recueil — which is the point of P10.
 */
export {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  CHECKSUMS_FILE,
  CONFIG_DIRECTORY,
  CONFIG_FILE,
  DATABASE_DIRECTORY,
  DATABASE_FILE,
  MANIFEST_FILE,
  RESTORED_CONFIG_FILE,
  RESTORED_DATABASE_FILE,
  RESTORED_STORAGE_DIRECTORY,
  STORAGE_DIRECTORY,
  assertSnapshotRelativePath,
  blobPath,
} from './format.js';

export { BackupFormatError, BackupTargetError, BackupVerificationError } from './errors.js';
export type { BackupVerificationFailure } from './errors.js';

export { manifestFiles, parseManifest, renderChecksums, serialiseManifest } from './manifest.js';
export type {
  BackupBlobEntry,
  BackupDatabaseManifest,
  BackupFileEntry,
  BackupManifest,
  BackupSchemaState,
  BackupStorageManifest,
} from './manifest.js';

export { createBackup } from './create.js';
export type { BackupPhase, BackupProgress, BackupResult, CorruptBlob, CreateBackupOptions } from './create.js';

export { readManifest, resolveSnapshotRoot, restoreBackup, verifyBackup } from './restore.js';
export type {
  RestoreBackupOptions,
  RestorePhase,
  RestoreProgress,
  RestoreResult,
  VerifyBackupResult,
} from './restore.js';

export { inspectDatabaseFile, tableCounts } from './inspect.js';
export type { DatabaseFacts } from './inspect.js';

export { listStoredBlobs, resolveWithin } from './files.js';
export type { StoredBlob } from './files.js';
