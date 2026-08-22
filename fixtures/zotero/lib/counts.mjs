/*
 * Recueil — fixtures
 * Copyright (C) 2026 the Recueil authors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Count what was built, and refuse to publish the counts unless they are the counts that were
 * promised.
 *
 * `EXPECTED` below is the promise: numbers written by hand, from the library design, before the
 * generator ever ran. Everything else in this module reads the finished database and compares. A
 * mismatch is a build failure, not a diff to be accepted — which is what stops
 * `expected-counts.json` from degenerating into a record of whatever the generator happened to do.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { open } from './sqlite.mjs';
import { objectKey } from './zotero-values.mjs';
import * as lib from './library.mjs';

/**
 * The stated counts. An importer test should assert against these numbers, and the Phase 1 exit
 * criterion — "own library imported at 100% item count" — is the same assertion against the real
 * library. Change a number here only together with the library it describes.
 */
export const EXPECTED = {
  items: {
    /** Every row in `items`, of every kind, trashed or not. */
    allRows: 103,
    /** Rows that are not a note, an attachment or an annotation. */
    regularRows: 67,
    /** …of those, the ones a library view shows: not in `deletedItems`. */
    regularLive: 64,
    /** …and the ones in the trash. */
    regularTrashed: 3,
  },
  /** Live (not trashed) regular items per Zotero item type. */
  liveByType: {
    journalArticle: 20,
    book: 8,
    bookSection: 7,
    thesis: 5,
    report: 6,
    preprint: 6,
    webpage: 6,
    dataset: 4,
    conferencePaper: 2,
  },
  /** All regular items per type, trash included. */
  allByType: {
    journalArticle: 21,
    book: 9,
    bookSection: 7,
    thesis: 5,
    report: 6,
    preprint: 6,
    webpage: 7,
    dataset: 4,
    conferencePaper: 2,
  },
  notes: { total: 11, child: 9, standalone: 2, trashed: 1, onTrashedParent: 1 },
  attachments: {
    total: 17,
    trashed: 1,
    byLinkMode: { imported_file: 10, imported_url: 2, linked_file: 2, linked_url: 3 },
    /** Rows claiming a file, whose file is on disk (10 in `storage/`, 1 linked, 1 snapshot pair). */
    filesPresent: 12,
    /** Rows claiming a file, whose file is not. This is what the verification report must report. */
    filesMissing: 2,
    standalone: 1,
  },
  annotations: {
    total: 8,
    byType: { highlight: 2, note: 2, image: 1, ink: 1, underline: 1, text: 1 },
    external: 1,
  },
  collections: { total: 9, live: 8, trashed: 1, maxDepth: 3, empty: 1 },
  tags: { total: 23, coloured: 3 },
  creators: { total: 52, singleField: 9 },
  relations: { total: 13, dangling: 3 },
  citationKeys: {
    /** Zotero 8+ native `citationKey` field. */
    nativeField: 3,
    /** The pre-Zotero-8 convention: a `Citation Key:` line in `extra`. */
    extraLine: 2,
    /** Rows in `better-bibtex.sqlite`. */
    betterBibtexRows: 28,
    betterBibtexPinned: 12,
    /** Better BibTeX rows naming items that are not in this library. */
    betterBibtexStale: 2,
    /** Items where the native field, the Extra line and Better BibTeX all disagree. */
    threeWayConflicts: 1,
  },
  storage: { directories: 11, files: 11, linkedFilesOnDisk: 1 },
};

/**
 * Read the built fixture and produce the manifest, asserting it against `EXPECTED` on the way.
 *
 * @param {object} built  the return value of `build()`
 * @param {object} meta   provenance to record alongside the counts
 * @returns {object}
 */
