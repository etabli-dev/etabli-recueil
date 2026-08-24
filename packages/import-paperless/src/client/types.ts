/**
 * The Paperless-ngx REST API, in Paperless-ngx's own names.
 *
 * These are the shapes the server sends, transcribed field by field from the serialisers of the
 * release named in `PAPERLESS_MODELLED_VERSION`. They are deliberately *not* Recueil shapes: the
 * mapping happens in `src/map/`, and keeping the wire types honest is what makes a change upstream
 * show up as a type error here rather than as a silently dropped field.
 *
 * **This package has never spoken to a real Paperless-ngx server.** Everything below was written
 * from the published source of the release named here, and the fake in `src/testing/` serialises
 * exactly these shapes. That is enough to test the mapping, the pagination, the resumption and the
 * report; it is *not* a compatibility claim. See `README.md` § "What is unproven".
 */

/**
 * The Paperless-ngx release these types were transcribed from.
 *
 * Sources, at tag `v3.0.5`:
 * `src/documents/serialisers.py` (the field lists), `src/documents/models.py`
 * (`CustomField.FieldDataType`), `src/documents/views.py` (the `metadata`, `download`, `preview`
 * and `notes` actions), `src/paperless/views.py` (`StandardPagination`),
 * `src/paperless/settings/__init__.py` (`REST_FRAMEWORK`) and `src/paperless/middleware.py`
 * (`ApiVersionMiddleware`).
 */
export const PAPERLESS_MODELLED_VERSION = '3.0.5';

/**
 * The DRF Accept-header API version this client asks for.
 *
 * Paperless-ngx uses `rest_framework.versioning.AcceptHeaderVersioning`, so the version travels as
 * `Accept: application/json; version=<n>` and the server answers `406` for a version outside
 * `ALLOWED_VERSIONS`. At 3.0.5 that list is `['9', '10']` and the default is `'10'`.
 *
 * Version 10 is the one worth asking for: from 10 the paginated envelope drops the `all` array,
 * which on a large library is every matching id repeated in every page of the response.
 */
export const PAPERLESS_API_VERSION = '10';

/** The versions of the envelope this client understands. Anything else is refused, not guessed. */
export const SUPPORTED_API_VERSIONS: readonly string[] = ['9', '10'];

/**
 * One page of a list endpoint (`StandardPagination`).
 *
 * `all` is present only below API version 10. `next` and `previous` are absolute URLs built by the
 * server from the request it saw — which means they are attacker-influenced if anything sits in
 * front of Paperless that can set `Host` or `X-Forwarded-*`. This client therefore never *follows*
 * them; see `client.ts`.
 */
export interface PaperlessPage<TRecord> {
  count: number;
  next: string | null;
  previous: string | null;
  all?: number[];
  results: TRecord[];
}

/** `MatchingModelSerializer.matching_algorithm`. Carried across as provenance, not re-implemented. */
export type PaperlessMatchingAlgorithm = number;

/** `CorrespondentSerializer`. */
export interface PaperlessCorrespondent {
  id: number;
  slug?: string;
  name: string;
  match?: string;
  matching_algorithm?: PaperlessMatchingAlgorithm;
  is_insensitive?: boolean;
  document_count?: number;
  last_correspondence?: string | null;
  owner?: number | null;
}

/** `DocumentTypeSerializer`. */
export interface PaperlessDocumentType {
  id: number;
  slug?: string;
  name: string;
  match?: string;
  matching_algorithm?: PaperlessMatchingAlgorithm;
  is_insensitive?: boolean;
  document_count?: number;
  owner?: number | null;
}

/**
 * `TagSerializer`.
 *
 * `parent`/`children` are the tag tree Paperless-ngx 3.0 added. Recueil tags are flat (§3.11), so
 * the tree is reported as a lossy mapping rather than invented into collections. Tag names are
 * unique per owner in Paperless, so flattening cannot collide.
 */
export interface PaperlessTag {
  id: number;
  slug?: string;
  name: string;
  /** `#rrggbb`. Paperless spells it the American way on the wire. */
  color?: string;
  text_color?: string;
  match?: string;
  matching_algorithm?: PaperlessMatchingAlgorithm;
  is_insensitive?: boolean;
  is_inbox_tag?: boolean;
  document_count?: number;
  owner?: number | null;
  parent?: number | null;
  children?: unknown[];
}

