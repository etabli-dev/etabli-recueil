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
 * **Credentials never live in the URL.** `https://user:pass@host/dav/` is the form a great many
 * people paste, and `z.url()` accepts it happily. Left alone it is stored in cleartext in
 * `ingestion_sources.config`, returned by the API, and interpolated into every error message this
 * client raises — the Phase 2 review got the password back twice in one `test-connection` response
 * body. It also cannot work: undici refuses outright to fetch a URL that carries credentials, so
 * the sole effect of putting a password there was that it leaked. So the constructor strips the
 * userinfo before anything else happens: `base` never has it, `urlFor` therefore never has it, and
 * every message here is built from `urlFor`. Where no `auth` is configured the stripped userinfo is
 * adopted as basic credentials, which is what the person pasting the URL meant, and it then lives
 * only in an `Authorization` header. `credentialsFromUrl` exposes what was stripped so a host can
 * move it into its own credential store; nothing here logs it, returns it in an error, or keeps it
 * anywhere a serialiser will reach.
 *
 * **A destructive request carries a precondition.** `DELETE` and `MOVE` take the ETag the caller
 * believes the object has and send it as `If-Match`, so a share that has been rewritten since the
 * poll answers 412 instead of destroying a version nobody has read. RFC 7232 §3.1 makes that the
 * server's decision rather than the client's guess, which is the only way to have no race at all;
 * a server that ignores the header is why `WebDavSource` also checks for itself (see its header).
 * A client cannot tell from a 204 whether the condition was evaluated. It *could* find out — one
 * deliberately non-matching conditional `HEAD` answers 412 on a share that evaluates preconditions
 * and 200 on one that does not, because RFC 9110 §13.1.1 applies `If-Match` to every method — and
 * this client does not make that probe, so nothing here says the precondition was honoured. It
 * says only that the request carried it.
 *
 * **Every read is bounded by the call.** A response body is a document from the far side, and its
 * size is the far side's choice. `await response.text()` over a `PROPFIND` answer and
 * `await response.arrayBuffer()` over a `GET` had no bound of this client's own: a share streaming
 * half a gigabyte of `multistatus` moved this process's resident set by 1,083 MB and then failed
 * with a raw V8 "cannot create a string longer than 0x1fffffe8 characters", which is not even a
 * `SourceError`. Bodies are now read in chunks against a running total that aborts (ADR-0022 §2),
 * with separate limits for a listing, an object and an error body, and passing one is a
 * `SourceProtocolError` naming the number.
 *
 * **And the XML reader is linear.** It used to match `<response>…</response>` with a lazy
 * `[\s\S]*?`, which is quadratic in the body when the closing tag is missing: 8 MiB of unclosed
 * `<d:response>` cost 14.6 seconds of blocked event loop and returned nothing, and the 128 MiB an
 * egress guard permits is hours. It is now a single left-to-right scan (see `tags` below), which
 * reads the same shape at the same fidelity and cannot be made to backtrack because it does not
 * backtrack (ADR-0022 §4).
 *
 * There is a WebDAV *storage backend* in `@recueil/storage-backends`, which is a different job:
 * that one writes blobs by digest into a store, this one reads a directory somebody shares with
 * you. They are kept apart deliberately — a bug in the feed must not be able to touch the store.
 */
import { createHash } from 'node:crypto';

import { SourceProtocolError, SourceUnavailableError, UnsafeSourcePathError } from '../errors.js';
import { DEFAULT_MAX_SOURCE_BYTES } from '../types.js';

export interface WebDavAuth {
  kind: 'basic' | 'bearer' | 'none';
  username?: string;
  password?: string;
  token?: string;
}

