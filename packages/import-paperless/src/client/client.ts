/**
 * The typed Paperless-ngx client: token auth, pagination, retries, and a hard rule about links.
 *
 * Three properties are load-bearing, and each one is a decision rather than a default.
 *
 * **Every URL is built here, none is followed.** A DRF paginated response carries `next` and
 * `previous` as absolute URLs that the server composed from the request it saw — which is to say,
 * from `Host` and whatever `X-Forwarded-*` headers reached it. A client that follows them sends the
 * migration token wherever they point. So this client walks pages by number, against a URL it
 * constructed from `baseUrl`, and treats `next` as a boolean it cross-checks rather than as an
 * instruction. A `next` that points off-origin raises `PaperlessUntrustedUrlError` instead of being
 * ignored, because it means something is wrong that a person should know about.
 *
 * **The credential appears once.** `Authorization: Token <token>` is built in `headers()` and
 * nowhere else. No error message, no log line and no report field ever carries it; `redactUrl`
 * scrubs anything credential-shaped out of a URL before it is quoted back.
 *
 * **A retry is bounded and idempotent.** Every request this client makes is a `GET`, so retrying is
 * safe by construction; 429 honours `Retry-After`, 5xx and transport failures back off, and 4xx
 * other than 429 fails immediately because retrying a rejected token only locks the account out.
 *
 * The transport is injected (`fetch`), which is what lets the tests run the whole client against
 * the in-process fake in `src/testing/` over a real loopback socket, with no container anywhere.
 */
import { Buffer } from 'node:buffer';

import {
  PaperlessApiVersionError,
  PaperlessAuthError,
  PaperlessError,
  PaperlessNotFoundError,
  PaperlessProtocolError,
  PaperlessUntrustedUrlError,
  redactUrl,
} from './errors.js';
import { PAPERLESS_API_VERSION, SUPPORTED_API_VERSIONS } from './types.js';
import type {
  PaperlessCorrespondent,
  PaperlessCustomField,
  PaperlessDocument,
  PaperlessDocumentMetadata,
  PaperlessDocumentType,
  PaperlessPage,
  PaperlessServerInfo,
  PaperlessStoragePath,
  PaperlessTag,
} from './types.js';

/** The subset of `fetch` this client uses. Node 22 supplies one; a test may supply another. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PaperlessClientOptions {
  /** The Paperless-ngx root, with or without a trailing `/api`. */
  baseUrl: string;
  /** An API token from Paperless-ngx (`/api/token/`, or the profile page). */
  token: string;
  /** DRF Accept-header version. Defaults to `10`; `9` is the other version this client knows. */
  apiVersion?: string;
  /** Records per page. Defaults to 100. Paperless caps it at 100000. */
  pageSize?: number;
  /** Attempts per request, the first included. Defaults to 4. */
  attempts?: number;
  /** Base backoff, doubled per attempt. Defaults to 250 ms. */
  retryDelayMs?: number;
  /** Per-request timeout. Defaults to 60 s; a large original on a slow link needs room. */
  timeoutMs?: number;
  /** Injected transport. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Injected sleep, so a test does not wait out a backoff in real time. */
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
}

/** One downloaded original. */
export interface PaperlessFile {
  bytes: Buffer;
  /** The filename the server suggested, reduced to a bare basename. Advisory only. */
  filename: string | null;
  contentType: string | null;
}

/** A page of documents, as the walker hands them out. */
export interface DocumentPage {
  page: number;
  /** `count` from the envelope: how many documents the server says match. */
  total: number;
  documents: PaperlessDocument[];
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_ATTEMPTS = 4;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * A ceiling on pages walked, so a server whose `count` and `results` disagree cannot spin forever.
 *
 * 100 000 pages at the default size is ten million documents, which is far past anything a
 * Paperless install holds and far short of an unbounded loop.
 */
const MAX_PAGES = 100_000;

export class PaperlessClient {
  /** The API root, always with a trailing slash: `https://paperless.example/api/`. */
  readonly apiRoot: URL;

