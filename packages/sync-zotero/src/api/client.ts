/**
 * A client for the Zotero Web API v3 — the subset the sync needs, and nothing that it does not.
 *
 * Four properties are deliberate:
 *
 * - **The key goes to one origin only.** It is sent as `Zotero-API-Key` to the configured base URL.
 *   A file download is a redirect to Zotero's file storage; redirects are followed by hand, without
 *   the key, so the key never reaches a second host (ADR-0025 §9). The key is never logged and is
 *   kept out of every error message.
 * - **The server's pacing is obeyed.** `Backoff` delays the next request; `429` and `503` with
 *   `Retry-After` are waited out and retried a bounded number of times.
 * - **Every write is conditional.** Object writes carry each object's last known version (Zotero
 *   answers `412` per object for a stale one), deletions carry `If-Unmodified-Since-Version`, and
 *   every write batch carries a `Zotero-Write-Token`, so a retried request cannot create twice.
 * - **`fetch` is injected.** The test suite runs the whole client against an in-process fake.
 */
import { randomBytes } from 'node:crypto';

import type {
  ZoteroCollectionData,
  ZoteroDeleted,
  ZoteroGlobalSchemaJson,
  ZoteroGroup,
  ZoteroItemData,
  ZoteroKeyInfo,
  ZoteroLibraryRef,
  ZoteroObject,
  ZoteroWriteResponse,
  Versioned,
} from './types.js';

export const ZOTERO_API_BASE = 'https://api.zotero.org';
/** The Zotero API limit for one write request. */
export const ZOTERO_WRITE_BATCH = 50;
const PAGE_SIZE = 100;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ZoteroApiClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Waiting is injected so tests do not sleep. Defaults to a real timer. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** How often a `429`/`503` is retried before the error is raised. */
  maxRetries?: number;
  userAgent?: string;
}

export class ZoteroApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(`Zotero API ${status} on ${path}: ${message}`);
    this.name = 'ZoteroApiError';
  }
}

/** The library changed on zotero.org since the version a write was based on. */
export class ZoteroPreconditionError extends ZoteroApiError {
  constructor(path: string) {
    super(412, path, 'the library changed on zotero.org since the last pull');
    this.name = 'ZoteroPreconditionError';
  }
}

export const libraryPrefix = (library: ZoteroLibraryRef): string =>
  `/${library.type === 'user' ? 'users' : 'groups'}/${library.id}`;

const writeToken = (): string => randomBytes(16).toString('hex');

