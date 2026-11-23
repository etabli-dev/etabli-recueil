/**
 * The common shape both sides are compared in (ADR-0025 §3).
 *
 * A Zotero item and a Recueil item never hold a value the same way: Zotero keeps `10.1000/ABC`
 * and `2020-05-03`, Recueil keeps `10.1000/abc` and EDTF. Comparing raw values would make every
 * normalisation look like an edit, and a sync that pushes its own normalisations back is a sync
 * that rewrites every record on the first run. So each side is *projected* into one shape — the
 * Recueil side as it is, the Zotero side through the importer's own mapping — and only projections
 * are compared. A field has changed on a side when that side's projection differs from the
 * projection of the base.
 *
 * Every projected value is a string (or a sorted string list), so the merge is a plain comparison.
 */
import type { BibliographicInput, CreatorRole, Recueil } from '@recueil/core';
import {
  mapCreatorName,
  mapCreatorRole,
  mapZoteroFields,
  mapZoteroItemType,
} from '@recueil/import-zotero';
import type { ZoteroFieldValue } from '@recueil/import-zotero';
import { htmlToMarkdown } from '@recueil/core';

import type { ZoteroCreatorJson, ZoteroItemData } from './api/types.js';
import type { ZoteroSchema } from './zotero-schema.js';

/**
 * The bibliographic columns the sync carries both ways, and the Zotero base field each comes from.
 *
 * This is the inverse of the importer's table plus its special cases, restricted to columns a
 * Zotero field can hold. `test/projection.test.ts` asserts that pulling through `mapZoteroFields`
 * lands every one of these base fields in the column named here, so the two cannot drift.
 */
export const COLUMN_BASE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  title: ['title'],
  shortTitle: ['shortTitle'],
  containerTitle: ['publicationTitle'],
  containerShort: ['journalAbbreviation'],
  collectionTitle: ['series', 'seriesTitle'],
  collectionNumber: ['seriesNumber'],
  publisher: ['publisher'],
  publisherPlace: ['place'],
  edition: ['edition'],
  volume: ['volume'],
  issue: ['issue'],
  pages: ['pages'],
  abstract: ['abstractNote'],
  url: ['url'],
  licence: ['rights'],
  versionLabel: ['versionNumber'],
  issuedDate: ['date'],
  accessedAt: ['accessDate'],
  doi: ['DOI'],
  isbn: ['ISBN'],
  issn: ['ISSN'],
  languageCode: ['language'],
  numberOfPages: ['numPages'],
};

export const SYNC_COLUMNS = Object.keys(COLUMN_BASE_FIELDS) as Array<keyof BibliographicInput>;

/** Keys of an item's JSON that are not fields of its item type. */
const NON_FIELD_KEYS = new Set([
  'key',
  'version',
  'itemType',
  'creators',
  'tags',
  'collections',
  'relations',
  'deleted',
  'parentItem',
  'dateAdded',
  'dateModified',
  'note',
]);

export interface ProjectedCreator {
  role: CreatorRole;
  kind: 'person' | 'organisation';
  family: string | null;
  given: string | null;
  literal: string | null;
}

/** A regular item, projected. */
export interface ItemProjection {
  itemType: string;
  /** Column → value; an absent key is an empty field. */
  fields: Record<string, string>;
  extra: string;
  creators: ProjectedCreator[];
  tags: string[];
  /** Zotero collection keys. */
  collections: string[];
  deleted: boolean;
}

/** A note, projected. */
export interface NoteProjection {
  markdown: string;
  parentKey: string | null;
  deleted: boolean;
}

/* -------------------------------------------------------------------------------------------- */
/* The Zotero side                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/** The field values of an item's JSON, in the importer's shape, resolved through the schema. */
export const zoteroFieldValues = (data: ZoteroItemData, schema: ZoteroSchema): ZoteroFieldValue[] => {
  const fields = schema.fields(data.itemType);
  const values: ZoteroFieldValue[] = [];
  for (const [field, raw] of Object.entries(data)) {
    if (NON_FIELD_KEYS.has(field) || typeof raw !== 'string') continue;
    // `extra` and `citationKey` are not always in an item type's field list, but are always fields.
    const baseField = fields.get(field) ?? (field === 'extra' || field === 'citationKey' ? field : null);
    if (baseField === null) continue;
    values.push({ field, baseField, value: raw });
  }
  return values;
};

export const isTrashed = (data: { deleted?: boolean | number }): boolean =>
  data.deleted === true || data.deleted === 1;

