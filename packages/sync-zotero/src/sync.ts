/**
 * One sync run between a Recueil library and one zotero.org library (ADR-0025).
 *
 * The run has two halves.
 *
 * **Pull.** Every collection and item Zotero reports as changed since the stored library version
 * is merged with its Recueil counterpart: three projections (the base both sides last agreed on,
 * Recueil now, Zotero now) go through `mergeThreeWay`, the result is written into Recueil, and
 * whatever the result holds that Zotero does not is queued for the push. Objects Zotero has
 * deleted for good go to Recueil's trash.
 *
 * **Push.** Every linked object Recueil changed since its base — and that the pull did not already
 * handle — is merged the same way, with Zotero's side equal to the base. New Recueil objects are
 * created in Zotero when this library is the *home* library. Writes go in batches of at most 50,
 * collections first (parents before children), then regular items, then notes and attachments, so
 * every reference points at something that exists. Each object carries its last known version, so
 * a write that would overwrite someone else's edit is refused and deferred to the next run.
 *
 * The stored library version only ever moves to the version the pull *started from the server
 * at*: anything written afterwards, including this run's own writes, is read again by the next
 * pull and found to be equal to its base. That costs a re-read and buys the guarantee that no edit
 * made by another client during the run can be skipped.
 *
 * **Dry run.** The whole run executes against the real Recueil database inside one transaction
 * that is rolled back at the end, with every write to zotero.org recorded instead of sent and no
 * file downloaded. The report is therefore the report of the real run, minus the writes. Because
 * the transaction holds the connection for the duration, a dry run needs a connection of its own —
 * which the CLI always has.
 */
import { createHash, randomInt } from 'node:crypto';

import {
  NotFoundError,
  htmlToMarkdown,
  newId,
  normalise,
  nowTimestamp,
  schema,
  systemActor,
} from '@recueil/core';
import type { Actor, BibliographicInput, CreatorRole, Recueil } from '@recueil/core';
import {
  CREATOR_ROLE_MAP,
  ITEM_TYPE_MAP,
  creatorIdentity,
  mapZoteroFields,
  mapZoteroItemType,
  mapZoteroTimestamp,
  parsePageSpan,
} from '@recueil/import-zotero';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';

import { ZOTERO_WRITE_BATCH } from './api/client.js';
import type { ZoteroApiClient } from './api/client.js';
import type {
  ZoteroCollectionData,
  ZoteroCreatorJson,
  ZoteroItemData,
  ZoteroLibraryRef,
  ZoteroObject,
} from './api/types.js';
import { mergeThreeWay } from './merge.js';
import type { ConflictPolicy, Flat, MergeResult } from './merge.js';
import { markdownToNoteHtml } from './note-html.js';
import {
  COLUMN_BASE_FIELDS,
  SYNC_COLUMNS,
  creatorsKey,
  isTrashed,
  normaliseMarkdown,
  projectRecueilItem,
  projectRecueilNote,
  projectZoteroItem,
  projectZoteroNote,
  sortedUnique,
  zoteroFieldValues,
} from './projection.js';
import type { ItemProjection, NoteProjection, ProjectedCreator } from './projection.js';
import { newReport } from './report.js';
import type { SyncConflictEntry, SyncReport } from './report.js';
import { SyncState } from './state.js';
import type { SyncLibraryRow, SyncLinkRow, SyncObjectType } from './state.js';
import { ZoteroSchema } from './zotero-schema.js';

/** The provenance stamp of every facet value the sync writes. Never a lock (P4-1). */
export const SYNC_SOURCE = 'sync:zotero';
const STAMP = { source: SYNC_SOURCE, lock: false } as const;
const ZOTERO_KEY_ALPHABET = '23456789ABCDEFGHIJKLMNPQRSTUVWXYZ';

export type SyncDirection = 'both' | 'pull' | 'push';
/** Which new Recueil items a home library receives. */
export type PushNewPolicy = 'bibliographic' | 'all' | 'none';

export interface ZoteroSyncOptions {
  library: ZoteroLibraryRef;
  libraryName?: string | null;
  policy?: ConflictPolicy;
  direction?: SyncDirection;
  dryRun?: boolean;
  /**
   * Whether Recueil objects that are in no bridged library are created in this one. Exactly one
   * library should be home — normally the user library.
   */
  home?: boolean;
  pushNew?: PushNewPolicy;
  /** Download and upload attachment files. */
  files?: boolean;
  maxFileBytes?: number;
  /** Push permanent deletions made in Recueil. Off by default (ADR-0025 §7). */
  propagatePurge?: boolean;
  actor?: Actor;
  /** Reuse a schema across runs. */
  schema?: ZoteroSchema;
  log?: (message: string) => void;
}

export const newZoteroKey = (): string => {
  let key = '';
  for (let index = 0; index < 8; index += 1) key += ZOTERO_KEY_ALPHABET[randomInt(ZOTERO_KEY_ALPHABET.length)];
  return key;
};

/* -------------------------------------------------------------------------------------------- */
/* Flattening projections into what the merge compares                                             */
/* -------------------------------------------------------------------------------------------- */

const flatItem = (p: ItemProjection): Flat => {
  const scalars: Record<string, string> = { itemType: p.itemType, creators: creatorsKey(p.creators) };
  for (const [column, value] of Object.entries(p.fields)) scalars[`f.${column}`] = value;
  if (p.extra !== '') scalars['extra'] = p.extra;
  if (p.deleted) scalars['deleted'] = '1';
  return { scalars, sets: { tags: p.tags, collections: p.collections } };
};

const flatNote = (p: NoteProjection): Flat => {
  const scalars: Record<string, string> = { markdown: p.markdown };
  if (p.parentKey !== null) scalars['parent'] = p.parentKey;
  if (p.deleted) scalars['deleted'] = '1';
  return { scalars, sets: {} };
};

interface CollectionProjection {
  name: string;
  parent: string | null;
  deleted: boolean;
}

const flatCollection = (p: CollectionProjection): Flat => {
  const scalars: Record<string, string> = { name: p.name };
  if (p.parent !== null) scalars['parent'] = p.parent;
  if (p.deleted) scalars['deleted'] = '1';
  return { scalars, sets: {} };
};

interface AttachmentProjection {
  title: string;
  parent: string | null;
  deleted: boolean;
}

const flatAttachment = (p: AttachmentProjection): Flat => {
  const scalars: Record<string, string> = {};
  if (p.title !== '') scalars['title'] = p.title;
  if (p.parent !== null) scalars['parent'] = p.parent;
  if (p.deleted) scalars['deleted'] = '1';
  return { scalars, sets: {} };
};

const projectZoteroCollection = (data: ZoteroCollectionData): CollectionProjection => ({
  name: data.name,
  parent: data.parentCollection === false || data.parentCollection === undefined ? null : data.parentCollection,
  deleted: isTrashed(data),
});

const projectZoteroAttachment = (data: ZoteroItemData): AttachmentProjection => ({
  title: (data.title ?? '').trim(),
  parent: data.parentItem ?? null,
  deleted: isTrashed(data),
});

/* -------------------------------------------------------------------------------------------- */
/* The push queue                                                                                  */
/* -------------------------------------------------------------------------------------------- */

interface PendingWrite {
  objectType: SyncObjectType;
  key: string;
  recueilId: string;
  /** The full object to send, with `key` and `version`. */
  json: Record<string, unknown>;
  created: boolean;
  /** Counted as a trash or a restore rather than an update. */
  trashChange: 'trashed' | 'restored' | null;
  subject: string | null;
  /** Run after Zotero accepted the write, with the object as Zotero now holds it. */
  file?: { attachmentId: string; documentId: string; previousMd5: string | null };
}

/* -------------------------------------------------------------------------------------------- */
/* The run                                                                                         */
/* -------------------------------------------------------------------------------------------- */

export class ZoteroSync {
  private readonly state: SyncState;
  private readonly actor: Actor;
  private readonly policy: ConflictPolicy;
  private readonly direction: SyncDirection;
  private readonly dryRun: boolean;
  private readonly files: boolean;
  private readonly maxFileBytes: number;
  private readonly log: (message: string) => void;

  private schema!: ZoteroSchema;
  private libraryRow!: SyncLibraryRow;
  private report!: SyncReport;

  /** Objects the pull already merged this run; the push half leaves them alone. */
  private readonly handled = new Set<string>();
  private readonly writes: PendingWrite[] = [];
  /** Zotero keys assigned this run to Recueil objects that do not have one yet. */
  private readonly newKeys = new Map<string, string>();

  constructor(
    private readonly recueil: Recueil,
    private readonly client: ZoteroApiClient,
    private readonly options: ZoteroSyncOptions,
  ) {
    this.state = new SyncState(recueil);
    this.actor = options.actor ?? systemActor();
    this.policy = options.policy ?? 'review';
    this.direction = options.direction ?? 'both';
    this.dryRun = options.dryRun ?? false;
    this.files = options.files ?? true;
    this.maxFileBytes = options.maxFileBytes ?? 200 * 1024 * 1024;
    this.log = options.log ?? (() => undefined);
  }

  private get lib(): ZoteroLibraryRef {
    return this.options.library;
  }

  async run(): Promise<SyncReport> {
    this.schema = this.options.schema ?? new ZoteroSchema(await this.client.schema());

    const connection = this.recueil.connection;
    // A caller running several libraries as one dry run holds the transaction itself.
    const ownTransaction = this.dryRun && !connection.inTransaction;
    if (ownTransaction) connection.exec('BEGIN');
    try {
      this.libraryRow = this.state.ensureLibrary(this.lib, this.options.libraryName ?? null);
      this.report = newReport({
        library: { ...this.lib, name: this.libraryRow.name },
        dryRun: this.dryRun,
        direction: this.direction,
        policy: this.policy,
        sinceVersion: this.libraryRow.version,
      });

      let reached = this.libraryRow.version;
      if (this.direction !== 'push') reached = await this.pull();
      if (this.direction !== 'pull') {
        this.collectLocalChanges();
        await this.push();
      }

      this.report.reachedVersion = reached;
      if (this.direction !== 'push') this.state.recordPull(this.libraryRow.id, reached);
      if (this.direction !== 'pull') this.state.recordPush(this.libraryRow.id);
    } finally {
      if (ownTransaction) connection.exec('ROLLBACK');
    }
    this.report.finishedAt = new Date().toISOString();
    return this.report;
  }

  /* ======================================================================================== */
  /* Pull                                                                                       */
  /* ======================================================================================== */