  readonly apiVersion: string;

  readonly pageSize: number;

  private readonly token: string;

  private readonly attempts: number;

  private readonly retryDelayMs: number;

  private readonly timeoutMs: number;

  private readonly fetchImpl: FetchLike;

  private readonly sleep: (ms: number) => Promise<void>;

  private readonly userAgent: string;

  constructor(options: PaperlessClientOptions) {
    this.apiRoot = apiRootOf(options.baseUrl);
    this.token = options.token;
    this.apiVersion = options.apiVersion ?? PAPERLESS_API_VERSION;
    if (!SUPPORTED_API_VERSIONS.includes(this.apiVersion)) {
      throw new PaperlessError(
        `API version ${this.apiVersion} is not one this client has been written against ` +
          `(${SUPPORTED_API_VERSIONS.join(', ')}).`,
        { method: 'GET', url: this.apiRoot.toString() },
      );
    }
    this.pageSize = clampPageSize(options.pageSize ?? DEFAULT_PAGE_SIZE);
    this.attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.userAgent = options.userAgent ?? 'Recueil/import-paperless';
  }

  /** The base URL as it may be printed: no credential, no query. */
  get displayUrl(): string {
    return redactUrl(this.apiRoot.toString());
  }

  /* ---------------------------------------------------------------------------------------- */
  /* The server itself                                                                           */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * Ask the server what it is.
   *
   * `ApiVersionMiddleware` sets `X-Version` and `X-Api-Version` on every response to an
   * authenticated request, so a probe both verifies the token and records the version the report
   * has to state. An absent `X-Version` is not an error — a reverse proxy may strip it — but the
   * report says so rather than inventing one.
   */
  async probe(): Promise<PaperlessServerInfo> {
    const { response, body } = await this.getJson('', {});
    const endpoints =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? Object.keys(body as Record<string, unknown>).sort()
        : [];
    return {
      serverVersion: response.headers.get('x-version'),
      apiVersion: response.headers.get('x-api-version'),
      requestedApiVersion: this.apiVersion,
      endpoints,
    };
  }

  /* ---------------------------------------------------------------------------------------- */
  /* The vocabularies                                                                            */
  /* ---------------------------------------------------------------------------------------- */

  listCorrespondents(): Promise<PaperlessCorrespondent[]> {
    return this.listAll<PaperlessCorrespondent>('correspondents/');
  }

  listDocumentTypes(): Promise<PaperlessDocumentType[]> {
    return this.listAll<PaperlessDocumentType>('document_types/');
  }

  listTags(): Promise<PaperlessTag[]> {
    return this.listAll<PaperlessTag>('tags/');
  }

  listCustomFields(): Promise<PaperlessCustomField[]> {
    return this.listAll<PaperlessCustomField>('custom_fields/');
  }

