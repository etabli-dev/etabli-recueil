/**
 * An in-process fake of the Paperless-ngx REST API.
 *
 * **This is a fake, and a fake is not a compatibility claim.** It reproduces what the published
 * source of Paperless-ngx `PAPERLESS_MODELLED_VERSION` does — the serialiser field lists, the
 * `StandardPagination` envelope, `AcceptHeaderVersioning`, `TokenAuthentication`, the
 * `ApiVersionMiddleware` headers, the `metadata` and `download` actions — and nothing more. It
 * cannot discover a field the real server sends that this package does not know about, and it
 * cannot discover that a real install behaves differently from its own source. `README.md` §"What
 * is unproven" says so at the top, and the report says so in `source.versionMatchesModel`.
 *
 * It is a **real HTTP server on the loopback interface**, not a stubbed `fetch`. That is deliberate:
 * the interesting failures in an HTTP client are in header parsing, redirects, chunked bodies,
 * status handling and timeouts, and a stubbed `fetch` tests none of them. It also means the tests
 * need no container of any kind, which is the constraint this package was built under.
 *
 * Fault injection is first-class, because the behaviour CONCEPT §6 actually specifies — "a document
 * whose original cannot be fetched goes to the review queue with a reason, not a failed run" — is
 * only testable against a server that can refuse.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { PAPERLESS_MODELLED_VERSION } from '../client/types.js';
import type {
  PaperlessCorrespondent,
  PaperlessCustomField,
  PaperlessDocument,
  PaperlessDocumentType,
  PaperlessStoragePath,
  PaperlessTag,
} from '../client/types.js';

/** The library the fake serves. */
export interface FakeLibrary {
  correspondents: PaperlessCorrespondent[];
  documentTypes: PaperlessDocumentType[];
  tags: PaperlessTag[];
  storagePaths: PaperlessStoragePath[];
  customFields: PaperlessCustomField[];
  documents: PaperlessDocument[];
  /** Document id → the original file. A document with no entry answers 404, as a lost file does. */
  originals: Map<number, FakeOriginal>;
}

export interface FakeOriginal {
  bytes: Buffer;
  /** Defaults to `application/pdf`. */
  contentType?: string;
  /** What `Content-Disposition` claims. Hostile values are the point of having this. */
  filename?: string;
  /**
   * The MD5 the metadata endpoint reports.
   *
   * Defaults to the real MD5 of `bytes`. Setting it to something else is how the checksum
   * reconciliation is tested: Paperless computed its checksum when it consumed the file, and a
   * file replaced on disk since then makes the two disagree.
   */
  reportedMd5?: string;
  /** The size the metadata endpoint reports. Defaults to `bytes.length`. */
  reportedSize?: number;
  /** Served when `?original=true` is *not* asked for, to prove the client always asks. */
  archiveBytes?: Buffer;
}

/** One injected failure, consumed in order. */
export interface FakeFault {
  /** Matched against the request path (and query). A substring or a pattern. */
  path: string | RegExp;
  /** How many matching requests it applies to. Defaults to 1. */
  times?: number;
  /** The status to answer with. */
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

export interface FakeServerOptions {
  /** The token the fake accepts. Defaults to `test-token`. */
  token?: string;
  /** `X-Version`. Defaults to the release this package was modelled against. */
  version?: string;
  /** `ALLOWED_VERSIONS`. Defaults to `['9', '10']`, as at 3.0.5. */
  allowedApiVersions?: string[];
  /** `DEFAULT_VERSION`, used when the Accept header names none. Defaults to `10`. */
  defaultApiVersion?: string;
  /** `StandardPagination.page_size`. Defaults to 25, as upstream. */
  defaultPageSize?: number;
  /** Injected failures, consumed in order. */
  faults?: FakeFault[];
  /**
   * Build `next`/`previous` against this origin instead of the request's own.
   *
   * A reverse proxy that trusts `X-Forwarded-Host` will do exactly this, which is why the client
   * refuses to follow a pagination link rather than trusting one.
   */
  linkOrigin?: string;
  /** Strip `X-Version`/`X-Api-Version`, as a proxy that filters response headers would. */
  suppressVersionHeaders?: boolean;
}

/** One request the fake saw, for a test that asserts on what the client asked for. */
export interface FakeRequest {
  method: string;
  url: string;
  accept: string | null;
  authorization: string | null;
}

export class FakePaperlessServer {
  readonly library: FakeLibrary;

  readonly token: string;

  /** Every request, in order. The `authorization` value is kept so a test can assert on the scheme. */
  readonly requests: FakeRequest[] = [];

  private readonly server: Server;

  private readonly options: FakeServerOptions;

  private readonly faults: FakeFault[];

  private baseUrl = '';

