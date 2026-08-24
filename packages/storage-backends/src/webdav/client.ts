/**
 * A small WebDAV client, written rather than taken off the shelf.
 *
 * The reason is scope. A content-addressed store uses six methods — `OPTIONS`, `HEAD`, `GET`,
 * `PUT`, `MKCOL`, `MOVE`, `DELETE` — over paths it generates itself from a digest. It never needs
 * `PROPPATCH`, locking, property discovery, or the XML parsing that comes with them, and it does
 * need three things the general-purpose clients do not give: a retry loop that reopens the request
 * body from a spooled file rather than replaying a consumed stream, a `MKCOL` that understands the
 * `409`-then-create-the-parent dance, and a clear refusal when the server cannot do what the store
 * requires.
 *
 * Every path segment this client builds is checked before it is joined. The digests come from
 * `assertSha256`, so nothing hostile should reach here — but "should" is what the Phase 1 review
 * found under three separate defects, and a segment check costs a regex.
 */
import type { Readable } from 'node:stream';

import { StorageRequestError, StorageUnsupportedError } from '../errors.js';
import { DEFAULT_RETRY_POLICY, parseRetryAfter, resolveRetryPolicy, withRetry } from '../retry.js';
import type { RetryAttempt, RetryPolicy } from '../retry.js';

export type WebDavAuth =
  | { kind: 'none' }
  | { kind: 'basic'; username: string; password: string }
  /** A bearer token — an OIDC access token, or a Nextcloud app password used as one. */
  | { kind: 'bearer'; token: string };

export interface WebDavClientOptions {
  /**
   * The collection the store lives in, as an absolute URL. For Nextcloud that looks like
   * `https://cloud.example.org/remote.php/dav/files/<user>/Recueil`.
   */
  url: string;
  auth?: WebDavAuth;
  /** Sent on every request. For a reverse proxy that wants a header, or a `User-Agent` you prefer. */
  headers?: Record<string, string>;
  retry?: Partial<RetryPolicy>;
  onRetry?: (attempt: RetryAttempt & { method: string; url: string }) => void;
  /** Swapped by the tests, and by anyone who needs a proxy agent. */
  fetch?: typeof globalThis.fetch;
  /** Swapped by the tests so a backoff run does not really wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** Statuses worth repeating. Everything else is the server saying the request is wrong. */
const RETRYABLE_STATUS = new Set([408, 423, 429, 500, 502, 503, 504]);

const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/u;

/**
 * Reject a path segment that could climb out of the root.
 *
 * The store only ever generates hex and a fixed temp-directory name, so this never fires in normal
 * use. It fires when something upstream has gone wrong, which is exactly when it is wanted.
 */
export const assertSegment = (segment: string): string => {
  if (!SEGMENT_PATTERN.test(segment) || segment === '.' || segment === '..') {
    throw new Error(`Refusing to build a WebDAV path from the segment '${segment}'.`);
  }
  return segment;
};

export interface WebDavCapabilities {
  /** The compliance classes from the `DAV` response header: `1`, `2`, `3`, and vendor tokens. */
  dav: string[];
  /** The methods from `Allow`, uppercased. Empty when the server did not say. */
  allow: string[];
}

export interface WebDavResponse {
  status: number;
  headers: Headers;
  body: Response['body'];
}

/** What `fetch` will accept as a request body, minus the `null` it also accepts. */
type FetchBody = NonNullable<RequestInit['body']>;

export class WebDavClient {
  readonly baseUrl: string;

  private readonly auth: WebDavAuth;

  private readonly extraHeaders: Record<string, string>;

  private readonly policy: RetryPolicy;

  private readonly onRetry: WebDavClientOptions['onRetry'];

  private readonly doFetch: typeof globalThis.fetch;

  private readonly sleep: WebDavClientOptions['sleep'];

  private capabilitiesPromise: Promise<WebDavCapabilities> | null = null;

  /** Collections known to exist, so a busy ingest does not `MKCOL` the same shard every time. */
  private readonly knownCollections = new Set<string>();