  listStoragePaths(): Promise<PaperlessStoragePath[]> {
    return this.listAll<PaperlessStoragePath>('storage_paths/');
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Documents                                                                                   */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * Walk the document list in ascending id order, page by page.
   *
   * Ascending id is the only ordering that makes a resumed run correct without a server-side
   * cursor. Paperless-ngx exposes `id` for `exact` and `in` lookups only — there is no `id__gt` —
   * so no client can ask the server to start in the middle, and every page is fetched on a resume
   * whatever the resume point is. That is cheap: the JSON of a page is three orders of magnitude
   * smaller than one original, and the originals are what a resume must avoid re-fetching.
   *
   * Deciding *which* of these documents still need work is therefore the importer's job, not this
   * one's. The walker hands over every document on the page and keeps no policy of its own, which
   * is also what lets the verification report compare the whole API side against the target after
   * a resumed run.
   */
  async *documents(): AsyncGenerator<DocumentPage> {
    let page = 1;
    let seen = 0;

    for (;;) {
      if (page > MAX_PAGES) {
        throw new PaperlessProtocolError(
          `The document list did not end after ${MAX_PAGES} pages. Refusing to keep asking.`,
          { method: 'GET', url: redactUrl(this.url('documents/', {}).toString()) },
        );
      }

      const envelope = await this.getPage<PaperlessDocument>('documents/', {
        page: String(page),
        page_size: String(this.pageSize),
        ordering: 'id',
      });

      if (envelope.results.length === 0) return;
      seen += envelope.results.length;

      yield { page, total: envelope.count, documents: envelope.results };

      if (envelope.next === null) return;
      if (seen >= envelope.count) return;
      page += 1;
    }
  }

  /** `GET /api/documents/{id}/metadata/`: the original's checksum, size and MIME type. */
  async documentMetadata(id: number): Promise<PaperlessDocumentMetadata> {
    const { body } = await this.getJson(`documents/${integer(id)}/metadata/`, {});
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new PaperlessProtocolError('The metadata endpoint did not return an object.', {
        method: 'GET',
        url: redactUrl(this.url(`documents/${integer(id)}/metadata/`, {}).toString()),
      });
    }
    return body as PaperlessDocumentMetadata;
  }

  /**
   * `GET /api/documents/{id}/download/?original=true`: the bytes as they arrived at Paperless.
   *
   * The original, never the archive. The archive is a PDF Paperless generated by running OCR over
   * the original; it is derived data, and ADR-0004 says identity is the hash of the file the
   * library actually received. A migration that stored the archive would give every document a
   * digest no other copy of that file has.
   */
  async downloadOriginal(id: number): Promise<PaperlessFile> {
    const url = this.url(`documents/${integer(id)}/download/`, { original: 'true' });
    const response = await this.send('GET', url);

    if (response.status === 404) {
      throw new PaperlessNotFoundError(`original file for document ${integer(id)}`, {
        method: 'GET',
        url: redactUrl(url.toString()),
        status: 404,
      });
    }
    await this.assertOk('GET', url, response);

    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      bytes,
      filename: dispositionFilename(response.headers.get('content-disposition')),
      contentType: response.headers.get('content-type'),
    };
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Paging and transport                                                                        */
  /* ---------------------------------------------------------------------------------------- */

  /** Every record of a list endpoint, walked by page number. */
  private async listAll<TRecord>(path: string): Promise<TRecord[]> {
    const out: TRecord[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const envelope = await this.getPage<TRecord>(path, {
        page: String(page),
        page_size: String(this.pageSize),
        ordering: 'id',
      });
      out.push(...envelope.results);
      if (envelope.results.length === 0) return out;
      if (envelope.next === null) return out;
      if (out.length >= envelope.count) return out;
    }
    throw new PaperlessProtocolError(
      `The list at ${path} did not end after ${MAX_PAGES} pages. Refusing to keep asking.`,
      { method: 'GET', url: redactUrl(this.url(path, {}).toString()) },
    );
  }

  /**
   * One page, validated as a page.
   *
   * The `next` link is checked against the configured origin and then discarded. Checking it and
   * discarding it may look redundant; it is not. Discarding it is what keeps the credential on the
   * configured host, and checking it is what turns "something in front of this server is rewriting
   * links" from an invisible condition into an error a person reads.
   */
  private async getPage<TRecord>(
    path: string,
    query: Record<string, string>,
  ): Promise<PaperlessPage<TRecord>> {
    const { body, url } = await this.getJson(path, query);
    const context = { method: 'GET', url: redactUrl(url.toString()) };

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new PaperlessProtocolError(
        `${path} did not return a paginated object. A Paperless-ngx list endpoint always does; ` +
          'this is usually a login page served by a reverse proxy in front of the API.',
        context,
      );
    }

    const envelope = body as Partial<PaperlessPage<TRecord>>;
    if (!Array.isArray(envelope.results)) {
      throw new PaperlessProtocolError(`${path} returned no \`results\` array.`, context);
    }
    if (typeof envelope.count !== 'number' || !Number.isFinite(envelope.count)) {
      throw new PaperlessProtocolError(`${path} returned no \`count\`.`, context);
    }

