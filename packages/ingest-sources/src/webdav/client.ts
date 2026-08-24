/**
 * As much WebDAV as a feed needs, and no more.
 *
 * Six methods — `OPTIONS`, `PROPFIND`, `GET`, `MOVE`, `DELETE`, `MKCOL` — over `fetch`, with no
 * dependency, because the surface is small and because the parts that matter are the parts a
 * library would hide: which properties are asked for, what happens to an `href` that points
 * somewhere unexpected, and what an ETag is allowed to be trusted for.
 *
 * **An `href` is hostile until it has been checked.** A `PROPFIND` answer is a document from the
 * far side, and the `href` in it is a path chosen by the far side. A server — or something
 * pretending to be one — can answer a listing of `/dav/inbox` with an `href` of `/dav/../../etc`,
 * or of `http://elsewhere/`, and a client that resolves those and then fetches them has been walked
 * out of its own collection. Every `href` here is resolved against the collection URL and refused
 * unless it lands inside it, which is the same rule this codebase applies to archive members and
 * watched-folder symlinks.
 *
 * **An ETag identifies a version, not the bytes.** It is used as the `revision` half of the
 * `(path, etag, size)` key that decides whether something has been seen before, and for nothing
 * else. Identity is still the SHA-256 the pipeline computes (P2), so a server that recycles ETags
 * costs a re-ingest that stage 2 will recognise as a duplicate, never a wrong document.
 *
 * There is a WebDAV *storage backend* in `@recueil/storage-backends`, which is a different job:
 * that one writes blobs by digest into a store, this one reads a directory somebody shares with
 * you. They are kept apart deliberately — a bug in the feed must not be able to touch the store.
 */
import { SourceProtocolError, SourceUnavailableError, UnsafeSourcePathError } from '../errors.js';

export interface WebDavAuth {
  kind: 'basic' | 'bearer' | 'none';
  username?: string;
  password?: string;
  token?: string;
}

export interface WebDavClientOptions {
  /** The collection to poll, e.g. `https://cloud.example/remote.php/dav/files/rh/Inbox`. */
  url: string;
  auth?: WebDavAuth;
  /** Extra headers, for a deployment behind something that wants one. */
  headers?: Record<string, string>;
  /** Per-request timeout. Default 30 s. */
  timeoutMillis?: number;
  /** Injected in tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export interface WebDavEntry {
  /** Path relative to the collection, `/`-separated and percent-decoded. */
  path: string;
  isCollection: boolean;
  byteSize: number | null;
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
}

const DEFAULT_TIMEOUT = 30_000;

export class WebDavClient {
  /** The collection URL, always with a trailing slash so that relative resolution behaves. */
  readonly base: URL;
  private readonly config: WebDavClientOptions;
  private readonly doFetch: typeof fetch;

  constructor(options: WebDavClientOptions) {
    this.config = options;
    const url = new URL(options.url);
    if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
    this.base = url;
    this.doFetch = options.fetch ?? fetch;
  }

  /** `OPTIONS`, for the health report: is this a WebDAV endpoint, and does it allow what we need? */
  async options(signal?: AbortSignal): Promise<{ dav: string | null; allow: string[] }> {
    const response = await this.request('OPTIONS', '', { signal });
    await response.arrayBuffer();
    const allow = (response.headers.get('allow') ?? '')
      .split(',')
      .map((method) => method.trim().toUpperCase())
      .filter((method) => method.length > 0);
    return { dav: response.headers.get('dav'), allow };
  }

  /** `PROPFIND` with `Depth: 1`, or `infinity` where the server allows it. */
  async list(path: string, depth: '1' | 'infinity' = '1', signal?: AbortSignal): Promise<WebDavEntry[]> {
    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<d:propfind xmlns:d="DAV:"><d:prop>' +
      '<d:resourcetype/><d:getetag/><d:getcontentlength/><d:getlastmodified/><d:getcontenttype/>' +
      '</d:prop></d:propfind>';

    const response = await this.request('PROPFIND', path, {
      body,
      headers: { depth, 'content-type': 'application/xml; charset=utf-8' },
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status !== 207) {
      throw new SourceProtocolError(
        `PROPFIND '${path}' answered ${String(response.status)}; a WebDAV collection answers 207.`,
        { status: response.status },
      );
    }
    return this.parseMultistatus(await response.text(), path);
  }

  async get(
    path: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: Buffer; contentType: string | null; etag: string | null; lastModified: string | null }> {
    const response = await this.request('GET', path, { signal });
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      bytes,
      contentType: response.headers.get('content-type'),
      etag: normaliseEtag(response.headers.get('etag')),
      lastModified: response.headers.get('last-modified'),
    };
  }

