/**
 * What a backup or a restore refuses to do, and why.
 *
 * All three are `RecueilError`s so that the API layer renders them as problem documents like
 * anything else, and all three carry structured detail rather than only a sentence: a restore that
 * failed verification has to be able to say *which* files failed, because the operator's next
 * question is always "which ones".
 */
import { RecueilError } from '../errors.js';

/** The snapshot is not one, or is one this build does not understand. */
export class BackupFormatError extends RecueilError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super('recueil:backup-format', 422, message, detail);
  }
}

/** The operation would destroy something. Pass `force` if that is genuinely the intention. */
export class BackupTargetError extends RecueilError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super('recueil:backup-target', 409, message, detail);
  }
}

/** One file the manifest describes. */
export interface BackupVerificationFailure {
  /** Snapshot-relative path, as the manifest spells it. */
  readonly path: string;
  readonly reason: 'missing' | 'size' | 'hash';
  readonly expectedSha256: string;
  /** Null when the file was not there to be hashed. */
  readonly actualSha256: string | null;
  readonly expectedSize: number;
  readonly actualSize: number | null;
}

/**
 * A file in the snapshot does not match the manifest.
 *
 * This is the failure the whole format exists to produce. A backup whose bytes have rotted, whose
 * manifest has been edited, or whose transfer truncated a file must fail loudly at restore time —
 * the alternative is a library that looks restored and is not.
 */
export class BackupVerificationError extends RecueilError {
  readonly failures: readonly BackupVerificationFailure[];

  constructor(failures: readonly BackupVerificationFailure[], context: string) {
    super(
      'recueil:backup-verification-failed',
      409,
      `${context}: ${failures.length} file${failures.length === 1 ? '' : 's'} did not match the manifest — ` +
        `${failures
          .slice(0, 5)
          .map((failure) => `${failure.path} (${failure.reason})`)
          .join(', ')}${failures.length > 5 ? `, and ${failures.length - 5} more` : ''}.`,
      { failures: [...failures] },
    );
    this.failures = failures;
  }
}
