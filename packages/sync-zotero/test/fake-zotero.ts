/**
 * An in-process zotero.org: the contract the sync is tested against.
 *
 * It implements the documented behaviour of the Web API v3 that the client relies on — library and
 * object versions, `?since=`, `includeTrashed`, paging with `Total-Results`, `/deleted`, the
 * per-object version precondition on writes (`412` in `failed`), `version: 0` meaning "must not
 * exist", `If-Unmodified-Since-Version` on deletions, and the three-step file upload — and records
 * every request so a test can assert on what was and was not sent.
 */
import { createHash } from 'node:crypto';

import type { ZoteroGlobalSchemaJson } from '../src/index.js';

export const API_KEY = 'test-key-0123456789';
const FILE_HOST = 'http://files.zotero.test';
const UPLOAD_HOST = 'http://upload.zotero.test';

export const TEST_SCHEMA: ZoteroGlobalSchemaJson = {
  version: 1,
  itemTypes: [
    {
      itemType: 'journalArticle',
      fields: [
        { field: 'title' },
        { field: 'abstractNote' },
        { field: 'publicationTitle' },
        { field: 'volume' },
        { field: 'issue' },
        { field: 'pages' },
        { field: 'date' },
        { field: 'journalAbbreviation' },
        { field: 'language' },
        { field: 'DOI' },
        { field: 'ISSN' },
        { field: 'shortTitle' },
        { field: 'url' },
        { field: 'accessDate' },
        { field: 'rights' },
        { field: 'extra' },
      ],
      creatorTypes: [
        { creatorType: 'author', primary: true },
        { creatorType: 'contributor' },
        { creatorType: 'editor' },
        { creatorType: 'translator' },
        { creatorType: 'reviewedAuthor' },
      ],
    },
    {
      itemType: 'book',
      fields: [
        { field: 'title' },
        { field: 'abstractNote' },
        { field: 'series' },
        { field: 'seriesNumber' },
        { field: 'edition' },
        { field: 'place' },
        { field: 'publisher' },
        { field: 'date' },
        { field: 'numPages' },
        { field: 'language' },
        { field: 'ISBN' },
        { field: 'shortTitle' },
        { field: 'url' },
        { field: 'extra' },
      ],
      creatorTypes: [
        { creatorType: 'author', primary: true },
        { creatorType: 'editor' },
        { creatorType: 'contributor' },
        { creatorType: 'translator' },
        { creatorType: 'seriesEditor' },
      ],
    },
    {
      itemType: 'thesis',
      fields: [
        { field: 'title' },
        { field: 'thesisType', baseField: 'type' },
        { field: 'university', baseField: 'publisher' },
        { field: 'place' },
        { field: 'date' },
        { field: 'extra' },
      ],
      creatorTypes: [{ creatorType: 'author', primary: true }, { creatorType: 'contributor' }],
    },
    {
      itemType: 'document',
      fields: [{ field: 'title' }, { field: 'publisher' }, { field: 'date' }, { field: 'url' }, { field: 'extra' }],
      creatorTypes: [{ creatorType: 'author', primary: true }, { creatorType: 'contributor' }, { creatorType: 'editor' }],
    },
    { itemType: 'note', fields: [], creatorTypes: [] },
    {
      itemType: 'attachment',
      fields: [{ field: 'title' }, { field: 'accessDate' }, { field: 'url' }],
      creatorTypes: [],
    },
  ],
};

type Data = Record<string, unknown> & { key: string; version: number };

interface Stored {
  kind: 'items' | 'collections';
  data: Data;
  version: number;
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

const KEY_CHARS = '23456789ABCDEFGHIJKLMNPQRSTUVWXYZ';
let keyCounter = 0;
export const fakeKey = (): string => {
  keyCounter += 1;
  let n = keyCounter;
  let key = '';
  for (let index = 0; index < 8; index += 1) {
    key = KEY_CHARS[n % KEY_CHARS.length] + key;
    n = Math.floor(n / KEY_CHARS.length);
  }
  return key;
};

export class FakeZotero {
  readonly userId = 4242;
  libraryVersion = 0;
  readonly objects = new Map<string, Stored>();
  readonly deleted = new Map<string, { kind: 'items' | 'collections'; version: number }>();
  readonly files = new Map<string, Uint8Array>();
  readonly requests: RecordedRequest[] = [];
  private pendingUploads = new Map<string, { key: string; md5: string; prefix: string; suffix: string; bytes?: Uint8Array }>();
  /** Make the next N requests answer 429 with Retry-After. */
  throttle = 0;
  /** A Backoff header to send with every response. */
  backoff: number | null = null;

