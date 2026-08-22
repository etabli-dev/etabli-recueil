/*
 * Recueil — fixtures
 * Copyright (C) 2026 the Recueil authors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * A faithful replay of Zotero's `_updateGlobalSchema()`
 * (`chrome/content/zotero/xpcom/schema.js`), which is what fills `itemTypes`, `fields`,
 * `creatorTypes`, `itemTypeFields`, `baseFieldMappings` and `itemTypeCreatorTypes`.
 *
 * Reproducing the algorithm rather than inventing identifiers matters because the identifiers a
 * real library carries are an accident of its history, and an importer that hard-codes
 * `itemTypeID = 4` for `journalArticle` is wrong on some libraries and right on others. This module
 * can produce both, so that the importer can be tested against both.
 *
 * The rules, from the upstream source:
 *
 * - New identifiers come from `Zotero.ID.get(table)`, which is `MAX(id) + 1`
 *   (`chrome/content/zotero/xpcom/id.js`). Existing names keep their identifiers.
 * - Fields and creator types are allocated first, in the order the schema's `itemTypes` array
 *   mentions them (a `Set`, so first mention wins), and a `baseField` counts as a mention.
 * - Item types are then walked in schema order; each unknown name gets the next id.
 * - `itemTypeFields`, `baseFieldMappings` and `itemTypeCreatorTypes` are emptied and rebuilt in
 *   full on every run, so their contents depend only on the schema, never on history.
 */

/**
 * The order in which item types entered Zotero's global schema, from the commit history of
 * `zotero/zotero-schema`. A library created before a given date has the types above it and not the
 * ones below, and its identifiers reflect exactly that.
 *
 * - everything in `system-107.sql`  — up to Zotero 4, ids 1–36
 * - `annotation`                     — 2021-03-03, "Add 'annotation' type and update locales"
 * - `preprint`                       — 2022-03-03, "Add `preprint` item type"
 * - `dataset`, `standard`            — 2023-03-23, "Add Dataset and Standard item types"
 *
 * Replaying the stages in order gives `annotation` 37, `preprint` 38, `dataset` 39 and
 * `standard` 40 — which is what a library carried over from Zotero 4 actually holds.
 */
export const LEGACY_STAGES = [
  { after: null, adds: [] },
  { after: '2021-03-03', adds: ['annotation'] },
  { after: '2022-03-03', adds: ['preprint'] },
  { after: '2023-03-23', adds: ['dataset', 'standard'] },
];

const LATE_TYPES = new Set(LEGACY_STAGES.flatMap((stage) => stage.adds));

/**
 * Apply the global schema to a database, the way Zotero does.
 *
 * @param {import('./sqlite.mjs').Db} db
 * @param {{ version: number, itemTypes: Array<object> }} schema  the reduced `global-schema.json`
 * @param {'legacy' | 'fresh'} layout
 *   `legacy` seeds from `system-107.sql` (already loaded by the caller) and replays the four stages
 *   above; `fresh` is the single pass a brand-new Zotero profile makes over empty tables.
 * @returns {{ itemTypeIds: Map<string, number>, fieldIds: Map<string, number>,
 *             creatorTypeIds: Map<string, number> }}
 */
export function applyGlobalSchema(db, schema, layout) {
  if (layout === 'fresh') {
    applyOnce(db, schema.itemTypes);
  } else {
    // Stage 0 is the schema as it stood before any of the late types existed. Later stages
    // reintroduce them one commit at a time, so that each gets the identifier its date earned.
    let allowed = new Set(
      schema.itemTypes.map((t) => t.itemType).filter((name) => !LATE_TYPES.has(name)),
    );
    for (const stage of LEGACY_STAGES) {
      for (const name of stage.adds) allowed.add(name);
      applyOnce(
        db,
        schema.itemTypes.filter((t) => allowed.has(t.itemType)),
      );
    }
  }

  return {
    itemTypeIds: readMap(db, 'SELECT typeName AS name, itemTypeID AS id FROM itemTypes'),
    fieldIds: readMap(db, 'SELECT fieldName AS name, fieldID AS id FROM fields'),
    creatorTypeIds: readMap(db, 'SELECT creatorType AS name, creatorTypeID AS id FROM creatorTypes'),
  };
}

/**
 * One pass of `_updateGlobalSchema()` over the given item types.
 *
 * @param {import('./sqlite.mjs').Db} db
 * @param {Array<object>} itemTypes
 */
