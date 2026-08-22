/**
 * The typed API client — the only module in this application that calls `fetch`.
 *
 * P6 says nothing is UI-only: the web client is a client of the same REST contract as the CLI, the
 * MCP server and the R package, with no privileged back channel. Keeping every request in one
 * module is how that stays true in practice. A component that wants data asks a hook in
 * `queries.ts`, the hook asks a method here, and the method is the only thing that knows a URL.
 *
 * Types come from `@recueil/schemas` — the same Zod schemas the server validates with and the
 * OpenAPI document is generated from — imported as types, so the contract is checked at compile
 * time and nothing is shipped to the browser to check it again at runtime. The client does not
 * re-validate responses: a server that breaks the contract is a server bug, and a second copy of
 * the validation in the browser would only tell the user about it in a worse place.
 *
 * Every method below names a path that `apps/server/src/routes` actually serves, and every query
 * parameter one that the route's schema accepts. That is not decoration: the list endpoints parse
 * their query with `z.strictObject`, so a parameter this client invented would be a 422 rather
 * than something the server politely ignored. `e2e/library.spec.ts` drives the built bundle
 * against a running server, which is what keeps this true rather than merely intended.
 *
 * The base URL is empty by default. In production the SPA is served by the Fastify app, and in
 * development Vite proxies `/api` and `/health` to it (vite.config.ts), so a relative path is
 * correct in both and there is no environment-dependent origin to get wrong.
 */
import type {
  Attachment,
  Collection,
  CustomField,
  FieldPath,
  FieldValue,
  FieldValueContent,
  HealthResponse,
  Item,
  ItemSummary,
  ItemUpdate,
  Note,
  Page,
  ProblemDetails,
  Tag,
} from '@recueil/schemas';

import {
  ApiError,
  parseProblemDocument,
  problemFromStatus,
  problemFromTransportFailure,
} from './problem.js';

/**
 * Where the versioned resources live.
 *
 * `@recueil/schemas` exports this as `API_BASE_PATH` from its OpenAPI module; it is restated here
 * as a constant rather than imported so that the browser bundle does not pull the document
 * generator, and `test/contract.test.ts` asserts that the two agree.
 */
export const API_BASE_PATH = '/api/v1';

/** `/health` is deliberately unversioned: a probe that knows the API version breaks when it changes. */
export const HEALTH_PATH = '/health';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RecueilClientOptions {
  /** Prefixed to every path. Empty for same-origin, which is the deployed and the proxied case. */
  baseUrl?: string;
  /** A scoped bearer token. The browser normally uses the session cookie and sets nothing. */
  token?: string;
  /** Injected in tests, and by the desktop shell when it talks to its sidecar. */
  fetch?: FetchLike;
}

/**
 * The parameters `GET /api/v1/items` accepts.
 *
 * There is no sort *field*: the list is ordered by `(dateModified, id)` and nothing else, because
 * that pair is what makes the cursor total — a cursor over a non-total order silently skips or
 * repeats rows (`packages/core/src/services/library.ts`). `order` reverses it; that is the whole
 * of the ordering surface, and the toolbar offers exactly that and no more.
 *
 * `q` is the *filter* — Recueil's query syntax folded into the SQL, so it composes with
 * `collectionId` and `tagId` and stays pageable. `GET /api/v1/search` is the ranked search, which
 * is a different operation and not one the item list can page through.
 */
export interface ItemListQuery {
  cursor?: string;
  limit?: number;
  order?: 'asc' | 'desc';
  itemType?: string;
  collectionId?: string;
  tagId?: string;
  /** Full-text filter, in Recueil's own syntax. Matches item text, note text and extracted text. */
  q?: string;
  includeTrashed?: boolean;
}

/**
 * The body of `PUT /api/v1/items/{id}/field-values/{fieldKey}`.
 *
 * `FieldValueWrite` in the OpenAPI document. It is restated as an interface rather than imported
 * because the schema is declared in `apps/server/src/schemas.ts` — a server module — while its
 * two interesting members are contract types from `@recueil/schemas`, which is what is imported.
 */
export interface FieldValueWrite {
  content?: FieldValueContent | null;
  groupKey?: string | null;
  ordinal?: number;
  /** An explicit "not reported", which is a different fact from "not extracted". */
  isBlank?: boolean;
}