  /* State helpers for tests --------------------------------------------------------------- */

  private bump(): number {
    this.libraryVersion += 1;
    return this.libraryVersion;
  }

  /** Another Zotero client writes: create or replace an object as it would. */
  put(kind: 'items' | 'collections', data: Record<string, unknown> & { key?: string }): Data {
    const version = this.bump();
    const key = data.key ?? fakeKey();
    const stored: Data = { ...data, key, version } as Data;
    if (kind === 'items') {
      stored['tags'] ??= [];
      stored['relations'] ??= {};
      if (stored['itemType'] !== 'note' && stored['itemType'] !== 'attachment') stored['collections'] ??= [];
      stored['dateAdded'] ??= '2024-01-01T00:00:00Z';
      stored['dateModified'] = new Date(1_700_000_000_000 + version * 1000).toISOString().replace(/\.\d+Z$/u, 'Z');
    } else {
      stored['parentCollection'] ??= false;
      stored['relations'] ??= {};
    }
    this.objects.set(key, { kind, data: stored, version });
    this.deleted.delete(key);
    return stored;
  }

  /** Another client edits fields of an existing object. */
  edit(key: string, patch: Record<string, unknown>): Data {
    const current = this.objects.get(key);
    if (current === undefined) throw new Error(`no object ${key}`);
    return this.put(current.kind, { ...current.data, ...patch, key });
  }

  /** Another client deletes an object for good. */
  remove(key: string): void {
    const current = this.objects.get(key);
    if (current === undefined) return;
    this.objects.delete(key);
    this.deleted.set(key, { kind: current.kind, version: this.bump() });
  }

  get(key: string): Data | undefined {
    return this.objects.get(key)?.data;
  }

  all(kind: 'items' | 'collections'): Data[] {
    return [...this.objects.values()].filter((object) => object.kind === kind).map((object) => object.data);
  }

  writes(): RecordedRequest[] {
    return this.requests.filter((request) => request.method !== 'GET');
  }

  /* The HTTP surface ------------------------------------------------------------------------ */

  readonly fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const body = init.body === undefined || init.body === null ? null : bodyText(init.body);
    this.requests.push({ method, url: url.toString(), headers, body });

    if (url.origin === FILE_HOST) return this.serveFile(url, headers);
    if (url.origin === UPLOAD_HOST) return this.receiveUpload(url, init.body ?? null, headers);

    if (headers['zotero-api-key'] !== API_KEY) return json(403, { error: 'Forbidden' });
    if (headers['zotero-api-version'] !== '3') return json(400, { error: 'API version' });
    if (this.throttle > 0) {
      this.throttle -= 1;
      return new Response('slow down', { status: 429, headers: { 'Retry-After': '1' } });
    }

    const response = await this.route(method, url, headers, body);
    if (this.backoff !== null) response.headers.set('Backoff', String(this.backoff));
    return response;
  };