    const next = envelope.next ?? null;
    if (next !== null) this.assertSameServer(next, context);

    return {
      count: envelope.count,
      next,
      previous: envelope.previous ?? null,
      results: envelope.results,
      ...(envelope.all === undefined ? {} : { all: envelope.all }),
    };
  }

  private async getJson(
    path: string,
    query: Record<string, string>,
  ): Promise<{ response: Response; body: unknown; url: URL }> {
    const url = this.url(path, query);
    const response = await this.send('GET', url);
    await this.assertOk('GET', url, response);

    const text = await response.text();
    try {
      return { response, body: JSON.parse(text), url };
    } catch {
      throw new PaperlessProtocolError(
        `${path} returned a body that is not JSON. The first bytes were: ${text.slice(0, 200)}`,
        { method: 'GET', url: redactUrl(url.toString()), status: response.status },
      );
    }
  }

  /** Build a URL under the API root. The path is ours; the query is escaped by `URLSearchParams`. */
  private url(path: string, query: Record<string, string>): URL {
    const url = new URL(path, this.apiRoot);
    // `new URL('../x', base)` would escape the API root, and a path is only ever a literal in this
    // file — but the check costs nothing and the assumption is exactly the kind that rots.
    if (!url.toString().startsWith(this.apiRoot.toString())) {
      throw new PaperlessUntrustedUrlError(url.toString(), {
        method: 'GET',
        url: this.apiRoot.toString(),
      });
    }
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
  }

  private assertSameServer(link: string, context: { method: string; url: string }): void {
    let parsed: URL;
    try {
      parsed = new URL(link, this.apiRoot);
    } catch {
      throw new PaperlessUntrustedUrlError(link, context);
    }
    if (parsed.origin !== this.apiRoot.origin || !parsed.pathname.startsWith(this.apiRoot.pathname)) {
      throw new PaperlessUntrustedUrlError(redactUrl(parsed.toString()), context);
    }
  }