  constructor(options: WebDavClientOptions) {
    const parsed = new URL(options.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`A WebDAV root must be http(s); got '${options.url}'.`);
    }
    this.baseUrl = parsed.toString().replace(/\/+$/u, '');
    this.auth = options.auth ?? { kind: 'none' };
    this.extraHeaders = options.headers ?? {};
    this.policy = resolveRetryPolicy(options.retry ?? DEFAULT_RETRY_POLICY);
    this.onRetry = options.onRetry;
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep;
  }

  /** The absolute URL of a path below the root. Each segment is checked, then encoded. */
  url(segments: readonly string[]): string {
    if (segments.length === 0) return this.baseUrl;
    return `${this.baseUrl}/${segments.map((segment) => encodeURIComponent(assertSegment(segment))).join('/')}`;
  }

  private authHeaders(): Record<string, string> {
    switch (this.auth.kind) {
      case 'basic':
        return {
          authorization: `Basic ${Buffer.from(`${this.auth.username}:${this.auth.password}`, 'utf8').toString('base64')}`,
        };
      case 'bearer':
        return { authorization: `Bearer ${this.auth.token}` };
      default:
        return {};
    }
  }

  /**
   * One request, retried on the statuses a server can recover from.
   *
   * `body` is a factory, not a value. That is the whole reason this is not four lines of `fetch`:
   * a `Readable` is consumed by the first attempt, so a retry that reused it would `PUT` an empty
   * body over a blob and leave a file whose name asserts a digest it does not have.
   */
  async request(
    method: string,
    segments: readonly string[],
    options: {
      headers?: Record<string, string>;
      body?: () => { stream: Readable; length: number } | Buffer | undefined;
      /** Statuses that are an answer rather than a failure — `404` for a `HEAD`, say. */
      expect?: (status: number) => boolean;
    } = {},
  ): Promise<WebDavResponse> {
    const url = this.url(segments);
    const expect = options.expect ?? ((status: number) => status >= 200 && status < 300);

    return withRetry(
      async () => {
        const headers: Record<string, string> = {
          ...this.extraHeaders,
          ...this.authHeaders(),
          ...(options.headers ?? {}),
        };

        let body: FetchBody | undefined;
        const built = options.body?.();
        if (built !== undefined) {
          if (Buffer.isBuffer(built)) {
            body = new Uint8Array(built);
            headers['content-length'] = String(built.byteLength);
          } else if (built.length === 0) {
            // A zero-length streaming body is a corner every HTTP stack handles differently, and
            // an empty blob is a perfectly ordinary thing to be handed. Send it as bytes.
            built.stream.destroy();
            body = new Uint8Array(0);
            headers['content-length'] = '0';
          } else {
            // `duplex: 'half'` is required by the fetch standard for a streaming request body.
            const { Readable: NodeReadable } = await import('node:stream');
            body = NodeReadable.toWeb(built.stream) as unknown as FetchBody;
            headers['content-length'] = String(built.length);
          }
        }

        const init: RequestInit = { method, headers, body };
        // The fetch standard requires `duplex: 'half'` for a streaming request body.
        if (body instanceof ReadableStream) init.duplex = 'half';

        const response = await this.doFetch(url, init);
        if (expect(response.status)) {
          return { status: response.status, headers: response.headers, body: response.body };
        }

        const text = await response.text().catch(() => '');
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        throw new StorageRequestError('webdav', {
          method,
          url,
          status: response.status,
          body: text,
          retryable: RETRYABLE_STATUS.has(response.status),
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        });
      },
      {
        policy: this.policy,
        isRetryable: (error) => isRetryableWebDavError(error),
        retryAfterMs: (error) =>
          error instanceof StorageRequestError ? error.retryAfterMs : undefined,
        onRetry: (attempt) => this.onRetry?.({ ...attempt, method, url }),
        ...(this.sleep === undefined ? {} : { sleep: this.sleep }),
      },
    );
  }

  /** What the server says it can do. Fetched once and remembered. */
  async capabilities(): Promise<WebDavCapabilities> {
    this.capabilitiesPromise ??= (async () => {
      const response = await this.request('OPTIONS', [], {
        expect: (status) => status >= 200 && status < 300,
      });
      await drain(response);
      const dav = (response.headers.get('dav') ?? '')
        .split(',')
        .map((token) => token.trim())
        .filter((token) => token !== '');
      const allow = (response.headers.get('allow') ?? '')
        .split(',')
        .map((token) => token.trim().toUpperCase())
        .filter((token) => token !== '');
      return { dav, allow };
    })().catch((error: unknown) => {
      this.capabilitiesPromise = null;
      throw error;
    });
    return this.capabilitiesPromise;
  }

