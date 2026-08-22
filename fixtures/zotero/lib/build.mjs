/*
 * Recueil — fixtures
 * Copyright (C) 2026 the Recueil authors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Turn `library.mjs` into a `zotero.sqlite`, a `storage/` directory and a `better-bibtex.sqlite`.
 *
 * The database is built the way Zotero builds one — its own `system.sql`, `userdata.sql` and
 * `triggers.sql`, then its own global-schema pass — and then filled through the same tables its own
 * code writes to. The triggers stay armed and foreign keys stay on throughout, so an insert this
 * module gets wrong is an insert SQLite refuses, not a fixture that quietly lies.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { open, stripStatementHack } from './sqlite.mjs';
import { applyGlobalSchema, rebuildCombinedTables } from './global-schema.mjs';
import { minimalPdf, snapshotHtml, asciiFold } from './documents.mjs';
import {
  objectKey,
  sqlDateTime,
  storageHash,
  sha256,
  localItemUri,
  groupItemUri,
  LINK_MODE,
  STORAGE_PREFIX,
  LINKED_PREFIX,
} from './zotero-values.mjs';
import * as lib from './library.mjs';

/** The one and only library in the fixture: `libraryID` 1, `type` 'user'. */
const LIBRARY_ID = 1;

/**
 * Build the whole fixture.
 *
 * @param {object} options
 * @param {string} options.outDir       directory to write into (created if absent)
 * @param {string} options.schemaDir    directory holding the vendored upstream SQL and JSON
 * @param {'legacy' | 'fresh'} options.idLayout
 * @returns {object} the manifest the counts module turns into `expected-counts.json`
 */
export function build({ outDir, schemaDir, idLayout }) {
  fs.mkdirSync(outDir, { recursive: true });

  const dbPath = path.join(outDir, 'zotero.sqlite');
  const bbtPath = path.join(outDir, 'better-bibtex.sqlite');
  const storageDir = path.join(outDir, 'storage');
  const linkedDir = path.join(outDir, 'linked-attachments');
  for (const p of [dbPath, bbtPath]) if (fs.existsSync(p)) fs.rmSync(p);
  for (const dir of [storageDir, linkedDir]) fs.rmSync(dir, { recursive: true, force: true });

  const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, 'global-schema.json'), 'utf8'));
  const sql = (name) => fs.readFileSync(path.join(schemaDir, name), 'utf8');
  const versionOf = (name) => {
    const match = /^--\s*(\d+)/.exec(sql(name));
    if (!match) throw new Error(`${name} has no version comment on its first line`);
    return Number(match[1]);
  };

  const db = open(dbPath);
  // Zotero sets these on a fresh profile in `_initializeSchema()`.
  db.exec('PRAGMA page_size = 4096');
  db.exec("PRAGMA encoding = 'UTF-8'");
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(stripStatementHack(sql('system.sql')));
  db.exec(stripStatementHack(sql('userdata.sql')));
  db.exec(stripStatementHack(sql('triggers.sql')));

  if (idLayout === 'legacy') db.exec(stripStatementHack(sql('system-107.sql')));
  const ids = applyGlobalSchema(db, schema, idLayout);
  rebuildCombinedTables(db);

  db.run('INSERT INTO version (schema, version) VALUES (?, ?)', ['system', versionOf('system.sql')]);
  db.run('INSERT INTO version (schema, version) VALUES (?, ?)', [
    'userdata',
    versionOf('userdata.sql'),
  ]);
  db.run('INSERT INTO version (schema, version) VALUES (?, ?)', [
    'triggers',
    versionOf('triggers.sql'),
  ]);
  db.run('INSERT INTO version (schema, version) VALUES (?, ?)', ['globalSchema', schema.version]);
  // `compatibility` is what Zotero refuses to open a newer database on; `_maxCompatibility` is 7
  // in Zotero 7 and later.
  db.run('INSERT INTO version (schema, version) VALUES (?, ?)', ['compatibility', 7]);

  db.run('INSERT INTO libraries (libraryID, type, editable, filesEditable) VALUES (?, ?, 1, 1)', [
    LIBRARY_ID,
    'user',
  ]);

  // Zotero deflates the global schema minus its `itemTypes` into `settings`. `pako.deflate` writes
  // a zlib stream, which is what `zlib.deflateSync` writes too.
  const settingsBlob = { ...schema };
  delete settingsBlob.itemTypes;
  db.run('INSERT INTO settings (setting, key, value) VALUES (?, ?, ?)', [
    'globalSchema',
    'data',
    zlib.deflateSync(Buffer.from(JSON.stringify(settingsBlob), 'utf8')),
  ]);
  db.run('INSERT INTO settings (setting, key, value) VALUES (?, ?, ?)', [
    'account',
    'localUserKey',
    lib.LOCAL_USER_KEY,
  ]);
  db.run('INSERT INTO settings (setting, key, value) VALUES (?, ?, ?)', [
    'client',
    'lastCompatibleVersion',
    '10.0.0',
  ]);

  const fieldsByType = allowedFields(schema);
  const creatorTypesByType = allowedCreatorTypes(schema);

  const state = {
    db,
    ids,
    fieldsByType,
    creatorTypesByType,
    nextItemId: 1,
    nextValueId: 1,
    valueIds: new Map(),
    tagIds: new Map(),
    predicateIds: new Map(),
    creatorIds: new Map(),
    /** @type {Map<string, { id: number, key: string }>} slug → item */
    bySlug: new Map(),
    collectionIds: new Map(),
    storedFiles: [],
  };

  insertCollections(state);
  for (const item of lib.items) insertRegularItem(state, item);
  for (const note of lib.notes) insertNote(state, note);
  const files = insertAttachments(state, { storageDir, linkedDir });
  insertAnnotations(state);
  insertRelations(state);
  insertTagColors(state);

  db.exec('VACUUM');
  db.close();

  buildBetterBibtex({ bbtPath, schemaDir, bySlug: state.bySlug });

  return { dbPath, bbtPath, storageDir, linkedDir, files, idLayout, schemaVersion: schema.version };
}