  /**
   * Send one request, retrying what is worth retrying.
   *
   * Redirects are followed only within the configured origin: `redirect: 'manual'` and an explicit
   * check, rather than `fetch`'s default of following anywhere, because a 302 to another host is
   * the same credential leak as an off-origin `next` link.
   */
  private async send(method: string, url: URL): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.sendOnce(method, url);
      } catch (error) {
        lastError = error;
        if (error instanceof PaperlessUntrustedUrlError) throw error;
        if (attempt === this.attempts) break;
        await this.sleep(this.backoff(attempt));
        continue;
      }

      if (response.status === 429) {
        if (attempt === this.attempts) return response;
        await this.sleep(retryAfterMs(response.headers.get('retry-after')) ?? this.backoff(attempt));
        continue;
      }
      if (response.status >= 500 && attempt < this.attempts) {
        await this.sleep(this.backoff(attempt));
        continue;
      }
      return response;
    }

    throw new PaperlessError(
      `Paperless-ngx did not answer after ${this.attempts} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
      { method, url: redactUrl(url.toString()) },
    );
  }

  private async sendOnce(method: string, url: URL, hop = 0): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url.toString(), {
        method,
        headers: this.headers(),
        redirect: 'manual',
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location === null) return response;
        if (hop >= 5) {
          throw new PaperlessProtocolError('Too many redirects.', {
            method,
            url: redactUrl(url.toString()),
            status: response.status,
          });
        }
        this.assertSameServer(location, { method, url: redactUrl(url.toString()) });
        return await this.sendOnce(method, new URL(location, this.apiRoot), hop + 1);
      }

      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The one place the credential is used. */
  private headers(): Record<string, string> {
    return {
      Authorization: `Token ${this.token}`,
      Accept: `application/json; version=${this.apiVersion}`,
      'User-Agent': this.userAgent,
    };
  }

  private backoff(attempt: number): number {
    return this.retryDelayMs * 2 ** (attempt - 1);
  }

  private async assertOk(method: string, url: URL, response: Response): Promise<void> {
    if (response.ok) return;

    const context = {
      method,
      url: redactUrl(url.toString()),
      status: response.status,
      body: (await safeText(response)).slice(0, 500),
    };

    if (response.status === 401 || response.status === 403) throw new PaperlessAuthError(context);
    if (response.status === 406) throw new PaperlessApiVersionError(this.apiVersion, context);
    if (response.status === 404) throw new PaperlessNotFoundError(url.pathname, context);
    throw new PaperlessError(`Paperless-ngx answered ${response.status}.`, context);
  }
}

/* ================================================================================================ */

/**
 * `https://paperless.example` or `https://paperless.example/api` or `.../api/` → `.../api/`.
 *
 * A trailing slash matters: `new URL('tags/', 'https://host/api')` resolves to `https://host/tags/`,
 * which would quietly ask a completely different server route.
 */
export const apiRootOf = (baseUrl: string): URL => {
  const trimmed = baseUrl.trim();
  if (trimmed === '') throw new TypeError('A Paperless-ngx base URL is required.');

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new TypeError(`\`${trimmed}\` is not an absolute URL. Give the scheme and the host.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`\`${url.protocol}\` is not a scheme this client speaks.`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError(
      'Put the credential in `token`, not in the URL. Userinfo in a URL leaks into logs, ' +
        'referrers and error messages.',
    );
  }

  url.hash = '';
  url.search = '';
  const path = url.pathname.replace(/\/+$/u, '');
  url.pathname = path.endsWith('/api') ? `${path}/` : `${path}/api/`;
  return url;
};

const clampPageSize = (size: number): number => {
  if (!Number.isInteger(size) || size < 1) {
    throw new TypeError(`\`pageSize\` must be a positive integer, got ${String(size)}.`);
  }
  return Math.min(size, 100_000);
};

/** A document id, proven to be an id before it is put in a path. */
const integer = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`\`${String(value)}\` is not a Paperless-ngx object id.`);
  }
  return value;
};

/**
 * The filename out of a `Content-Disposition`, reduced to something safe to record.
 *
 * The value is chosen by the server and derived from data a person typed into Paperless, so it is
 * hostile: `../../.ssh/authorized_keys` is a perfectly valid string to find here. Nothing in this
 * package opens a file by this name — originals go into the content-addressed store under their
 * digest — but it is recorded on the document and shown in the report, so it is reduced to a bare
 * basename with separators, `..` and control characters removed before it goes anywhere.
 */
export const dispositionFilename = (header: string | null): string | null => {
  if (header === null) return null;

  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/u.exec(header);
  const plain = /filename\s*=\s*"((?:[^"\\]|\\.)*)"|filename\s*=\s*([^;]+)/u.exec(header);

  let raw: string | null = null;
  if (extended?.[1] !== undefined) {
    try {
      raw = decodeURIComponent(extended[1]);
    } catch {
      raw = extended[1];
    }
  } else if (plain?.[1] !== undefined) {
    raw = plain[1].replace(/\\(.)/gu, '$1');
  } else if (plain?.[2] !== undefined) {
    raw = plain[2].trim();
  }

  return raw === null ? null : safeBasename(raw);
};

/** Every path element, traversal and control character taken out of a filename. */
export const safeBasename = (raw: string): string | null => {
  const last = raw.split(/[/\\]/u).pop() ?? '';
  const cleaned = last.replace(/[\u0000-\u001F\u007F]/gu, '').trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return null;
  return cleaned.slice(0, 255);
};

const retryAfterMs = (header: string | null): number | null => {
  if (header === null) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(0, date - Date.now()), 60_000);
};

const safeText = async (response: Response): Promise<string> => {
  try {
    return await response.text();
  } catch {
    return '';
  }
};