  private async route(method: string, url: URL, headers: Record<string, string>, body: string | null): Promise<Response> {
    const path = url.pathname;
    const prefix = `/users/${this.userId}`;
    if (method === 'GET' && path === '/schema') return json(200, TEST_SCHEMA);
    if (method === 'GET' && path === '/keys/current') {
      return json(200, {
        key: API_KEY,
        userID: this.userId,
        username: 'tester',
        access: { user: { library: true, files: true, notes: true, write: true } },
      });
    }
    if (!path.startsWith(prefix)) return json(404, { error: 'not found' });
    const rest = path.slice(prefix.length);

    if (method === 'GET' && (rest === '/items' || rest === '/collections')) {
      return this.list(rest === '/items' ? 'items' : 'collections', url);
    }
    if (method === 'GET' && rest === '/deleted') {
      const since = Number(url.searchParams.get('since') ?? '0');
      const out = { collections: [] as string[], items: [] as string[], searches: [], tags: [] };
      for (const [key, entry] of this.deleted) if (entry.version > since) out[entry.kind].push(key);
      return json(200, out, this.libraryVersion);
    }
    if (method === 'POST' && (rest === '/items' || rest === '/collections')) {
      return this.write(rest === '/items' ? 'items' : 'collections', JSON.parse(body ?? '[]') as Data[]);
    }
    if (method === 'DELETE' && (rest === '/items' || rest === '/collections')) {
      const since = Number(headers['if-unmodified-since-version'] ?? 'NaN');
      if (since !== this.libraryVersion) return new Response('changed', { status: 412 });
      const keys = (url.searchParams.get(rest === '/items' ? 'itemKey' : 'collectionKey') ?? '').split(',');
      const version = this.bump();
      for (const key of keys) {
        const current = this.objects.get(key);
        if (current === undefined) continue;
        this.objects.delete(key);
        this.deleted.set(key, { kind: current.kind, version });
      }
      return new Response(null, { status: 204, headers: { 'Last-Modified-Version': String(version) } });
    }
    const fileMatch = /^\/items\/([A-Z0-9]{8})\/file$/u.exec(rest);
    if (fileMatch !== null) {
      const key = fileMatch[1] as string;
      if (method === 'GET') {
        if (!this.files.has(key)) return json(404, { error: 'no file' });
        return new Response(null, { status: 302, headers: { Location: `${FILE_HOST}/${key}` } });
      }
      if (method === 'POST') return this.fileUpload(key, headers, body ?? '');
    }
    return json(404, { error: `no route ${method} ${path}` });
  }

  private list(kind: 'items' | 'collections', url: URL): Response {
    const since = Number(url.searchParams.get('since') ?? '0');
    const includeTrashed = url.searchParams.get('includeTrashed') === '1';
    const keys = url.searchParams.get('itemKey')?.split(',');
    let objects = [...this.objects.values()].filter((object) => object.kind === kind && object.version > since);
    if (keys !== undefined) objects = objects.filter((object) => keys.includes(object.data.key));
    if (!includeTrashed && kind === 'items') objects = objects.filter((object) => !object.data['deleted']);
    objects.sort((left, right) => left.version - right.version);
    if (url.searchParams.get('format') === 'versions') {
      return json(200, Object.fromEntries(objects.map((object) => [object.data.key, object.version])), this.libraryVersion);
    }
    const start = Number(url.searchParams.get('start') ?? '0');
    const limit = Number(url.searchParams.get('limit') ?? '25');
    const page = objects.slice(start, start + limit).map((object) => ({
      key: object.data.key,
      version: object.version,
      library: { type: 'user', id: this.userId },
      data: structuredClone(object.data),
    }));
    const response = json(200, page, this.libraryVersion);
    response.headers.set('Total-Results', String(objects.length));
    return response;
  }

  private write(kind: 'items' | 'collections', objects: Data[]): Response {
    if (objects.length > 50) return json(413, { error: 'too many' });
    const out = { successful: {} as Record<string, unknown>, success: {} as Record<string, string>, unchanged: {} as Record<string, string>, failed: {} as Record<string, unknown> };
    let version: number | null = null;
    objects.forEach((object, index) => {
      const key = object.key ?? fakeKey();
      const current = this.objects.get(key);
      if (object.version !== undefined) {
        if (object.version === 0 && current !== undefined) {
          out.failed[String(index)] = { key, code: 412, message: 'Object already exists' };
          return;
        }
        if (object.version > 0 && (current === undefined || current.version !== object.version)) {
          out.failed[String(index)] = { key, code: 412, message: `Object has been modified since ${object.version}` };
          return;
        }
      }
      if (kind === 'items' && typeof object['itemType'] !== 'string') {
        out.failed[String(index)] = { key, code: 400, message: 'itemType missing' };
        return;
      }
      const next = { ...object, key } as Data;
      delete (next as Record<string, unknown>)['version'];
      if (current !== undefined && sameData(current.data, next)) {
        out.unchanged[String(index)] = key;
        return;
      }
      version ??= this.bump();
      const stored: Data = { ...next, version } as Data;
      if (kind === 'items') {
        stored['dateModified'] = new Date(1_700_000_000_000 + version * 1000).toISOString().replace(/\.\d+Z$/u, 'Z');
        if (stored['deleted'] === false || stored['deleted'] === 0) delete stored['deleted'];
      }
      this.objects.set(key, { kind, data: stored, version });
      out.success[String(index)] = key;
      out.successful[String(index)] = { key, version, data: structuredClone(stored) };
    });
    return json(200, out, this.libraryVersion);
  }