/** `StoragePathSerializer`. Carried as a custom field: it is a file-layout rule, not a collection. */
export interface PaperlessStoragePath {
  id: number;
  slug?: string;
  name: string;
  path?: string;
  document_count?: number;
  owner?: number | null;
}

/** `CustomField.FieldDataType` (`src/documents/models.py`). */
export const PAPERLESS_CUSTOM_FIELD_DATA_TYPES = [
  'string',
  'url',
  'date',
  'boolean',
  'integer',
  'float',
  'monetary',
  'documentlink',
  'select',
  'longtext',
] as const;

export type PaperlessCustomFieldDataType = (typeof PAPERLESS_CUSTOM_FIELD_DATA_TYPES)[number];

/** One option of a `select` field. The stored value is the `id`, not the `label`. */
export interface PaperlessSelectOption {
  id: string;
  label: string;
}

/** `CustomFieldSerializer`. */
export interface PaperlessCustomField {
  id: number;
  name: string;
  /** Immutable upstream (`editable=False`), which is what lets Recueil mirror it 1:1 (CF1). */
  data_type: PaperlessCustomFieldDataType;
  extra_data?: {
    select_options?: PaperlessSelectOption[];
    default_currency?: string | null;
  } | null;
  document_count?: number;
}

/**
 * `CustomFieldInstanceSerializer` — one value on one document.
 *
 * The `value` is typed by the field's `data_type`: a string for `string`/`url`/`longtext`, a
 * `YYYY-MM-DD` string for `date`, a boolean, a number for `integer`/`float`, the *option id* for
 * `select`, an array of document ids for `documentlink`, and a string like `GBP123.45` (or a bare
 * decimal, in the legacy form) for `monetary`.
 */
export interface PaperlessCustomFieldInstance {
  field: number;
  value: unknown;
}

/** `NotesSerializer`. */
export interface PaperlessNote {
  id: number;
  note: string;
  created: string;
  user?: { id: number; username?: string } | number | null;
}

/** `DocumentSerializer`. Only the fields a migration needs are declared as required. */
export interface PaperlessDocument {
  id: number;
  correspondent: number | null;
  document_type: number | null;
  storage_path?: number | null;
  title: string;
  /** The extracted/OCR text. See `README.md`: Recueil has nowhere to put it in this phase. */
  content?: string;
  tags: number[];
  /** `YYYY-MM-DD` from API 9 onwards; older servers sent a full ISO timestamp. */
  created?: string;
  /** Deprecated upstream in favour of `created`, still serialised at 3.0.5. */
  created_date?: string;
  modified?: string;
  added?: string;
  deleted_at?: string | null;
  archive_serial_number: number | null;
  original_file_name?: string | null;
  archived_file_name?: string | null;
  owner?: number | null;
  notes?: PaperlessNote[];
  custom_fields?: PaperlessCustomFieldInstance[];
  page_count?: number | null;
  mime_type?: string | null;
  /** Set on a non-root version of a document (Paperless-ngx 3.0 versioning). */
  root_document?: number | null;
}

/** The `GET /api/documents/{id}/metadata/` payload. */
export interface PaperlessDocumentMetadata {
  /** MD5 of the *original* file, as Paperless stored it. The cross-check the report reconciles. */
  original_checksum?: string | null;
  original_size?: number | null;
  original_mime_type?: string | null;
  media_filename?: string | null;
  has_archive_version?: boolean;
  archive_checksum?: string | null;
  archive_media_filename?: string | null;
  original_filename?: string | null;
  archive_size?: number | null;
  lang?: string | null;
}

/** What the server said about itself, from the headers `ApiVersionMiddleware` sets. */
export interface PaperlessServerInfo {
  /** `X-Version`, e.g. `3.0.5`. Null when the header is absent (an unauthenticated response). */
  serverVersion: string | null;
  /** `X-Api-Version`: the newest version the server allows. */
  apiVersion: string | null;
  /** The version this client asked for in its `Accept` header. */
  requestedApiVersion: string;
  /** The endpoints the DRF router advertises at `/api/`. */
  endpoints: string[];
}
