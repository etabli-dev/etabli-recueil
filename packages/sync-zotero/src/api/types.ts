/**
 * The shapes of the Zotero Web API v3, as far as the sync reads and writes them.
 *
 * Only what the API documents is modelled. Everything else an object carries is kept as an opaque
 * part of its JSON (`[field: string]: unknown`), because a push must return every field Recueil
 * does not model exactly as Zotero sent it (ADR-0025 §4).
 */

export type ZoteroLibraryType = 'user' | 'group';

export interface ZoteroLibraryRef {
  type: ZoteroLibraryType;
  /** The numeric user or group id. */
  id: number;
}

export interface ZoteroCreatorJson {
  creatorType: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

export interface ZoteroTagJson {
  tag: string;
  /** 0 = manual, 1 = automatic. */
  type?: number;
}

/** An item's `data`: regular items, notes and attachments share the one shape in the API. */
export interface ZoteroItemData {
  key: string;
  version: number;
  itemType: string;
  parentItem?: string;
  title?: string;
  creators?: ZoteroCreatorJson[];
  tags?: ZoteroTagJson[];
  collections?: string[];
  relations?: Record<string, string | string[]>;
  /** Present and truthy for an item in the Zotero trash. */
  deleted?: boolean | number;
  note?: string;
  linkMode?: string;
  contentType?: string;
  filename?: string;
  md5?: string | null;
  mtime?: number | null;
  url?: string;
  dateAdded?: string;
  dateModified?: string;
  [field: string]: unknown;
}

export interface ZoteroCollectionData {
  key: string;
  version: number;
  name: string;
  /** `false` for a top-level collection. */
  parentCollection: string | false;
  relations?: Record<string, string | string[]>;
  deleted?: boolean | number;
  [field: string]: unknown;
}

export interface ZoteroObject<Data> {
  key: string;
  version: number;
  library?: { type: ZoteroLibraryType; id: number; name?: string };
  data: Data;
}

export interface ZoteroDeleted {
  collections: string[];
  items: string[];
  searches: string[];
  tags: string[];
}

export interface ZoteroKeyInfo {
  key?: string;
  userID: number;
  username: string;
  access: {
    user?: { library?: boolean; files?: boolean; notes?: boolean; write?: boolean };
    groups?: Record<string, { library?: boolean; write?: boolean }>;
  };
}

export interface ZoteroGroup {
  id: number;
  version: number;
  data: { id: number; name: string; [field: string]: unknown };
}

/** One entry of `failed` in a write response. */
export interface ZoteroWriteFailure {
  key?: string;
  code: number;
  message: string;
}

/** The response of `POST /items` and `POST /collections`, keyed by the index in the request. */
export interface ZoteroWriteResponse<Data> {
  successful: Record<string, ZoteroObject<Data>>;
  success: Record<string, string>;
  unchanged: Record<string, string>;
  failed: Record<string, ZoteroWriteFailure>;
}

/** `GET /schema`: the parts of Zotero's global schema the mapping needs. */
export interface ZoteroGlobalSchemaJson {
  version: number;
  itemTypes: Array<{
    itemType: string;
    fields: Array<{ field: string; baseField?: string }>;
    creatorTypes: Array<{ creatorType: string; primary?: boolean }>;
  }>;
}

/** A versioned page of objects, with the library version the server reported for it. */
export interface Versioned<T> {
  value: T;
  libraryVersion: number;
}