  private async pull(): Promise<number> {
    const since = this.libraryRow.version;
    const collections = await this.client.collectionsSince(this.lib, since);
    const items = await this.client.itemsSince(this.lib, since);
    const deleted = await this.client.deletedSince(this.lib, since);
    // The earliest version any of the three reads saw: whatever changed after it is read again.
    const reached = Math.min(collections.libraryVersion, items.libraryVersion, deleted.libraryVersion);
    this.log(
      `pull since ${since}: ${collections.value.length} collections, ${items.value.length} items, ` +
        `${deleted.value.items.length + deleted.value.collections.length} deletions`,
    );

    for (const collection of orderCollections(collections.value)) this.pullCollection(collection);

    const regular = items.value.filter((o) => o.data.itemType !== 'note' && o.data.itemType !== 'attachment');
    const notes = items.value.filter((o) => o.data.itemType === 'note');
    const attachments = items.value.filter((o) => o.data.itemType === 'attachment');
    for (const item of regular) this.guard('item', item.key, () => this.pullItem(item));
    for (const note of notes) this.guard('note', note.key, () => this.pullNote(note));
    for (const attachment of attachments) await this.guardAsync('attachment', attachment.key, () => this.pullAttachment(attachment));

    for (const key of deleted.value.items) this.guard('item', key, () => this.pullPermanentDeletion(key));
    for (const key of deleted.value.collections) this.guard('collection', key, () => this.pullCollectionDeletion(key));

    // An object that failed is only fetched again if the cursor stays where it was. Everything that
    // succeeded is re-read next time and found equal to its base, so holding back costs a re-read.
    if (this.report.errors.length > 0) return since;
    return reached;
  }

  private guard(objectType: SyncObjectType, key: string, work: () => void): void {
    try {
      this.recueil.connection.transaction(work)();
    } catch (error) {
      this.report.errors.push({ objectType, key, recueilId: null, subject: null, message: messageOf(error) });
    }
  }