/* ------------------------------------------------------------------------------------------------ */
/* Schema-derived validation                                                                          */
/* ------------------------------------------------------------------------------------------------ */

/** @returns {Map<string, Set<string>>} item type → the field names Zotero permits on it */
function allowedFields(schema) {
  const map = new Map();
  for (const { itemType, fields } of schema.itemTypes) {
    map.set(itemType, new Set(fields.map((f) => f.field)));
  }
  return map;
}

/** @returns {Map<string, Set<string>>} item type → the creator types Zotero permits on it */
function allowedCreatorTypes(schema) {
  const map = new Map();
  for (const { itemType, creatorTypes } of schema.itemTypes) {
    map.set(itemType, new Set(creatorTypes.map((c) => c.creatorType)));
  }
  return map;
}

/* ------------------------------------------------------------------------------------------------ */
/* Writers                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

function insertCollections(state) {
  const { db } = state;
  let id = 1;
  for (const collection of lib.collections) {
    const key = objectKey(`collection:${collection.slug}`);
    const parentId = collection.parent ? state.collectionIds.get(collection.parent) : null;
    if (collection.parent && parentId === undefined) {
      throw new Error(`collection ${collection.slug} names an unknown parent`);
    }
    db.run(
      'INSERT INTO collections (collectionID, collectionName, parentCollectionID, ' +
        'clientDateModified, libraryID, key, version, clientVersion, synced) ' +
        'VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0)',
      [id, collection.name, parentId, sqlDateTime('2024-06-01T12:00:00Z'), LIBRARY_ID, key],
    );
    if (collection.trashed) {
      db.run('INSERT INTO deletedCollections (collectionID, dateDeleted) VALUES (?, ?)', [
        id,
        sqlDateTime(collection.trashed),
      ]);
    }
    state.collectionIds.set(collection.slug, id);
    id += 1;
  }
}

function insertRegularItem(state, item) {
  const { db } = state;
  const itemId = newItem(state, {
    slug: item.slug,
    type: item.type,
    added: item.added,
    modified: item.modified,
  });

  const allowed = state.fieldsByType.get(item.type);
  if (!allowed) throw new Error(`unknown item type ${item.type} on ${item.slug}`);
  for (const [field, value] of Object.entries(item.fields)) {
    if (!allowed.has(field)) {
      throw new Error(`Zotero does not allow field "${field}" on a ${item.type} (${item.slug})`);
    }
    writeField(state, itemId, field, value);
  }

  writeCreators(state, itemId, item);
  writeTags(state, itemId, item.tags ?? []);
  writeCollections(state, itemId, item.collections ?? [], item.slug);

  if (item.trashed) {
    db.run('INSERT INTO deletedItems (itemID, dateDeleted) VALUES (?, ?)', [
      itemId,
      sqlDateTime(item.trashed),
    ]);
  }
  if (item.retracted) {
    // Zotero caches the Retraction Watch record here. The payload shape is Zotero's; only the
    // presence of the row matters to an importer, which should carry the flag across.
    db.run('INSERT INTO retractedItems (itemID, data, flag) VALUES (?, ?, 1)', [
      itemId,
      JSON.stringify({ date: '2022-09-14', reason: ['Error in Data'], doi: item.fields.DOI }),
    ]);
  }
}

function insertNote(state, note) {
  const { db } = state;
  const itemId = newItem(state, {
    slug: note.slug,
    type: 'note',
    added: note.added,
    modified: note.modified,
  });
  const parentId = note.parent ? requireItem(state, note.parent, note.slug).id : null;
  db.run('INSERT INTO itemNotes (itemID, parentItemID, note, title) VALUES (?, ?, ?, ?)', [
    itemId,
    parentId,
    note.html,
    note.title,
  ]);
  writeTags(state, itemId, note.tags ?? []);
  // Zotero's `fki_collectionItems_itemID_parentItemID` trigger forbids a child note in a
  // collection, so only standalone notes may carry one.
  if (note.collections?.length && parentId !== null) {
    throw new Error(`child note ${note.slug} cannot be in a collection`);
  }
  writeCollections(state, itemId, note.collections ?? [], note.slug);
  if (note.trashed) {
    db.run('INSERT INTO deletedItems (itemID, dateDeleted) VALUES (?, ?)', [
      itemId,
      sqlDateTime(note.trashed),
    ]);
  }
}

function insertAttachments(state, { storageDir, linkedDir }) {
  const { db } = state;
  /** @type {Array<object>} what ended up on disk, for the manifest */
  const written = [];

  for (const attachment of lib.attachments) {
    const itemId = newItem(state, {
      slug: attachment.slug,
      type: 'attachment',
      added: attachment.added,
      modified: attachment.modified,
    });
    const key = state.bySlug.get(attachment.slug).key;
    const parentId = attachment.parent ? requireItem(state, attachment.parent, attachment.slug).id : null;

    // An attachment's title, url and accessDate are ordinary `itemData` rows — the only three
    // fields the `attachment` item type has.
    writeField(state, itemId, 'title', attachment.title);
    if (attachment.url) writeField(state, itemId, 'url', attachment.url);
    if (attachment.accessDate) writeField(state, itemId, 'accessDate', attachment.accessDate);

    let storedPath = null;
    let hash = null;
    let modTime = null;

    if (attachment.linkMode === LINK_MODE.linked_file) {
      storedPath = attachment.absolutePath ?? `${LINKED_PREFIX}${attachment.linkedPath}`;
    } else if (attachment.linkMode !== LINK_MODE.linked_url) {
      storedPath = `${STORAGE_PREFIX}${attachment.filename}`;
    }

    if (attachment.file) {
      const bytes = renderFile(attachment);
      const target =
        attachment.linkMode === LINK_MODE.linked_file
          ? path.join(linkedDir, attachment.linkedPath)
          : path.join(storageDir, key, attachment.filename);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
      hash = storageHash(bytes);
      modTime = Date.parse(attachment.modified);
      written.push({
        slug: attachment.slug,
        itemKey: key,
        path: path.relative(path.dirname(storageDir), target),
        bytes: bytes.length,
        md5: hash,
        sha256: sha256(bytes),
        contentType: attachment.contentType,
      });
    }

    db.run(
      'INSERT INTO itemAttachments (itemID, parentItemID, linkMode, contentType, charsetID, ' +
        'path, syncState, storageModTime, storageHash, lastProcessedModificationTime, lastRead) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)',
      [
        itemId,
        parentId,
        attachment.linkMode,
        attachment.contentType ?? null,
        attachment.charset ? charsetId(state, attachment.charset) : null,
        storedPath,
        // syncState 1 is Zotero's SYNC_STATE_TO_UPLOAD; 0 is TO_DOWNLOAD. A file that exists
        // locally and has a hash is `IN_SYNC` (3) once the server has it.
        attachment.file ? 3 : 0,
        modTime,
        hash,
      ],
    );

    if (attachment.collections?.length && parentId !== null) {
      throw new Error(`child attachment ${attachment.slug} cannot be in a collection`);
    }
    writeCollections(state, itemId, attachment.collections ?? [], attachment.slug);
    writeTags(state, itemId, attachment.tags ?? []);

    if (attachment.trashed) {
      db.run('INSERT INTO deletedItems (itemID, dateDeleted) VALUES (?, ?)', [
        itemId,
        sqlDateTime(attachment.trashed),
      ]);
    }
  }

  return written;
}