export function measure(built, meta) {
  const db = open(built.dbPath);
  const bbt = open(built.bbtPath);
  /** @type {string[]} */
  const problems = [];
  const check = (label, actual, expected) => {
    if (actual !== expected) problems.push(`${label}: expected ${expected}, built ${actual}`);
    return actual;
  };

  const n = (sql, params = []) => Number(db.value(sql, params));
  const notRegular = "('note', 'attachment', 'annotation')";
  const typeJoin = 'JOIN itemTypes USING (itemTypeID)';
  const live = 'items.itemID NOT IN (SELECT itemID FROM deletedItems)';

  /* -- items ------------------------------------------------------------------------------- */
  const items = {
    allRows: check('items.allRows', n('SELECT COUNT(*) FROM items'), EXPECTED.items.allRows),
    regularRows: check(
      'items.regularRows',
      n(`SELECT COUNT(*) FROM items ${typeJoin} WHERE typeName NOT IN ${notRegular}`),
      EXPECTED.items.regularRows,
    ),
    regularLive: check(
      'items.regularLive',
      n(
        `SELECT COUNT(*) FROM items ${typeJoin} WHERE typeName NOT IN ${notRegular} AND ${live}`,
      ),
      EXPECTED.items.regularLive,
    ),
    regularTrashed: check(
      'items.regularTrashed',
      n(
        `SELECT COUNT(*) FROM items ${typeJoin} WHERE typeName NOT IN ${notRegular} ` +
          'AND items.itemID IN (SELECT itemID FROM deletedItems)',
      ),
      EXPECTED.items.regularTrashed,
    ),
  };

  const liveByType = countsByType(db, `WHERE typeName NOT IN ${notRegular} AND ${live}`);
  const allByType = countsByType(db, `WHERE typeName NOT IN ${notRegular}`);
  compareMaps('liveByType', liveByType, EXPECTED.liveByType, problems);
  compareMaps('allByType', allByType, EXPECTED.allByType, problems);

  /* -- notes ------------------------------------------------------------------------------- */
  const notes = {
    total: check('notes.total', n('SELECT COUNT(*) FROM itemNotes'), EXPECTED.notes.total),
    child: check(
      'notes.child',
      n('SELECT COUNT(*) FROM itemNotes WHERE parentItemID IS NOT NULL'),
      EXPECTED.notes.child,
    ),
    standalone: check(
      'notes.standalone',
      n('SELECT COUNT(*) FROM itemNotes WHERE parentItemID IS NULL'),
      EXPECTED.notes.standalone,
    ),
    trashed: check(
      'notes.trashed',
      n('SELECT COUNT(*) FROM itemNotes WHERE itemID IN (SELECT itemID FROM deletedItems)'),
      EXPECTED.notes.trashed,
    ),
    onTrashedParent: check(
      'notes.onTrashedParent',
      n(
        'SELECT COUNT(*) FROM itemNotes WHERE parentItemID IN (SELECT itemID FROM deletedItems) ' +
          'AND itemID NOT IN (SELECT itemID FROM deletedItems)',
      ),
      EXPECTED.notes.onTrashedParent,
    ),
  };

  /* -- attachments ------------------------------------------------------------------------- */
  const linkModeNames = ['imported_file', 'imported_url', 'linked_file', 'linked_url'];
  const byLinkMode = {};
  linkModeNames.forEach((name, mode) => {
    byLinkMode[name] = n('SELECT COUNT(*) FROM itemAttachments WHERE linkMode = ?', [mode]);
  });
  compareMaps('attachments.byLinkMode', byLinkMode, EXPECTED.attachments.byLinkMode, problems);

  const declaredFiles = lib.attachments.filter((a) => a.linkMode !== 3);
  const attachments = {
    total: check(
      'attachments.total',
      n('SELECT COUNT(*) FROM itemAttachments'),
      EXPECTED.attachments.total,
    ),
    trashed: check(
      'attachments.trashed',
      n('SELECT COUNT(*) FROM itemAttachments WHERE itemID IN (SELECT itemID FROM deletedItems)'),
      EXPECTED.attachments.trashed,
    ),
    byLinkMode,
    filesPresent: check(
      'attachments.filesPresent',
      built.files.length,
      EXPECTED.attachments.filesPresent,
    ),
    filesMissing: check(
      'attachments.filesMissing',
      declaredFiles.length - built.files.length,
      EXPECTED.attachments.filesMissing,
    ),
    standalone: check(
      'attachments.standalone',
      n('SELECT COUNT(*) FROM itemAttachments WHERE parentItemID IS NULL'),
      EXPECTED.attachments.standalone,
    ),
    missing: lib.attachments
      .filter((a) => a.missingOnPurpose)
      .map((a) => ({
        slug: a.slug,
        itemKey: keyOf(db, a.slug),
        linkMode: linkModeNames[a.linkMode],
        reason:
          a.linkMode === 2
            ? 'linked file recorded with an absolute path from another machine'
            : 'stored file recorded in itemAttachments but absent from storage/',
      })),
  };

  /* -- annotations ------------------------------------------------------------------------- */
  const annotationTypeNames = [null, 'highlight', 'note', 'image', 'ink', 'underline', 'text'];
  const annotationsByType = {};
  for (let type = 1; type <= 6; type += 1) {
    annotationsByType[annotationTypeNames[type]] = n(
      'SELECT COUNT(*) FROM itemAnnotations WHERE type = ?',
      [type],
    );
  }
  compareMaps('annotations.byType', annotationsByType, EXPECTED.annotations.byType, problems);
  const annotations = {
    total: check(
      'annotations.total',
      n('SELECT COUNT(*) FROM itemAnnotations'),
      EXPECTED.annotations.total,
    ),
    byType: annotationsByType,
    external: check(
      'annotations.external',
      n('SELECT COUNT(*) FROM itemAnnotations WHERE isExternal = 1'),
      EXPECTED.annotations.external,
    ),
  };

  /* -- collections, tags, creators, relations ----------------------------------------------- */
  const collections = {
    total: check(
      'collections.total',
      n('SELECT COUNT(*) FROM collections'),
      EXPECTED.collections.total,
    ),
    live: check(
      'collections.live',
      n(
        'SELECT COUNT(*) FROM collections WHERE collectionID NOT IN ' +
          '(SELECT collectionID FROM deletedCollections)',
      ),
      EXPECTED.collections.live,
    ),
    trashed: check(
      'collections.trashed',
      n('SELECT COUNT(*) FROM deletedCollections'),
      EXPECTED.collections.trashed,
    ),
    maxDepth: check('collections.maxDepth', collectionDepth(db), EXPECTED.collections.maxDepth),
    empty: check(
      'collections.empty',
      // Live only: the trashed collection is empty too, but that is a consequence of trashing it.
      n(
        'SELECT COUNT(*) FROM collections WHERE collectionID NOT IN ' +
          '(SELECT collectionID FROM collectionItems) AND collectionID NOT IN ' +
          '(SELECT collectionID FROM deletedCollections)',
      ),
      EXPECTED.collections.empty,
    ),
    memberships: n('SELECT COUNT(*) FROM collectionItems'),
  };

  const tags = {
    total: check('tags.total', n('SELECT COUNT(*) FROM tags'), EXPECTED.tags.total),
    manual: n('SELECT COUNT(DISTINCT tagID) FROM itemTags WHERE type = 0'),
    automatic: n('SELECT COUNT(DISTINCT tagID) FROM itemTags WHERE type = 1'),
    assignments: n('SELECT COUNT(*) FROM itemTags'),
    coloured: check('tags.coloured', lib.tagColors.length, EXPECTED.tags.coloured),
  };

  const creators = {
    total: check('creators.total', n('SELECT COUNT(*) FROM creators'), EXPECTED.creators.total),
    singleField: check(
      'creators.singleField',
      n('SELECT COUNT(*) FROM creators WHERE fieldMode = 1'),
      EXPECTED.creators.singleField,
    ),
    assignments: n('SELECT COUNT(*) FROM itemCreators'),
    byType: Object.fromEntries(
      db
        .all(
          'SELECT creatorType AS name, COUNT(*) AS n FROM itemCreators ' +
            'JOIN creatorTypes USING (creatorTypeID) GROUP BY creatorType ORDER BY creatorType',
        )
        .map((row) => [row.name, Number(row.n)]),
    ),
  };

  const relations = {
    total: check(
      'relations.total',
      n('SELECT COUNT(*) FROM itemRelations'),
      EXPECTED.relations.total,
    ),
    byPredicate: Object.fromEntries(
      db
        .all(
          'SELECT predicate AS name, COUNT(*) AS n FROM itemRelations ' +
            'JOIN relationPredicates USING (predicateID) GROUP BY predicate ORDER BY predicate',
        )
        .map((row) => [row.name, Number(row.n)]),
    ),
    dangling: check(
      'relations.dangling',
      lib.relations.filter((r) => typeof r.to !== 'string').length,
      EXPECTED.relations.dangling,
    ),
  };

  /* -- citation keys ------------------------------------------------------------------------ */
  const citationKeys = {
    nativeField: check(
      'citationKeys.nativeField',
      n(
        "SELECT COUNT(*) FROM itemData WHERE fieldID = (SELECT fieldID FROM fields WHERE fieldName = 'citationKey')",
      ),
      EXPECTED.citationKeys.nativeField,
    ),
    extraLine: check(
      'citationKeys.extraLine',
      lib.items.filter((i) => /(^|\n)Citation Key:/.test(i.fields.extra ?? '')).length,
      EXPECTED.citationKeys.extraLine,
    ),
    betterBibtexRows: check(
      'citationKeys.betterBibtexRows',
      Number(bbt.value('SELECT COUNT(*) FROM citationkey')),
      EXPECTED.citationKeys.betterBibtexRows,
    ),
    betterBibtexPinned: check(
      'citationKeys.betterBibtexPinned',
      Number(bbt.value('SELECT COUNT(*) FROM citationkey WHERE pinned = 1')),
      EXPECTED.citationKeys.betterBibtexPinned,
    ),
    betterBibtexStale: check(
      'citationKeys.betterBibtexStale',
      lib.betterBibtexKeys.filter((row) => !row.item).length,
      EXPECTED.citationKeys.betterBibtexStale,
    ),
    threeWayConflicts: check(
      'citationKeys.threeWayConflicts',
      countThreeWayConflicts(),
      EXPECTED.citationKeys.threeWayConflicts,
    ),
  };

  /* -- storage ------------------------------------------------------------------------------ */
  const storageEntries = fs.existsSync(built.storageDir)
    ? fs.readdirSync(built.storageDir).sort()
    : [];
  const storage = {
    directories: check('storage.directories', storageEntries.length, EXPECTED.storage.directories),
    files: check(
      'storage.files',
      built.files.filter((f) => f.path.startsWith('storage')).length,
      EXPECTED.storage.files,
    ),
    linkedFilesOnDisk: check(
      'storage.linkedFilesOnDisk',
      built.files.filter((f) => f.path.startsWith('linked-attachments')).length,
      EXPECTED.storage.linkedFilesOnDisk,
    ),
    totalBytes: built.files.reduce((sum, f) => sum + f.bytes, 0),
    contents: built.files.map((f) => ({
      slug: f.slug,
      itemKey: f.itemKey,
      path: f.path,
      bytes: f.bytes,
      contentType: f.contentType,
      md5: f.md5,
      sha256: f.sha256,
    })),
  };

  /* -- identifiers -------------------------------------------------------------------------- */
  const itemTypeIds = Object.fromEntries(
    db
      .all(
        'SELECT typeName AS name, itemTypeID AS id FROM itemTypes ORDER BY itemTypeID',
      )
      .map((row) => [row.name, Number(row.id)]),
  );

  db.close();
  bbt.close();

  if (problems.length) {
    throw new Error(
      `the built fixture does not match the stated counts:\n  - ${problems.join('\n  - ')}`,
    );
  }

  return {
    $schema: 'https://recueil.invalid/fixtures/expected-counts',
    description:
      'Counts asserted by the fixture generator against the numbers stated in ' +
      'fixtures/zotero/lib/counts.mjs. Importer tests should assert against these, not against ' +
      'whatever an importer happens to produce.',
    generatedBy: 'fixtures/zotero/make-fixture.mjs',
    ...meta,
    zotero: {
      identifierLayout: built.idLayout,
      itemTypeIds,
      library: { libraryID: 1, type: 'user', localUserKey: lib.LOCAL_USER_KEY },
      items,
      liveByType,
      allByType,
      notes,
      attachments,
      annotations,
      collections,
      tags,
      creators,
      relations,
      citationKeys,
      storage,
    },
  };

  function countThreeWayConflicts() {
    const bbtByItem = new Map(lib.betterBibtexKeys.filter((r) => r.item).map((r) => [r.item, r.key]));
    return lib.items.filter((item) => {
      const native = item.fields.citationKey;
      const extra = /(^|\n)Citation Key:\s*(\S+)/.exec(item.fields.extra ?? '')?.[2];
      const pinned = bbtByItem.get(item.slug);
      const distinct = new Set([native, extra, pinned].filter(Boolean));
      return native && extra && pinned && distinct.size === 3;
    }).length;
  }
}