  /**
   * Refuse a server that cannot support a content-addressed store, and say precisely what is wrong.
   *
   * Class 1 compliance is the bar because it is the one that mandates `PUT`, `DELETE`, `MKCOL` and
   * `MOVE`. A server that does not claim it may still work, and a server that claims it may still
   * refuse `MOVE` on some paths — so this is a cheap early check, not a guarantee, and the write
   * path raises its own error if `MOVE` turns out to be missing.
   */
  async assertUsable(options: { requireMove: boolean }): Promise<WebDavCapabilities> {
    const capabilities = await this.capabilities();

    if (!capabilities.dav.includes('1')) {
      throw new StorageUnsupportedError(
        'webdav',
        'DAV: 1',
        `${this.baseUrl} did not advertise WebDAV class 1 compliance in its OPTIONS response ` +
          `(DAV: ${capabilities.dav.join(', ') || '<absent>'}). Recueil needs PUT, DELETE, MKCOL ` +
          'and MOVE. Check that the URL points at a WebDAV collection and not at a web UI.',
      );
    }

    // `Allow` is advisory: plenty of correct servers omit it, and some list only the methods
    // allowed on that one resource. Only an explicit "here is my list, and MOVE is not on it" is
    // treated as a refusal.
    if (options.requireMove && capabilities.allow.length > 0 && !capabilities.allow.includes('MOVE')) {
      throw new StorageUnsupportedError(
        'webdav',
        'MOVE',
        `${this.baseUrl} lists its methods as ${capabilities.allow.join(', ')} and MOVE is not ` +
          'among them. Recueil writes a blob to a temporary name and MOVEs it into place so that ' +
          'an interrupted upload cannot leave a partial file under a name that asserts a digest. ' +
          "Set writeStrategy: 'direct-put' to accept non-atomic writes on this server.",
      );
    }

    return capabilities;
  }

  /**
   * Create a collection, creating its parents when the server says the parent is missing.
   *
   * `405 Method Not Allowed` on `MKCOL` means "there is already something here", which is the
   * common case once a shard has been used, and is success. `409 Conflict` means the parent does
   * not exist — the one case where recursing is right, and the reason this is not a one-liner.
   */
  async ensureCollection(segments: readonly string[]): Promise<void> {
    if (segments.length === 0) return;
    const key = segments.join('/');
    if (this.knownCollections.has(key)) return;

    const response = await this.request('MKCOL', segments, {
      expect: (status) =>
        (status >= 200 && status < 300) || status === 405 || status === 409 || status === 501,
    });
    await drain(response);

    if (response.status === 501) {
      throw new StorageUnsupportedError(
        'webdav',
        'MKCOL',
        `${this.url(segments)} could not be created: the server does not implement MKCOL. A ` +
          'content-addressed store needs 65 536 shard collections; it cannot run on a server that ' +
          'only serves a fixed tree.',
      );
    }

    if (response.status === 409) {
      await this.ensureCollection(segments.slice(0, -1));
      const retry = await this.request('MKCOL', segments, {
        expect: (status) => (status >= 200 && status < 300) || status === 405,
      });
      await drain(retry);
    }

    this.knownCollections.add(key);
  }

  /** Forget the cached collections. For a test, or after someone has emptied the store by hand. */
  forgetCollections(): void {
    this.knownCollections.clear();
  }
}

export const isRetryableWebDavError = (error: unknown): boolean => {
  if (error instanceof StorageRequestError) return error.retryable;
  if (error instanceof StorageUnsupportedError) return false;
  // A fetch that never got an answer: connection reset, DNS blip, socket timeout. `fetch` wraps
  // these in a TypeError whose cause carries the errno.
  if (error instanceof TypeError) return true;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  );
};

/** Release the socket for a response whose body we do not want. */
export const drain = async (response: WebDavResponse): Promise<void> => {
  await response.body?.cancel().catch(() => undefined);
};