function renderFile(attachment) {
  if (attachment.file.kind === 'pdf') {
    return minimalPdf({
      title: attachment.file.title,
      lines: [
        asciiFold(attachment.file.title),
        '',
        'This is a generated fixture document. It carries no content of its own;',
        'it exists so that a Recueil importer has real bytes to hash, a real MIME',
        'type to sniff and a real file to fail to find when one is missing.',
        '',
        `Zotero attachment: ${attachment.slug}`,
      ],
    });
  }
  if (attachment.file.kind === 'html') {
    return snapshotHtml({
      title: attachment.file.title,
      url: attachment.url,
      body: attachment.file.body,
    });
  }
  throw new Error(`unknown file kind ${attachment.file.kind}`);
}

function insertAnnotations(state) {
  const { db } = state;
  const parentOf = new Map();
  for (const attachment of lib.attachments) {
    for (const slug of attachment.annotations ?? []) parentOf.set(slug, attachment.slug);
  }

  for (const annotation of lib.annotations) {
    const parentSlug = parentOf.get(annotation.slug);
    if (!parentSlug) throw new Error(`annotation ${annotation.slug} is on no attachment`);
    const itemId = newItem(state, {
      slug: annotation.slug,
      type: 'annotation',
      added: annotation.added,
      modified: annotation.modified,
    });
    db.run(
      'INSERT INTO itemAnnotations (itemID, parentItemID, type, authorName, text, ' +
        'textNormalized, comment, commentNormalized, color, pageLabel, sortIndex, position, ' +
        'isExternal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        itemId,
        requireItem(state, parentSlug, annotation.slug).id,
        annotation.type,
        annotation.authorName ?? null,
        annotation.text ?? null,
        normalize(annotation.text),
        annotation.comment ?? null,
        normalize(annotation.comment),
        annotation.color,
        annotation.pageLabel ?? null,
        annotation.sortIndex,
        JSON.stringify(annotation.position),
        annotation.isExternal ? 1 : 0,
      ],
    );
    writeTags(state, itemId, annotation.tags ?? []);
  }
}

