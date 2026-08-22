/**
 * Everything the importer reads out of `zotero.sqlite`, in one place.
 *
 * One class, one query per relation, no writes and no interpretation: `ZoteroLibrary` answers
 * questions about the source library in the source library's own terms. Mapping happens in
 * `src/map/`, and keeping the two apart is what makes it possible to test the mapping against
 * literal rows and the reader against a real database.
 *
 * Two Zotero mechanisms are honoured here rather than hard-coded downstream:
 *
 * - **Base fields.** `baseFieldMappingsCombined` says that a thesis's `university`, a report's
 *   `institution` and a dataset's `repository` are all the base field `publisher`. Resolving
 *   through that table means the field map in `src/map/fields.ts` has one entry for `publisher`
 *   instead of eight, and that a Zotero version which adds a ninth is handled without a change.
 * - **Primary creator types.** `itemTypeCreatorTypes.primaryField` says which creator type is the
 *   principal one for an item type — `artist` for artwork, `inventor` for a patent — which is what
 *   lets those map onto Recueil's `author` rather than being flattened to `contributor`.
 *
 * `fieldsCombined`, `itemTypesCombined` and `baseFieldMappingsCombined` are used in preference to
 * the plain tables because the combined views include a user's custom item types and fields.
 *
 * Every reader is memoised. The importer asks for the tag assignments once per item, and a
 * fifty-thousand-item library would otherwise run fifty thousand full-table scans; the database is
 * a private read-only copy, so a cached answer cannot go stale.
 */
import { inflateSync } from 'node:zlib';

import { ReadOnlyDatabase } from './readonly-db.js';
import type { OpenReadOnlyOptions, SourceFingerprint } from './readonly-db.js';
import { fingerprintFile } from './readonly-db.js';
import type {
  BetterBibtexKeyRow,
  ZoteroAnnotationRow,
  ZoteroAttachmentRow,
  ZoteroCollectionItemRow,
  ZoteroCollectionRow,
  ZoteroCreatorRow,
  ZoteroFieldValue,
  ZoteroItemCreatorRow,
  ZoteroItemRow,
  ZoteroItemTagRow,
  ZoteroLibraryRow,
  ZoteroNoteRow,
  ZoteroRelationRow,
  ZoteroTagColour,
  ZoteroTagRow,
} from './types.js';

/** The parts of Zotero's global schema this importer uses, when the database carries it. */
export interface ZoteroGlobalSchema {
  version: number | null;
  /** Zotero item type to CSL type. Inverted from the schema's `csl.types`, which maps the other way. */
  cslTypeByItemType: Readonly<Record<string, string>>;
  /** Zotero creator type to CSL name variable. */
  cslNameByCreatorType: Readonly<Record<string, string>>;
}

export interface ZoteroLibraryOptions extends OpenReadOnlyOptions {
  /** Which library to read. Defaults to the personal library, `1`. */
  libraryId?: number;
}

export class ZoteroLibrary {
  private readonly db: ReadOnlyDatabase;

  readonly libraryId: number;

  readonly fingerprint: SourceFingerprint;

  private readonly memos = new Map<string, unknown>();

  constructor(databasePath: string, options: ZoteroLibraryOptions = {}) {
    this.fingerprint = fingerprintFile(databasePath);
    this.db = new ReadOnlyDatabase(databasePath, options);
    this.libraryId = options.libraryId ?? 1;

    if (this.userdataVersion() === null) {
      this.db.close();
      throw new Error(
        `'${databasePath}' has no \`version\` table, so it is not a Zotero database. Point the ` +
          'importer at `zotero.sqlite` in the Zotero data directory.',
      );
    }
  }

  close(): void {
    this.db.close();
    this.memos.clear();
  }

  /** The digest of the source file now, for comparison with the one taken at open. */
  refingerprint(): SourceFingerprint {
    return fingerprintFile(this.fingerprint.path);
  }

  private memo<TValue>(key: string, compute: () => TValue): TValue {
    if (this.memos.has(key)) return this.memos.get(key) as TValue;
    const value = compute();
    this.memos.set(key, value);
    return value;
  }

  /* -------------------------------------------------------------------------------------------- */
  /* Library-level facts                                                                             */
  /* -------------------------------------------------------------------------------------------- */

  userdataVersion(): number | null {
    if (!this.db.hasTable('version')) return null;
    return this.db.pluck<number>("select version from version where schema = 'userdata'") ?? null;
  }

  clientVersion(): string | null {
    return (
      this.db.pluck<string>(
        "select value from settings where setting = 'client' and key = 'lastCompatibleVersion'",
      ) ?? null
    );
  }