  private fileUpload(key: string, headers: Record<string, string>, body: string): Response {
    const item = this.objects.get(key);
    if (item === undefined) return json(404, { error: 'no item' });
    const form = new URLSearchParams(body);
    const currentMd5 = (item.data['md5'] as string | null | undefined) ?? null;
    if (headers['if-none-match'] === '*' && currentMd5 !== null) return new Response('exists', { status: 412 });
    if (headers['if-match'] !== undefined && headers['if-match'] !== currentMd5) return new Response('changed', { status: 412 });

    const uploadKey = form.get('upload');
    if (uploadKey !== null) {
      const pending = this.pendingUploads.get(uploadKey);
      if (pending?.bytes === undefined) return json(400, { error: 'no upload' });
      this.files.set(key, pending.bytes);
      const version = this.bump();
      item.data = { ...item.data, md5: pending.md5, version };
      item.version = version;
      return new Response(null, { status: 204, headers: { 'Last-Modified-Version': String(version) } });
    }

    const md5 = form.get('md5') ?? '';
    if (currentMd5 === md5) return json(200, { exists: 1 });
    const id = `U-${key}-${md5.slice(0, 6)}`;
    this.pendingUploads.set(id, { key, md5, prefix: 'PREFIX--', suffix: '--SUFFIX' });
    return json(200, {
      url: `${UPLOAD_HOST}/${id}`,
      contentType: 'multipart/form-data; boundary=x',
      prefix: 'PREFIX--',
      suffix: '--SUFFIX',
      uploadKey: id,
    });
  }

  private serveFile(url: URL, headers: Record<string, string>): Response {
    if (headers['zotero-api-key'] !== undefined) throw new Error('the API key was sent to the file host');
    const bytes = this.files.get(url.pathname.slice(1));
    return bytes === undefined ? new Response('missing', { status: 404 }) : new Response(bytes, { status: 200 });
  }

  private receiveUpload(url: URL, body: unknown, headers: Record<string, string>): Response {
    if (headers['zotero-api-key'] !== undefined) throw new Error('the API key was sent to the upload host');
    const pending = this.pendingUploads.get(url.pathname.slice(1));
    if (pending === undefined || !(body instanceof Uint8Array)) return new Response('bad', { status: 400 });
    const prefix = new TextEncoder().encode(pending.prefix).byteLength;
    const suffix = new TextEncoder().encode(pending.suffix).byteLength;
    const bytes = body.slice(prefix, body.byteLength - suffix);
    if (createHash('md5').update(bytes).digest('hex') !== pending.md5) return new Response('md5', { status: 400 });
    pending.bytes = bytes;
    return new Response(null, { status: 201 });
  }

  /** Put a file behind an attachment, as Zotero's own client would. */
  attachFile(key: string, bytes: Uint8Array): void {
    this.files.set(key, bytes);
    this.edit(key, { md5: createHash('md5').update(bytes).digest('hex'), mtime: 1_700_000_000_000 });
  }
}

const json = (status: number, value: unknown, version?: number): Response => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (version !== undefined) headers['Last-Modified-Version'] = String(version);
  return new Response(JSON.stringify(value), { status, headers });
};

const bodyText = (body: NonNullable<RequestInit["body"]>): string => {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return `<${body.byteLength} bytes>`;
  return String(body);
};

const sameData = (left: Record<string, unknown>, right: Record<string, unknown>): boolean => {
  const strip = (value: Record<string, unknown>) => {
    const copy = { ...value };
    delete copy['version'];
    delete copy['dateModified'];
    if (copy['deleted'] === false || copy['deleted'] === 0) delete copy['deleted'];
    return JSON.stringify(Object.keys(copy).sort().map((key) => [key, copy[key]]));
  };
  return strip(left) === strip(right);
};
