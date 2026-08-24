/**
 * The errors a remote backend can raise.
 *
 * They are separate from `@recueil/core`'s `RecueilError` family on purpose. A `RecueilError`
 * carries the RFC 9457 problem type an API route will render, and a storage fault is not that: it
 * is an operational fact about somebody else's server, and the route above it has to decide
 * whether that is a 503, a 500 or a retry. What these carry instead is the detail an operator
 * needs to fix the server — the method, the URL, the status, and whether trying again could
 * possibly help.
 */

/** The common shape: something went wrong talking to a store that is not this machine. */
export class StorageBackendError extends Error {
  /** `webdav` or `s3`. */
  readonly backend: string;

  /** True when the same call, unchanged, might succeed later. */
  readonly retryable: boolean;

  constructor(backend: string, message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.backend = backend;
    this.retryable = options.retryable ?? false;
  }
}

/** The server answered, and the answer was not one we can work with. */
export class StorageRequestError extends StorageBackendError {
  readonly method: string;

  readonly url: string;

  readonly status: number;

  /** As much of the body as is worth showing an operator. Truncated. */
  readonly body: string;

  /** What the server's `Retry-After` asked for, in milliseconds, when it sent one. */
  readonly retryAfterMs?: number;

  constructor(
    backend: string,
    parameters: {
      method: string;
      url: string;
      status: number;
      body?: string;
      retryable?: boolean;
      retryAfterMs?: number;
    },
  ) {
    const body = (parameters.body ?? '').slice(0, 500);
    super(
      backend,
      `${parameters.method} ${parameters.url} failed with HTTP ${parameters.status}${
        body.trim() === '' ? '' : `: ${body.trim()}`
      }`,
      { retryable: parameters.retryable },
    );
    this.method = parameters.method;
    this.url = parameters.url;
    this.status = parameters.status;
    this.body = body;
    if (parameters.retryAfterMs !== undefined) this.retryAfterMs = parameters.retryAfterMs;
  }
}

/**
 * The server is not capable of what this backend needs, and no amount of retrying will change it.
 *
 * This exists because the alternative is worse than an error: a WebDAV server without `MOVE`, used
 * anyway, silently gives up atomic writes, and the first anybody hears of it is a half-written blob
 * sitting under a name that asserts a digest it does not have.
 */
export class StorageUnsupportedError extends StorageBackendError {
  /** What was missing: `MOVE`, `MKCOL`, `DAV: 1`, `multipart`… */
  readonly capability: string;

  constructor(backend: string, capability: string, message: string) {
    super(backend, message, { retryable: false });
    this.capability = capability;
  }
}

/**
 * The bytes that came back are not the bytes the digest names.
 *
 * On the read path this is invariant D2's hard failure, and the caller must set
 * `documents.storage_ok = 0` rather than believe the stream.
 */
export class StorageIntegrityError extends StorageBackendError {
  readonly expected: string;

  readonly actual: string;

  readonly size: number;

  constructor(backend: string, parameters: { expected: string; actual: string; size: number }) {
    super(
      backend,
      `Integrity failure: ${parameters.size} bytes read for ${parameters.expected} hash to ${parameters.actual}.`,
      { retryable: false },
    );
    this.expected = parameters.expected;
    this.actual = parameters.actual;
    this.size = parameters.size;
  }
}

/**
 * A multipart upload was started, could not be finished, and could not be aborted either.
 *
 * The parts are still on the server, still billable, and invisible to `ListObjects`. Losing this
 * quietly is how an S3 bucket ends up paying rent on gigabytes nobody can see, so it is an error
 * with its own name and it carries the upload id an operator needs to clean it up by hand.
 */
export class StorageAbandonedUploadError extends StorageBackendError {
  readonly key: string;

  readonly uploadId: string;

  constructor(backend: string, parameters: { key: string; uploadId: string; cause?: unknown }) {
    super(
      backend,
      `Multipart upload ${parameters.uploadId} of '${parameters.key}' failed and could not be aborted. ` +
        'Its parts remain on the server and are billable; abort it by hand or set a lifecycle rule ' +
        'for incomplete multipart uploads.',
      { retryable: false, cause: parameters.cause },
    );
    this.key = parameters.key;
    this.uploadId = parameters.uploadId;
  }
}