  async delete(path: string, signal?: AbortSignal): Promise<'deleted' | 'absent'> {
    const response = await this.request('DELETE', path, { signal, allow: [204, 200, 404] });
    await response.arrayBuffer();
    return response.status === 404 ? 'absent' : 'deleted';
  }

  async move(
    from: string,
    to: string,
    signal?: AbortSignal,
  ): Promise<'moved' | 'absent'> {
    const response = await this.request('MOVE', from, {
      headers: { destination: this.urlFor(to).toString(), overwrite: 'F' },
      signal,
      allow: [201, 204, 404, 412],
    });
    await response.arrayBuffer();
    if (response.status === 404) return 'absent';
    if (response.status === 412) {
      throw new SourceProtocolError(
        `MOVE of '${from}' refused: something is already at '${to}'.`,
        { from, to },
      );
    }
    return 'moved';
  }

  /** Create a collection and every missing parent between it and the base. */
  async ensureCollection(path: string, signal?: AbortSignal): Promise<void> {
    const segments = path.split('/').filter((segment) => segment.length > 0);
    let walked = '';
    for (const segment of segments) {
      walked = walked === '' ? segment : `${walked}/${segment}`;
      const response = await this.request('MKCOL', walked, { signal, allow: [201, 405, 301] });
      await response.arrayBuffer();
    }
  }

  /** The absolute URL of a collection-relative path, with each segment encoded exactly once. */
  urlFor(path: string): URL {
    const relative = path
      .split('/')
      .filter((segment) => segment.length > 0)
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const url = new URL(this.base.toString());
    url.pathname = `${this.base.pathname}${relative}`;
    return url;
  }

  /* ---------------------------------------------------------------------------------------- */

  private async request(
    method: string,
    path: string,
    init: {
      body?: string;
      headers?: Record<string, string>;
      signal?: AbortSignal | undefined;
      allow?: number[];
    } = {},
  ): Promise<Response> {
    const url = this.urlFor(path);
    const headers: Record<string, string> = {
      ...(this.config.headers ?? {}),
      ...(init.headers ?? {}),
      ...this.authHeader(),
    };

    const timeout = AbortSignal.timeout(this.config.timeoutMillis ?? DEFAULT_TIMEOUT);
    const signal = init.signal === undefined ? timeout : AbortSignal.any([timeout, init.signal]);

    let response: Response;
    try {
      response = await this.doFetch(url, {
        method,
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        signal,
        redirect: 'manual',
      });
    } catch (error) {
      throw new SourceUnavailableError(
        `${method} ${url.toString()} failed: ${error instanceof Error ? error.message : String(error)}`,
        { method, url: url.toString() },
      );
    }

    const allowed = init.allow ?? [200, 201, 204, 207];
    if (allowed.includes(response.status)) return response;

    if (response.status === 401 || response.status === 403) {
      await response.arrayBuffer().catch(() => undefined);
      throw new SourceUnavailableError(
        `${method} ${url.toString()} was refused with ${String(response.status)}: check the credentials.`,
        { status: response.status },
      );
    }
    const text = await response.text().catch(() => '');
    throw new SourceProtocolError(
      `${method} ${url.toString()} answered ${String(response.status)}${text === '' ? '' : `: ${text.slice(0, 200)}`}`,
      { status: response.status },
    );
  }

  private authHeader(): Record<string, string> {
    const auth = this.config.auth;
    if (auth === undefined || auth.kind === 'none') return {};
    if (auth.kind === 'bearer') return { authorization: `Bearer ${auth.token ?? ''}` };
    const pair = `${auth.username ?? ''}:${auth.password ?? ''}`;
    return { authorization: `Basic ${Buffer.from(pair, 'utf8').toString('base64')}` };
  }