  /** Zotero's identifier for a local, never-synced account. Part of every local relation URI. */
  localUserKey(): string | null {
    return (
      this.db.pluck<string>("select value from settings where setting = 'account' and key = 'localUserKey'") ??
      null
    );
  }

  /** The numeric user id of a synced account, when there is one. */
  syncedUserId(): number | null {
    const raw = this.db.pluck<unknown>(
      "select value from settings where setting = 'account' and key = 'userID'",
    );
    if (raw === undefined || raw === null) return null;
    const parsed = Number.parseInt(String(raw), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  library(): ZoteroLibraryRow | undefined {
    return this.db.get<ZoteroLibraryRow>(
      'select libraryID, type, editable, filesEditable from libraries where libraryID = ?',
      [this.libraryId],
    );
  }

  /**
   * Zotero's global schema, as stored in `settings` — a zlib-compressed JSON document.
   *
   * Used for the CSL type of each item type, which is the one thing the relational tables do not
   * carry. Absent or unreadable is not an error: `src/map/item-types.ts` ships the same table.
   */
  globalSchema(): ZoteroGlobalSchema | null {
    return this.memo('globalSchema', () => {
      const raw = this.db.pluck<Buffer | string>(
        "select value from settings where setting = 'globalSchema' and key = 'data'",
      );
      if (raw === undefined || raw === null) return null;
      try {
        const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'binary');
        const text = bytes[0] === 0x78 ? inflateSync(bytes).toString('utf8') : bytes.toString('utf8');
        const parsed = JSON.parse(text) as {
          version?: number;
          csl?: { types?: Record<string, string[]>; names?: Record<string, string> };
        };
        const cslTypeByItemType: Record<string, string> = {};
        for (const [cslType, zoteroTypes] of Object.entries(parsed.csl?.types ?? {})) {
          for (const zoteroType of zoteroTypes) cslTypeByItemType[zoteroType] = cslType;
        }
        return {
          version: parsed.version ?? null,
          cslTypeByItemType,
          cslNameByCreatorType: parsed.csl?.names ?? {},
        };
      } catch {
        // A schema blob this cannot read is a curiosity, not a failure: the static tables cover it.
        return null;
      }
    });
  }

  /* -------------------------------------------------------------------------------------------- */
  /* Items                                                                                           */
  /* -------------------------------------------------------------------------------------------- */

  /** Every row of `items` in this library, of every kind, trashed or not, in `itemID` order. */
  items(): ZoteroItemRow[] {
    return this.memo('items', () =>
      this.db.all<ZoteroItemRow>(
        `select i.itemID, i.key, i.libraryID, t.typeName as itemType, i.dateAdded, i.dateModified,
                i.version, d.dateDeleted as dateDeleted
           from items i
           join itemTypesCombined t on t.itemTypeID = i.itemTypeID
           left join deletedItems d on d.itemID = i.itemID
          where i.libraryID = ?
          order by i.itemID`,
        [this.libraryId],
      ),
    );
  }

  /** `itemID` to its row, for the joins the importer does in memory. */
  itemsById(): ReadonlyMap<number, ZoteroItemRow> {
    return this.memo('itemsById', () => new Map(this.items().map((row) => [row.itemID, row])));
  }

  /**
   * Every field value in the library, grouped by item and resolved to its base field.
   *
   * One query for the whole library rather than one per item: a fifty-thousand-item library is a
   * few hundred thousand rows, which is a single pass here and fifty thousand round trips the
   * other way.
   */
  fieldValues(): ReadonlyMap<number, ZoteroFieldValue[]> {
    return this.memo('fieldValues', () => {
      const rows = this.db.all<{ itemID: number; itemType: string; field: string; value: string }>(
        `select d.itemID, t.typeName as itemType, f.fieldName as field, v.value as value
           from itemData d
           join items i on i.itemID = d.itemID
           join itemTypesCombined t on t.itemTypeID = i.itemTypeID
           join fieldsCombined f on f.fieldID = d.fieldID
           join itemDataValues v on v.valueID = d.valueID
          where i.libraryID = ?
          order by d.itemID, f.fieldName`,
        [this.libraryId],
      );

      const baseFields = this.baseFields();
      const out = new Map<number, ZoteroFieldValue[]>();
      for (const row of rows) {
        const list = out.get(row.itemID) ?? [];
        list.push({
          field: row.field,
          baseField: baseFields.get(`${row.itemType}:${row.field}`) ?? row.field,
          value: String(row.value),
        });
        out.set(row.itemID, list);
      }
      return out;
    });
  }

  /** `<itemType>:<field>` to the base field Zotero maps it to. */
  baseFields(): ReadonlyMap<string, string> {
    return this.memo('baseFields', () => {
      const table = this.db.hasTable('baseFieldMappingsCombined')
        ? 'baseFieldMappingsCombined'
        : 'baseFieldMappings';
      const rows = this.db.all<{ itemType: string; base: string; field: string }>(
        `select t.typeName as itemType, b.fieldName as base, f.fieldName as field
           from ${table} m
           join itemTypesCombined t on t.itemTypeID = m.itemTypeID
           join fieldsCombined b on b.fieldID = m.baseFieldID
           join fieldsCombined f on f.fieldID = m.fieldID`,
      );
      return new Map(rows.map((row) => [`${row.itemType}:${row.field}`, row.base]));
    });
  }

  /** Item type to its principal creator type (`artist` for artwork, `inventor` for a patent). */
  primaryCreatorTypes(): ReadonlyMap<string, string> {
    return this.memo('primaryCreatorTypes', () => {
      const rows = this.db.all<{ itemType: string; creatorType: string }>(
        `select t.typeName as itemType, c.creatorType as creatorType
           from itemTypeCreatorTypes j
           join itemTypesCombined t on t.itemTypeID = j.itemTypeID
           join creatorTypes c on c.creatorTypeID = j.creatorTypeID
          where j.primaryField = 1`,
      );
      return new Map(rows.map((row) => [row.itemType, row.creatorType]));
    });
  }

  /* -------------------------------------------------------------------------------------------- */
  /* People, organisation, content                                                                   */
  /* -------------------------------------------------------------------------------------------- */

  creators(): ZoteroCreatorRow[] {
    return this.memo('creators', () =>
      this.db.all<ZoteroCreatorRow>(
        'select creatorID, firstName, lastName, fieldMode from creators order by creatorID',
      ),
    );
  }

  creatorsById(): ReadonlyMap<number, ZoteroCreatorRow> {
    return this.memo('creatorsById', () => new Map(this.creators().map((row) => [row.creatorID, row])));
  }

  itemCreators(): ZoteroItemCreatorRow[] {
    return this.memo('itemCreators', () =>
      this.db.all<ZoteroItemCreatorRow>(
        `select ic.itemID, ic.creatorID, c.creatorType as creatorType, ic.orderIndex
           from itemCreators ic
           join items i on i.itemID = ic.itemID
           join creatorTypes c on c.creatorTypeID = ic.creatorTypeID
          where i.libraryID = ?
          order by ic.itemID, ic.orderIndex`,
        [this.libraryId],
      ),
    );
  }

  itemCreatorsByItem(): ReadonlyMap<number, ZoteroItemCreatorRow[]> {
    return this.memo('itemCreatorsByItem', () => groupBy(this.itemCreators(), (row) => row.itemID));
  }

  collections(): ZoteroCollectionRow[] {
    return this.memo('collections', () => {
      const hasDeleted = this.db.hasTable('deletedCollections');
      return this.db.all<ZoteroCollectionRow>(
        `select c.collectionID, c.key, c.collectionName, c.parentCollectionID,
                ${hasDeleted ? 'd.dateDeleted' : 'null'} as dateDeleted
           from collections c
           ${hasDeleted ? 'left join deletedCollections d on d.collectionID = c.collectionID' : ''}
          where c.libraryID = ?
          order by c.collectionID`,
        [this.libraryId],
      );
    });
  }

  collectionItems(): ZoteroCollectionItemRow[] {
    return this.memo('collectionItems', () =>
      this.db.all<ZoteroCollectionItemRow>(
        `select ci.collectionID, ci.itemID, ci.orderIndex
           from collectionItems ci
           join collections c on c.collectionID = ci.collectionID
          where c.libraryID = ?
          order by ci.collectionID, ci.orderIndex, ci.itemID`,
        [this.libraryId],
      ),
    );
  }

  collectionItemsByItem(): ReadonlyMap<number, ZoteroCollectionItemRow[]> {
    return this.memo('collectionItemsByItem', () => groupBy(this.collectionItems(), (row) => row.itemID));
  }

  tags(): ZoteroTagRow[] {
    return this.memo('tags', () => this.db.all<ZoteroTagRow>('select tagID, name from tags order by tagID'));
  }

  tagsById(): ReadonlyMap<number, ZoteroTagRow> {
    return this.memo('tagsById', () => new Map(this.tags().map((row) => [row.tagID, row])));
  }

  itemTags(): ZoteroItemTagRow[] {
    return this.memo('itemTags', () =>
      this.db.all<ZoteroItemTagRow>(
        `select it.itemID, it.tagID, it.type
           from itemTags it
           join items i on i.itemID = it.itemID
          where i.libraryID = ?
          order by it.itemID, it.tagID`,
        [this.libraryId],
      ),
    );
  }

  itemTagsByItem(): ReadonlyMap<number, ZoteroItemTagRow[]> {
    return this.memo('itemTagsByItem', () => groupBy(this.itemTags(), (row) => row.itemID));
  }

  /** Tag colours, which Zotero keeps in `syncedSettings` rather than on the tag. */
  tagColours(): ZoteroTagColour[] {
    return this.memo('tagColours', () => {
      if (!this.db.hasTable('syncedSettings')) return [];
      const raw = this.db.pluck<string>(
        "select value from syncedSettings where setting = 'tagColors' and libraryID = ?",
        [this.libraryId],
      );
      if (raw === undefined || raw === null) return [];
      try {
        const parsed: unknown = JSON.parse(String(raw));
        if (!Array.isArray(parsed)) return [];
        return (parsed as Array<Record<string, unknown>>)
          .filter((entry) => typeof entry === 'object' && entry !== null)
          .map((entry, index) => ({
            name: String(entry['name'] ?? ''),
            color: String(entry['color'] ?? ''),
            position: typeof entry['position'] === 'number' ? (entry['position'] as number) : index,
          }))
          .filter((entry) => entry.name !== '');
      } catch {
        return [];
      }
    });
  }

  notes(): ZoteroNoteRow[] {
    return this.memo('notes', () =>
      this.db.all<ZoteroNoteRow>(
        `select n.itemID, n.parentItemID, n.note, n.title
           from itemNotes n
           join items i on i.itemID = n.itemID
          where i.libraryID = ?
          order by n.itemID`,
        [this.libraryId],
      ),
    );
  }

  attachments(): ZoteroAttachmentRow[] {
    return this.memo('attachments', () => {
      const charset = this.db.hasTable('charsets')
        ? '(select c.charset from charsets c where c.charsetID = a.charsetID)'
        : 'null';
      return this.db.all<ZoteroAttachmentRow>(
        `select a.itemID, a.parentItemID, a.linkMode, a.contentType, ${charset} as charset,
                a.path, a.storageHash, a.storageModTime
           from itemAttachments a
           join items i on i.itemID = a.itemID
          where i.libraryID = ?
          order by a.itemID`,
        [this.libraryId],
      );
    });
  }

  attachmentsById(): ReadonlyMap<number, ZoteroAttachmentRow> {
    return this.memo('attachmentsById', () => new Map(this.attachments().map((row) => [row.itemID, row])));
  }

  annotations(): ZoteroAnnotationRow[] {
    return this.memo('annotations', () => {
      if (!this.db.hasTable('itemAnnotations')) return [];
      return this.db.all<ZoteroAnnotationRow>(
        `select a.itemID, a.parentItemID, a.type, a.authorName, a.text, a.comment, a.color,
                a.pageLabel, a.sortIndex, a.position, a.isExternal
           from itemAnnotations a
           join items i on i.itemID = a.itemID
          where i.libraryID = ?
          order by a.itemID`,
        [this.libraryId],
      );
    });
  }

  relations(): ZoteroRelationRow[] {
    return this.memo('relations', () =>
      this.db.all<ZoteroRelationRow>(
        `select r.itemID, p.predicate as predicate, r.object
           from itemRelations r
           join items i on i.itemID = r.itemID
           join relationPredicates p on p.predicateID = r.predicateID
          where i.libraryID = ?
          order by r.itemID, p.predicate, r.object`,
        [this.libraryId],
      ),
    );
  }
}

/**
 * Better BibTeX's key store, which lives in its own database beside `zotero.sqlite`.
 *
 * Absent is normal — plenty of libraries have never had the plugin — and is reported as an empty
 * list rather than an error. Rows naming items that are not in the library are returned too: the
 * report counts them as stale, which is a fact about the source worth knowing.
 */
export const readBetterBibtexKeys = (
  databasePath: string,
  options: OpenReadOnlyOptions = {},
): BetterBibtexKeyRow[] => {
  const db = new ReadOnlyDatabase(databasePath, options);
  try {
    if (!db.hasTable('citationkey')) return [];
    return db
      .all<{ itemKey: string; libraryID: number; citationKey: string; pinned: number | null }>(
        'select itemKey, libraryID, citationKey, pinned from citationkey order by itemKey',
      )
      .map((row) => ({
        itemKey: String(row.itemKey),
        libraryID: Number(row.libraryID),
        citationKey: String(row.citationKey),
        pinned: row.pinned === 1,
      }));
  } finally {
    db.close();
  }
};

const groupBy = <TRow>(rows: readonly TRow[], key: (row: TRow) => number): Map<number, TRow[]> => {
  const out = new Map<number, TRow[]>();
  for (const row of rows) {
    const id = key(row);
    const list = out.get(id) ?? [];
    list.push(row);
    out.set(id, list);
  }
  return out;
};
