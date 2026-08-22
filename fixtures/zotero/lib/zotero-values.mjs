/*
 * Recueil — fixtures
 * Copyright (C) 2026 the Recueil authors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The value conventions of a real `zotero.sqlite`, reproduced from Zotero's own source so that the
 * fixture is awkward in the same ways a user's library is.
 *
 * Every constant below carries the upstream file it comes from. Zotero 10.0.0 unless stated.
 */
import { createHash } from 'node:crypto';

/* ---------------------------------------------------------------------------------------------- */
/* Object keys                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

/** `Zotero.Utilities.allowedKeyChars` — zotero/utilities `utilities.js`. 33 characters. */
export const ALLOWED_KEY_CHARS = '23456789ABCDEFGHIJKLMNPQRSTUVWXYZ';

/**
 * An eight-character Zotero object key, derived deterministically from a slug.
 *
 * Real keys are random (`Zotero.Utilities.generateObjectKey`). Ours are a hash of the slug, so that
 * regenerating the fixture does not churn every key and a test may hard-code one and keep it.
 *
 * @param {string} slug
 * @returns {string}
 */
export function objectKey(slug) {
  const digest = createHash('sha256').update(`recueil-fixture:${slug}`).digest();
  let key = '';
  for (let i = 0; i < 8; i += 1) key += ALLOWED_KEY_CHARS[digest[i] % ALLOWED_KEY_CHARS.length];
  return key;
}

/* ---------------------------------------------------------------------------------------------- */
/* Dates                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Zotero's multipart date, from `Zotero.Date.strToMultipart` (zotero/utilities `date.js`):
 * `YYYY-MM-DD ` followed by the string the user actually typed. Unknown components are zeroes, so
 * a bare year is stored `2011-00-00 2011` and `n.d.` is stored `0000-00-00 n.d.`.
 *
 * This is the single most commonly mishandled value in `zotero.sqlite`: the sortable prefix is
 * Zotero's, the suffix is the user's, and only the suffix should survive a round trip.
 *
 * @param {string} display  what the user typed, e.g. `March 2019`
 * @param {{ year?: number, month?: number, day?: number }} parts  what Zotero parsed out of it
 * @returns {string}
 */
export function multipartDate(display, parts = {}) {
  const year = parts.year ? String(parts.year).padStart(4, '0') : '0000';
  const month = parts.month ? String(parts.month).padStart(2, '0') : '00';
  const day = parts.day ? String(parts.day).padStart(2, '0') : '00';
  return `${year}-${month}-${day} ${display}`;
}

/**
 * Zotero's SQL datetime: UTC, `YYYY-MM-DD HH:MM:SS`, no zone marker, no fractional seconds.
 * Used for `dateAdded`, `dateModified`, `clientDateModified`, `accessDate` and `dateDeleted`.
 *
 * @param {string} iso  an ISO-8601 instant
 * @returns {string}
 */
export function sqlDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`not a date: ${iso}`);
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

/* ---------------------------------------------------------------------------------------------- */
/* Enumerations                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

/** `Zotero.Attachments.LINK_MODE_*` — `chrome/content/zotero/xpcom/attachments.js`. */
export const LINK_MODE = Object.freeze({
  imported_file: 0,
  imported_url: 1,
  linked_file: 2,
  linked_url: 3,
  embedded_image: 4,
});

/** `Zotero.Annotations.ANNOTATION_TYPE_*` — `chrome/content/zotero/xpcom/annotations.js`. */
export const ANNOTATION_TYPE = Object.freeze({
  highlight: 1,
  note: 2,
  image: 3,
  ink: 4,
  underline: 5,
  text: 6,
});

/** `itemTags.type`: 0 is a tag the user typed, 1 is one a translator attached. */
export const TAG_TYPE = Object.freeze({ manual: 0, automatic: 1 });

/**
 * The relation predicates Zotero itself uses — `chrome/content/zotero/xpcom/data/relations.js`.
 * `relationPredicates` rows are created on demand, so the numeric ids depend on the order a given
 * library first needed each one; an importer must resolve them by string.
 */
export const PREDICATE = Object.freeze({
  related: 'dc:relation',
  sameAs: 'owl:sameAs',
  replaces: 'dc:replaces',
});

/* ---------------------------------------------------------------------------------------------- */
/* URIs                                                                                             */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The object of a row in `itemRelations` is a URI, not a key —
 * `chrome/content/zotero/xpcom/uri.js`. A library that has never synced has no numeric user id, so
 * Zotero substitutes `local/<localUserKey>`, the eight-character random string it stores in
 * `settings` under `('account', 'localUserKey')`.
 *
 * @param {string} localUserKey
 * @param {string} itemKey
 * @returns {string}
 */
export function localItemUri(localUserKey, itemKey) {
  return `http://zotero.org/users/local/${localUserKey}/items/${itemKey}`;
}

/**
 * The same, for an item in a group library — the shape left behind when an item was copied out of
 * a group, which is where most real `owl:sameAs` rows come from.
 *
 * @param {number} groupId
 * @param {string} itemKey
 * @returns {string}
 */
export function groupItemUri(groupId, itemKey) {
  return `http://zotero.org/groups/${groupId}/items/${itemKey}`;
}

/* ---------------------------------------------------------------------------------------------- */
/* Attachment paths                                                                                 */
/* ---------------------------------------------------------------------------------------------- */

/**
 * `itemAttachments.path` for a stored file is the literal prefix `storage:` and a bare filename;
 * the directory is `storage/<itemKey>/`. For a linked file it is `attachments:` and a path relative
 * to the linked-attachment base directory, or an absolute path when no base directory is set. For a
 * linked URL it is `NULL`.
 */
export const STORAGE_PREFIX = 'storage:';
export const LINKED_PREFIX = 'attachments:';

/**
 * `itemAttachments.storageHash` is the **MD5** of the file as the storage server last saw it —
 * `Zotero.Item.prototype.attachmentHash` and `Zotero.Item.prototype.toResponseJSON` both go through
 * `Zotero.Utilities.Internal.md5Async`. Recueil hashes with SHA-256 (P2), so an importer has to
 * treat this value as a foreign checksum to be verified against, never as the document identity.
 *
 * @param {Buffer} bytes
 * @returns {string}
 */
export function storageHash(bytes) {
  return createHash('md5').update(bytes).digest('hex');
}

/**
 * The SHA-256 the attachment's bytes will hash to once Recueil ingests it. Recorded in
 * `expected-counts.json` so that the attachment-hash coverage report the Phase 1 exit criterion
 * asks for can be asserted against a stated value.
 *
 * @param {Buffer} bytes
 * @returns {string}
 */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