const projectZoteroCreator = (
  creator: ZoteroCreatorJson,
  itemType: string,
  schema: ZoteroSchema,
): ProjectedCreator => {
  const single = creator.name !== undefined;
  const name = mapCreatorName({
    creatorID: 0,
    firstName: single ? null : (creator.firstName ?? null),
    lastName: single ? (creator.name ?? null) : (creator.lastName ?? null),
    fieldMode: single ? 1 : 0,
  });
  return {
    role: mapCreatorRole(creator.creatorType, itemType, schema.primaryCreatorTypes).role,
    kind: name.kind,
    family: name.familyName,
    given: name.givenName,
    literal: name.literalName,
  };
};

export const projectZoteroItem = (data: ZoteroItemData, schema: ZoteroSchema): ItemProjection => {
  const mapping = mapZoteroItemType(data.itemType);
  const mapped = mapZoteroFields(zoteroFieldValues(data, schema), {
    zoteroItemType: data.itemType,
    cslType: mapping.cslType,
  });
  const fields: Record<string, string> = {};
  const bibliographic = mapped.bibliographic as Record<string, unknown>;
  for (const column of SYNC_COLUMNS) {
    const value = column === 'title' ? (mapped.title ?? bibliographic['title']) : bibliographic[column];
    if (value !== undefined && value !== null && String(value) !== '') fields[column] = String(value);
  }
  return {
    itemType: mapping.itemType,
    fields,
    extra: mapped.extra ?? '',
    creators: dedupeCreators(
      (data.creators ?? []).map((creator) => projectZoteroCreator(creator, data.itemType, schema)),
    ),
    tags: sortedUnique((data.tags ?? []).map((tag) => tag.tag.trim()).filter((tag) => tag !== '')),
    collections: sortedUnique(data.collections ?? []),
    deleted: isTrashed(data),
  };
};

export const projectZoteroNote = (data: ZoteroItemData): NoteProjection => ({
  markdown: normaliseMarkdown(htmlToMarkdown(data.note ?? '')),
  parentKey: data.parentItem ?? null,
  deleted: isTrashed(data),
});

/* -------------------------------------------------------------------------------------------- */
/* The Recueil side                                                                                */
/* -------------------------------------------------------------------------------------------- */

/**
 * Project a Recueil item. `collectionKeyOf` turns a Recueil collection id into the Zotero key of the
 * collection it is linked to, or null for one with no counterpart in this Zotero library.
 */
export const projectRecueilItem = (
  recueil: Recueil,
  itemId: string,
  collectionKeyOf: (collectionId: string) => string | null,
): ItemProjection => {
  const record = recueil.library.getItem(itemId, { includeTrashed: true });
  const bibliographic = (record.bibliographic ?? {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const column of SYNC_COLUMNS) {
    const value = column === 'title' ? (record.item.title ?? bibliographic['title']) : bibliographic[column];
    if (value !== undefined && value !== null && String(value) !== '') fields[column] = String(value);
  }

  const creators = recueil.creators.forItem(itemId).map(({ appearance, creator }) => ({
    role: appearance.role as CreatorRole,
    kind: creator.kind as 'person' | 'organisation',
    family: creator.familyName,
    given: creator.givenName,
    literal: creator.literalName,
  }));

  const collections: string[] = [];
  for (const collection of recueil.collections.forItem(itemId)) {
    const key = collectionKeyOf(collection.id);
    if (key !== null) collections.push(key);
  }

  return {
    itemType: record.item.itemType,
    fields,
    extra: record.item.extra ?? '',
    creators,
    tags: sortedUnique(recueil.tags.forItem(itemId).map((tag) => tag.name.trim())),
    collections: sortedUnique(collections),
    deleted: record.item.trashedAt !== null,
  };
};

export const projectRecueilNote = (
  recueil: Recueil,
  noteId: string,
  zoteroKeyOfItem: (itemId: string) => string | null,
): NoteProjection => {
  const note = recueil.notes.get(noteId, { includeTrashed: true });
  return {
    markdown: normaliseMarkdown(note.contentMarkdown),
    parentKey: note.itemId === null ? null : zoteroKeyOfItem(note.itemId),
    deleted: note.trashedAt !== null,
  };
};

/* -------------------------------------------------------------------------------------------- */
/* Helpers                                                                                         */
/* -------------------------------------------------------------------------------------------- */

export const sortedUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

/** Whitespace at line ends and trailing blank lines are not edits. */
export const normaliseMarkdown = (markdown: string): string =>
  markdown
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .trim();

/**
 * Recueil refuses the same person twice in the same role on one item (invariant IC2) and Zotero
 * permits it; the projection drops the repeat as the importer does, so it is not a perpetual edit.
 */
const dedupeCreators = (creators: readonly ProjectedCreator[]): ProjectedCreator[] => {
  const seen = new Set<string>();
  return creators.filter((creator) => {
    const key = creatorsKey([creator]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** A stable text form of a creator list, for comparison and for conflict records. */
export const creatorsKey = (creators: readonly ProjectedCreator[]): string =>
  JSON.stringify(creators.map((c) => [c.role, c.kind, c.family, c.given, c.literal]));