function countsByType(db, where) {
  return Object.fromEntries(
    db
      .all(
        `SELECT typeName AS name, COUNT(*) AS n FROM items JOIN itemTypes USING (itemTypeID) ` +
          `${where} GROUP BY typeName ORDER BY typeName`,
      )
      .map((row) => [row.name, Number(row.n)]),
  );
}

function compareMaps(label, actual, expected, problems) {
  for (const key of new Set([...Object.keys(actual), ...Object.keys(expected)])) {
    if ((actual[key] ?? 0) !== (expected[key] ?? 0)) {
      problems.push(`${label}.${key}: expected ${expected[key] ?? 0}, built ${actual[key] ?? 0}`);
    }
  }
}

function collectionDepth(db) {
  const rows = db.all('SELECT collectionID AS id, parentCollectionID AS parent FROM collections');
  const parents = new Map(rows.map((r) => [Number(r.id), r.parent === null ? null : Number(r.parent)]));
  let deepest = 0;
  for (const id of parents.keys()) {
    let depth = 1;
    let cursor = parents.get(id);
    while (cursor !== null && cursor !== undefined) {
      depth += 1;
      cursor = parents.get(cursor);
    }
    deepest = Math.max(deepest, depth);
  }
  return deepest;
}

/**
 * The slug is not in the database; the key derived from it is. Recomputing it keeps the manifest
 * self-describing without threading the builder's slug map through the counting pass.
 */
function keyOf(_db, slug) {
  return objectKey(`item:${slug}`);
}

/**
 * A hash of everything the database *says*, independent of how SQLite laid the pages out.
 *
 * Two builds of the same fixture on different SQLite versions differ byte for byte and not at all
 * in content; this is how `--check` tells those two situations apart.
 *
 * @param {string} dbPath
 * @returns {string} hex SHA-256
 */
export function logicalDigest(dbPath) {
  const db = open(dbPath);
  const hash = createHash('sha256');
  const tables = db
    .all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map((row) => String(row.name));
  for (const table of tables) {
    hash.update(`|table:${table}`);
    // No ORDER BY: the row order a table scan returns is itself part of what was written, and both
    // drivers return it identically for the same file content.
    for (const row of db.all(`SELECT * FROM "${table}"`)) {
      hash.update(JSON.stringify(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : 1))));
    }
  }
  db.close();
  return hash.digest('hex');
}

/**
 * Write the manifest.
 *
 * @param {string} file
 * @param {object} manifest
 */
export function writeManifest(file, manifest) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}
