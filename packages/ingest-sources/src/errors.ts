/**
 * The errors a source raises, each with a code the runner can act on.
 *
 * The codes matter more than the classes: `spec/hooks.md` §6.4 says a throw from `poll` is retried
 * with backoff and marks the source `degraded` after three consecutive failures, a throw from
 * `fetch` puts the candidate back, and a throw from `acknowledge` is retried separately from
 * ingestion — the document is already in the library, so failing to move the mail out of the inbox
 * must never cause a re-ingest. A runner can only honour that if it can tell the three apart.
 */
export class SourceError extends Error {
  readonly code: string;
  readonly detail: Record<string, unknown>;

  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.detail = detail;
  }
}

/** The far side could not be reached, or answered with something that is not a source. */
export class SourceUnavailableError extends SourceError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('source_unavailable', message, detail);
  }
}

/** The far side answered, and the answer was wrong: a bad status, a malformed body, a lie. */
export class SourceProtocolError extends SourceError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('source_protocol', message, detail);
  }
}

/** A path arrived from a listing, a header or a URL and did not resolve inside its root. */
export class UnsafeSourcePathError extends SourceError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('unsafe_source_path', message, detail);
  }
}