  private constructor(library: FakeLibrary, options: FakeServerOptions) {
    this.library = library;
    this.options = options;
    this.token = options.token ?? 'test-token';
    this.faults = (options.faults ?? []).map((fault) => ({ ...fault, times: fault.times ?? 1 }));
    this.server = createServer((request, response) => {
      this.handle(request, response);
    });
  }

  /** Start on an ephemeral loopback port. */
  static async start(
    library: FakeLibrary,
    options: FakeServerOptions = {},
  ): Promise<FakePaperlessServer> {
    const fake = new FakePaperlessServer(library, options);
    await new Promise<void>((resolve) => {
      fake.server.listen(0, '127.0.0.1', resolve);
    });
    const address = fake.server.address() as AddressInfo;
    fake.baseUrl = `http://127.0.0.1:${address.port}`;
    return fake;
  }

  /** The server root. `${url}/api/` is the API root. */
  get url(): string {
    return this.baseUrl;
  }

  /** Add a fault after the server has started. */
  fail(fault: FakeFault): void {
    this.faults.push({ ...fault, times: fault.times ?? 1 });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }

  /* ---------------------------------------------------------------------------------------- */

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const rawUrl = request.url ?? '/';
    this.requests.push({
      method: request.method ?? 'GET',
      url: rawUrl,
      accept: header(request, 'accept'),
      authorization: header(request, 'authorization'),
    });

    const fault = this.takeFault(rawUrl);
    if (fault !== undefined) {
      this.send(response, fault.status, fault.body ?? '{"detail":"injected"}', {
        'content-type': 'application/json',
        ...(fault.headers ?? {}),
      });
      return;
    }

    // `TokenAuthentication`: the scheme is the literal word `Token`, not `Bearer`.
    const authorization = header(request, 'authorization');
    if (authorization !== `Token ${this.token}`) {
      // `ApiVersionMiddleware` sets its headers only for an authenticated request, so a 401 has
      // none — which is why `probe()` treats an absent `X-Version` as unknown rather than as a
      // server that answered.
      this.send(response, 401, JSON.stringify({ detail: 'Invalid token.' }), {
        'content-type': 'application/json',
      });
      return;
    }

    const apiVersion = this.negotiateVersion(header(request, 'accept'));
    if (apiVersion === null) {
      this.send(
        response,
        406,
        JSON.stringify({ detail: 'Invalid version in "Accept" header.' }),
        { 'content-type': 'application/json' },
      );
      return;
    }

    const url = new URL(rawUrl, this.baseUrl);
    const path = url.pathname;

    if (path === '/api/' || path === '/api') {
      this.json(response, this.routerRoot());
      return;
    }

    const list = LIST_ROUTES[path];
    if (list !== undefined) {
      this.json(response, this.page(url, this.library[list] as unknown[], apiVersion));
      return;
    }

    const metadata = /^\/api\/documents\/(\d+)\/metadata\/$/u.exec(path);
    if (metadata !== null) {
      this.documentMetadata(response, Number(metadata[1]));
      return;
    }

    const download = /^\/api\/documents\/(\d+)\/download\/$/u.exec(path);
    if (download !== null) {
      this.download(response, Number(download[1]), url.searchParams.get('original') === 'true');
      return;
    }

    this.send(response, 404, JSON.stringify({ detail: 'Not found.' }), {
      'content-type': 'application/json',
    });
  }

  private routerRoot(): Record<string, string> {
    return Object.fromEntries(
      Object.keys(LIST_ROUTES)
        .map((path) => [path.replace('/api/', '').replace('/', ''), `${this.baseUrl}${path}`])
        .sort(),
    );
  }

  /** `StandardPagination`: `count`, `next`, `previous`, `all` below version 10, `results`. */
  private page(url: URL, all: unknown[], apiVersion: number): Record<string, unknown> {
    const ordering = url.searchParams.get('ordering');
    const sorted = [...all];
    if (ordering === 'id' || ordering === null) {
      sorted.sort((left, right) => idOf(left) - idOf(right));
    } else if (ordering === '-id') {
      sorted.sort((left, right) => idOf(right) - idOf(left));
    }

    const pageSize = clampInt(
      url.searchParams.get('page_size'),
      this.options.defaultPageSize ?? 25,
      1,
      100_000,
    );
    const page = clampInt(url.searchParams.get('page'), 1, 1, Number.MAX_SAFE_INTEGER);
    const offset = (page - 1) * pageSize;
    const results = sorted.slice(offset, offset + pageSize);

    const link = (target: number): string | null => {
      const next = new URL(url.toString());
      next.searchParams.set('page', String(target));
      const origin = this.options.linkOrigin;
      return origin === undefined ? next.toString() : `${origin}${next.pathname}${next.search}`;
    };

    const envelope: Record<string, unknown> = {
      count: sorted.length,
      next: offset + results.length < sorted.length ? link(page + 1) : null,
      previous: page > 1 ? link(page - 1) : null,
    };
    // TODO in upstream terms: `all` goes away with API v9. Reproduced so that a run against a v9
    // server is exercised by the tests rather than assumed to work.
    if (apiVersion < 10) envelope['all'] = sorted.map((row) => idOf(row));
    envelope['results'] = results;
    return envelope;
  }

