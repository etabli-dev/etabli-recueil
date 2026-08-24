/**
 * The rows of `zotero.sqlite`, as this importer reads them.
 *
 * These are Zotero's own shapes, deliberately not Recueil's: everything here uses Zotero's names
 * (`itemID`, `linkMode`, `sortIndex`), so that the mapping in `src/map/` is the only place where
 * the two vocabularies meet and a reader of that code can see both sides at once.
 */

/** Zotero's four attachment link modes, by their numeric value in `itemAttachments.linkMode`. */
export const ZOTERO_LINK_MODES = ['imported_file', 'imported_url', 'linked_file', 'linked_url'] as const;
export type ZoteroLinkMode = (typeof ZOTERO_LINK_MODES)[number];

/** `itemAnnotations.type`, by its numeric value. */
export const ZOTERO_ANNOTATION_TYPES = [
  undefined,
  'highlight',
  'note',
  'image',
  'ink',
  'underline',
  'text',
] as const;
export type ZoteroAnnotationType = Exclude<(typeof ZOTERO_ANNOTATION_TYPES)[number], undefined>;

export interface ZoteroLibraryRow {
  libraryID: number;
  type: string;
  editable: number;
  filesEditable: number;
}

/**
 * How many items of one type one library holds, straight out of `items`.
 *
 * The importer reads a single library, so everything else in the file is invisible to every other
 * reader here. This is the one query that looks across all of them, and it exists so that the
 * verification report can say "there are five items in a group library and they were not imported"
 * instead of counting only what it chose to read and finding, unsurprisingly, no discrepancy.
 */
export interface ZoteroLibraryItemCount {
  libraryID: number;
  /** `user` or `group`. Null when `libraries` has no row for this id. */
  libraryType: string | null;
  itemType: string;
  count: number;
}

/** One row of `items`, joined to its type name and its trash state. */
export interface ZoteroItemRow {
  itemID: number;
  key: string;
  libraryID: number;
  itemType: string;
  dateAdded: string;
  dateModified: string;
  version: number;
  /** From `deletedItems`. Null when the item is live. */
  dateDeleted: string | null;
}

export interface ZoteroFieldValue {
  /** The field as recorded on the item. */
  field: string;
  /** The base field for this item type, when Zotero maps one — `university` → `publisher`. */
  baseField: string;
  value: string;
}

export interface ZoteroCreatorRow {
  creatorID: number;
  firstName: string | null;
  lastName: string | null;
  /** 0 = two-field name, 1 = single-field ("institutional") name. */
  fieldMode: number;
}

export interface ZoteroItemCreatorRow {
  itemID: number;
  creatorID: number;
  creatorType: string;
  orderIndex: number;
}

export interface ZoteroCollectionRow {
  collectionID: number;
  key: string;
  collectionName: string;
  parentCollectionID: number | null;
  dateDeleted: string | null;
}

export interface ZoteroCollectionItemRow {
  collectionID: number;
  itemID: number;
  orderIndex: number;
}

export interface ZoteroTagRow {
  tagID: number;
  name: string;
}

export interface ZoteroItemTagRow {
  itemID: number;
  tagID: number;
  /** 0 = added by a person, 1 = added by a translator or a plugin — Recueil's `automatic`. */
  type: number;
}

/** A tag colour from `syncedSettings`, which is where Zotero keeps them. */
export interface ZoteroTagColour {
  name: string;
  color: string;
  position: number;
}

export interface ZoteroNoteRow {
  itemID: number;
  parentItemID: number | null;
  note: string;
  title: string | null;
}

export interface ZoteroAttachmentRow {
  itemID: number;
  parentItemID: number | null;
  linkMode: number;
  contentType: string | null;
  charset: string | null;
  path: string | null;
  storageHash: string | null;
  storageModTime: number | null;
}

export interface ZoteroAnnotationRow {
  itemID: number;
  parentItemID: number;
  type: number;
  authorName: string | null;
  text: string | null;
  comment: string | null;
  color: string | null;
  pageLabel: string | null;
  sortIndex: string;
  position: string;
  isExternal: number;
}

export interface ZoteroRelationRow {
  itemID: number;
  predicate: string;
  object: string;
}

/** One row of Better BibTeX's `citationkey` table. */
export interface BetterBibtexKeyRow {
  itemKey: string;
  libraryID: number;
  citationKey: string;
  pinned: boolean;
}

/** Zotero's position JSON, which differs by annotation type. */
export interface ZoteroPosition {
  pageIndex?: number;
  /** `[x1, y1, x2, y2]` in PDF user space, origin bottom-left. */
  rects?: number[][];
  /** Flat `[x, y, x, y, …]` polylines. */
  paths?: number[][];
  width?: number;
  height?: number;
  fontSize?: number;
  rotation?: number;
}