  private async guardAsync(objectType: SyncObjectType, key: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.report.errors.push({ objectType, key, recueilId: null, subject: null, message: messageOf(error) });
    }
  }

  /**
   * Deleted for good in Recueil. A purge leaves the row as a tombstone and stamps its trash record
   * (TR2), so "gone" is either no row at all or a purged trash record.
   */
  private isPurged(entityType: 'item' | 'note' | 'collection' | 'attachment', entityId: string): boolean {
    return (
      this.recueil.db
        .select({ id: schema.trash.id })
        .from(schema.trash)
        .where(
          and(
            eq(schema.trash.entityType, entityType),
            eq(schema.trash.entityId, entityId),
            isNotNull(schema.trash.purgedAt),
            isNull(schema.trash.restoredAt),
          ),
        )
        .get() !== undefined
    );
  }

  /* Collections ------------------------------------------------------------------------------ */

  private localCollectionProjection(collectionId: string): CollectionProjection | null {
    if (this.isPurged('collection', collectionId)) return null;
    try {
      const row = this.recueil.collections.get(collectionId, { includeTrashed: true });
      let parent: string | null = null;
      if (row.parentId !== null) {
        // A parent Zotero does not know (and will not this run) keeps whatever parent Zotero has:
        // a collection is never moved to the top level because Recueil filed it somewhere local.
        parent = this.collectionKeyOf(row.parentId);
        if (parent === null) {
          const own = this.state.linkByRecueilId(this.libraryRow.id, 'collection', collectionId);
          const zoteroParent = own === undefined ? false : (JSON.parse(own.base) as ZoteroCollectionData).parentCollection;
          parent = zoteroParent === false || zoteroParent === undefined ? null : zoteroParent;
        }
      }
      return { name: row.name, parent, deleted: row.trashedAt !== null };
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  /** The Zotero key of a Recueil collection: linked, assigned this run, or (if `assign`) new. */
  private collectionKeyOf(collectionId: string, assign = false): string | null {
    const link = this.state.linkByRecueilId(this.libraryRow.id, 'collection', collectionId);
    if (link !== undefined) return link.zoteroKey;
    const fresh = this.newKeys.get(`collection:${collectionId}`);
    if (fresh !== undefined) return fresh;
    if (!assign) return null;
    return `local:${collectionId}`;
  }

  private collectionIdOf(key: string): string | null {
    return this.state.linkByKey(this.libraryRow.id, 'collection', key)?.recueilId ?? null;
  }

  private pullCollection(remote: ZoteroObject<ZoteroCollectionData>): void {
    this.handled.add(`collection:${remote.key}`);
    this.guard('collection', remote.key, () => {
      const link = this.state.linkByKey(this.libraryRow.id, 'collection', remote.key);
      const remoteProjection = projectZoteroCollection(remote.data);
      let collectionId = link?.recueilId ?? null;
      let base: Flat;

      if (link !== undefined && this.localCollectionProjection(link.recueilId) === null) {
        this.localPurge('collection', link);
        return;
      }
      if (link !== undefined) {
        if (link.zoteroVersion === remote.version) {
          this.report.toRecueil.collection.unchanged += 1;
          return;
        }
        base = flatCollection(projectZoteroCollection(JSON.parse(link.base) as ZoteroCollectionData));
      } else {
        if (remoteProjection.deleted) return;
        collectionId = this.adoptCollection(remote);
        if (collectionId === null) {
          const parentId = remoteProjection.parent === null ? null : this.collectionIdOf(remoteProjection.parent);
          const created = this.recueil.collections.create(
            { name: remote.data.name, parentId, publicId: this.freePublicId('collection', remote.key) },
            this.actor,
          );
          this.state.saveLink({
            libraryId: this.libraryRow.id,
            objectType: 'collection',
            key: remote.key,
            recueilId: created.id,
            version: remote.version,
            base: remote.data,
          });
          this.report.toRecueil.collection.created += 1;
          return;
        }
        this.report.toRecueil.collection.adopted += 1;
        // First contact: Zotero is taken as the truth, so the base is Recueil's current state.
        base = flatCollection(this.localCollectionProjection(collectionId)!);
      }

      const local = flatCollection(this.localCollectionProjection(collectionId!)!);
      const result = this.merge('collection', remote.key, collectionId, remote.data.name, base, local, flatCollection(remoteProjection));
      this.applyCollection(collectionId!, result, remoteProjection);

      if (result.toZotero.length > 0 && this.direction !== 'pull') {
        this.queueCollection(collectionId!, remote.key, remote.data, remote.version, result);
      } else {
        this.state.saveLink({
          libraryId: this.libraryRow.id,
          objectType: 'collection',
          key: remote.key,
          recueilId: collectionId!,
          version: remote.version,
          base: remote.data,
        });
      }
    });
  }

  private adoptCollection(remote: ZoteroObject<ZoteroCollectionData>): string | null {
    // The importer carries the Zotero key across as the collection's public id.
    try {
      const byKey = this.recueil.collections.getByPublicId(remote.key, { includeTrashed: true });
      if (!this.state.isLinkedAnywhere('collection', byKey.id)) {
        this.saveAdoption('collection', remote.key, byKey.id, remote.version, remote.data);
        return byKey.id;
      }
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
    return null;
  }

  private applyCollection(collectionId: string, result: MergeResult, remote: CollectionProjection): void {
    const fields = new Set(result.toRecueil);
    const merged = result.merged.scalars;
    const current = this.recueil.collections.get(collectionId, { includeTrashed: true });
    if (fields.has('deleted') && merged['deleted'] === undefined && current.trashedAt !== null) {
      this.recueil.collections.restore(collectionId, this.actor);
      this.report.toRecueil.collection.restored += 1;
    }
    let changed = false;
    if (fields.has('name') && merged['name'] !== undefined) {
      this.recueil.collections.rename(collectionId, merged['name'], this.actor);
      changed = true;
    }
    if (fields.has('parent')) {
      const parentKey = merged['parent'] ?? null;
      const parentId = parentKey === null ? null : this.collectionIdOf(parentKey);
      if (parentKey === null || parentId !== null) {
        this.recueil.collections.move(collectionId, parentId, this.actor);
        changed = true;
      } else {
        this.report.review.push({
          objectType: 'collection',
          key: null,
          recueilId: collectionId,
          subject: remote.name,
          message: `its parent collection '${parentKey}' is not in Recueil yet; it stays where it is until the next run`,
        });
      }
    }
    if (changed) this.report.toRecueil.collection.updated += 1;
    if (fields.has('deleted') && merged['deleted'] === '1' && current.trashedAt === null) {
      this.recueil.collections.trash(collectionId, this.actor);
      this.report.toRecueil.collection.trashed += 1;
    }
  }

  private pullCollectionDeletion(key: string): void {
    const link = this.state.linkByKey(this.libraryRow.id, 'collection', key);
    if (link === undefined) return;
    const local = this.localCollectionProjection(link.recueilId);
    if (local !== null && !local.deleted) {
      this.recueil.collections.trash(link.recueilId, this.actor);
      this.report.toRecueil.collection.trashed += 1;
    }
    this.state.dropLink(link.id);
  }

  /* Items -------------------------------------------------------------------------------------- */

  private itemKeyOf(itemId: string): string | null {
    const link = this.state.linkByRecueilId(this.libraryRow.id, 'item', itemId);
    if (link !== undefined) return link.zoteroKey;
    return this.newKeys.get(`item:${itemId}`) ?? null;
  }

  private itemIdOf(key: string): string | null {
    return this.state.linkByKey(this.libraryRow.id, 'item', key)?.recueilId ?? null;
  }

  private itemExists(itemId: string): boolean {
    if (this.isPurged('item', itemId)) return false;
    try {
      this.recueil.library.getItem(itemId, { includeTrashed: true });
      return true;
    } catch (error) {
      if (error instanceof NotFoundError) return false;
      throw error;
    }
  }

  /**
   * A Recueil collection with no counterpart in this Zotero library — and none being created this
   * run — is not part of the item's Zotero membership. Naming it would make the item look changed
   * on every run without anything to send.
   */
  private localItem(itemId: string): ItemProjection {
    return projectRecueilItem(this.recueil, itemId, (collectionId) => this.collectionKeyOf(collectionId));
  }

  /*
   * A merge whose result Zotero does not hold yet is queued for this run's push. When this run does
   * not push (`direction: 'pull'`, as in the pull half of `syncZoteroLibraries`), the link takes
   * Zotero's current object as its base instead: the merged values then read as Recueil-side
   * changes against the newest version, and the next push sends them with a version Zotero
   * accepts. Keeping the old base there would push against a stale version and be refused (412)
   * on every run.
   */
  private pullItem(remote: ZoteroObject<ZoteroItemData>): void {
    this.handled.add(`item:${remote.key}`);
    const link = this.state.linkByKey(this.libraryRow.id, 'item', remote.key);
    const remoteProjection = projectZoteroItem(remote.data, this.schema);
    let itemId: string;
    let base: Flat;

    if (link !== undefined && !this.itemExists(link.recueilId)) {
      // Deleted for good in Recueil: not brought back, and not deleted online unless asked to.
      this.localPurge('item', link);
      return;
    }
    if (link !== undefined) {
      if (link.zoteroVersion === remote.version) {
        this.report.toRecueil.item.unchanged += 1;
        return;
      }
      itemId = link.recueilId;
      base = flatItem(projectZoteroItem(JSON.parse(link.base) as ZoteroItemData, this.schema));
    } else {
      const adopted = this.adoptItem(remote);
      if (adopted === null) {
        this.createItemFromZotero(remote, remoteProjection);
        return;
      }
      itemId = adopted;
      this.report.toRecueil.item.adopted += 1;
      base = flatItem(this.localItem(itemId));
    }

    const local = flatItem(this.localItem(itemId));
    const subject = remote.data.title ?? remote.key;
    const locked = new Set(this.recueil.library.lockedBibliographicFields(itemId).map((field) => `f.${field}`));
    const result = this.merge('item', remote.key, itemId, subject, base, local, flatItem(remoteProjection), locked);
    this.applyItem(itemId, result, remote.data);

    if (result.toZotero.length > 0 && this.direction !== 'pull') {
      this.queueItem(itemId, remote.key, remote.data, remote.version, result, subject);
    } else {
      this.state.saveLink({
        libraryId: this.libraryRow.id,
        objectType: 'item',
        key: remote.key,
        recueilId: itemId,
        version: remote.version,
        base: remote.data,
      });
    }
  }

  private adoptItem(remote: ZoteroObject<ZoteroItemData>): string | null {
    const row = this.recueil.db
      .select({ id: schema.items.id })
      .from(schema.items)
      .where(and(eq(schema.items.sourceSystem, 'zotero'), eq(schema.items.sourceId, remote.key)))
      .get();
    if (row === undefined || this.state.isLinkedAnywhere('item', row.id)) return null;
    this.saveAdoption('item', remote.key, row.id, remote.version, remote.data);
    return row.id;
  }

  /** Link an adopted row with a provisional base, so a failure later in the run keeps the link. */
  private saveAdoption(objectType: SyncObjectType, key: string, recueilId: string, version: number, data: unknown): void {
    this.state.saveLink({ libraryId: this.libraryRow.id, objectType, key, recueilId, version: 0, base: data });
    void version;
  }

  private createItemFromZotero(remote: ZoteroObject<ZoteroItemData>, projection: ItemProjection): void {
    const mapping = mapZoteroItemType(remote.data.itemType);
    const mapped = mapZoteroFields(zoteroFieldValues(remote.data, this.schema), {
      zoteroItemType: remote.data.itemType,
      cslType: mapping.cslType,
    });
    const bibliographic: BibliographicInput = { ...mapped.bibliographic };
    if (mapped.nativeCitationKey !== null) bibliographic.citationKey = mapped.nativeCitationKey;
    this.dropTakenIdentifiers(null, bibliographic, remote.key, mapped.title);

    const sourceFree =
      this.recueil.db
        .select({ id: schema.items.id })
        .from(schema.items)
        .where(and(eq(schema.items.sourceSystem, 'zotero'), eq(schema.items.sourceId, remote.key)))
        .get() === undefined;

    const record = this.recueil.library.createItem(
      {
        itemType: mapping.itemType,
        title: mapped.title,
        extra: mapped.extra,
        sourceSystem: sourceFree ? 'zotero' : null,
        sourceId: sourceFree ? remote.key : null,
        dateAdded: mapZoteroTimestamp(remote.data.dateAdded ?? '') ?? nowTimestamp(),
        bibliographic,
        provenance: STAMP,
      },
      this.actor,
    );
    const itemId = record.item.id;
    const flat = flatItem(projection);
    this.applyItem(
      itemId,
      {
        merged: flat,
        toRecueil: ['creators', 'tags', 'collections', 'deleted'],
        toZotero: [],
        conflicts: [],
        decided: [],
      },
      remote.data,
    );
    this.state.saveLink({
      libraryId: this.libraryRow.id,
      objectType: 'item',
      key: remote.key,
      recueilId: itemId,
      version: remote.version,
      base: remote.data,
    });
    this.report.toRecueil.item.created += 1;
  }

  /**
   * Two live items may not share a DOI or a citation key (B1, ADR-0016). A value another item
   * already holds is not written, and the clash goes to review rather than failing the item.
   */
  private dropTakenIdentifiers(
    itemId: string | null,
    values: BibliographicInput,
    key: string,
    subject: string | null,
  ): void {
    for (const column of ['doi', 'citationKey'] as const) {
      const value = values[column];
      if (value === undefined || value === null) continue;
      const holder = this.recueil.db
        .select({ itemId: schema.itemBibliographic.itemId })
        .from(schema.itemBibliographic)
        .where(and(eq(schema.itemBibliographic[column], value), isNull(schema.itemBibliographic.itemTrashedAt)))
        .get();
      if (holder !== undefined && holder.itemId !== itemId) {
        delete values[column];
        this.report.review.push({
          objectType: 'item',
          key,
          recueilId: itemId,
          subject,
          message: `another live item already holds ${column === 'doi' ? 'DOI' : 'citation key'} '${value}'; it was not written here`,
        });
      }
    }
  }

  private applyItem(itemId: string, result: MergeResult, remote: ZoteroItemData | null): void {
    const fields = new Set(result.toRecueil);
    if (fields.size === 0) return;
    const merged = result.merged;
    const record = this.recueil.library.getItem(itemId, { includeTrashed: true });
    const subject = record.item.title;
    let updated = false;

    // A trashed item refuses every write, so a restore comes first and a trash comes last.
    if (fields.has('deleted') && merged.scalars['deleted'] === undefined && record.item.trashedAt !== null) {
      this.recueil.library.restoreItem(itemId, this.actor);
      this.report.toRecueil.item.restored += 1;
    }
    const live = this.recueil.library.getItem(itemId, { includeTrashed: true }).item.trashedAt === null;

    if (live) {
      const patch: { itemType?: string; title?: string | null; extra?: string | null } = {};
      if (fields.has('itemType') && merged.scalars['itemType'] !== undefined) patch.itemType = merged.scalars['itemType'];
      if (fields.has('f.title')) patch.title = merged.scalars['f.title'] ?? null;
      if (fields.has('extra')) patch.extra = merged.scalars['extra'] ?? null;

      const bibliographic: BibliographicInput = {};
      const decidedBibliographic: BibliographicInput = {};
      const decided = new Set(result.decided);
      for (const column of SYNC_COLUMNS) {
        if (!fields.has(`f.${column}`)) continue;
        const target = decided.has(`f.${column}`) ? decidedBibliographic : bibliographic;
        Object.assign(target, columnValues(column, merged.scalars[`f.${column}`] ?? null));
      }
      this.dropTakenIdentifiers(itemId, bibliographic, this.itemKeyOf(itemId) ?? '', subject);
      this.dropTakenIdentifiers(itemId, decidedBibliographic, this.itemKeyOf(itemId) ?? '', subject);
      if (Object.keys(decidedBibliographic).length > 0) {
        // A person decided these: written as their edit, which is what moves a lock (P4).
        this.recueil.library.updateItem(itemId, { bibliographic: decidedBibliographic }, this.actor);
        updated = true;
      }

      if (Object.keys(patch).length > 0 || Object.keys(bibliographic).length > 0) {
        const outcome = this.recueil.library.updateItemDetailed(
          itemId,
          { ...patch, ...(Object.keys(bibliographic).length > 0 ? { bibliographic } : {}) },
          this.actor,
          { provenance: STAMP },
        );
        for (const skipped of outcome.skipped) {
          this.report.review.push({
            objectType: 'item',
            key: this.itemKeyOf(itemId),
            recueilId: itemId,
            subject,
            message: `'${skipped.fieldPath}' is locked in Recueil (by ${skipped.lockedBy}); Zotero's value was not written`,
          });
        }
        updated = true;
      }

      if (fields.has('creators')) {
        this.setCreators(itemId, JSON.parse(merged.scalars['creators'] ?? '[]') as unknown[][]);
        updated = true;
      }
      if (fields.has('tags')) {
        const wanted = new Set(merged.sets['tags'] ?? []);
        const current = this.recueil.tags.forItem(itemId);
        for (const tag of current) {
          if (!wanted.has(tag.name.trim())) this.recueil.tags.unassign(itemId, tag.id, this.actor);
        }
        const have = new Set(current.map((tag) => tag.name.trim()));
        for (const name of wanted) {
          if (!have.has(name)) this.recueil.tags.assignByName(itemId, name, this.actor, { source: 'import' });
        }
        updated = true;
      }
      if (fields.has('collections')) {
        const wanted = new Set(merged.sets['collections'] ?? []);
        const current = this.recueil.collections.forItem(itemId);
        for (const collection of current) {
          const key = this.collectionKeyOf(collection.id);
          // A collection with no counterpart in this Zotero library is none of this sync's business.
          if (key !== null && !wanted.has(key)) this.recueil.collections.removeItems(collection.id, [itemId], this.actor);
        }
        const have = new Set(current.map((collection) => this.collectionKeyOf(collection.id)));
        for (const key of wanted) {
          if (have.has(key)) continue;
          const collectionId = this.collectionIdOf(key);
          if (collectionId === null) continue;
          const collection = this.recueil.collections.get(collectionId, { includeTrashed: true });
          if (collection.trashedAt === null) {
            this.recueil.collections.addItems(collectionId, [itemId], this.actor, { source: 'import' });
          }
        }
        updated = true;
      }
    }

    if (updated) this.report.toRecueil.item.updated += 1;
    if (fields.has('deleted') && merged.scalars['deleted'] === '1' && live) {
      this.recueil.library.trashItem(itemId, this.actor);
      this.report.toRecueil.item.trashed += 1;
    }
    void remote;
  }

  private setCreators(itemId: string, entries: unknown[][]): void {
    const resolved: Array<{ creatorId: string; role: CreatorRole; rawName: string | null }> = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const [role, kind, family, given, literal] = entry as [
        CreatorRole,
        'person' | 'organisation',
        string | null,
        string | null,
        string | null,
      ];
      const name = {
        kind,
        familyName: family,
        givenName: given,
        literalName: literal,
        rawName: literal ?? [given, family].filter((part) => part !== null).join(' '),
      };
      const creatorId = this.findOrCreateCreator(name);
      if (seen.has(`${creatorId}:${role}`)) continue;
      seen.add(`${creatorId}:${role}`);
      resolved.push({ creatorId, role, rawName: name.rawName });
    }
    this.recueil.creators.setItemCreators(itemId, resolved, this.actor);
  }

  private findOrCreateCreator(name: {
    kind: 'person' | 'organisation';
    familyName: string | null;
    givenName: string | null;
    literalName: string | null;
    rawName: string;
  }): string {
    const identity = creatorIdentity(name);
    const sortName =
      name.literalName !== null
        ? name.literalName
        : name.givenName === null
          ? (name.familyName ?? '')
          : `${name.familyName ?? ''}, ${name.givenName}`;
    const existing = this.recueil.creators
      .findBySortName(normalise(sortName))
      .find(
        (candidate) =>
          creatorIdentity({
            kind: candidate.kind as 'person' | 'organisation',
            familyName: candidate.familyName,
            givenName: candidate.givenName,
            literalName: candidate.literalName,
            rawName: candidate.displayName,
          }) === identity,
      );
    if (existing !== undefined) return existing.id;
    return this.recueil.creators.create(
      {
        kind: name.kind,
        familyName: name.familyName,
        givenName: name.givenName,
        literalName: name.literalName,
      },
      this.actor,
    ).id;
  }

  private pullPermanentDeletion(key: string): void {
    for (const objectType of ['item', 'note', 'attachment'] as const) {
      const link = this.state.linkByKey(this.libraryRow.id, objectType, key);
      if (link === undefined) continue;
      this.trashLocal(objectType, link.recueilId);
      this.state.dropLink(link.id);
    }
  }

  private trashLocal(objectType: 'item' | 'note' | 'attachment', recueilId: string): void {
    try {
      if (objectType === 'item') {
        if (this.recueil.library.getItem(recueilId, { includeTrashed: true }).item.trashedAt === null) {
          this.recueil.library.trashItem(recueilId, this.actor);
          this.report.toRecueil.item.trashed += 1;
        }
      } else if (objectType === 'note') {
        if (this.recueil.notes.get(recueilId, { includeTrashed: true }).trashedAt === null) {
          this.recueil.notes.trash(recueilId, this.actor);
          this.report.toRecueil.note.trashed += 1;
        }
      } else {
        const row = this.attachmentRow(recueilId);
        if (row !== undefined && row.trashedAt === null) {
          this.recueil.documents.detachDocument(recueilId, this.actor);
          this.report.toRecueil.attachment.trashed += 1;
        }
      }
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
  }

  /* Notes -------------------------------------------------------------------------------------- */

  private noteExists(noteId: string): boolean {
    if (this.isPurged('note', noteId)) return false;
    try {
      this.recueil.notes.get(noteId, { includeTrashed: true });
      return true;
    } catch (error) {
      if (error instanceof NotFoundError) return false;
      throw error;
    }
  }

  private localNote(noteId: string): NoteProjection {
    return projectRecueilNote(this.recueil, noteId, (itemId) => this.itemKeyOf(itemId));
  }

  private pullNote(remote: ZoteroObject<ZoteroItemData>): void {
    this.handled.add(`note:${remote.key}`);
    const link = this.state.linkByKey(this.libraryRow.id, 'note', remote.key);
    const remoteProjection = projectZoteroNote(remote.data);
    let noteId: string;
    let base: Flat;

    if (link !== undefined && !this.noteExists(link.recueilId)) {
      this.localPurge('note', link);
      return;
    }
    if (link !== undefined) {
      if (link.zoteroVersion === remote.version) {
        this.report.toRecueil.note.unchanged += 1;
        return;
      }
      noteId = link.recueilId;
      base = flatNote(projectZoteroNote(JSON.parse(link.base) as ZoteroItemData));
    } else {
      const adopted = this.adoptNote(remote);
      if (adopted === null) {
        this.createNoteFromZotero(remote, remoteProjection);
        return;
      }
      noteId = adopted;
      this.report.toRecueil.note.adopted += 1;
      base = flatNote(this.localNote(noteId));
    }

    const local = flatNote(this.localNote(noteId));
    const result = this.merge('note', remote.key, noteId, null, base, local, flatNote(remoteProjection));
    this.applyNote(noteId, result, remote.data);
    if (result.toZotero.length > 0 && this.direction !== 'pull') {
      this.queueNote(noteId, remote.key, remote.data, remote.version, result);
    } else {
      this.state.saveLink({
        libraryId: this.libraryRow.id,
        objectType: 'note',
        key: remote.key,
        recueilId: noteId,
        version: remote.version,
        base: remote.data,
      });
    }
  }

  private adoptNote(remote: ZoteroObject<ZoteroItemData>): string | null {
    const parentId = remote.data.parentItem === undefined ? null : this.itemIdOf(remote.data.parentItem);
    if (remote.data.parentItem !== undefined && parentId === null) return null;
    const candidates = this.recueil.db
      .select({ id: schema.notes.id, original: schema.notes.contentOriginal })
      .from(schema.notes)
      .where(parentId === null ? isNull(schema.notes.itemId) : eq(schema.notes.itemId, parentId))
      .all();
    const match = candidates.find(
      (candidate) => candidate.original === (remote.data.note ?? '') && !this.state.isLinkedAnywhere('note', candidate.id),
    );
    if (match === undefined) return null;
    this.saveAdoption('note', remote.key, match.id, remote.version, remote.data);
    return match.id;
  }

  private createNoteFromZotero(remote: ZoteroObject<ZoteroItemData>, projection: NoteProjection): void {
    if (projection.deleted) return;
    const parentId = projection.parentKey === null ? null : this.itemIdOf(projection.parentKey);
    if (projection.parentKey !== null && parentId === null) {
      this.report.review.push({
        objectType: 'note',
        key: remote.key,
        recueilId: null,
        subject: null,
        message: `its parent item '${projection.parentKey}' is not in Recueil; the note is picked up once it is`,
      });
      return;
    }
    if (projection.markdown === '') {
      this.report.review.push({
        objectType: 'note',
        key: remote.key,
        recueilId: null,
        subject: null,
        message: 'an empty note; Recueil requires a note to have content (N1)',
      });
      return;
    }
    if (parentId !== null && this.recueil.library.getItem(parentId, { includeTrashed: true }).item.trashedAt !== null) {
      return;
    }
    const note = this.recueil.notes.create({ itemId: parentId, contentHtml: remote.data.note ?? '' }, this.actor);
    this.state.saveLink({
      libraryId: this.libraryRow.id,
      objectType: 'note',
      key: remote.key,
      recueilId: note.id,
      version: remote.version,
      base: remote.data,
    });
    this.report.toRecueil.note.created += 1;
  }

  private applyNote(noteId: string, result: MergeResult, remote: ZoteroItemData): void {
    const fields = new Set(result.toRecueil);
    if (fields.size === 0) return;
    const merged = result.merged.scalars;
    const current = this.recueil.notes.get(noteId, { includeTrashed: true });
    if (fields.has('deleted') && merged['deleted'] === undefined && current.trashedAt !== null) {
      this.recueil.notes.restore(noteId, this.actor);
      this.report.toRecueil.note.restored += 1;
    }
    const live = this.recueil.notes.get(noteId, { includeTrashed: true }).trashedAt === null;
    if (live && fields.has('markdown') && (merged['markdown'] ?? '') === '') {
      // Recueil cannot hold an empty note (N1). Holding the field as a conflict keeps both sides as
      // they are — the next push must not quietly put the old text back into Zotero.
      const key = this.state.linkByRecueilId(this.libraryRow.id, 'note', noteId)?.zoteroKey ?? remote.key;
      this.state.recordConflict(this.libraryRow.id, 'note', key, noteId, {
        field: 'markdown',
        base: null,
        recueil: normaliseMarkdown(current.contentMarkdown),
        zotero: '',
      });
      this.report.review.push({
        objectType: 'note',
        key,
        recueilId: noteId,
        subject: current.title,
        message: 'the note was emptied in Zotero; Recueil cannot hold an empty note, so both sides are held until you decide',
      });
      fields.delete('markdown');
    }
    if (live && (fields.has('markdown') || fields.has('parent'))) {
      const patch: { contentHtml?: string; contentMarkdown?: string; itemId?: string | null } = {};
      if (fields.has('markdown')) {
        const value = merged['markdown'] ?? '';
        // Taking Zotero's text: keep Zotero's HTML verbatim (N1) rather than a re-rendering of it.
        if (value === normaliseMarkdown(htmlToMarkdown(remote.note ?? ''))) patch.contentHtml = remote.note ?? '';
        else patch.contentMarkdown = value;
      }
      if (fields.has('parent')) {
        const parentKey = merged['parent'] ?? null;
        const parentId = parentKey === null ? null : this.itemIdOf(parentKey);
        if (parentKey === null || parentId !== null) patch.itemId = parentId;
      }
      if (Object.keys(patch).length > 0 && (patch.contentHtml ?? patch.contentMarkdown ?? 'x').trim() !== '') {
        this.recueil.notes.update(noteId, patch, this.actor);
        this.report.toRecueil.note.updated += 1;
      }
    }
    if (fields.has('deleted') && merged['deleted'] === '1' && live) {
      this.recueil.notes.trash(noteId, this.actor);
      this.report.toRecueil.note.trashed += 1;
    }
  }

  /* Attachments -------------------------------------------------------------------------------- */

  private attachmentRow(attachmentId: string): schema.AttachmentRow | undefined {
    return this.recueil.db.select().from(schema.attachments).where(eq(schema.attachments.id, attachmentId)).get();
  }

  private localAttachment(attachmentId: string): AttachmentProjection | null {
    if (this.isPurged('attachment', attachmentId)) return null;
    const row = this.attachmentRow(attachmentId);
    if (row === undefined) return null;
    const host = this.recueil.library.getItem(row.itemId, { includeTrashed: true });
    const standalone = host.item.itemType === 'attachment_only';
    return {
      title: (row.title ?? '').trim(),
      parent: standalone ? null : this.itemKeyOf(row.itemId),
      deleted: row.trashedAt !== null,
    };
  }

  private async pullAttachment(remote: ZoteroObject<ZoteroItemData>): Promise<void> {
    this.handled.add(`attachment:${remote.key}`);
    const link = this.state.linkByKey(this.libraryRow.id, 'attachment', remote.key);
    const remoteProjection = projectZoteroAttachment(remote.data);
    const remoteMd5 = typeof remote.data.md5 === 'string' ? remote.data.md5 : null;

    if (link !== undefined && this.localAttachment(link.recueilId) === null) {
      this.localPurge('attachment', link);
      return;
    }
    if (link !== undefined) {
      if (link.zoteroVersion === remote.version) {
        this.report.toRecueil.attachment.unchanged += 1;
        return;
      }
      const base = flatAttachment(projectZoteroAttachment(JSON.parse(link.base) as ZoteroItemData));
      const local = flatAttachment(this.localAttachment(link.recueilId)!);
      const result = this.merge('attachment', remote.key, link.recueilId, remote.data.title ?? null, base, local, flatAttachment(remoteProjection));
      this.recueil.connection.transaction(() => this.applyAttachment(link.recueilId, result))();

      let fileMd5 = link.fileMd5;
      if (remoteMd5 !== null && remoteMd5 !== link.fileMd5 && storesFile(remote.data)) {
        const replaced = await this.replaceAttachmentFile(link.recueilId, remote);
        if (replaced) fileMd5 = remoteMd5;
      }
      if (result.toZotero.length > 0 && this.direction !== 'pull') {
        this.queueAttachmentUpdate(link.recueilId, remote.key, remote.data, remote.version, result);
      } else {
        this.state.saveLink({
          libraryId: this.libraryRow.id,
          objectType: 'attachment',
          key: remote.key,
          recueilId: link.recueilId,
          version: remote.version,
          base: remote.data,
          fileMd5,
        });
      }
      return;
    }

    if (remoteProjection.deleted) return;
    const adopted = this.adoptAttachment(remote);
    if (adopted !== null) {
      this.report.toRecueil.attachment.adopted += 1;
      this.state.saveLink({
        libraryId: this.libraryRow.id,
        objectType: 'attachment',
        key: remote.key,
        recueilId: adopted,
        version: remote.version,
        base: remote.data,
        fileMd5: remoteMd5,
      });
      return;
    }
    await this.createAttachmentFromZotero(remote);
  }

  private adoptAttachment(remote: ZoteroObject<ZoteroItemData>): string | null {
    // The importer records a stored attachment's Zotero key in `document_provenance.source_ref`.
    const provenance = this.recueil.db
      .select({ documentId: schema.documentProvenance.documentId })
      .from(schema.documentProvenance)
      .where(eq(schema.documentProvenance.sourceRef, `zotero:${remote.key}`))
      .all();
    for (const row of provenance) {
      const attachment = this.recueil.db
        .select({ id: schema.attachments.id })
        .from(schema.attachments)
        .where(eq(schema.attachments.documentId, row.documentId))
        .all()
        .find((candidate) => !this.state.isLinkedAnywhere('attachment', candidate.id));
      if (attachment !== undefined) return attachment.id;
    }
    return null;
  }

  private hostFor(remote: ZoteroObject<ZoteroItemData>): string | null {
    if (remote.data.parentItem !== undefined) return this.itemIdOf(remote.data.parentItem);
    // A standalone attachment gets a host item of the type that exists for exactly this.
    const record = this.recueil.library.createItem(
      {
        itemType: 'attachment_only',
        title: remote.data.title ?? null,
        dateAdded: mapZoteroTimestamp(remote.data.dateAdded ?? '') ?? nowTimestamp(),
        provenance: STAMP,
      },
      this.actor,
    );
    return record.item.id;
  }

  private async fetchFile(remote: ZoteroObject<ZoteroItemData>): Promise<Uint8Array | null> {
    if (!this.files || this.dryRun) {
      this.report.files.skipped += 1;
      return null;
    }
    const bytes = await this.client.downloadFile(this.lib, remote.key);
    if (bytes === null) {
      this.report.files.skipped += 1;
      return null;
    }
    if (bytes.byteLength > this.maxFileBytes) {
      this.report.files.skipped += 1;
      this.report.review.push({
        objectType: 'attachment',
        key: remote.key,
        recueilId: null,
        subject: remote.data.filename ?? null,
        message: `the file is ${bytes.byteLength} bytes, over the limit of ${this.maxFileBytes}; not stored`,
      });
      return null;
    }
    const md5 = createHash('md5').update(bytes).digest('hex');
    if (typeof remote.data.md5 === 'string' && remote.data.md5 !== md5) {
      this.report.files.skipped += 1;
      this.report.errors.push({
        objectType: 'attachment',
        key: remote.key,
        recueilId: null,
        subject: remote.data.filename ?? null,
        message: `the downloaded file's MD5 ${md5} is not the ${remote.data.md5} Zotero states; not stored`,
      });
      return null;
    }
    this.report.files.downloaded += 1;
    return bytes;
  }

  private async createAttachmentFromZotero(remote: ZoteroObject<ZoteroItemData>): Promise<void> {
    if (remote.data.parentItem !== undefined && this.itemIdOf(remote.data.parentItem) === null) {
      this.report.review.push({
        objectType: 'attachment',
        key: remote.key,
        recueilId: null,
        subject: remote.data.title ?? null,
        message: `its parent item '${remote.data.parentItem}' is not in Recueil; the attachment is picked up once it is`,
      });
      return;
    }
    const bytes = storesFile(remote.data) ? await this.fetchFile(remote) : null;
    const title = remote.data.title ?? null;

    let attachmentId: string;
    if (bytes !== null) {
      const hostId = this.recueil.connection.transaction(() => this.hostFor(remote))();
      if (hostId === null) return;
      const ingest = await this.recueil.documents.ingestBuffer(bytes, {
        sourceKind: 'import',
        sourceRef: `zotero:${remote.key}`,
        sourceDetail: { zoteroKey: remote.key, via: 'zotero.org', library: `${this.lib.type}:${this.lib.id}` },
        originalFilename: remote.data.filename ?? null,
        declaredMimeType: remote.data.contentType ?? null,
        actor: this.actor,
      });
      const existing = this.recueil.db
        .select({ id: schema.attachments.id })
        .from(schema.attachments)
        .where(and(eq(schema.attachments.itemId, hostId), eq(schema.attachments.documentId, ingest.document.id)))
        .get();
      attachmentId =
        existing?.id ??
        this.recueil.documents.attachDocument(
          { itemId: hostId, documentId: ingest.document.id, role: this.roleFor(hostId, remote.data.linkMode), title },
          this.actor,
        );
    } else {
      const linkMode = remote.data.linkMode === 'linked_url' ? 'linked_url' : 'linked_file';
      const url = typeof remote.data.url === 'string' && remote.data.url !== '' ? remote.data.url : null;
      const path =
        typeof remote.data['path'] === 'string' && remote.data['path'] !== ''
          ? (remote.data['path'] as string)
          : `zotero:${remote.key}/${remote.data.filename ?? ''}`;
      if (linkMode === 'linked_url' && url === null) {
        this.report.review.push({
          objectType: 'attachment',
          key: remote.key,
          recueilId: null,
          subject: title,
          message: 'a linked-URL attachment with no URL cannot be represented',
        });
        return;
      }
      attachmentId = this.recueil.connection.transaction(() => {
        const hostId = this.hostFor(remote);
        if (hostId === null) throw new Error('no host item');
        return this.insertLinkAttachment(hostId, {
          linkMode: url !== null && linkMode === 'linked_url' ? 'linked_url' : 'linked_file',
          title,
          url,
          linkedPath: linkMode === 'linked_url' ? null : path,
          contentTypeHint: remote.data.contentType ?? null,
        });
      })();
    }

    this.state.saveLink({
      libraryId: this.libraryRow.id,
      objectType: 'attachment',
      key: remote.key,
      recueilId: attachmentId,
      version: remote.version,
      base: remote.data,
      fileMd5: bytes === null ? null : (remote.data.md5 ?? null),
    });
    this.report.toRecueil.attachment.created += 1;
    if (isTrashed(remote.data)) this.trashLocal('attachment', attachmentId);
  }

  private roleFor(itemId: string, linkMode: string | undefined): 'primary' | 'supplement' | 'snapshot' {
    if (linkMode === 'imported_url') return 'snapshot';
    const primary = this.recueil.db
      .select({ id: schema.attachments.id })
      .from(schema.attachments)
      .where(
        and(eq(schema.attachments.itemId, itemId), eq(schema.attachments.role, 'primary'), isNull(schema.attachments.trashedAt)),
      )
      .get();
    return primary === undefined ? 'primary' : 'supplement';
  }

  private insertLinkAttachment(
    itemId: string,
    input: {
      linkMode: 'linked_file' | 'linked_url';
      title: string | null;
      url: string | null;
      linkedPath: string | null;
      contentTypeHint: string | null;
    },
  ): string {
    const now = nowTimestamp();
    const id = newId();
    const position =
      this.recueil.db
        .select({ id: schema.attachments.id })
        .from(schema.attachments)
        .where(eq(schema.attachments.itemId, itemId))
        .all().length;
    this.recueil.db
      .insert(schema.attachments)
      .values({
        id,
        itemId,
        documentId: null,
        role: 'supplement',
        linkMode: input.linkMode,
        title: input.title,
        url: input.url,
        linkedPath: input.linkedPath,
        contentTypeHint: input.contentTypeHint,
        position,
        addedAt: now,
        addedByUserId: null,
        source: 'import',
        updatedAt: now,
      })
      .run();
    return id;
  }

  private async replaceAttachmentFile(attachmentId: string, remote: ZoteroObject<ZoteroItemData>): Promise<boolean> {
    const bytes = await this.fetchFile(remote);
    if (bytes === null) return false;
    const ingest = await this.recueil.documents.ingestBuffer(bytes, {
      sourceKind: 'import',
      sourceRef: `zotero:${remote.key}`,
      sourceDetail: { zoteroKey: remote.key, via: 'zotero.org', replaced: true },
      originalFilename: remote.data.filename ?? null,
      declaredMimeType: remote.data.contentType ?? null,
      actor: this.actor,
    });
    // The bytes are immutable (D3): the attachment is pointed at the new document, the old one stays.
    this.recueil.db
      .update(schema.attachments)
      .set({ documentId: ingest.document.id, linkMode: 'stored', linkedPath: null, updatedAt: nowTimestamp() })
      .where(eq(schema.attachments.id, attachmentId))
      .run();
    this.report.toRecueil.attachment.updated += 1;
    return true;
  }

  private applyAttachment(attachmentId: string, result: MergeResult): void {
    const fields = new Set(result.toRecueil);
    const merged = result.merged.scalars;
    const row = this.attachmentRow(attachmentId);
    if (row === undefined) return;
    if (fields.has('deleted') && merged['deleted'] === undefined && row.trashedAt !== null) {
      this.recueil.documents.restoreAttachment(attachmentId, this.actor);
      this.report.toRecueil.attachment.restored += 1;
    }
    if (fields.has('title')) {
      this.recueil.db
        .update(schema.attachments)
        .set({ title: merged['title'] ?? null, updatedAt: nowTimestamp() })
        .where(eq(schema.attachments.id, attachmentId))
        .run();
      this.report.toRecueil.attachment.updated += 1;
    }
    if (fields.has('deleted') && merged['deleted'] === '1' && row.trashedAt === null) {
      this.recueil.documents.detachDocument(attachmentId, this.actor);
      this.report.toRecueil.attachment.trashed += 1;
    }
  }

  /* ======================================================================================== */
  /* Merge bookkeeping                                                                          */
  /* ======================================================================================== */

  private merge(
    objectType: SyncObjectType,
    key: string,
    recueilId: string | null,
    subject: string | null,
    base: Flat,
    local: Flat,
    remote: Flat,
    locked: ReadonlySet<string> = new Set(),
  ): MergeResult {
    const open = this.state.openConflicts(this.libraryRow.id, objectType, key);
    const frozen = new Set(open.map((row) => row.field));
    const decided = this.state.pendingResolutions(this.libraryRow.id, objectType, key);
    const forced = new Map(
      decided.map((row) => [row.field, row.state === 'resolved_zotero' ? 'zotero' : 'recueil'] as const),
    );
    const result = mergeThreeWay(base, local, remote, {
      policy: this.policy,
      frozen,
      lockedInRecueil: locked,
      forced,
    });
    this.state.markApplied(decided.map((row) => row.id));

    for (const conflict of result.conflicts) {
      const held =
        this.policy === 'review' || (locked.has(conflict.field) && this.policy !== 'recueil');
      const entry: SyncConflictEntry = {
        ...conflict,
        objectType,
        key,
        recueilId,
        subject,
        outcome: held ? 'held' : this.policy === 'zotero' ? 'zotero' : 'recueil',
      };
      this.report.conflicts.push(entry);
      if (held) this.state.recordConflict(this.libraryRow.id, objectType, key, recueilId, conflict);
    }

    // An open conflict whose two sides have since come to agree has resolved itself.
    const agreed = open.filter(
      (row) =>
        !result.conflicts.some((conflict) => conflict.field === row.field) &&
        (local.scalars[row.field] ?? null) === (remote.scalars[row.field] ?? null),
    );
    this.state.resolveConflicts(
      agreed.map((row) => row.id),
      'resolved_manual',
    );
    return result;
  }

  /* ======================================================================================== */
  /* Push: what changed in Recueil                                                              */
  /* ======================================================================================== */

  private collectLocalChanges(): void {
    const home = this.options.home ?? false;

    // Keys for every new local collection first, so items and child collections can refer to them.
    if (home) {
      for (const collection of this.recueil.collections.list()) {
        if (collection.kind === 'smart') continue;
        if (this.state.isLinkedAnywhere('collection', collection.id)) continue;
        this.newKeys.set(`collection:${collection.id}`, newZoteroKey());
      }
    }

    // Linked collections.
    for (const link of this.state.links(this.libraryRow.id, 'collection')) {
      if (this.handled.has(`collection:${link.zoteroKey}`)) continue;
      this.guard('collection', link.zoteroKey, () => {
        const local = this.localCollectionProjection(link.recueilId);
        if (local === null) return this.localPurge('collection', link);
        const baseData = JSON.parse(link.base) as ZoteroCollectionData;
        const base = flatCollection(projectZoteroCollection(baseData));
        const result = this.merge('collection', link.zoteroKey, link.recueilId, local.name, base, flatCollection(local), base);
        this.applyCollection(link.recueilId, result, local);
        if (result.toZotero.length > 0) this.queueCollection(link.recueilId, link.zoteroKey, baseData, link.zoteroVersion, result);
      });
    }

    // New collections.
    for (const [ref, key] of this.newKeys) {
      if (!ref.startsWith('collection:')) continue;
      const collectionId = ref.slice('collection:'.length);
      const local = this.localCollectionProjection(collectionId);
      if (local === null) continue;
      const json: Record<string, unknown> = {
        key,
        version: 0,
        name: local.name,
        parentCollection: local.parent === null ? false : this.resolveLocalKey(local.parent),
      };
      this.writes.push({
        objectType: 'collection',
        key,
        recueilId: collectionId,
        json,
        created: true,
        trashChange: null,
        subject: local.name,
      });
    }

    // Linked items.
    for (const link of this.state.links(this.libraryRow.id, 'item')) {
      if (this.handled.has(`item:${link.zoteroKey}`)) continue;
      this.guard('item', link.zoteroKey, () => {
        if (!this.itemExists(link.recueilId)) return this.localPurge('item', link);
        const baseData = JSON.parse(link.base) as ZoteroItemData;
        const base = flatItem(projectZoteroItem(baseData, this.schema));
        const local = flatItem(this.localItem(link.recueilId));
        const subject = this.recueil.library.getItem(link.recueilId, { includeTrashed: true }).item.title;
        const locked = new Set(
          this.recueil.library.lockedBibliographicFields(link.recueilId).map((field) => `f.${field}`),
        );
        const result = this.merge('item', link.zoteroKey, link.recueilId, subject, base, local, base, locked);
        this.applyItem(link.recueilId, result, baseData);
        if (result.toZotero.length > 0) this.queueItem(link.recueilId, link.zoteroKey, baseData, link.zoteroVersion, result, subject);
      });
    }

    // New items.
    const pushNew = this.options.pushNew ?? 'bibliographic';
    if (home && pushNew !== 'none') {
      const rows = this.recueil.db
        .select({
          id: schema.items.id,
          itemType: schema.items.itemType,
          title: schema.items.title,
          sourceSystem: schema.items.sourceSystem,
          sourceId: schema.items.sourceId,
        })
        .from(schema.items)
        .where(isNull(schema.items.trashedAt))
        .all();
      for (const row of rows) {
        if (row.itemType === 'attachment_only') continue;
        if (this.state.isLinkedAnywhere('item', row.id)) continue;
        if (row.sourceSystem === 'zotero') {
          // It came from a Zotero library no bridged library has claimed. Pushing it would make a
          // second copy of an item that already exists somewhere in Zotero.
          this.report.notPushed.push({
            objectType: 'item',
            key: row.sourceId,
            recueilId: row.id,
            subject: row.title,
            message: 'imported from a Zotero library that is not bridged; not pushed, to avoid a duplicate',
          });
          continue;
        }
        if (pushNew === 'bibliographic') {
          const hasFacet =
            this.recueil.db
              .select({ id: schema.itemBibliographic.itemId })
              .from(schema.itemBibliographic)
              .where(eq(schema.itemBibliographic.itemId, row.id))
              .get() !== undefined;
          if (!hasFacet) continue;
        }
        this.newKeys.set(`item:${row.id}`, newZoteroKey());
      }
      for (const [ref, key] of this.newKeys) {
        if (!ref.startsWith('item:')) continue;
        const itemId = ref.slice('item:'.length);
        this.guard('item', key, () => this.queueNewItem(itemId, key));
      }
    }

    // Linked notes, then new notes on items that are in this library.
    for (const link of this.state.links(this.libraryRow.id, 'note')) {
      if (this.handled.has(`note:${link.zoteroKey}`)) continue;
      this.guard('note', link.zoteroKey, () => {
        if (!this.noteExists(link.recueilId)) return this.localPurge('note', link);
        const baseData = JSON.parse(link.base) as ZoteroItemData;
        const base = flatNote(projectZoteroNote(baseData));
        const result = this.merge('note', link.zoteroKey, link.recueilId, null, base, flatNote(this.localNote(link.recueilId)), base);
        this.applyNote(link.recueilId, result, baseData);
        if (result.toZotero.length > 0) this.queueNote(link.recueilId, link.zoteroKey, baseData, link.zoteroVersion, result);
      });
    }
    const noteRows = this.recueil.db
      .select({ id: schema.notes.id, itemId: schema.notes.itemId })
      .from(schema.notes)
      .where(isNull(schema.notes.trashedAt))
      .all();
    for (const row of noteRows) {
      if (this.state.isLinkedAnywhere('note', row.id)) continue;
      const parentKey = row.itemId === null ? null : this.itemKeyOf(row.itemId);
      if (row.itemId !== null && parentKey === null) continue;
      if (row.itemId === null && !home) continue;
      this.guard('note', row.id, () => this.queueNewNote(row.id, parentKey));
    }

    // Linked attachments, then new stored attachments on items that are in this library.
    for (const link of this.state.links(this.libraryRow.id, 'attachment')) {
      if (this.handled.has(`attachment:${link.zoteroKey}`)) continue;
      this.guard('attachment', link.zoteroKey, () => {
        const local = this.localAttachment(link.recueilId);
        if (local === null) return this.localPurge('attachment', link);
        const baseData = JSON.parse(link.base) as ZoteroItemData;
        const base = flatAttachment(projectZoteroAttachment(baseData));
        const result = this.merge('attachment', link.zoteroKey, link.recueilId, local.title, base, flatAttachment(local), base);
        this.applyAttachment(link.recueilId, result);
        if (result.toZotero.length > 0) this.queueAttachmentUpdate(link.recueilId, link.zoteroKey, baseData, link.zoteroVersion, result);
      });
    }
    const attachmentRows = this.recueil.db
      .select()
      .from(schema.attachments)
      .where(isNull(schema.attachments.trashedAt))
      .all();
    for (const row of attachmentRows) {
      if (this.state.isLinkedAnywhere('attachment', row.id)) continue;
      const parentKey = this.itemKeyOf(row.itemId);
      if (parentKey === null) continue;
      this.guard('attachment', row.id, () => this.queueNewAttachment(row, parentKey));
    }
  }

  /** A linked Recueil row that no longer exists at all. */
  private localPurge(objectType: SyncObjectType, link: SyncLinkRow): void {
    if (this.options.propagatePurge === true) {
      this.writes.push({
        objectType,
        key: link.zoteroKey,
        recueilId: link.recueilId,
        json: { __delete: true },
        created: false,
        trashChange: 'trashed',
        subject: null,
      });
      return;
    }
    this.report.notPushed.push({
      objectType,
      key: link.zoteroKey,
      recueilId: link.recueilId,
      subject: null,
      message: 'deleted for good in Recueil; not deleted on zotero.org without --propagate-purge',
    });
  }

  /** `local:<id>` placeholders are resolved once every new collection has its key. */
  private resolveLocalKey(key: string): string | false {
    if (!key.startsWith('local:')) return key;
    return this.newKeys.get(`collection:${key.slice('local:'.length)}`) ?? false;
  }

  /* Building Zotero JSON ----------------------------------------------------------------------- */

  private queueCollection(
    collectionId: string,
    key: string,
    start: ZoteroCollectionData,
    version: number,
    result: MergeResult,
  ): void {
    const json: Record<string, unknown> = { ...start, key, version };
    const fields = new Set(result.toZotero);
    const merged = result.merged.scalars;
    if (fields.has('name')) json['name'] = merged['name'] ?? start.name;
    if (fields.has('parent')) {
      const parent = merged['parent'] ?? null;
      json['parentCollection'] = parent === null ? false : this.resolveLocalKey(parent);
    }
    let trashChange: PendingWrite['trashChange'] = null;
    if (fields.has('deleted')) {
      json['deleted'] = merged['deleted'] === '1';
      trashChange = merged['deleted'] === '1' ? 'trashed' : 'restored';
    }
    this.writes.push({ objectType: 'collection', key, recueilId: collectionId, json, created: false, trashChange, subject: start.name });
  }

  private zoteroFieldFor(itemType: string, column: string): string | null {
    const bases = COLUMN_BASE_FIELDS[column] ?? [];
    for (const [field, base] of this.schema.fields(itemType)) {
      if (bases.includes(base) || bases.includes(field)) return field;
    }
    return null;
  }

  private zoteroCreators(
    itemType: string,
    creators: readonly ProjectedCreator[],
    previous: readonly ZoteroCreatorJson[],
  ): ZoteroCreatorJson[] {
    const valid = new Set(this.schema.creatorTypes(itemType));
    const primary = this.schema.primaryCreatorTypes.get(itemType) ?? 'author';
    const reuse = new Map<string, ZoteroCreatorJson[]>();
    const previousProjected = projectZoteroItem(
      { key: 'x', version: 0, itemType, creators: [...previous] },
      this.schema,
    ).creators;
    previous.forEach((creator, index) => {
      const projected = previousProjected[index];
      if (projected === undefined) return;
      const id = creatorsKey([projected]);
      reuse.set(id, [...(reuse.get(id) ?? []), creator]);
    });

    return creators.map((creator) => {
      const kept = reuse.get(creatorsKey([creator]))?.shift();
      if (kept !== undefined) return kept;
      let creatorType: string = primary;
      if (creator.role !== 'author') {
        const direct = Object.entries(CREATOR_ROLE_MAP).find(([, role]) => role === creator.role)?.[0];
        creatorType = direct !== undefined && valid.has(direct) ? direct : valid.has('contributor') ? 'contributor' : primary;
      }
      if (creator.kind === 'organisation' || (creator.family === null && creator.given === null)) {
        return { creatorType, name: creator.literal ?? '' };
      }
      return { creatorType, firstName: creator.given ?? '', lastName: creator.family ?? '' };
    });
  }

  private buildItemJson(
    itemId: string,
    start: ZoteroItemData,
    fields: readonly string[],
    merged: Flat,
    key: string,
    version: number,
    subject: string | null,
  ): { json: Record<string, unknown>; trashChange: PendingWrite['trashChange'] } {
    const json: Record<string, unknown> = { ...start, key, version };
    delete json['dateModified'];
    const itemType = start.itemType;
    let trashChange: PendingWrite['trashChange'] = null;

    for (const field of fields) {
      if (field.startsWith('f.')) {
        const column = field.slice(2);
        const zoteroField = this.zoteroFieldFor(itemType, column);
        if (zoteroField === null) {
          this.report.notPushed.push({
            objectType: 'item',
            key,
            recueilId: itemId,
            subject,
            message: `Zotero's '${itemType}' has no field for '${column}'`,
          });
          continue;
        }
        json[zoteroField] = formatForZotero(column, merged.scalars[field] ?? null);
      } else if (field === 'extra') {
        json['extra'] = merged.scalars['extra'] ?? '';
      } else if (field === 'creators') {
        json['creators'] = this.zoteroCreators(
          itemType,
          (JSON.parse(merged.scalars['creators'] ?? '[]') as unknown[][]).map(([role, kind, family, given, literal]) => ({
            role: role as CreatorRole,
            kind: kind as 'person' | 'organisation',
            family: family as string | null,
            given: given as string | null,
            literal: literal as string | null,
          })),
          start.creators ?? [],
        );
      } else if (field === 'tags') {
        const previous = new Map((start.tags ?? []).map((tag) => [tag.tag.trim(), tag]));
        json['tags'] = (merged.sets['tags'] ?? []).map((name) => previous.get(name) ?? { tag: name });
      } else if (field === 'collections') {
        json['collections'] = (merged.sets['collections'] ?? [])
          .map((collection) => this.resolveLocalKey(collection))
          .filter((collection): collection is string => collection !== false);
      } else if (field === 'deleted') {
        json['deleted'] = merged.scalars['deleted'] === '1';
        trashChange = merged.scalars['deleted'] === '1' ? 'trashed' : 'restored';
      } else if (field === 'itemType') {
        this.report.notPushed.push({
          objectType: 'item',
          key,
          recueilId: itemId,
          subject,
          message: `the item type changed in Recueil to '${merged.scalars['itemType'] ?? ''}'; change it in Zotero by hand`,
        });
      }
    }
    return { json, trashChange };
  }

  private queueItem(
    itemId: string,
    key: string,
    start: ZoteroItemData,
    version: number,
    result: MergeResult,
    subject: string | null,
  ): void {
    const { json, trashChange } = this.buildItemJson(itemId, start, result.toZotero, result.merged, key, version, subject);
    this.writes.push({ objectType: 'item', key, recueilId: itemId, json, created: false, trashChange, subject });
  }

  private queueNewItem(itemId: string, key: string): void {
    const local = this.localItem(itemId);
    const itemType = this.zoteroItemType(local.itemType);
    const start: ZoteroItemData = { key, version: 0, itemType, creators: [], tags: [], collections: [] };
    const flat = flatItem(local);
    const fields = [...Object.keys(flat.scalars).filter((field) => field !== 'itemType' && field !== 'deleted'), 'tags', 'collections'];
    const subject = this.recueil.library.getItem(itemId).item.title;
    const { json } = this.buildItemJson(itemId, start, fields, flat, key, 0, subject);
    // A new object is only written if no field of that name was refused.
    this.writes.push({ objectType: 'item', key, recueilId: itemId, json, created: true, trashChange: null, subject });
  }

  private zoteroItemType(recueilType: string): string {
    for (const [zoteroType, mapped] of Object.entries(ITEM_TYPE_MAP)) {
      if (mapped === recueilType && this.schema.hasItemType(zoteroType)) return zoteroType;
    }
    const direct = this.schema.itemTypes().find((type) => mapZoteroItemType(type).itemType === recueilType);
    return direct ?? (this.schema.hasItemType('document') ? 'document' : 'journalArticle');
  }

  private noteHtml(noteId: string, markdown: string): string {
    const note = this.recueil.notes.get(noteId, { includeTrashed: true });
    if (
      note.sourceFormat === 'html' &&
      note.contentOriginal !== null &&
      normaliseMarkdown(htmlToMarkdown(note.contentOriginal)) === markdown
    ) {
      return note.contentOriginal;
    }
    return markdownToNoteHtml(markdown);
  }

  private queueNote(noteId: string, key: string, start: ZoteroItemData, version: number, result: MergeResult): void {
    const json: Record<string, unknown> = { ...start, key, version };
    delete json['dateModified'];
    const fields = new Set(result.toZotero);
    const merged = result.merged.scalars;
    if (fields.has('markdown')) json['note'] = this.noteHtml(noteId, merged['markdown'] ?? '');
    if (fields.has('parent')) {
      const parent = merged['parent'] ?? null;
      if (parent === null) delete json['parentItem'];
      else json['parentItem'] = parent;
    }
    let trashChange: PendingWrite['trashChange'] = null;
    if (fields.has('deleted')) {
      json['deleted'] = merged['deleted'] === '1';
      trashChange = merged['deleted'] === '1' ? 'trashed' : 'restored';
    }
    this.writes.push({ objectType: 'note', key, recueilId: noteId, json, created: false, trashChange, subject: null });
  }

  private queueNewNote(noteId: string, parentKey: string | null): void {
    const local = this.localNote(noteId);
    if (local.markdown === '') return;
    const key = newZoteroKey();
    const json: Record<string, unknown> = {
      key,
      version: 0,
      itemType: 'note',
      note: this.noteHtml(noteId, local.markdown),
      tags: [],
      collections: [],
      relations: {},
    };
    if (parentKey !== null) json['parentItem'] = parentKey;
    this.writes.push({ objectType: 'note', key, recueilId: noteId, json, created: true, trashChange: null, subject: null });
  }

  private queueAttachmentUpdate(
    attachmentId: string,
    key: string,
    start: ZoteroItemData,
    version: number,
    result: MergeResult,
  ): void {
    const json: Record<string, unknown> = { ...start, key, version };
    delete json['dateModified'];
    const fields = new Set(result.toZotero);
    const merged = result.merged.scalars;
    if (fields.has('title')) json['title'] = merged['title'] ?? '';
    let trashChange: PendingWrite['trashChange'] = null;
    if (fields.has('deleted')) {
      json['deleted'] = merged['deleted'] === '1';
      trashChange = merged['deleted'] === '1' ? 'trashed' : 'restored';
    }
    if (fields.has('parent')) {
      this.report.notPushed.push({
        objectType: 'attachment',
        key,
        recueilId: attachmentId,
        subject: start.title ?? null,
        message: 'the attachment moved to another item in Recueil; Zotero cannot move an attachment between items',
      });
    }
    this.writes.push({
      objectType: 'attachment',
      key,
      recueilId: attachmentId,
      json,
      created: false,
      trashChange,
      subject: start.title ?? null,
    });
  }

  private queueNewAttachment(row: schema.AttachmentRow, parentKey: string): void {
    const key = newZoteroKey();
    if (row.linkMode === 'linked_url') {
      this.writes.push({
        objectType: 'attachment',
        key,
        recueilId: row.id,
        json: {
          key,
          version: 0,
          itemType: 'attachment',
          parentItem: parentKey,
          linkMode: 'linked_url',
          title: row.title ?? row.url ?? '',
          url: row.url ?? '',
          contentType: row.contentTypeHint ?? '',
          tags: [],
          relations: {},
        },
        created: true,
        trashChange: null,
        subject: row.title,
      });
      return;
    }
    if (row.linkMode !== 'stored' || row.documentId === null) {
      this.report.notPushed.push({
        objectType: 'attachment',
        key: null,
        recueilId: row.id,
        subject: row.title,
        message: 'a linked file lives on one machine; it is not uploaded',
      });
      return;
    }
    const document = this.recueil.documents.getDocument(row.documentId);
    const filename = document.originalFilename ?? `${document.sha256.slice(0, 12)}`;
    this.writes.push({
      objectType: 'attachment',
      key,
      recueilId: row.id,
      json: {
        key,
        version: 0,
        itemType: 'attachment',
        parentItem: parentKey,
        linkMode: 'imported_file',
        title: row.title ?? filename,
        filename,
        contentType: document.mimeType ?? row.contentTypeHint ?? 'application/octet-stream',
        tags: [],
        relations: {},
      },
      created: true,
      trashChange: null,
      subject: row.title ?? filename,
      file: { attachmentId: row.id, documentId: row.documentId, previousMd5: null },
    });
  }

  /* ======================================================================================== */
  /* Push: sending                                                                              */
  /* ======================================================================================== */

  private async push(): Promise<void> {
    const deletions = this.writes.filter((write) => write.json['__delete'] === true);
    const writes = this.writes.filter((write) => write.json['__delete'] !== true);

    const collections = orderCollectionWrites(writes.filter((write) => write.objectType === 'collection'));
    for (const round of collections) await this.send('collection', round);
    await this.send('item', writes.filter((write) => write.objectType === 'item'));
    await this.send(
      'child',
      writes.filter((write) => write.objectType === 'note' || write.objectType === 'attachment'),
    );

    if (deletions.length > 0) await this.sendDeletions(deletions);
  }

  private async send(kind: 'collection' | 'item' | 'child', writes: readonly PendingWrite[]): Promise<void> {
    for (let index = 0; index < writes.length; index += ZOTERO_WRITE_BATCH) {
      const batch = writes.slice(index, index + ZOTERO_WRITE_BATCH);
      if (this.dryRun) {
        for (const write of batch) this.countPush(write);
        continue;
      }
      let response;
      try {
        const objects = batch.map((write) => write.json);
        response =
          kind === 'collection'
            ? (await this.client.writeCollections(this.lib, objects)).response
            : (await this.client.writeItems(this.lib, objects)).response;
      } catch (error) {
        for (const write of batch) {
          this.report.errors.push({
            objectType: write.objectType,
            key: write.key,
            recueilId: write.recueilId,
            subject: write.subject,
            message: messageOf(error),
          });
        }
        continue;
      }

      for (const [position, write] of batch.entries()) {
        const index = String(position);
        const saved = response.successful[index];
        const unchanged = response.unchanged[index];
        const failed = response.failed[index];
        if (saved !== undefined) {
          let fileMd5: string | null | undefined;
          if (write.file !== undefined) {
            fileMd5 = await this.uploadFile(write, saved as ZoteroObject<ZoteroItemData>);
          }
          this.state.saveLink({
            libraryId: this.libraryRow.id,
            objectType: write.objectType,
            key: saved.key,
            recueilId: write.recueilId,
            version: saved.version,
            base: saved.data,
            ...(fileMd5 !== undefined ? { fileMd5 } : {}),
          });
          this.countPush(write);
        } else if (unchanged !== undefined) {
          // Zotero already holds exactly this; the base simply catches up.
          const link = this.state.linkByKey(this.libraryRow.id, write.objectType, write.key);
          if (link !== undefined) {
            const json = { ...write.json };
            this.state.saveLink({
              libraryId: this.libraryRow.id,
              objectType: write.objectType,
              key: write.key,
              recueilId: write.recueilId,
              version: link.zoteroVersion,
              base: json,
            });
          }
          this.report.toZotero[write.objectType].unchanged += 1;
        } else if (failed !== undefined) {
          const event = {
            objectType: write.objectType,
            key: write.key,
            recueilId: write.recueilId,
            subject: write.subject,
            message: `${failed.code}: ${failed.message}`,
          };
          if (failed.code === 412) this.report.deferred.push(event);
          else this.report.errors.push(event);
        }
      }
    }
  }

  private async uploadFile(
    write: PendingWrite,
    saved: ZoteroObject<ZoteroItemData>,
  ): Promise<string | null> {
    const file = write.file!;
    if (!this.files) {
      this.report.files.skipped += 1;
      return null;
    }
    try {
      const document = this.recueil.documents.getDocument(file.documentId);
      if (document.byteSize > this.maxFileBytes) {
        this.report.files.skipped += 1;
        return null;
      }
      const bytes = await this.recueil.documents.readBuffer(file.documentId);
      const md5 = createHash('md5').update(bytes).digest('hex');
      const outcome = await this.client.uploadFile(
        this.lib,
        saved.key,
        {
          bytes: new Uint8Array(bytes),
          md5,
          filename: String(saved.data.filename ?? document.originalFilename ?? saved.key),
          mtime: Date.parse(document.createdAt) || Date.now(),
        },
        file.previousMd5,
      );
      if (outcome === 'uploaded') this.report.files.uploaded += 1;
      else this.report.files.alreadyThere += 1;
      return md5;
    } catch (error) {
      this.report.errors.push({
        objectType: 'attachment',
        key: saved.key,
        recueilId: write.recueilId,
        subject: write.subject,
        message: `the file was not uploaded: ${messageOf(error)}`,
      });
      return null;
    }
  }

  private async sendDeletions(deletions: readonly PendingWrite[]): Promise<void> {
    if (this.dryRun) {
      for (const write of deletions) this.report.toZotero[write.objectType].trashed += 1;
      return;
    }
    try {
      let version = await this.client.libraryVersion(this.lib);
      const collections = deletions.filter((write) => write.objectType === 'collection').map((write) => write.key);
      const items = deletions.filter((write) => write.objectType !== 'collection').map((write) => write.key);
      if (items.length > 0) version = await this.client.deleteItems(this.lib, items, version);
      if (collections.length > 0) await this.client.deleteCollections(this.lib, collections, version);
      for (const write of deletions) {
        const link = this.state.linkByKey(this.libraryRow.id, write.objectType, write.key);
        if (link !== undefined) this.state.dropLink(link.id);
        this.report.toZotero[write.objectType].trashed += 1;
      }
    } catch (error) {
      for (const write of deletions) {
        this.report.deferred.push({
          objectType: write.objectType,
          key: write.key,
          recueilId: write.recueilId,
          subject: null,
          message: `deletion not sent: ${messageOf(error)}`,
        });
      }
    }
  }

  private countPush(write: PendingWrite): void {
    const counts = this.report.toZotero[write.objectType];
    if (write.created) counts.created += 1;
    else if (write.trashChange === 'trashed') counts.trashed += 1;
    else if (write.trashChange === 'restored') counts.restored += 1;
    else counts.updated += 1;
  }

  /** A Recueil public id may carry the Zotero key only when no other row already has it. */
  private freePublicId(objectType: 'collection', key: string): string | undefined {
    void objectType;
    try {
      this.recueil.collections.getByPublicId(key, { includeTrashed: true });
      return undefined;
    } catch (error) {
      if (error instanceof NotFoundError) return key;
      throw error;
    }
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Helpers                                                                                         */
/* -------------------------------------------------------------------------------------------- */

const storesFile = (data: ZoteroItemData): boolean =>
  data.linkMode === 'imported_file' || data.linkMode === 'imported_url';

/** Parents before children, so a collection is never created under one that does not exist yet. */
const orderCollections = (
  collections: readonly ZoteroObject<ZoteroCollectionData>[],
): ZoteroObject<ZoteroCollectionData>[] => {
  const byKey = new Map(collections.map((collection) => [collection.key, collection]));
  const depth = (collection: ZoteroObject<ZoteroCollectionData>, seen = new Set<string>()): number => {
    const parent = collection.data.parentCollection;
    if (parent === false || parent === undefined || seen.has(collection.key)) return 0;
    const next = byKey.get(parent);
    if (next === undefined) return 1;
    seen.add(collection.key);
    return 1 + depth(next, seen);
  };
  return [...collections].sort((left, right) => depth(left) - depth(right));
};

/** New collections in rounds by depth: Zotero must know a parent before a child names it. */
const orderCollectionWrites = (writes: readonly PendingWrite[]): PendingWrite[][] => {
  const created = new Set(writes.filter((write) => write.created).map((write) => write.key));
  const byKey = new Map(writes.map((write) => [write.key, write]));
  const depth = (write: PendingWrite, seen = new Set<string>()): number => {
    const parent = write.json['parentCollection'];
    if (typeof parent !== 'string' || !created.has(parent) || seen.has(write.key)) return 0;
    seen.add(write.key);
    const next = byKey.get(parent);
    return next === undefined ? 0 : 1 + depth(next, seen);
  };
  const rounds: PendingWrite[][] = [];
  for (const write of writes) {
    const level = depth(write);
    (rounds[level] ??= []).push(write);
  }
  return rounds.filter((round) => round !== undefined);
};

/** A projected column value back into the facet's column types, with the values derived from it. */
const columnValues = (column: string, value: string | null): BibliographicInput => {
  const out: Record<string, unknown> = {};
  if (column === 'numberOfPages') {
    out[column] = value === null || !/^\d{1,9}$/u.test(value) ? null : Number.parseInt(value, 10);
  } else if (column === 'issuedDate') {
    out['issuedDate'] = value;
    const match = value === null ? null : /^(-?\d{4})(?:-(\d{2}))?/u.exec(value);
    out['issuedYear'] = match === null ? null : Number.parseInt(match[1] ?? '', 10);
    const month = match?.[2] === undefined ? null : Number.parseInt(match[2], 10);
    out['issuedMonth'] = month !== null && month >= 1 && month <= 12 ? month : null;
  } else if (column === 'pages') {
    out['pages'] = value;
    const span = value === null ? { first: null, last: null } : parsePageSpan(value);
    out['pageFirst'] = span.first;
    out['pageLast'] = span.last;
  } else {
    out[column] = value;
  }
  return out as BibliographicInput;
};

/** A projected column value in the form Zotero stores. */
const formatForZotero = (column: string, value: string | null): string => {
  if (value === null) return '';
  if (column === 'accessedAt') return value.replace(/\.\d+Z$/u, 'Z');
  return value;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export { sortedUnique };