  private documentMetadata(response: ServerResponse, id: number): void {
    const document = this.library.documents.find((row) => row.id === id);
    if (document === undefined) {
      this.send(response, 404, JSON.stringify({ detail: 'Not found.' }), {
        'content-type': 'application/json',
      });
      return;
    }

    const original = this.library.originals.get(id);
    this.json(response, {
      original_checksum: original === undefined ? null : (original.reportedMd5 ?? md5(original.bytes)),
      original_size: original === undefined ? null : (original.reportedSize ?? original.bytes.length),
      original_mime_type: document.mime_type ?? 'application/pdf',
      media_filename: `originals/${id}.pdf`,
      has_archive_version: original?.archiveBytes !== undefined,
      archive_checksum: original?.archiveBytes === undefined ? null : md5(original.archiveBytes),
      archive_media_filename: original?.archiveBytes === undefined ? null : `archive/${id}.pdf`,
      original_filename: document.original_file_name ?? null,
      archive_size: original?.archiveBytes?.length ?? null,
      lang: 'de',
    });
  }

  private download(response: ServerResponse, id: number, wantOriginal: boolean): void {
    const original = this.library.originals.get(id);
    if (original === undefined) {
      this.send(response, 404, JSON.stringify({ detail: 'Not found.' }), {
        'content-type': 'application/json',
      });
      return;
    }

    const bytes = wantOriginal ? original.bytes : (original.archiveBytes ?? original.bytes);
    const filename = original.filename ?? `${id}.pdf`;
    this.send(response, 200, bytes, {
      'content-type': original.contentType ?? 'application/pdf',
      'content-disposition': `attachment; filename="${filename.replaceAll('"', '')}"`,
    });
  }

  /* ---------------------------------------------------------------------------------------- */

  /** `AcceptHeaderVersioning`: `application/json; version=N`. Returns null for a refused version. */
  private negotiateVersion(accept: string | null): number | null {
    const allowed = this.options.allowedApiVersions ?? ['9', '10'];
    const fallback = this.options.defaultApiVersion ?? '10';

    const asked = accept === null ? null : /version\s*=\s*"?([\w.]+)"?/u.exec(accept)?.[1];
    const version = asked === undefined || asked === null ? fallback : asked;
    if (!allowed.includes(version)) return null;
    return Number(version);
  }

  private takeFault(url: string): FakeFault | undefined {
    for (const fault of this.faults) {
      if ((fault.times ?? 0) <= 0) continue;
      const matches =
        typeof fault.path === 'string' ? url.includes(fault.path) : fault.path.test(url);
      if (!matches) continue;
      fault.times = (fault.times ?? 1) - 1;
      return fault;
    }
    return undefined;
  }

  private json(response: ServerResponse, body: unknown): void {
    this.send(response, 200, JSON.stringify(body), { 'content-type': 'application/json' });
  }

  private send(
    response: ServerResponse,
    status: number,
    body: string | Buffer,
    headers: Record<string, string>,
  ): void {
    const all: Record<string, string> = { ...headers };
    if (this.options.suppressVersionHeaders !== true && status !== 401) {
      const allowed = this.options.allowedApiVersions ?? ['9', '10'];
      all['x-api-version'] = allowed[allowed.length - 1] as string;
      all['x-version'] = this.options.version ?? PAPERLESS_MODELLED_VERSION;
    }
    response.writeHead(status, all);
    response.end(body);
  }
}

/* ================================================================================================ */

const LIST_ROUTES: Readonly<Record<string, keyof FakeLibrary>> = {
  '/api/correspondents/': 'correspondents',
  '/api/document_types/': 'documentTypes',
  '/api/tags/': 'tags',
  '/api/storage_paths/': 'storagePaths',
  '/api/custom_fields/': 'customFields',
  '/api/documents/': 'documents',
};

const header = (request: IncomingMessage, name: string): string | null => {
  const value = request.headers[name];
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
};

const idOf = (row: unknown): number =>
  typeof row === 'object' && row !== null && typeof (row as { id?: unknown }).id === 'number'
    ? (row as { id: number }).id
    : 0;

const clampInt = (raw: string | null, fallback: number, low: number, high: number): number => {
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, low), high);
};

/** Paperless records an MD5 of the original; the fake computes the same thing. */
const md5 = (bytes: Buffer): string => createHash('md5').update(bytes).digest('hex');