function applyOnce(db, itemTypes) {
  const nextId = {
    itemTypes: nextFor(db, 'itemTypes', 'itemTypeID'),
    fields: nextFor(db, 'fields', 'fieldID'),
    creatorTypes: nextFor(db, 'creatorTypes', 'creatorTypeID'),
  };

  const itemTypeIds = readMap(db, 'SELECT typeName AS name, itemTypeID AS id FROM itemTypes');
  const fieldIds = readMap(db, 'SELECT fieldName AS name, fieldID AS id FROM fields');
  const creatorTypeIds = readMap(
    db,
    'SELECT creatorType AS name, creatorTypeID AS id FROM creatorTypes',
  );

  // Fields and creator types first, in order of first mention. `baseField` counts as a mention,
  // which is how `medium` exists even though no item type has a plain `medium` field.
  const mentionedFields = new Set();
  const mentionedCreatorTypes = new Set();
  for (const { fields, creatorTypes } of itemTypes) {
    for (const { field, baseField } of fields) {
      mentionedFields.add(field);
      if (baseField) mentionedFields.add(baseField);
    }
    for (const { creatorType } of creatorTypes) mentionedCreatorTypes.add(creatorType);
  }

  for (const field of mentionedFields) {
    if (fieldIds.has(field)) continue;
    const id = nextId.fields++;
    db.run('INSERT INTO fields VALUES (?, ?, NULL)', [id, field]);
    fieldIds.set(field, id);
  }
  for (const type of mentionedCreatorTypes) {
    if (creatorTypeIds.has(type)) continue;
    const id = nextId.creatorTypes++;
    db.run('INSERT INTO creatorTypes VALUES (?, ?)', [id, type]);
    creatorTypeIds.set(type, id);
  }

  const typeFieldRows = [];
  const baseFieldRows = [];
  const typeCreatorRows = [];

  for (const { itemType, fields, creatorTypes } of itemTypes) {
    let itemTypeId = itemTypeIds.get(itemType);
    if (itemTypeId === undefined) {
      itemTypeId = nextId.itemTypes++;
      // Upstream inserts new types with `templateItemTypeID` NULL and `display` 1.
      db.run('INSERT INTO itemTypes VALUES (?, ?, NULL, 1)', [itemTypeId, itemType]);
      itemTypeIds.set(itemType, itemTypeId);
    }

    let orderIndex = 0;
    for (const { field, baseField } of fields) {
      const fieldId = fieldIds.get(field);
      typeFieldRows.push([itemTypeId, fieldId, 0, orderIndex]);
      orderIndex += 1;
      if (baseField) baseFieldRows.push([itemTypeId, fieldIds.get(baseField), fieldId]);
    }
    for (const { creatorType, primary } of creatorTypes) {
      typeCreatorRows.push([itemTypeId, creatorTypeIds.get(creatorType), primary ? 1 : 0]);
    }
  }

  db.exec('DELETE FROM itemTypeFields');
  db.exec('DELETE FROM baseFieldMappings');
  db.exec('DELETE FROM itemTypeCreatorTypes');
  for (const row of typeFieldRows) db.run('INSERT INTO itemTypeFields VALUES (?, ?, ?, ?)', row);
  for (const row of baseFieldRows) db.run('INSERT INTO baseFieldMappings VALUES (?, ?, ?)', row);
  for (const row of typeCreatorRows) {
    db.run('INSERT INTO itemTypeCreatorTypes VALUES (?, ?, ?)', row);
  }
}

/**
 * Zotero rebuilds the `*Combined` views-as-tables at startup from the real tables plus the (always
 * empty, in practice) `custom*` tables — `_updateCustomTables()` in `schema.js`. A library on disk
 * always has them populated, so the fixture must too: `itemData.fieldID` is declared as a foreign
 * key into `fieldsCombined`, not into `fields`.
 *
 * @param {import('./sqlite.mjs').Db} db
 */
export function rebuildCombinedTables(db) {
  const offset = 10000; // Zotero.ItemTypes.customIDOffset

  db.exec('DELETE FROM itemTypesCombined');
  db.exec('DELETE FROM fieldsCombined');
  db.exec('DELETE FROM itemTypeFieldsCombined');
  db.exec('DELETE FROM baseFieldMappingsCombined');

  db.exec(
    'INSERT INTO itemTypesCombined ' +
      'SELECT itemTypeID, typeName, display, 0 AS custom FROM itemTypes UNION ' +
      `SELECT customItemTypeID + ${offset}, typeName, display, 1 FROM customItemTypes`,
  );
  db.exec(
    'INSERT INTO fieldsCombined ' +
      'SELECT fieldID, fieldName, NULL AS label, fieldFormatID, 0 AS custom FROM fields UNION ' +
      `SELECT customFieldID + ${offset}, fieldName, label, NULL, 1 FROM customFields`,
  );
  db.exec(
    'INSERT INTO itemTypeFieldsCombined ' +
      'SELECT itemTypeID, fieldID, hide, orderIndex FROM itemTypeFields UNION ' +
      `SELECT customItemTypeID + ${offset}, ` +
      `COALESCE(fieldID, customFieldID + ${offset}), hide, orderIndex FROM customItemTypeFields`,
  );
  db.exec(
    'INSERT INTO baseFieldMappingsCombined ' +
      'SELECT itemTypeID, baseFieldID, fieldID FROM baseFieldMappings UNION ' +
      `SELECT customItemTypeID + ${offset}, baseFieldID, customFieldID + ${offset} ` +
      'FROM customBaseFieldMappings',
  );
}

/** `Zotero.ID._getNext()`: `SELECT COALESCE(MAX(col) + 1, 1) FROM table`. */
function nextFor(db, table, column) {
  return Number(db.value(`SELECT COALESCE(MAX(${column}) + 1, 1) FROM ${table}`));
}

/** @returns {Map<string, number>} */
function readMap(db, sql) {
  const map = new Map();
  for (const row of db.all(sql)) map.set(String(row.name), Number(row.id));
  return map;
}