/**
 * The `*Normalized` columns arrived with userdata 126 to back accent-insensitive search. Zotero
 * fills them by lower-casing and stripping combining marks (`Zotero.Utilities.normalizeToSearch`
 * in `schema.js`'s migration). Reproduced here so the columns are not misleadingly empty.
 */
function normalize(value) {
  if (!value) return null;
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function insertRelations(state) {
  const { db } = state;
  for (const relation of lib.relations) {
    const subject = requireItem(state, relation.from, 'relation');
    let object;
    if (typeof relation.to === 'string') {
      object = localItemUri(lib.LOCAL_USER_KEY, requireItem(state, relation.to, 'relation').key);
    } else if (relation.to.group) {
      object = groupItemUri(lib.FORMER_GROUP_ID, relation.to.group);
    } else {
      object = localItemUri(lib.LOCAL_USER_KEY, relation.to.danglingKey);
    }
    db.run('INSERT INTO itemRelations (itemID, predicateID, object) VALUES (?, ?, ?)', [
      subject.id,
      predicateId(state, relation.predicate),
      object,
    ]);
  }
}

function insertTagColors(state) {
  const { db } = state;
  db.run(
    'INSERT INTO syncedSettings (setting, libraryID, value, version, synced) VALUES (?, ?, ?, 0, 0)',
    ['tagColors', LIBRARY_ID, JSON.stringify(lib.tagColors)],
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Row helpers                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

function newItem(state, { slug, type, added, modified }) {
  if (state.bySlug.has(slug)) throw new Error(`duplicate slug ${slug}`);
  const itemTypeId = state.ids.itemTypeIds.get(type);
  if (itemTypeId === undefined) throw new Error(`no itemTypeID for ${type}`);
  const id = state.nextItemId++;
  const key = objectKey(`item:${slug}`);
  state.db.run(
    'INSERT INTO items (itemID, itemTypeID, dateAdded, dateModified, clientDateModified, ' +
      'libraryID, key, version, clientVersion, synced) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0)',
    [id, itemTypeId, sqlDateTime(added), sqlDateTime(modified), sqlDateTime(modified), LIBRARY_ID, key],
  );
  state.bySlug.set(slug, { id, key, slug, type });
  return id;
}

function requireItem(state, slug, context) {
  const found = state.bySlug.get(slug);
  if (!found) throw new Error(`${context} refers to unknown item ${slug}`);
  return found;
}

function writeField(state, itemId, field, value) {
  const fieldId = state.ids.fieldIds.get(field);
  if (fieldId === undefined) throw new Error(`no fieldID for ${field}`);
  state.db.run('INSERT INTO itemData (itemID, fieldID, valueID) VALUES (?, ?, ?)', [
    itemId,
    fieldId,
    valueId(state, value),
  ]);
}

/** `itemDataValues` is deduplicated across the whole library; two items sharing a title share a row. */
function valueId(state, value) {
  const existing = state.valueIds.get(value);
  if (existing !== undefined) return existing;
  const id = state.nextValueId++;
  state.db.run('INSERT INTO itemDataValues (valueID, value, valueNormalized) VALUES (?, ?, ?)', [
    id,
    value,
    normalize(value),
  ]);
  state.valueIds.set(value, id);
  return id;
}

function writeCreators(state, itemId, item) {
  const allowed = state.creatorTypesByType.get(item.type);
  let orderIndex = 0;
  for (const creator of item.creators ?? []) {
    if (!allowed.has(creator.type)) {
      throw new Error(
        `Zotero does not allow creator type "${creator.type}" on a ${item.type} (${item.slug})`,
      );
    }
    const creatorTypeId = state.ids.creatorTypeIds.get(creator.type);
    state.db.run(
      'INSERT INTO itemCreators (itemID, creatorID, creatorTypeID, orderIndex) VALUES (?, ?, ?, ?)',
      [itemId, creatorId(state, creator), creatorTypeId, orderIndex],
    );
    orderIndex += 1;
  }
}

/**
 * `creators` is unique on `(lastName, firstName, fieldMode)`, so one person is one row however many
 * items cite them. A single-field name puts the whole name in `lastName` and an empty string — not
 * NULL — in `firstName`, which is what `fieldMode` 1 means.
 */
function creatorId(state, creator) {
  const fieldMode = creator.name ? 1 : 0;
  const lastName = creator.name ?? creator.last;
  const firstName = creator.name ? '' : creator.first;
  const cacheKey = `${fieldMode} ${lastName} ${firstName}`;
  const existing = state.creatorIds.get(cacheKey);
  if (existing !== undefined) return existing;
  const id = state.creatorIds.size + 1;
  state.db.run(
    'INSERT INTO creators (creatorID, firstName, lastName, fieldMode, firstNameNormalized, ' +
      'lastNameNormalized) VALUES (?, ?, ?, ?, ?, ?)',
    [id, firstName, lastName, fieldMode, normalize(firstName) ?? '', normalize(lastName)],
  );
  state.creatorIds.set(cacheKey, id);
  return id;
}

function writeTags(state, itemId, tags) {
  for (const [name, type] of tags) {
    state.db.run('INSERT INTO itemTags (itemID, tagID, type) VALUES (?, ?, ?)', [
      itemId,
      tagId(state, name),
      type,
    ]);
  }
}

function tagId(state, name) {
  const existing = state.tagIds.get(name);
  if (existing !== undefined) return existing;
  const id = state.tagIds.size + 1;
  state.db.run('INSERT INTO tags (tagID, name, nameNormalized) VALUES (?, ?, ?)', [
    id,
    name,
    normalize(name),
  ]);
  state.tagIds.set(name, id);
  return id;
}

function predicateId(state, predicate) {
  const existing = state.predicateIds.get(predicate);
  if (existing !== undefined) return existing;
  const id = state.predicateIds.size + 1;
  state.db.run('INSERT INTO relationPredicates (predicateID, predicate) VALUES (?, ?)', [
    id,
    predicate,
  ]);
  state.predicateIds.set(predicate, id);
  return id;
}

function writeCollections(state, itemId, slugs, context) {
  let orderIndex = 0;
  for (const slug of slugs) {
    const collectionId = state.collectionIds.get(slug);
    if (collectionId === undefined) throw new Error(`${context} names unknown collection ${slug}`);
    state.db.run(
      'INSERT INTO collectionItems (collectionID, itemID, orderIndex) VALUES (?, ?, ?)',
      [collectionId, itemId, orderIndex],
    );
    orderIndex += 1;
  }
}

function charsetId(state, charset) {
  const id = state.db.value('SELECT charsetID FROM charsets WHERE charset = ?', [charset]);
  if (id === undefined) throw new Error(`system.sql knows no charset ${charset}`);
  return Number(id);
}

/* ------------------------------------------------------------------------------------------------ */
/* Better BibTeX                                                                                      */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Write `better-bibtex.sqlite` from Better BibTeX's own DDL. Upstream runs it against an `ATTACH`ed
 * database under the schema name `betterbibtex`; opened on its own, as an importer opens it, the
 * objects are unqualified — which is the only change made here.
 */
function buildBetterBibtex({ bbtPath, schemaDir, bySlug }) {
  const ddl = fs
    .readFileSync(path.join(schemaDir, 'better-bibtex-citation-key.sql'), 'utf8')
    .replaceAll('betterbibtex.', '')
    .split('\n--\n');

  const db = open(bbtPath);
  for (const statement of ddl) {
    const trimmed = statement.trim();
    if (trimmed) db.exec(trimmed);
  }

  // Stale rows name item ids that were never in this library. Better BibTeX allocates them from
  // Zotero's `itemID` sequence, so they are plausible integers well above anything the fixture uses.
  let staleId = 8814;
  for (const row of lib.betterBibtexKeys) {
    const item = row.item ? bySlug.get(row.item) : null;
    if (row.item && !item) throw new Error(`better-bibtex row names unknown item ${row.item}`);
    db.run(
      'INSERT INTO citationkey (itemID, itemKey, libraryID, citationKey, pinned) ' +
        'VALUES (?, ?, ?, ?, ?)',
      [
        item ? item.id : staleId,
        item ? item.key : objectKey(`stale:${row.stale}`),
        LIBRARY_ID,
        row.key,
        row.pinned ? 1 : 0,
      ],
    );
    if (!item) staleId += 188;
  }

  db.exec('VACUUM');
  db.close();
}