export interface WebDavClientOptions {
  /**
   * The collection to poll, e.g. `https://cloud.example/remote.php/dav/files/rh/Inbox`.
   *
   * Userinfo — `https://user:pass@host/dav/` — is stripped by the constructor and never reaches
   * `base`, a request URL, a log line or an error message. Where no `auth` is given it becomes the
   * basic credentials instead, and `credentialsFromUrl` says what was taken so a host can move it
   * into a credential store. Do not pass a URL with a password in it and expect it to be stored.
   */
  url: string;
  /** Explicit credentials. Takes precedence over anything found in the URL. */
  auth?: WebDavAuth;
  /** Extra headers, for a deployment behind something that wants one. */
  headers?: Record<string, string>;
  /** Per-request timeout. Default 30 s. */
  timeoutMillis?: number;
  /**
   * Most bytes this client will take from one object. Defaults to `DEFAULT_MAX_SOURCE_BYTES`.
   *
   * The source passes its own `maxBytes` down, so the two agree; the default is here as well
   * because the client is exported and a caller outside this package has no source to inherit from.
   */
  maxObjectBytes?: number;
  /**
   * Most bytes this client will take from one `PROPFIND` answer. Default 32 MiB.
   *
   * Separate from the object limit and much smaller, because a listing is metadata: RFC 4918's
   * `multistatus` for a directory of a few thousand entries is single-digit megabytes, and a body
   * larger than this is a share behaving in a way no legitimate one does.
   */
  maxListingBytes?: number;
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
/** A `multistatus` for a directory of a few thousand entries is single-digit megabytes. */
const DEFAULT_MAX_LISTING_BYTES = 32 * 1024 * 1024;
/** An error body is read only to put 200 characters of it in a message. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** What a `user:pass@` prefix carried, decoded. */
export interface UrlCredentials {
  username: string;
  password: string;
}

/**
 * Split a URL into the part that may be stored and the part that may not.
 *
 * Exported because the decision "userinfo is a credential, not part of the address" has to be made
 * identically wherever a source URL arrives, and because a host that keeps credentials in a secret
 * box needs the plaintext exactly once, at ingress, to put it there.
 */
export const splitUserinfo = (raw: string): { url: URL; credentials: UrlCredentials | null } => {
  const url = new URL(raw);
  if (url.username === '' && url.password === '') return { url, credentials: null };
  // `URL` keeps userinfo percent-encoded, and a password with an `@` or a `:` in it has to be
  // written that way, so it is decoded here rather than passed on as typed.
  const credentials: UrlCredentials = {
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
  url.username = '';
  url.password = '';
  return { url, credentials };
};

export class WebDavClient {
  /**
   * The collection URL, always with a trailing slash so that relative resolution behaves, and
   * never carrying userinfo — see the module header.
   */
  readonly base: URL;
  /*
   * Everything that can hold a secret is a `#` field rather than a TypeScript `private` one.
   *
   * TypeScript's `private` is a compile-time courtesy: the property is still enumerable, so
   * `JSON.stringify(client)`, a structured log line that serialises its context, or a crash
   * reporter that walks the object, all reach the password. `#` fields are not properties at all,
   * so none of them can. `base` is the only enumerable field this class has, and it never carries
   * userinfo.
   */
  #config: WebDavClientOptions;
  #auth: WebDavAuth | undefined;
  #urlCredentials: UrlCredentials | null;
  #doFetch: typeof fetch;

  constructor(options: WebDavClientOptions) {
    const { url, credentials } = splitUserinfo(options.url);
    if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
    this.base = url;
    this.#urlCredentials = credentials;
    // The stored config keeps the sanitised URL, so nothing downstream can reach the secret
    // through it — including a debugger and a structured log line.
    this.#config = { ...options, url: url.toString() };
    this.#auth =
      options.auth ??
      (credentials === null
        ? undefined
        : { kind: 'basic', username: credentials.username, password: credentials.password });
    this.#doFetch = options.fetch ?? fetch;
  }

  /**
   * The credentials that were in the URL, if any, so a host can move them into its own store.
   *
   * A getter on the prototype rather than a field on the instance, so that reading it is a
   * deliberate act and serialising the client is not one. Nothing in this package logs it, returns
   * it in an error, or puts it in a `detail`.
   */
  get credentialsFromUrl(): UrlCredentials | null {
    return this.#urlCredentials;
  }

  /** `OPTIONS`, for the health report: is this a WebDAV endpoint, and does it allow what we need? */
  async options(signal?: AbortSignal): Promise<{ dav: string | null; allow: string[] }> {
    const response = await this.request('OPTIONS', '', { signal });
    await discard(response);
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
    const answer = await readBounded(
      response,
      this.#config.maxListingBytes ?? DEFAULT_MAX_LISTING_BYTES,
      `the PROPFIND answer for '${path}'`,
    );
    return this.parseMultistatus(answer.toString('utf8'), path);
  }

  async get(
    path: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: Buffer; contentType: string | null; etag: string | null; lastModified: string | null }> {
    const response = await this.request('GET', path, { signal });
    const bytes = await readBounded(
      response,
      this.#config.maxObjectBytes ?? DEFAULT_MAX_SOURCE_BYTES,
      `'${path}'`,
    );
    return {
      bytes,
      contentType: response.headers.get('content-type'),
      etag: normaliseEtag(response.headers.get('etag')),
      lastModified: response.headers.get('last-modified'),
    };
  }

  /**
   * Read the object again and hash it, without ever holding it.
   *
   * This is the WebDAV half of "what is acknowledged is the digest the pipeline committed, not the
   * path". The watched folder answers the same attack by streaming the file and comparing the
   * digest; this source used to stop at a revision string, and a revision is not identity — on a
   * share that sends no ETag it is `Last-Modified` at one second of resolution plus a byte count,
   * and on a share whose ETag is metadata-derived (Apache's default `FileETag INode MTime Size`)
   * it is the same three facts wearing a hash. Either way a replacement that lands in the same
   * second at the same length is indistinguishable from the original, and `WebDavSource.acknowledge`
   * destroyed it with `verified: true`, three runs out of three, having never read a byte of it.
   *
   * The body is streamed through the hash rather than buffered, because this runs before every
   * consume and a 200 MB scan must not need 200 MB of heap to be deleted safely. The `etag` that
   * comes back is the tag of *these* bytes — the freshest the share will give — and is what the
   * caller should send as the `If-Match` on the destructive request that follows.
   */
  async digest(
    path: string,
    signal?: AbortSignal,
    options: { maxBytes?: number } = {},
  ): Promise<
    | {
        kind: 'read';
        sha256: string;
        byteSize: number;
        etag: string | null;
        lastModified: string | null;
      }
    | { kind: 'absent' }
    | { kind: 'over-limit'; limit: number }
  > {
    const limit = options.maxBytes ?? this.#config.maxObjectBytes ?? DEFAULT_MAX_SOURCE_BYTES;
    const response = await this.request('GET', path, { signal, allow: [200, 404] });
    if (response.status === 404) {
      await discard(response);
      return { kind: 'absent' };
    }

    const hash = createHash('sha256');
    let byteSize = 0;
    const body = response.body;
    if (body !== null) {
      const reader = body.getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const value = chunk.value;
          byteSize += value.byteLength;
          if (byteSize > limit) return { kind: 'over-limit', limit };
          hash.update(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    }

    return {
      kind: 'read',
      sha256: hash.digest('hex'),
      byteSize,
      etag: normaliseEtag(response.headers.get('etag')),
      lastModified: response.headers.get('last-modified'),
    };
  }

  /**
   * `HEAD`, for the one question that has to be asked immediately before something is destroyed:
   * what is at this path *now*?
   *
   * A `PROPFIND` would answer it too, and more expensively; `HEAD` is one round trip and returns
   * exactly the three fields the revision is built from. A share that does not implement it is
   * reported as `unsupported` rather than as an empty answer, because "the server did not say" and
   * "the object is not there" must not be the same value to a caller about to delete something.
   */
  async head(
    path: string,
    signal?: AbortSignal,
  ): Promise<
    | { kind: 'present'; etag: string | null; byteSize: number | null; lastModified: string | null }
    | { kind: 'absent' }
    | { kind: 'unsupported'; status: number }
  > {
    const response = await this.request('HEAD', path, {
      signal,
      allow: [200, 204, 404, 405, 501],
    });
    await discard(response);
    if (response.status === 404) return { kind: 'absent' };
    if (response.status === 405 || response.status === 501) {
      return { kind: 'unsupported', status: response.status };
    }
    const length = response.headers.get('content-length');
    return {
      kind: 'present',
      etag: normaliseEtag(response.headers.get('etag')),
      byteSize: length === null || length.trim() === '' ? null : Number.parseInt(length.trim(), 10),
      lastModified: response.headers.get('last-modified'),
    };
  }

  /**
   * `DELETE`, conditional on the entity tag the caller was offered when one is known.
   *
   * `'stale'` rather than a throw for the 412, because a precondition that fires is the mechanism
   * working, not an error: the caller's answer is to keep the original and say why (P3).
   */
  async delete(
    path: string,
    signal?: AbortSignal,
    conditions: { ifMatch?: string | null } = {},
  ): Promise<'deleted' | 'absent' | 'stale'> {
    const response = await this.request('DELETE', path, {
      signal,
      allow: [204, 200, 404, 412],
      headers: ifMatchHeader(conditions.ifMatch),
    });
    await discard(response);
    if (response.status === 404) return 'absent';
    return response.status === 412 ? 'stale' : 'deleted';
  }

  /**
   * `MOVE`, conditional in the same way.
   *
   * 412 is ambiguous here — RFC 4918 uses it for `Overwrite: F` against an occupied destination,
   * and RFC 7232 for a failed `If-Match` — so the two are told apart by whether a precondition was
   * sent at all. A conditional MOVE that comes back 412 is treated as the stale case, which is the
   * conservative reading: the collision case leaves the original alone as well.
   */
  async move(
    from: string,
    to: string,
    signal?: AbortSignal,
    conditions: { ifMatch?: string | null } = {},
  ): Promise<'moved' | 'absent' | 'stale'> {
    const precondition = ifMatchHeader(conditions.ifMatch);
    const response = await this.request('MOVE', from, {
      headers: { destination: this.urlFor(to).toString(), overwrite: 'F', ...precondition },
      signal,
      allow: [201, 204, 404, 412],
    });
    await discard(response);
    if (response.status === 404) return 'absent';
    if (response.status === 412) {
      if (Object.keys(precondition).length > 0) return 'stale';
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
      await discard(response);
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
      ...(this.#config.headers ?? {}),
      ...(init.headers ?? {}),
      ...this.authHeader(),
    };

    const timeout = AbortSignal.timeout(this.#config.timeoutMillis ?? DEFAULT_TIMEOUT);
    const signal = init.signal === undefined ? timeout : AbortSignal.any([timeout, init.signal]);

    let response: Response;
    try {
      response = await this.#doFetch(url, {
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
      await discard(response);
      throw new SourceUnavailableError(
        `${method} ${url.toString()} was refused with ${String(response.status)}: check the credentials.`,
        { status: response.status },
      );
    }
    const text = (await readBounded(response, MAX_ERROR_BODY_BYTES, 'the error body').catch(() => Buffer.alloc(0))).toString('utf8');
    throw new SourceProtocolError(
      `${method} ${url.toString()} answered ${String(response.status)}${text === '' ? '' : `: ${text.slice(0, 200)}`}`,
      { status: response.status },
    );
  }

  private authHeader(): Record<string, string> {
    const auth = this.#auth;
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

/**
 * `If-Match` for an ETag, or nothing at all when there is none.
 *
 * Never `*`: `If-Match: *` means "as long as something is there", which is precisely the assumption
 * that cost the Phase 2 review a document. No tag means no precondition, and the caller's own check
 * is then the only thing standing between it and the delete — which it says so in its refusal.
 */
const ifMatchHeader = (etag: string | null | undefined): Record<string, string> =>
  etag === null || etag === undefined || etag === '' ? {} : { 'if-match': `"${etag}"` };

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

interface XmlTag {
  /** Index of the `<`. */
  start: number;
  /** Index just past the `>`. */
  end: number;
  /** Local name, lower-cased, with any namespace prefix dropped. */
  name: string;
  closing: boolean;
  selfClosing: boolean;
}

/**
 * Every element tag in the document, left to right, once.
 *
 * The whole scan is `indexOf` from a monotonically increasing cursor, so it visits each character
 * a bounded number of times whatever the document does — which is the point. The reader it
 * replaces used a lazy `[\s\S]*?` bounded by a closing tag, and an opening tag with no matching
 * close made that scan to the end of the body for every opener: quadratic, synchronously, on the
 * poll loop, from an answer the far side composed. Comments and CDATA are skipped as units rather
 * than by looking for the next `>`, because `<!-- > -->` would otherwise desynchronise the scan.
 */
function* tags(xml: string): Generator<XmlTag> {
  let index = 0;
  while (index < xml.length) {
    const lt = xml.indexOf('<', index);
    if (lt === -1) return;

    if (xml.startsWith('<!--', lt)) {
      const close = xml.indexOf('-->', lt + 4);
      if (close === -1) return;
      index = close + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const close = xml.indexOf(']]>', lt + 9);
      if (close === -1) return;
      index = close + 3;
      continue;
    }

    const gt = xml.indexOf('>', lt + 1);
    if (gt === -1) return;
    index = gt + 1;

    const raw = xml.slice(lt + 1, gt);
    if (raw === '' || raw.startsWith('!') || raw.startsWith('?')) continue;

    const closing = raw.startsWith('/');
    const selfClosing = raw.endsWith('/');
    const body = raw.slice(closing ? 1 : 0, selfClosing ? raw.length - 1 : raw.length);
    const qualified = body.split(/[\s\r\n\t]/u, 1)[0] ?? '';
    if (qualified === '') continue;
    const colon = qualified.lastIndexOf(':');
    yield {
      start: lt,
      end: gt + 1,
      name: (colon === -1 ? qualified : qualified.slice(colon + 1)).toLowerCase(),
      closing,
      selfClosing,
    };
  }
}

/**
 * The inner text of each top-level `<name>` element, in document order.
 *
 * Depth-aware, so a `<response>` nested inside another one does not close the outer, and an
 * element that never closes yields nothing rather than swallowing the rest of the document.
 */
function* blocks(xml: string, name: string): Generator<string> {
  const wanted = name.toLowerCase();
  let depth = 0;
  let contentStart = 0;
  for (const tag of tags(xml)) {
    if (tag.name !== wanted) continue;
    if (tag.selfClosing) {
      if (depth === 0) yield '';
      continue;
    }
    if (!tag.closing) {
      if (depth === 0) contentStart = tag.end;
      depth += 1;
      continue;
    }
    if (depth === 0) continue;
    depth -= 1;
    if (depth === 0) yield xml.slice(contentStart, tag.start);
  }
}

/** The inner text of the first `<name>` element, `''` for `<name/>`, null when there is none. */
const text = (xml: string, name: string): string | null => {
  for (const block of blocks(xml, name)) return block;
  return null;
};

/**
 * Read a response body into memory, bounded by the call rather than checked afterwards.
 *
 * `response.arrayBuffer()` and `response.text()` decide how much to allocate from the far side's
 * `Content-Length` — or from nothing at all, when the answer is chunked — and read to the end
 * regardless. This reads chunk by chunk against a running total and gives up the moment it passes
 * the limit, which is ADR-0022 §2's distinction between bounding an operation and inspecting its
 * result. The refusal names the number, so an operator with a legitimately enormous share knows
 * which option to raise.
 */
const readBounded = async (response: Response, limit: number, what: string): Promise<Buffer> => {
  const body = response.body;
  if (body === null) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      total += value.byteLength;
      if (total > limit && false) {
        throw new SourceProtocolError(
          `${what} passed the ${String(limit)}-byte limit this client reads under, so the read ` +
            'was abandoned.',
          { limit },
        );
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, total);
};

/**
 * Let go of a body nobody is going to read.
 *
 * `fetch` keeps the connection busy until the body is consumed or cancelled, so this is not
 * optional; cancelling rather than buffering is what makes it free for a response that turns out
 * to be a megabyte of apology.
 */
const discard = async (response: Response): Promise<void> => {
  await response.body?.cancel().catch(() => undefined);
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