/** Which facet a lock belongs to. Bibliographic unless said otherwise, as on the server. */
export type LockFacet = 'bibliographic' | 'office';

interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Sent as `If-Match`, which is how a conditional write is rejected rather than merged (P1). */
  expectedVersion?: number;
  signal?: AbortSignal;
}

const JSON_CONTENT_TYPE = 'application/json';

/** Query values that are `undefined` are absent, not empty: `?q=` means something else. */
const buildQueryString = (query: RequestOptions['query']): string => {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.append(key, String(value));
  }
  const rendered = params.toString();
  return rendered === '' ? '' : `?${rendered}`;
};

export class RecueilClient {
  private readonly baseUrl: string;

  private readonly token: string | undefined;

  private readonly doFetch: FetchLike;

  constructor(options: RecueilClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? '';
    this.token = options.token;
    this.doFetch =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /* Transport ------------------------------------------------------------------------------- */

  /** The absolute (or origin-relative) URL of a versioned resource, for links and `<embed>` targets. */
  url(path: string, query?: RequestOptions['query']): string {
    return `${this.baseUrl}${API_BASE_PATH}${path}${buildQueryString(query)}`;
  }

  /**
   * One request. Everything that can go wrong ends as an `ApiError` carrying a problem document,
   * including the failures that never produced one.
   */
  private async request<TResult>(path: string, options: RequestOptions = {}): Promise<TResult> {
    const method = options.method ?? 'GET';
    const url = `${this.baseUrl}${path}${buildQueryString(options.query)}`;

    const headers: Record<string, string> = { accept: `${JSON_CONTENT_TYPE}, application/problem+json` };
    if (this.token !== undefined) headers.authorization = `Bearer ${this.token}`;
    if (options.body !== undefined) headers['content-type'] = JSON_CONTENT_TYPE;
    if (options.expectedVersion !== undefined) headers['if-match'] = `"${options.expectedVersion}"`;

    const init: RequestInit = { method, headers, credentials: 'same-origin' };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    if (options.signal !== undefined) init.signal = options.signal;

    let response: Response;
    try {
      response = await this.doFetch(url, init);
    } catch (cause) {
      // An abort is the caller changing its mind, not a failure to report.
      if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
      throw new ApiError(problemFromTransportFailure(cause), { method, url });
    }

    if (!response.ok) {
      throw new ApiError(await readProblem(response), { method, url });
    }
    if (response.status === 204) return undefined as TResult;

    try {
      return (await response.json()) as TResult;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : 'The response body was not JSON.';
      throw new ApiError(problemFromStatus(response.status, detail), { method, url });
    }
  }

  private api<TResult>(path: string, options: RequestOptions = {}): Promise<TResult> {
    return this.request<TResult>(`${API_BASE_PATH}${path}`, options);
  }

  /* System ---------------------------------------------------------------------------------- */

  getHealth(signal?: AbortSignal): Promise<HealthResponse> {
    return this.request<HealthResponse>(HEALTH_PATH, { signal });
  }

  /* Items ----------------------------------------------------------------------------------- */

  listItems(query: ItemListQuery = {}, signal?: AbortSignal): Promise<Page<ItemSummary>> {
    return this.api<Page<ItemSummary>>('/items', { query: { ...query }, signal });
  }

  /**
   * One item, whole.
   *
   * There is no `expand`: `GET /items/{id}` always returns the facets, the creators, the tags, the
   * collection ids and the attachments, and `noteIds` rather than the note bodies. The item pane
   * therefore needs one request for everything except the notes, which the notes section fetches
   * because a note is up to a megabyte of markdown.
   */
  getItem(id: string, options: { signal?: AbortSignal } = {}): Promise<Item> {
    return this.api<Item>(`/items/${encodeURIComponent(id)}`, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  /**
   * A partial write. Every field written by hand takes a `manual` provenance row and a lock with
   * it (P4-1), so the caller sends only what actually changed — a patch that echoes the whole facet
   * back would lock every field on it.
   */
  updateItem(id: string, patch: ItemUpdate, expectedVersion?: number): Promise<Item> {
    return this.api<Item>(`/items/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch,
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    });
  }

  /**
   * Release one manual lock.
   *
   * A lock is addressed, not posted: `DELETE /items/{id}/locks/{fieldPath}`, one field at a time,
   * answering `204`. Provenance is read-only on the wire, so this is the only way back — a client
   * never posts a provenance map (P4-3). The caller refetches the item to see the result, because
   * the response carries no body.
   */
  unlockField(id: string, fieldPath: FieldPath, facet?: LockFacet): Promise<void> {
    return this.api<void>(
      `/items/${encodeURIComponent(id)}/locks/${encodeURIComponent(fieldPath)}`,
      { method: 'DELETE', ...(facet === undefined ? {} : { query: { facet } }) },
    );
  }

  /* Filing ---------------------------------------------------------------------------------- */

  /**
   * Every collection, with its item count.
   *
   * The endpoint takes no `limit`: collections are a bounded set the server returns whole, and the
   * count comes with each row whether or not anyone asked (`routes/collections.ts`).
   */
  listCollections(signal?: AbortSignal): Promise<Page<Collection>> {
    return this.api<Page<Collection>>('/collections', { signal });
  }

  listTags(signal?: AbortSignal): Promise<Page<Tag>> {
    return this.api<Page<Tag>>('/tags', { query: { limit: 200 }, signal });
  }

  /* Item-pane resources ---------------------------------------------------------------------- */

  /** An attachment does not exist without its item, so the list is addressed under the item. */
  listAttachments(itemId: string, signal?: AbortSignal): Promise<Page<Attachment>> {
    return this.api<Page<Attachment>>(`/items/${encodeURIComponent(itemId)}/attachments`, { signal });
  }

  getAttachment(id: string, signal?: AbortSignal): Promise<Attachment> {
    return this.api<Attachment>(`/attachments/${encodeURIComponent(id)}`, { signal });
  }

  /**
   * Where an attachment's bytes are.
   *
   * The bytes belong to the *document*, not to the attachment: the same PDF reachable from two
   * items is stored once and served once (AT1, ADR-0004), so the content endpoint is
   * `/documents/{documentId}/content` and an attachment names the document it points at. A
   * `linked_url` attachment has no document and therefore no content URL, which is why this takes
   * the id rather than the attachment and the reader checks before calling it.
   */
  documentContentUrl(documentId: string): string {
    return this.url(`/documents/${encodeURIComponent(documentId)}/content`);
  }

  listNotes(itemId: string, signal?: AbortSignal): Promise<Page<Note>> {
    return this.api<Page<Note>>('/notes', { query: { itemId }, signal });
  }

  listCustomFields(signal?: AbortSignal): Promise<Page<CustomField>> {
    return this.api<Page<CustomField>>('/fields', { query: { scope: 'library' }, signal });
  }

  listFieldValues(itemId: string, signal?: AbortSignal): Promise<Page<FieldValue>> {
    return this.api<Page<FieldValue>>(`/items/${encodeURIComponent(itemId)}/field-values`, { signal });
  }

  /**
   * Write one custom-field value.
   *
   * An upsert addressed by `(item, fieldKey)` rather than a create and a patch against a surrogate
   * id: the value of a field on an item is one thing, and a client that had to know whether the row
   * already existed would race with anything else writing it.
   */
  setFieldValue(itemId: string, fieldKey: string, value: FieldValueWrite): Promise<FieldValue> {
    return this.api<FieldValue>(
      `/items/${encodeURIComponent(itemId)}/field-values/${encodeURIComponent(fieldKey)}`,
      { method: 'PUT', body: value },
    );
  }

  /** Clear one value. `204`, and the absence of the row means "not recorded" rather than "blank". */
  clearFieldValue(
    itemId: string,
    fieldKey: string,
    options: { groupKey?: string; ordinal?: number } = {},
  ): Promise<void> {
    return this.api<void>(
      `/items/${encodeURIComponent(itemId)}/field-values/${encodeURIComponent(fieldKey)}`,
      { method: 'DELETE', query: { ...options } },
    );
  }
}

/** Read an error response as a problem document, falling back on the status when it is not one. */
const readProblem = async (response: Response): Promise<ProblemDetails> => {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return problemFromStatus(response.status);
  }
  return parseProblemDocument(body) ?? problemFromStatus(response.status);
};