  /**
   * Turn a `multistatus` document into entries, refusing any `href` that is not inside the
   * collection this client was pointed at.
   */
  private parseMultistatus(xml: string, requestedPath: string): WebDavEntry[] {
    const entries: WebDavEntry[] = [];
    const requested = this.urlFor(requestedPath).pathname.replace(/\/+$/u, '');

    for (const block of blocks(xml, 'response')) {
      const rawHref = text(block, 'href');
      if (rawHref === null) continue;

      let href: URL;
      try {
        href = new URL(decodeEntities(rawHref), this.base);
      } catch {
        throw new SourceProtocolError(`The listing contained an unparseable href: '${rawHref}'.`);
      }
      if (href.origin !== this.base.origin) {
        throw new UnsafeSourcePathError(
          `The listing named '${href.toString()}', which is on another host than the collection.`,
          { href: href.toString(), base: this.base.toString() },
        );
      }

      const pathname = href.pathname.replace(/\/+$/u, '');
      const basePath = this.base.pathname.replace(/\/+$/u, '');
      if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
        throw new UnsafeSourcePathError(
          `The listing named '${href.pathname}', which is outside the collection '${this.base.pathname}'.`,
          { href: href.pathname, base: this.base.pathname },
        );
      }
      // The collection itself is in its own listing; it is not an entry.
      if (pathname === requested) continue;

      // Decoded segment by segment, never as a whole: a `%2F` inside one segment is a slash the
      // server chose to hide, and decoding the joined string would turn it into a separator.
      const relative = pathname
        .slice(basePath.length + 1)
        .split('/')
        .map((segment) => decodeURIComponent(segment))
        .join('/');
      if (relative.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) {
        throw new UnsafeSourcePathError(
          `The listing named '${relative}', which walks out of the collection.`,
          { relative },
        );
      }

      const propstats = [...blocks(block, 'propstat')].filter((propstat) => {
        const status = text(propstat, 'status');
        return status === null || /\b200\b/u.test(status);
      });
      const properties = propstats.length > 0 ? propstats.join('') : block;

      const length = text(properties, 'getcontentlength');
      entries.push({
        path: relative,
        isCollection: /<(?:[A-Za-z0-9_.-]+:)?collection\s*\/?>/iu.test(
          text(properties, 'resourcetype') ?? '',
        ),
        byteSize: length === null || length.trim() === '' ? null : Number.parseInt(length.trim(), 10),
        etag: normaliseEtag(text(properties, 'getetag')),
        lastModified: text(properties, 'getlastmodified'),
        contentType: text(properties, 'getcontenttype'),
      });
    }

    return entries;
  }
}

/** `"abc"` and `W/"abc"` are the same version; the quotes and the weak marker are not identity. */
export const normaliseEtag = (value: string | null): string | null => {
  if (value === null) return null;
  const trimmed = decodeEntities(value).trim().replace(/^W\//iu, '');
  const unquoted = trimmed.replace(/^"(.*)"$/u, '$1');
  return unquoted === '' ? null : unquoted;
};

/* --------------------------------------------------------------------------------------------- */
/* A very small XML reader                                                                         */
/*                                                                                                 */
/* Namespace prefixes vary by server — `d:`, `D:`, `lp1:`, none at all — so everything matches on   */
/* the local name. This is not a general XML parser and does not pretend to be one: it reads the    */
/* shape RFC 4918 §14.16 defines, and anything it cannot read becomes a protocol error rather than  */
/* a silently empty listing.                                                                        */
/* --------------------------------------------------------------------------------------------- */

const localName = (name: string): string => `(?:[A-Za-z0-9_.-]+:)?${name}`;

function* blocks(xml: string, name: string): Generator<string> {
  const pattern = new RegExp(`<${localName(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${localName(name)}>`, 'giu');
  for (const match of xml.matchAll(pattern)) yield match[1] ?? '';
}

const text = (xml: string, name: string): string | null => {
  const pattern = new RegExp(
    `<${localName(name)}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${localName(name)}>)`,
    'iu',
  );
  const match = pattern.exec(xml);
  if (match === null) return null;
  return match[1] ?? '';
};

const decodeEntities = (value: string): string =>
  value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/giu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/gu, '&');