export class ZoteroApiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly userAgent: string;
  /** Epoch milliseconds before which no request is sent, from the last `Backoff`. */
  private notBefore = 0;

  constructor(options: ZoteroApiClientOptions) {
    if (options.apiKey.trim() === '') throw new Error('a Zotero API key is required');
    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl ?? ZOTERO_API_BASE).replace(/\/+$/u, '');
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep =
      options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.maxRetries = options.maxRetries ?? 5;
    this.userAgent = options.userAgent ?? 'Recueil-sync-zotero';
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Transport                                                                                  */
  /* ---------------------------------------------------------------------------------------- */

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Zotero-API-Key', this.apiKey);
    headers.set('Zotero-API-Version', '3');
    headers.set('User-Agent', this.userAgent);

    for (let attempt = 0; ; attempt += 1) {
      const wait = this.notBefore - Date.now();
      if (wait > 0) await this.sleep(wait);

      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        redirect: 'manual',
      });

      const backoff = secondsHeader(response.headers.get('Backoff'));
      if (backoff !== null) this.notBefore = Math.max(this.notBefore, Date.now() + backoff * 1000);

      if ((response.status === 429 || response.status === 503) && attempt < this.maxRetries) {
        const retryAfter = secondsHeader(response.headers.get('Retry-After')) ?? 2 ** attempt;
        await response.body?.cancel();
        await this.sleep(retryAfter * 1000);
        continue;
      }
      return response;
    }
  }

  private async fail(response: Response, path: string): Promise<never> {
    const text = (await response.text().catch(() => '')).slice(0, 500);
    if (response.status === 412) throw new ZoteroPreconditionError(path);
    throw new ZoteroApiError(response.status, path, text === '' ? response.statusText : text);
  }

  private async getJson<T>(path: string, init: RequestInit = {}): Promise<{ value: T; response: Response }> {
    const response = await this.request(path, init);
    if (!response.ok) await this.fail(response, path);
    return { value: (await response.json()) as T, response };
  }

  /** Every page of a multi-object read, and the library version the first page reported. */
  private async getAll<T>(path: string): Promise<Versioned<T[]>> {
    const all: T[] = [];
    let libraryVersion: number | null = null;
    for (let start = 0; ; start += PAGE_SIZE) {
      const separator = path.includes('?') ? '&' : '?';
      const pagePath = `${path}${separator}limit=${PAGE_SIZE}&start=${start}`;
      const { value, response } = await this.getJson<T[]>(pagePath);
      const version = versionHeader(response);
      if (libraryVersion === null) libraryVersion = version;
      else if (version !== libraryVersion) {
        // The library moved between two pages. Starting again is the only consistent read.
        return this.getAll(path);
      }
      all.push(...value);
      const total = Number.parseInt(response.headers.get('Total-Results') ?? '', 10);
      if (value.length < PAGE_SIZE || (Number.isFinite(total) && all.length >= total)) break;
    }
    return { value: all, libraryVersion: libraryVersion ?? 0 };
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Account                                                                                    */
  /* ---------------------------------------------------------------------------------------- */

  async keyInfo(): Promise<ZoteroKeyInfo> {
    return (await this.getJson<ZoteroKeyInfo>('/keys/current')).value;
  }

  async groups(userId: number): Promise<ZoteroGroup[]> {
    return (await this.getAll<ZoteroGroup>(`/users/${userId}/groups`)).value;
  }

  async schema(): Promise<ZoteroGlobalSchemaJson> {
    return (await this.getJson<ZoteroGlobalSchemaJson>('/schema')).value;
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Reads                                                                                      */
  /* ---------------------------------------------------------------------------------------- */

  /** The library's current version, without reading any object. */
  async libraryVersion(library: ZoteroLibraryRef): Promise<number> {
    const path = `${libraryPrefix(library)}/items?limit=1&format=versions`;
    const { response } = await this.getJson<Record<string, number>>(path);
    return versionHeader(response);
  }

  async collectionsSince(
    library: ZoteroLibraryRef,
    since: number,
  ): Promise<Versioned<ZoteroObject<ZoteroCollectionData>[]>> {
    return this.getAll(`${libraryPrefix(library)}/collections?since=${since}&format=json`);
  }

  /** Every item, note and attachment changed since `since`, including those in the trash. */
  async itemsSince(
    library: ZoteroLibraryRef,
    since: number,
  ): Promise<Versioned<ZoteroObject<ZoteroItemData>[]>> {
    return this.getAll(`${libraryPrefix(library)}/items?since=${since}&includeTrashed=1&format=json`);
  }

  async items(library: ZoteroLibraryRef, keys: readonly string[]): Promise<ZoteroObject<ZoteroItemData>[]> {
    const out: ZoteroObject<ZoteroItemData>[] = [];
    for (let index = 0; index < keys.length; index += ZOTERO_WRITE_BATCH) {
      const chunk = keys.slice(index, index + ZOTERO_WRITE_BATCH).join(',');
      const page = await this.getAll<ZoteroObject<ZoteroItemData>>(
        `${libraryPrefix(library)}/items?itemKey=${chunk}&includeTrashed=1&format=json`,
      );
      out.push(...page.value);
    }
    return out;
  }

  async deletedSince(library: ZoteroLibraryRef, since: number): Promise<Versioned<ZoteroDeleted>> {
    const { value, response } = await this.getJson<Partial<ZoteroDeleted>>(
      `${libraryPrefix(library)}/deleted?since=${since}`,
    );
    return {
      value: {
        collections: value.collections ?? [],
        items: value.items ?? [],
        searches: value.searches ?? [],
        tags: value.tags ?? [],
      },
      libraryVersion: versionHeader(response),
    };
  }

  /**
   * Download an attachment's file. Zotero answers with a redirect to its file storage, which is
   * followed here without the API key.
   */
  async downloadFile(library: ZoteroLibraryRef, key: string): Promise<Uint8Array | null> {
    const path = `${libraryPrefix(library)}/items/${key}/file`;
    const response = await this.request(path);
    if (response.status === 404) return null;
    let final = response;
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('Location');
      await response.body?.cancel();
      if (location === null) throw new ZoteroApiError(response.status, path, 'redirect without a Location');
      final = await this.fetchImpl(new URL(location, this.baseUrl).toString(), {
        headers: { 'User-Agent': this.userAgent },
      });
    }
    if (final.status === 404) return null;
    if (!final.ok) await this.fail(final, path);
    return new Uint8Array(await final.arrayBuffer());
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Writes                                                                                     */
  /* ---------------------------------------------------------------------------------------- */

  private async writeObjects<Data>(
    path: string,
    objects: readonly Record<string, unknown>[],
  ): Promise<{ response: ZoteroWriteResponse<Data>; libraryVersion: number }> {
    if (objects.length > ZOTERO_WRITE_BATCH) throw new Error(`at most ${ZOTERO_WRITE_BATCH} objects per write`);
    const response = await this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Zotero-Write-Token': writeToken() },
      body: JSON.stringify(objects),
    });
    if (!response.ok) await this.fail(response, path);
    const body = (await response.json()) as Partial<ZoteroWriteResponse<Data>>;
    return {
      response: {
        successful: body.successful ?? {},
        success: body.success ?? {},
        unchanged: body.unchanged ?? {},
        failed: body.failed ?? {},
      },
      libraryVersion: versionHeader(response),
    };
  }

  /** Create or update up to 50 items. An object with `version` is refused per object if stale. */
  writeItems(library: ZoteroLibraryRef, objects: readonly Record<string, unknown>[]) {
    return this.writeObjects<ZoteroItemData>(`${libraryPrefix(library)}/items`, objects);
  }

  writeCollections(library: ZoteroLibraryRef, objects: readonly Record<string, unknown>[]) {
    return this.writeObjects<ZoteroCollectionData>(`${libraryPrefix(library)}/collections`, objects);
  }

  private async deleteObjects(
    library: ZoteroLibraryRef,
    kind: 'items' | 'collections',
    keys: readonly string[],
    libraryVersion: number,
  ): Promise<number> {
    let version = libraryVersion;
    const parameter = kind === 'items' ? 'itemKey' : 'collectionKey';
    for (let index = 0; index < keys.length; index += ZOTERO_WRITE_BATCH) {
      const chunk = keys.slice(index, index + ZOTERO_WRITE_BATCH).join(',');
      const path = `${libraryPrefix(library)}/${kind}?${parameter}=${chunk}`;
      const response = await this.request(path, {
        method: 'DELETE',
        headers: { 'If-Unmodified-Since-Version': String(version) },
      });
      if (response.status !== 204) await this.fail(response, path);
      version = versionHeader(response);
    }
    return version;
  }

  deleteItems(library: ZoteroLibraryRef, keys: readonly string[], libraryVersion: number) {
    return this.deleteObjects(library, 'items', keys, libraryVersion);
  }

  deleteCollections(library: ZoteroLibraryRef, keys: readonly string[], libraryVersion: number) {
    return this.deleteObjects(library, 'collections', keys, libraryVersion);
  }

  /**
   * Upload an attachment's file: authorise, upload to the storage URL Zotero names, register.
   *
   * `previousMd5` is the MD5 of the file Zotero holds now, or null for an attachment that has none;
   * it becomes `If-Match` or `If-None-Match: *`, so an upload never replaces a file someone else
   * changed in the meantime. Returns `exists` when Zotero already has these bytes.
   */
  async uploadFile(
    library: ZoteroLibraryRef,
    key: string,
    file: { bytes: Uint8Array; md5: string; filename: string; mtime: number },
    previousMd5: string | null,
  ): Promise<'uploaded' | 'exists'> {
    const path = `${libraryPrefix(library)}/items/${key}/file`;
    const condition: Record<string, string> =
      previousMd5 === null ? { 'If-None-Match': '*' } : { 'If-Match': previousMd5 };

    const authorise = await this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...condition },
      body: new URLSearchParams({
        md5: file.md5,
        filename: file.filename,
        filesize: String(file.bytes.byteLength),
        mtime: String(file.mtime),
      }).toString(),
    });
    if (!authorise.ok) await this.fail(authorise, path);
    const grant = (await authorise.json()) as {
      exists?: number;
      url?: string;
      contentType?: string;
      prefix?: string;
      suffix?: string;
      uploadKey?: string;
    };
    if (grant.exists) return 'exists';
    if (grant.url === undefined || grant.uploadKey === undefined) {
      throw new ZoteroApiError(authorise.status, path, 'upload authorisation without a URL');
    }

    const encoder = new TextEncoder();
    const prefix = encoder.encode(grant.prefix ?? '');
    const suffix = encoder.encode(grant.suffix ?? '');
    const body = new Uint8Array(prefix.byteLength + file.bytes.byteLength + suffix.byteLength);
    body.set(prefix, 0);
    body.set(file.bytes, prefix.byteLength);
    body.set(suffix, prefix.byteLength + file.bytes.byteLength);

    // The storage URL is another host: no API key goes there.
    const upload = await this.fetchImpl(grant.url, {
      method: 'POST',
      headers: { 'Content-Type': grant.contentType ?? 'application/octet-stream', 'User-Agent': this.userAgent },
      body,
    });
    if (upload.status !== 201 && upload.status !== 200 && upload.status !== 204) {
      throw new ZoteroApiError(upload.status, 'file storage', 'the file upload was refused');
    }

    const register = await this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...condition },
      body: new URLSearchParams({ upload: grant.uploadKey }).toString(),
    });
    if (register.status !== 204) await this.fail(register, path);
    return 'uploaded';
  }
}

const secondsHeader = (value: string | null): number | null => {
  if (value === null) return null;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
};

const versionHeader = (response: Response): number => {
  const version = Number.parseInt(response.headers.get('Last-Modified-Version') ?? '', 10);
  return Number.isFinite(version) ? version : 0;
};
