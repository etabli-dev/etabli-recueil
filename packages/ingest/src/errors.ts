/**
 * The pipeline's errors.
 *
 * Two of them are load-bearing rather than decorative. `UnsafeArchivePathError` is what a member
 * name that escapes its extraction root produces, and it is a hard stop rather than a skip, because
 * an archive that contains one is not an archive with a bad file in it — it is an archive built to
 * write outside the root, and the honest response is to refuse the whole thing and say so.
 * `ArchiveLimitError` is the zip-bomb guard, for the same reason: an archive that trips it has told
 * you what it is.
 */
import { RecueilError } from '@recueil/core';

export class IngestError extends RecueilError {
  /** Machine-readable, and the value that reaches `review_queue.reason_code`. */
  readonly code: string;

  constructor(message: string, code: string, detail: Record<string, unknown> = {}) {
    super(`recueil:ingest/${code}`, 422, message, detail);
    this.code = code;
  }
}

/** An archive member whose name resolves outside the extraction root. Never extracted. */
export class UnsafeArchivePathError extends IngestError {
  constructor(
    readonly entryName: string,
    reason: string,
  ) {
    super(
      `Archive member '${entryName}' is not safe to extract: ${reason}. The archive was refused ` +
        'rather than partially extracted.',
      'unsafe_archive_path',
      { entryName, reason },
    );
  }
}

/** The archive exceeds a configured limit: member count, member size, or expansion ratio. */
export class ArchiveLimitError extends IngestError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message, 'archive_limit_exceeded', detail);
  }
}

/** The archive itself is malformed, encrypted or in a variant this reader does not support. */
export class ArchiveFormatError extends IngestError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message, 'archive_unreadable', detail);
  }
}

/** A sidecar — OCRmyPDF, GROBID — was asked for and is not reachable. */
export class AdapterUnavailableError extends IngestError {
  constructor(adapter: string, message: string, detail: Record<string, unknown> = {}) {
    super(`${adapter} is not available: ${message}`, 'adapter_unavailable', { adapter, ...detail });
  }
}

/** The run was cancelled through its `AbortSignal`. Not a failure; the job stays resumable. */
export class IngestCancelledError extends IngestError {
  constructor(message = 'The ingestion run was cancelled.') {
    super(message, 'cancelled');
  }
}
