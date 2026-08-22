/**
 * The Zotero importer (CONCEPT §6, §7 Phase 1 exit criterion).
 *
 * The order of the stages is the whole design, so it is worth stating before the code.
 *
 * 1. **Collections, tags, creators** first, because items refer to all three.
 * 2. **Items**, every one of them *live*, including the ones Zotero has in its trash. Trashing is
 *    deferred to stage 9 for one reason: `NoteService.create` refuses a trashed parent, and Zotero
 *    keeps notes and attachments on trashed items. Creating everything live and trashing at the end
 *    reproduces Zotero's state without a special case for every child of a trashed parent.
 * 3. **Attachments**, which resolve and hash a file, ingest it as a Document (ADR-0004) and link
 *    it. A file that is not there does not fail the run: it becomes a review entry (P3).
 * 4. **Notes**, then **annotations** (which need their attachment's document), then **relations**
 *    (which need every item to exist before a target can be resolved).
 * 5. **Trash**, where Zotero's `deletedItems` is applied, cascading to children exactly as
 *    `LibraryService.trashItem` does.
 * 6. **Finalise**: the values that had to wait for the trash — a DOI or a citation key held by a
 *    live twin, which only becomes free once that twin is the sole live claimant — and the
 *    `date_modified` the services do not accept as an argument.
 *
 * Three properties are load-bearing.
 *
 * **Idempotence (P9).** Every write is keyed by something the source library owns: an item by
 * `(source_system, source_id) = ('zotero', <item key>)`, a document by the SHA-256 of its bytes, a
 * collection by its parent and name, a tag by its name, a creator by its name parts, an annotation
 * by `external_ref`, a note by its parent and its verbatim source HTML, an attachment by its parent
 * and its document, URL or path. Importing the same library twice therefore produces the same
 * library, not a doubled one, and there is no bookkeeping table to keep in step.
 *
 * **Resumability (P9, IK4).** The `jobs` row carries a cursor written after every record. A resumed
 * run skips the stages that finished, rebuilding from the database the identifier maps those stages
 * would have produced, and repeats the interrupted stage from its start — which is safe for exactly
 * the reason above.
 *
 * **A report that survives a resume.** Every observation — an attachment's outcome, a skipped
 * record, a review entry — is written to `job_logs` as it happens rather than accumulated in
 * memory, and the verification report is assembled at the end from those rows plus queries against
 * both databases. So the report of a run that was interrupted twice says the same thing as the
 * report of one that was not (§6.4: the log exists so a report can answer "what happened to this
 * file during the import").
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  NotFoundError,
  newId,
  newPublicId,
  normalise,
  nowTimestamp,
  scopeKey,
  schema,
} from '@recueil/core';
import type { Actor, BibliographicInput, CreatorRole, Recueil } from '@recueil/core';
import { and, eq, isNull, like } from 'drizzle-orm';

import { claimsFile, linkModeName, resolveAttachment } from './attachments.js';
import type { AttachmentSources, ResolvedAttachment } from './attachments.js';
import {
  IMPORT_STAGES,
  checkpoint,
  claimImportJob,
  clearJobLog,
  finishJob,
  importIdempotencyKey,
  libraryHash,
  logJob,
  setProgressTotal,
} from './job.js';
import type { ImportCursor, ImportProgress, ImportStage } from './job.js';
import { UnmappableAnnotationError, mapZoteroAnnotation } from './map/annotations.js';
import { resolveCitationKey } from './map/citation-keys.js';
import type { ResolvedCitationKey } from './map/citation-keys.js';
import { creatorIdentity, mapCreatorName, mapCreatorRole } from './map/creators.js';
import { mapZoteroTimestamp } from './map/dates.js';
import { parseExtra } from './map/extra.js';
import type { ParsedExtra } from './map/extra.js';
import { mapZoteroFields } from './map/fields.js';
import type { CarriedField, MappedFields } from './map/fields.js';
import { mapZoteroItemType } from './map/item-types.js';
import type { ItemTypeMapping } from './map/item-types.js';
import type {
  ZoteroAnnotationRow,
  ZoteroAttachmentRow,
  ZoteroCollectionRow,
  ZoteroCreatorRow,
  ZoteroItemRow,
  ZoteroNoteRow,
  ZoteroTagRow,
} from './reader/types.js';
import { ZoteroLibrary, readBetterBibtexKeys } from './reader/zotero-library.js';
import { buildReport, readImportLog } from './report/build.js';
import type { AttachmentReportEntry, ReviewEntry, SkippedRecord, ZoteroImportReport } from './report/types.js';
import { writeReport } from './report/write.js';

/** The provenance source every field this importer writes carries (`spec/data-model.md` §3.6). */
export const IMPORT_SOURCE = 'import:zotero';

/** `items.source_system`, and therefore half of the key that makes a re-run match (P9). */
export const SOURCE_SYSTEM = 'zotero';

/** `document_provenance.source_ref` for an imported file: the Zotero attachment it arrived as. */
export const attachmentSourceRef = (zoteroKey: string): string => `zotero:${zoteroKey}`;

/** Zotero item types that are not library records in their own right. */
export const NON_REGULAR_ZOTERO_TYPES: ReadonlySet<string> = new Set(['note', 'attachment', 'annotation']);

export interface ZoteroImportOptions {
  /** Path to `zotero.sqlite`. Opened read-only, through a copy, and never written to. */
  databasePath: string;
  /** `better-bibtex.sqlite`. Defaults to the file of that name beside `zotero.sqlite`. */
  betterBibtexPath?: string | null;
  /** Zotero's `storage/` directory. Defaults to `storage/` beside `zotero.sqlite`. */
  storageDirectory?: string | null;
  /** Zotero's "Linked Attachment Base Directory", for `attachments:` paths. */
  linkedAttachmentBase?: string | null;
  /** A directory of `<KEY>.zip` files, as a WebDAV sync target holds them. */
  webdavDirectory?: string | null;
  /** Which Zotero library to read. Defaults to the personal library. */
  libraryId?: number;
  /** Distinguishes two deliberate imports of the same library. Part of the idempotency key (IK1). */
  runLabel?: string;
  /** Copy the source database before opening it. Default true; see `reader/readonly-db.ts`. */
  copySourceBeforeReading?: boolean;
  /**
   * What to do with a linked file that is present on disk.
   *
   * `store` — the default — hashes it into the content-addressed store and records the original
   * path beside it, which is what P1 (the server is the source of truth) and P2 (the hash is
   * identity) want, and what puts the file into the hash-coverage report. `link` keeps it as a
   * `linked_file` attachment pointing at the path, which invariant AT5 names as a P10 hazard and
   * which exists for a desktop-only library that must keep its layout.
   */
  linkedFilePolicy?: 'store' | 'link';
  /** Where `report.json`, `report.md` and `_REVIEW/` are written. Nothing is written when absent. */
  reportDirectory?: string | null;
  /** Called after every record. Returning true stops the run cleanly at the next checkpoint. */
  abortAfter?: (progress: ImportProgress) => boolean;
}

export interface ZoteroImportResult {
  report: ZoteroImportReport;
  jobId: string;
  /** Where the report was written, when `reportDirectory` was given. */
  reportPaths: { json: string; markdown: string; review: string } | null;
}

/** Thrown when `abortAfter` stopped the run. The job keeps its cursor and can be resumed. */
export class ImportCancelledError extends Error {
  readonly jobId: string;

  readonly cursor: ImportCursor;

  constructor(jobId: string, cursor: ImportCursor) {
    super(
      `Zotero import cancelled during stage '${cursor.stage}' after ${cursor.index} records. The ` +
        'job keeps its cursor; running the import again resumes it.',
    );
    this.name = 'ImportCancelledError';
    this.jobId = jobId;
    this.cursor = cursor;
  }
}

/** Import a Zotero library into an open Recueil library. */
export const importZoteroLibrary = async (
  recueil: Recueil,
  options: ZoteroImportOptions,
): Promise<ZoteroImportResult> => new ZoteroImporter(recueil, options).run();

/* ================================================================================================ */

/** Everything decided about one Zotero item before the first write. */
export interface ItemPlan {
  zotero: ZoteroItemRow;
  mapping: ItemTypeMapping;
  fields: MappedFields;
  extra: ParsedExtra;
  citationKey: ResolvedCitationKey;
  /** Withheld now because a live item holds it; written in `finalise`, after the trash. */
  deferredDoi: string | null;
  deferredCitationKey: string | null;
  /** Refused outright: a live item holds it and this item is live too. */
  droppedDoi: string | null;
  droppedCitationKey: string | null;
}

class ZoteroImporter {
  private readonly recueil: Recueil;

  private readonly options: ZoteroImportOptions;

  private readonly actor: Actor;

  private readonly sources: AttachmentSources;

  private library!: ZoteroLibrary;

  private jobId = '';

  private resumeStageIndex = 0;

  private stage: ImportStage = 'collections';

  private stageIndex = 0;

  private stageTotal = 0;

  private done = 0;

  /* Zotero identity to Recueil id. Populated as the run goes, rebuilt from the database on resume. */
  private readonly itemIdByKey = new Map<string, string>();

  private readonly collectionIdByZoteroId = new Map<number, string>();

  private readonly tagIdByZoteroId = new Map<number, string>();

  private readonly creatorIdByZoteroId = new Map<number, string>();

  private readonly attachmentIdByKey = new Map<string, string>();

  private readonly documentIdByAttachmentKey = new Map<string, string>();

  private readonly definedCustomFields = new Set<string>();

  constructor(recueil: Recueil, options: ZoteroImportOptions) {
    this.recueil = recueil;
    this.options = options;
    this.actor = { type: 'import' };
    const beside = dirname(resolve(options.databasePath));
    this.sources = {
      storageDirectory:
        options.storageDirectory === undefined
          ? existingOrNull(join(beside, 'storage'))
          : options.storageDirectory,
      linkedAttachmentBase: options.linkedAttachmentBase ?? null,
      webdavDirectory: options.webdavDirectory ?? null,
    };
  }

  async run(): Promise<ZoteroImportResult> {
    const startedAt = nowTimestamp();
    const startedMs = Date.now();
    const copy = this.options.copySourceBeforeReading !== false;

    this.library = new ZoteroLibrary(this.options.databasePath, {
      copy,
      ...(this.options.libraryId === undefined ? {} : { libraryId: this.options.libraryId }),
    });

    try {
      const betterBibtexPath =
        this.options.betterBibtexPath === undefined
          ? existingOrNull(join(dirname(resolve(this.options.databasePath)), 'better-bibtex.sqlite'))
          : this.options.betterBibtexPath;

      const job = claimImportJob(this.recueil, {
        idempotencyKey: importIdempotencyKey(
          libraryHash({
            localUserKey: this.library.localUserKey(),
            userId: this.library.syncedUserId(),
            libraryId: this.library.libraryId,
            databasePath: resolve(this.options.databasePath),
          }),
          this.options.runLabel ?? 'default',
        ),
        params: {
          databasePath: resolve(this.options.databasePath),
          libraryId: this.library.libraryId,
          betterBibtexPath,
          storageDirectory: this.sources.storageDirectory,
          linkedAttachmentBase: this.sources.linkedAttachmentBase,
          webdavDirectory: this.sources.webdavDirectory,
          linkedFilePolicy: this.options.linkedFilePolicy ?? 'store',
        },
      });
      this.jobId = job.id;
      this.resumeStageIndex =
        job.resumedFrom === null ? 0 : Math.max(0, IMPORT_STAGES.indexOf(job.resumedFrom.stage));

      // A run that starts from the beginning re-observes everything, so the previous attempt's
      // observations would be stale duplicates. A resumed run keeps them: they are the record of
      // the stages it is about to skip.
      if (job.resumedFrom === null) clearJobLog(this.recueil, this.jobId);

      const report = await this.execute({
        startedAt,
        startedMs,
        betterBibtexPath,
        copy,
        attempt: job.attempt,
        idempotencyKey: job.idempotencyKey,
        resumedFromStage: job.resumedFrom?.stage ?? null,
      });

      finishJob(this.recueil, this.jobId, {
        state: 'succeeded',
        result: {
          pass: report.pass,
          items: report.items.recueilRegularTotal,
          attachmentsResolved: report.attachments.resolved,
          attachmentsMissing: report.attachments.missing,
          review: report.review.length,
        },
      });

      const reportPaths =
        this.options.reportDirectory == null ? null : writeReport(this.options.reportDirectory, report);

      return { report, jobId: this.jobId, reportPaths };
    } catch (error) {
      if (this.jobId === '') throw error;
      if (error instanceof ImportCancelledError) {
        finishJob(this.recueil, this.jobId, { state: 'cancelled' });
      } else {
        finishJob(this.recueil, this.jobId, {
          state: 'failed',
          errorCode: error instanceof Error ? error.name : 'Error',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    } finally {
      this.library.close();
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* The stages                                                                                  */
  /* ---------------------------------------------------------------------------------------- */

  private async execute(context: {
    startedAt: string;
    startedMs: number;
    betterBibtexPath: string | null;
    copy: boolean;
    attempt: number;
    idempotencyKey: string;
    resumedFromStage: ImportStage | null;
  }): Promise<ZoteroImportReport> {
    const items = this.library.items();
    const regular = items.filter((row) => !NON_REGULAR_ZOTERO_TYPES.has(row.itemType));
    const globalSchema = this.library.globalSchema();

    const betterBibtex =
      context.betterBibtexPath === null
        ? []
        : readBetterBibtexKeys(context.betterBibtexPath, { copy: context.copy });

    setProgressTotal(this.recueil, this.jobId, items.length + this.library.collections().length);

    const plans = this.plan(regular, globalSchema?.cslTypeByItemType ?? {}, betterBibtex);

    this.runStage('collections', this.library.collections(), (collection, all) =>
      this.importCollection(collection, all),
    );
    this.runStage('tags', this.library.tags(), (tag) => this.importTag(tag));
    this.runStage('creators', this.library.creators(), (creator) => this.importCreator(creator));
    this.runStage('items', plans, (plan) => this.importItem(plan));
    await this.runStageAsync('attachments', this.library.attachments(), (attachment) =>
      this.importAttachment(attachment),
    );
    this.runStage('notes', this.library.notes(), (note) => this.importNote(note));
    await this.runStageAsync('annotations', this.library.annotations(), (annotation) =>
      this.importAnnotation(annotation),
    );
    this.runStage('relations', this.relationGroups(), (group) => this.importRelations(group));
    this.runStage('trash', [null], () => this.applyTrash(items));
    this.runStage('finalise', plans, (plan) => this.finaliseItem(plan));

    return buildReport({
      library: this.library,
      recueil: this.recueil,
      plans,
      log: readImportLog(this.recueil, this.jobId),
      betterBibtex,
      betterBibtexPath: context.betterBibtexPath,
      sources: this.sources,
      run: {
        jobId: this.jobId,
        idempotencyKey: context.idempotencyKey,
        runLabel: this.options.runLabel ?? 'default',
        startedAt: context.startedAt,
        finishedAt: nowTimestamp(),
        durationMs: Date.now() - context.startedMs,
        attempt: context.attempt,
        resumedFromStage: context.resumedFromStage,
      },
    });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Planning: the decisions that need the whole library before the first write                  */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * Work out, for every item, its type, its fields and its citation key — and which items must
   * give up a DOI or a key because two of them claim the same one.
   *
   * `ux_item_bibliographic_doi` and `ux_item_bibliographic_citation_key` are unique **among live
   * items**, so a duplicate is only a problem while both claimants are live. That gives two
   * outcomes rather than one: a duplicate between a live item and one Zotero has in its trash is
   * *deferred* — written in `finalise`, once the trash has been applied and the index no longer
   * sees the trashed row — while a duplicate between two live items is genuinely unrepresentable
   * and is refused, reported and carried into a custom field, which is P3 rather than a crash.
   *
   * Planning runs on every attempt, including a resumed one, because it is a pure function of the
   * source library. That is what lets the report's citation-key section be correct after a resume.
   */
  private plan(
    regular: readonly ZoteroItemRow[],
    cslTypes: Readonly<Record<string, string>>,
    betterBibtex: readonly { itemKey: string; citationKey: string; pinned: boolean }[],
  ): ItemPlan[] {
    const fieldValues = this.library.fieldValues();
    const bbtByKey = new Map(betterBibtex.map((row) => [row.itemKey, row]));

    const plans = regular.map((zotero): ItemPlan => {
      const mapping = mapZoteroItemType(zotero.itemType, cslTypes);
      const fields = mapZoteroFields(fieldValues.get(zotero.itemID) ?? [], {
        zoteroItemType: zotero.itemType,
        cslType: mapping.cslType,
      });
      const extra = parseExtra(fields.extra);
      const bbt = bbtByKey.get(zotero.key);
      const citationKey = resolveCitationKey({
        native: fields.nativeCitationKey,
        extraLine: extra.citationKey,
        betterBibtex: bbt === undefined ? null : { key: bbt.citationKey, pinned: bbt.pinned },
      });

      // Identifiers `Extra` carries and the facet has a column for. Written only where the item's
      // own fields did not supply them: a field beats a note about a field.
      if (extra.pmid !== null && fields.bibliographic.pmid === undefined) fields.bibliographic.pmid = extra.pmid;
      if (extra.pmcid !== null && fields.bibliographic.pmcid === undefined) {
        fields.bibliographic.pmcid = extra.pmcid;
      }
      if (extra.arxivId !== null && fields.bibliographic.arxivId === undefined) {
        fields.bibliographic.arxivId = extra.arxivId;
      }

      return {
        zotero,
        mapping,
        fields,
        extra,
        citationKey,
        deferredDoi: null,
        deferredCitationKey: null,
        droppedDoi: null,
        droppedCitationKey: null,
      };
    });

    this.allocate(
      plans,
      (plan) => (typeof plan.fields.bibliographic.doi === 'string' ? plan.fields.bibliographic.doi : null),
      (plan, outcome, value) => {
        delete plan.fields.bibliographic.doi;
        if (outcome === 'defer') {
          plan.deferredDoi = value;
          return;
        }
        plan.droppedDoi = value;
        plan.fields.carried.push({
          zoteroField: 'DOI',
          fieldKey: 'zotero_doi_conflict',
          label: 'Zotero: DOI (claimed by another item)',
          value,
          reason: 'column_taken',
          detail: 'two live items may not claim the same DOI (invariant B1)',
        });
      },
    );

    this.allocate(
      plans,
      (plan) => plan.citationKey.key,
      (plan, outcome, value) => {
        plan.citationKey = { ...plan.citationKey, key: null };
        if (outcome === 'defer') {
          plan.deferredCitationKey = value;
          return;
        }
        plan.droppedCitationKey = value;
      },
    );

    return plans;
  }

  /**
   * Decide who keeps a value that must be unique among live items.
   *
   * A live item wins over a trashed one whatever their order, because the live one is the one the
   * library will show; among live items the lowest Zotero item id wins, so the answer does not
   * depend on the order rows came back in.
   */
  private allocate(
    plans: readonly ItemPlan[],
    valueOf: (plan: ItemPlan) => string | null,
    give: (plan: ItemPlan, outcome: 'defer' | 'drop', value: string) => void,
  ): void {
    const byValue = new Map<string, ItemPlan[]>();
    for (const plan of plans) {
      const value = valueOf(plan);
      if (value === null) continue;
      const list = byValue.get(value) ?? [];
      list.push(plan);
      byValue.set(value, list);
    }

    for (const claimants of byValue.values()) {
      if (claimants.length < 2) continue;
      const live = claimants.filter((plan) => plan.zotero.dateDeleted === null);
      const owner = (live.length > 0 ? live : claimants).reduce((best, plan) =>
        plan.zotero.itemID < best.zotero.itemID ? plan : best,
      );
      for (const plan of claimants) {
        if (plan === owner) continue;
        give(plan, plan.zotero.dateDeleted === null ? 'drop' : 'defer', valueOf(plan) as string);
      }
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Stage drivers                                                                               */
  /* ---------------------------------------------------------------------------------------- */

  private runStage<TRecord>(
    stage: ImportStage,
    records: readonly TRecord[],
    handle: (record: TRecord, all: readonly TRecord[]) => void,
  ): void {
    if (!this.beginStage(stage, records.length)) return;
    for (const record of records) {
      handle(record, records);
      this.advance();
    }
  }

  private async runStageAsync<TRecord>(
    stage: ImportStage,
    records: readonly TRecord[],
    handle: (record: TRecord) => Promise<void>,
  ): Promise<void> {
    if (!this.beginStage(stage, records.length)) return;
    for (const record of records) {
      await handle(record);
      this.advance();
    }
  }

  /**
   * Start a stage, or skip one an earlier attempt already finished (IK4).
   *
   * Skipping is only safe because the identifier maps the stage would have built are rebuilt from
   * the database instead. Everything else the stage did — the rows themselves and the observations
   * in `job_logs` — is already there.
   */
  private beginStage(stage: ImportStage, total: number): boolean {
    if (IMPORT_STAGES.indexOf(stage) < this.resumeStageIndex) {
      this.rehydrate(stage);
      return false;
    }
    this.stage = stage;
    this.stageIndex = 0;
    this.stageTotal = total;
    checkpoint(this.recueil, this.jobId, { stage, index: 0 }, this.done);
    return true;
  }

  private advance(): void {
    this.stageIndex += 1;
    this.done += 1;
    const cursor: ImportCursor = { stage: this.stage, index: this.stageIndex };
    checkpoint(this.recueil, this.jobId, cursor, this.done);
    if (this.options.abortAfter?.({ ...cursor, total: this.stageTotal }) === true) {
      throw new ImportCancelledError(this.jobId, cursor);
    }
  }

  /** Rebuild the identifier map a skipped stage would have produced. */
  private rehydrate(stage: ImportStage): void {
    switch (stage) {
      case 'collections':
        for (const collection of this.library.collections()) {
          const parentId = this.parentCollectionId(collection);
          const found = this.findCollection(collection.collectionName, parentId);
          if (found !== undefined) this.collectionIdByZoteroId.set(collection.collectionID, found);
        }
        return;
      case 'tags':
        for (const tag of this.library.tags()) {
          const found = this.recueil.tags.findByName(tag.name);
          if (found !== undefined) this.tagIdByZoteroId.set(tag.tagID, found.id);
        }
        return;
      case 'creators':
        for (const creator of this.library.creators()) {
          const found = this.findCreator(creator);
          if (found !== undefined) this.creatorIdByZoteroId.set(creator.creatorID, found);
        }
        return;
      case 'items':
        for (const row of this.recueil.db
          .select({ id: schema.items.id, sourceId: schema.items.sourceId })
          .from(schema.items)
          .where(eq(schema.items.sourceSystem, SOURCE_SYSTEM))
          .all()) {
          if (row.sourceId !== null) this.itemIdByKey.set(row.sourceId, row.id);
        }
        return;
      case 'attachments':
        this.rehydrateAttachments();
        return;
      default:
        return;
    }
  }

  /**
   * Rebuild "which Recueil attachment is this Zotero attachment".
   *
   * The link is `document_provenance.source_ref`, which the ingest already wrote as
   * `zotero:<attachment key>` (P4). That is the whole reason the importer sets it: it makes the
   * correspondence a fact in the database rather than something only the running process knew.
   */
  private rehydrateAttachments(): void {
    const provenance = this.recueil.db
      .select({
        documentId: schema.documentProvenance.documentId,
        sourceRef: schema.documentProvenance.sourceRef,
      })
      .from(schema.documentProvenance)
      .where(like(schema.documentProvenance.sourceRef, 'zotero:%'))
      .all();
    for (const row of provenance) {
      if (row.sourceRef === null) continue;
      this.documentIdByAttachmentKey.set(row.sourceRef.slice('zotero:'.length), row.documentId);
    }

    for (const attachment of this.library.attachments()) {
      const zoteroItem = this.library.itemsById().get(attachment.itemID);
      if (zoteroItem === undefined) continue;
      const hostItemId = this.hostItemIdFor(attachment, zoteroItem);
      if (hostItemId === undefined) continue;

      const rows = this.recueil.db
        .select({
          id: schema.attachments.id,
          documentId: schema.attachments.documentId,
          url: schema.attachments.url,
          linkedPath: schema.attachments.linkedPath,
        })
        .from(schema.attachments)
        .where(eq(schema.attachments.itemId, hostItemId))
        .all();

      const documentId = this.documentIdByAttachmentKey.get(zoteroItem.key);
      if (documentId !== undefined) {
        const match = rows.find((row) => row.documentId === documentId);
        if (match !== undefined) this.attachmentIdByKey.set(zoteroItem.key, match.id);
        continue;
      }

      const resolution = resolveAttachment(attachment, zoteroItem.key, this.sources);
      const expected =
        resolution.status === 'resolved'
          ? resolution.source
          : (resolution.expectedPath ?? `zotero:${zoteroItem.key}/${resolution.filename ?? ''}`);
      const url = this.attachmentUrl(attachment.itemID);
      const match = rows.find((row) =>
        attachment.linkMode === 3 ? row.url === url : row.linkedPath === expected,
      );
      if (match !== undefined) this.attachmentIdByKey.set(zoteroItem.key, match.id);
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Collections, tags, creators                                                                 */
  /* ---------------------------------------------------------------------------------------- */

  private importCollection(collection: ZoteroCollectionRow, all: readonly ZoteroCollectionRow[]): void {
    const parentId = this.ensureAncestors(collection, all, new Set());
    this.collectionIdByZoteroId.set(collection.collectionID, this.ensureCollection(collection, parentId));
  }

  /**
   * Make sure a collection's ancestors exist before it does.
   *
   * `collections` comes back in `collectionID` order, which is creation order in Zotero and
   * therefore *usually* parents-first — but only usually, and a child written before its parent
   * would get the wrong `parent_key` and the wrong depth. The recursion costs nothing and removes
   * the assumption.
   */
  private ensureAncestors(
    collection: ZoteroCollectionRow,
    all: readonly ZoteroCollectionRow[],
    seen: Set<number>,
  ): string | null {
    const parentZoteroId = collection.parentCollectionID;
    if (parentZoteroId === null) return null;
    const known = this.collectionIdByZoteroId.get(parentZoteroId);
    if (known !== undefined) return known;
    if (seen.has(parentZoteroId)) return null;
    seen.add(parentZoteroId);

    const parent = all.find((row) => row.collectionID === parentZoteroId);
    if (parent === undefined) return null;
    const grandparent = this.ensureAncestors(parent, all, seen);
    const id = this.ensureCollection(parent, grandparent);
    this.collectionIdByZoteroId.set(parentZoteroId, id);
    return id;
  }

  private ensureCollection(collection: ZoteroCollectionRow, parentId: string | null): string {
    const existing = this.findCollection(collection.collectionName, parentId);
    if (existing !== undefined) return existing;
    return this.recueil.collections.create({ name: collection.collectionName, parentId }, this.actor).id;
  }

  /** Sibling names are unique among live collections, so `(parent, name)` is the natural key. */
  private findCollection(name: string, parentId: string | null): string | undefined {
    return this.recueil.db
      .select({ id: schema.collections.id })
      .from(schema.collections)
      .where(
        and(
          eq(schema.collections.parentKey, scopeKey(parentId)),
          eq(schema.collections.nameNormalised, normalise(name)),
        ),
      )
      .get()?.id;
  }

  private parentCollectionId(collection: ZoteroCollectionRow): string | null {
    if (collection.parentCollectionID === null) return null;
    const known = this.collectionIdByZoteroId.get(collection.parentCollectionID);
    if (known !== undefined) return known;
    const parent = this.library
      .collections()
      .find((row) => row.collectionID === collection.parentCollectionID);
    if (parent === undefined) return null;
    const grandparent = this.parentCollectionId(parent);
    const found = this.findCollection(parent.collectionName, grandparent);
    if (found !== undefined) this.collectionIdByZoteroId.set(parent.collectionID, found);
    return found ?? null;
  }

  /**
   * One tag.
   *
   * Zotero records "added by a person" against the *assignment*; Recueil records it against the
   * tag (`tags.scheme`) and records the assignment's own source separately. A tag every one of
   * whose assignments is automatic becomes `automatic`; a tag with any manual assignment stays
   * `manual`, because a tag a person has used deliberately even once is theirs.
   */
  private importTag(tag: ZoteroTagRow): void {
    const existing = this.recueil.tags.findByName(tag.name);
    if (existing !== undefined) {
      this.tagIdByZoteroId.set(tag.tagID, existing.id);
      return;
    }

    const assignments = this.library.itemTags().filter((row) => row.tagID === tag.tagID);
    const automatic = assignments.length > 0 && assignments.every((row) => row.type === 1);
    const colour = this.library.tagColours().find((entry) => entry.name === tag.name);

    const created = this.recueil.tags.create(
      {
        name: tag.name,
        scheme: automatic ? 'automatic' : 'manual',
        colour: colour?.color ?? null,
        ...(colour === undefined ? {} : { position: colour.position }),
      },
      this.actor,
    );
    this.tagIdByZoteroId.set(tag.tagID, created.id);
  }

  private importCreator(row: ZoteroCreatorRow): void {
    const existing = this.findCreator(row);
    if (existing !== undefined) {
      this.creatorIdByZoteroId.set(row.creatorID, existing);
      return;
    }
    const name = mapCreatorName(row);
    const created = this.recueil.creators.create(
      {
        kind: name.kind,
        familyName: name.familyName,
        givenName: name.givenName,
        literalName: name.literalName,
      },
      this.actor,
    );
    this.creatorIdByZoteroId.set(row.creatorID, created.id);
  }

  /** The natural key for a creator: the exact name parts, which is what Zotero deduplicates on. */
  private findCreator(row: ZoteroCreatorRow): string | undefined {
    const name = mapCreatorName(row);
    const identity = creatorIdentity(name);
    const sortName =
      name.literalName !== null
        ? normalise(name.literalName)
        : normalise(
            name.givenName === null
              ? (name.familyName ?? '')
              : `${name.familyName ?? ''}, ${name.givenName}`,
          );

    return this.recueil.creators
      .findBySortName(sortName)
      .find(
        (candidate) =>
          creatorIdentity({
            kind: candidate.kind,
            familyName: candidate.familyName,
            givenName: candidate.givenName,
            literalName: candidate.literalName,
            rawName: candidate.displayName,
          }) === identity,
      )?.id;
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Items                                                                                       */
  /* ---------------------------------------------------------------------------------------- */

  private importItem(plan: ItemPlan): void {
    /*
     * A re-run meets items that this importer put in the trash on an earlier pass, and every
     * writing service refuses a trashed item — correctly, because editing something in the bin is
     * a mistake in every other caller. There is nothing to do for one anyway: it was imported in
     * full before it was trashed, and `finalise` reaches its deferred values by their own path.
     */
    const alreadyTrashed = this.findTrashedItemByZoteroKey(plan.zotero.key);
    if (alreadyTrashed !== undefined) {
      this.itemIdByKey.set(plan.zotero.key, alreadyTrashed);
      return;
    }

    const bibliographic: BibliographicInput = { ...plan.fields.bibliographic };
    if (plan.citationKey.key !== null) {
      bibliographic.citationKey = plan.citationKey.key;
      bibliographic.citationKeyLocked = true;
    }

    const itemId = this.ensureItem(plan, bibliographic);
    this.itemIdByKey.set(plan.zotero.key, itemId);

    // ADR-0016: a key that arrives from a migration is pinned, because it is already in a
    // manuscript. The column records the pin; the field lock is what refuses a later rewrite.
    if (plan.citationKey.key !== null) this.pinCitationKey(itemId);

    this.setItemCreators(plan, itemId);
    this.assignTags(plan.zotero.itemID, itemId);
    this.fileInCollections(plan.zotero.itemID, itemId);
    this.writeCarriedFields(itemId, plan.fields.carried);

    if (plan.droppedDoi !== null) {
      this.review({
        kind: 'doi',
        zoteroKey: plan.zotero.key,
        subject: plan.fields.title ?? plan.zotero.key,
        reason: `another live item already claims DOI ${plan.droppedDoi}; two live items may not (invariant B1)`,
        proposedAction: 'deduplicate the two items, then set the DOI on the survivor',
        detail: { doi: plan.droppedDoi },
      });
    }
    if (plan.droppedCitationKey !== null) {
      this.review({
        kind: 'citation_key',
        zoteroKey: plan.zotero.key,
        subject: plan.fields.title ?? plan.zotero.key,
        reason: `another live item already holds the citation key '${plan.droppedCitationKey}' (ADR-0016)`,
        proposedAction: 'decide which item the key belongs to; the other needs a new one',
        detail: { citationKey: plan.droppedCitationKey },
      });
    }
    if (plan.citationKey.conflict) {
      this.review({
        kind: 'citation_key',
        zoteroKey: plan.zotero.key,
        subject: plan.fields.title ?? plan.zotero.key,
        reason: 'the Zotero field, the Extra line and Better BibTeX give different citation keys',
        proposedAction: `kept '${plan.citationKey.candidates[0]?.key ?? '—'}' from ${
          plan.citationKey.candidates[0]?.source ?? 'nowhere'
        }; confirm it is the one in the manuscripts`,
        detail: { candidates: plan.citationKey.candidates },
      });
    }
  }

  private ensureItem(plan: ItemPlan, bibliographic: BibliographicInput): string {
    const existing = this.findItemByZoteroKey(plan.zotero.key);
    if (existing !== undefined) {
      this.recueil.library.writeBibliographic(existing, bibliographic, this.actor, {
        provenance: { source: IMPORT_SOURCE, lock: false },
      });
      return existing;
    }

    return this.recueil.library.createItem(
      {
        itemType: plan.mapping.itemType,
        title: plan.fields.title,
        extra: plan.fields.extra,
        sourceSystem: SOURCE_SYSTEM,
        sourceId: plan.zotero.key,
        dateAdded: mapZoteroTimestamp(plan.zotero.dateAdded) ?? nowTimestamp(),
        bibliographic,
        provenance: { source: IMPORT_SOURCE, lock: false },
      },
      this.actor,
    ).item.id;
  }

  private pinCitationKey(itemId: string): void {
    try {
      this.recueil.library.lockBibliographicField(itemId, 'citationKey', this.actor);
    } catch (error) {
      // The only route here is a facet write the provenance gate refused, which has already left a
      // trace of its own; a failed pin must not end the run.
      logJob(this.recueil, this.jobId, {
        level: 'warn',
        message: `could not pin the citation key: ${messageOf(error)}`,
        subjectType: 'item',
        subjectId: itemId,
      });
    }
  }

  private setItemCreators(plan: ItemPlan, itemId: string): void {
    const appearances = [...(this.library.itemCreatorsByItem().get(plan.zotero.itemID) ?? [])].sort(
      (left, right) => left.orderIndex - right.orderIndex,
    );
    if (appearances.length === 0) return;

    const primary = this.library.primaryCreatorTypes();
    const creatorRows = this.library.creatorsById();
    const entries: Array<{ creatorId: string; role: CreatorRole; rawName: string | null }> = [];
    const seen = new Set<string>();

    for (const appearance of appearances) {
      const creatorId = this.creatorIdByZoteroId.get(appearance.creatorID);
      const source = creatorRows.get(appearance.creatorID);
      if (creatorId === undefined || source === undefined) continue;

      const mapped = mapCreatorRole(appearance.creatorType, plan.zotero.itemType, primary);
      // IC2: the same person may hold two roles on an item but not the same role twice. Zotero
      // permits the duplicate, so it is reported rather than carried across and refused.
      const key = `${creatorId}:${mapped.role}`;
      if (seen.has(key)) {
        this.skip({
          kind: 'item_creator',
          zoteroKey: plan.zotero.key,
          subject: mapCreatorName(source).rawName,
          reason: `already appears as '${mapped.role}' on this item (invariant IC2)`,
        });
        continue;
      }
      seen.add(key);
      entries.push({ creatorId, role: mapped.role, rawName: mapCreatorName(source).rawName });
    }

    if (entries.length > 0) this.recueil.creators.setItemCreators(itemId, entries, this.actor);
  }

  private assignTags(zoteroItemId: number, itemId: string): void {
    for (const assignment of this.library.itemTagsByItem().get(zoteroItemId) ?? []) {
      const tagId = this.tagIdByZoteroId.get(assignment.tagID);
      if (tagId === undefined) continue;
      this.recueil.tags.assign(itemId, tagId, this.actor, { source: 'import' });
    }
  }

  /**
   * File an item in the collections Zotero has it in.
   *
   * `CollectionService.addItems` refuses a trashed collection, which is right for every other
   * caller and wrong for a re-run: the collection was trashed by the previous pass, and the
   * membership it holds is one this import put there. So a trashed collection gets the row written
   * directly, only when it is missing, which keeps the membership count in step with Zotero's
   * without asking the service to do something it should refuse.
   */
  private fileInCollections(zoteroItemId: number, itemId: string): void {
    for (const membership of this.library.collectionItemsByItem().get(zoteroItemId) ?? []) {
      const collectionId = this.collectionIdByZoteroId.get(membership.collectionID);
      if (collectionId === undefined) continue;

      const collection = this.recueil.db
        .select({ trashedAt: schema.collections.trashedAt })
        .from(schema.collections)
        .where(eq(schema.collections.id, collectionId))
        .get();
      if (collection?.trashedAt == null) {
        this.recueil.collections.addItems(collectionId, [itemId], this.actor, { source: 'import' });
        continue;
      }

      const existing = this.recueil.db
        .select({ itemId: schema.collectionItems.itemId })
        .from(schema.collectionItems)
        .where(
          and(
            eq(schema.collectionItems.collectionId, collectionId),
            eq(schema.collectionItems.itemId, itemId),
          ),
        )
        .get();
      if (existing !== undefined) continue;

      const now = nowTimestamp();
      this.recueil.db.transaction((tx) => {
        tx.insert(schema.collectionItems)
          .values({
            collectionId,
            itemId,
            position: 0,
            addedAt: now,
            addedByUserId: null,
            source: 'import',
          })
          .run();
        this.recueil.audit.record(
          {
            actor: this.actor,
            action: 'collection.items_added',
            entityType: 'collection',
            entityId: collectionId,
            after: { itemIds: [itemId], source: 'import' },
            reason: 'the collection is in the trash, having been trashed by this import',
          },
          tx,
        );
      });
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Attachments                                                                                 */
  /* ---------------------------------------------------------------------------------------- */

  private async importAttachment(attachment: ZoteroAttachmentRow): Promise<void> {
    const zoteroItem = this.library.itemsById().get(attachment.itemID);
    if (zoteroItem === undefined) return;

    const fields = this.library.fieldValues().get(attachment.itemID) ?? [];
    const title = fields.find((field) => field.baseField === 'title')?.value ?? null;
    const url = this.attachmentUrl(attachment.itemID);
    const parentKey = this.parentKeyOf(attachment);
    const mode = linkModeName(attachment.linkMode);

    const hostItemId =
      parentKey === null ? this.ensureAttachmentHostItem(zoteroItem, title) : this.itemIdByKey.get(parentKey);
    if (hostItemId === undefined) {
      this.skip({
        kind: 'attachment',
        zoteroKey: zoteroItem.key,
        subject: title ?? zoteroItem.key,
        reason: `its parent item '${parentKey ?? '?'}' was not imported`,
      });
      return;
    }

    const resolution = resolveAttachment(attachment, zoteroItem.key, this.sources);

    if (resolution.status === 'resolved' && this.storesBytes(attachment)) {
      await this.storeAttachment(attachment, zoteroItem, hostItemId, title, url, resolution, mode, parentKey);
      return;
    }

    if (resolution.status === 'resolved') {
      // A linked file under the `link` policy: recorded as a link, hashed only for the report.
      this.recordAttachmentRow(hostItemId, zoteroItem.key, {
        linkMode: 'linked_file',
        title,
        url: null,
        linkedPath: resolution.source,
        contentTypeHint: attachment.contentType,
      });
      this.attachmentOutcome({
        zoteroKey: zoteroItem.key,
        parentZoteroKey: parentKey,
        title,
        linkMode: mode,
        status: 'resolved',
        origin: resolution.origin,
        sha256: resolution.sha256,
        byteSize: resolution.byteSize,
        matchesZoteroHash: resolution.matchesZoteroHash,
        recueilLinkMode: 'linked_file',
        reason: null,
        expectedPath: resolution.source,
      });
      return;
    }

    if (resolution.status === 'no_file') {
      if (url === null) {
        this.skip({
          kind: 'attachment',
          zoteroKey: zoteroItem.key,
          subject: title ?? zoteroItem.key,
          reason: 'a linked-URL attachment with no URL cannot be represented (ck_attachments_link_mode)',
        });
        this.attachmentOutcome({
          zoteroKey: zoteroItem.key,
          parentZoteroKey: parentKey,
          title,
          linkMode: mode,
          status: 'no_file',
          origin: null,
          sha256: null,
          byteSize: null,
          matchesZoteroHash: null,
          recueilLinkMode: null,
          reason: 'no URL recorded',
          expectedPath: null,
        });
        return;
      }
      this.recordAttachmentRow(hostItemId, zoteroItem.key, {
        linkMode: 'linked_url',
        title,
        url,
        linkedPath: null,
        contentTypeHint: attachment.contentType,
      });
      this.attachmentOutcome({
        zoteroKey: zoteroItem.key,
        parentZoteroKey: parentKey,
        title,
        linkMode: mode,
        status: 'no_file',
        origin: null,
        sha256: null,
        byteSize: null,
        matchesZoteroHash: null,
        recueilLinkMode: 'linked_url',
        reason: null,
        expectedPath: null,
      });
      return;
    }

    /*
     * The file is missing or unreadable. P3: the attachment record survives, pointing at where the
     * file should be, and a review entry carries the reason. Dropping the row instead would make
     * the attachment count disagree with Zotero's and hide the very thing the report is for.
     */
    const expected = resolution.expectedPath ?? `zotero:${zoteroItem.key}/${resolution.filename ?? ''}`;
    this.recordAttachmentRow(hostItemId, zoteroItem.key, {
      linkMode: 'linked_file',
      title,
      url: null,
      linkedPath: expected,
      contentTypeHint: attachment.contentType,
    });
    this.attachmentOutcome({
      zoteroKey: zoteroItem.key,
      parentZoteroKey: parentKey,
      title,
      linkMode: mode,
      status: resolution.status,
      origin: null,
      sha256: null,
      byteSize: null,
      matchesZoteroHash: null,
      recueilLinkMode: 'linked_file',
      reason: resolution.reason,
      expectedPath: resolution.expectedPath,
    });
    this.review({
      kind: 'attachment',
      zoteroKey: zoteroItem.key,
      subject: title ?? resolution.filename ?? zoteroItem.key,
      reason: resolution.reason,
      proposedAction:
        resolution.status === 'missing'
          ? 'find the file and attach it, or delete the attachment record'
          : 'check the file, then run the import again to hash it',
      detail: { expectedPath: resolution.expectedPath, linkMode: mode },
    });
  }

  /** Whether this attachment's bytes belong in the content-addressed store. */
  private storesBytes(attachment: ZoteroAttachmentRow): boolean {
    if (attachment.linkMode === 0 || attachment.linkMode === 1) return true;
    return attachment.linkMode === 2 && (this.options.linkedFilePolicy ?? 'store') === 'store';
  }

  private async storeAttachment(
    attachment: ZoteroAttachmentRow,
    zoteroItem: ZoteroItemRow,
    hostItemId: string,
    title: string | null,
    url: string | null,
    resolution: ResolvedAttachment,
    mode: string,
    parentKey: string | null,
  ): Promise<void> {
    const known = this.recueil.documents.findBySha256(resolution.sha256);
    const role = attachment.linkMode === 1 ? 'snapshot' : this.roleFor(hostItemId);

    let documentId: string;
    if (known === null) {
      const ingest = await this.recueil.documents.ingestBuffer(resolution.bytes, {
        sourceKind: 'import',
        sourceRef: attachmentSourceRef(zoteroItem.key),
        sourceDetail: {
          zoteroKey: zoteroItem.key,
          origin: resolution.origin,
          source: resolution.source,
          linkMode: mode,
        },
        originalFilename: resolution.filename,
        declaredMimeType: attachment.contentType,
        observedAt: mapZoteroTimestamp(zoteroItem.dateAdded) ?? nowTimestamp(),
        jobId: this.jobId,
        actor: this.actor,
      });
      documentId = ingest.document.id;
    } else {
      documentId = known.id;
      this.ensureDocumentProvenance(documentId, known.sha256, zoteroItem, resolution, mode, attachment);
    }
    this.documentIdByAttachmentKey.set(zoteroItem.key, documentId);

    const existing = this.recueil.db
      .select({ id: schema.attachments.id })
      .from(schema.attachments)
      .where(and(eq(schema.attachments.itemId, hostItemId), eq(schema.attachments.documentId, documentId)))
      .get();

    const attachmentId =
      existing?.id ??
      this.recueil.documents.attachDocument({ itemId: hostItemId, documentId, role, title }, this.actor);
    this.attachmentIdByKey.set(zoteroItem.key, attachmentId);

    // The snapshot URL and the original location are facts about the attachment that the ingest
    // path has no argument for, and they are what keeps a migrated library traceable back to the
    // Zotero one. `link_mode = 'stored'` places no constraint on either column.
    const patch: Record<string, unknown> = { updatedAt: nowTimestamp() };
    if (url !== null) patch['url'] = url;
    if (resolution.origin === 'linked') patch['linkedPath'] = resolution.source;
    if (attachment.contentType !== null) patch['contentTypeHint'] = attachment.contentType;
    this.recueil.db
      .update(schema.attachments)
      .set(patch)
      .where(eq(schema.attachments.id, attachmentId))
      .run();

    this.attachmentOutcome({
      zoteroKey: zoteroItem.key,
      parentZoteroKey: parentKey,
      title,
      linkMode: mode,
      status: 'resolved',
      origin: resolution.origin,
      sha256: resolution.sha256,
      byteSize: resolution.byteSize,
      matchesZoteroHash: resolution.matchesZoteroHash,
      recueilLinkMode: 'stored',
      reason: null,
      expectedPath: resolution.source,
    });

    if (resolution.matchesZoteroHash === false) {
      this.review({
        kind: 'attachment',
        zoteroKey: zoteroItem.key,
        subject: title ?? resolution.filename,
        reason: 'the file on disk no longer matches the MD5 Zotero recorded for it',
        proposedAction:
          'check whether the file was replaced outside Zotero; the bytes that were imported are the ones on disk',
        detail: { sha256: resolution.sha256, zoteroMd5: attachment.storageHash },
      });
    }
  }

  /**
   * Record this Zotero attachment as an arrival of a document the library already had.
   *
   * Two Zotero attachments can be the same bytes — the same PDF filed under two items — and D1 says
   * that is one document. `document_provenance` is where the second arrival is recorded (P4), and
   * writing it here rather than letting `ingestBuffer` do it keeps the row idempotent: the importer
   * asks whether this Zotero key already has one, so a re-run does not add a third.
   */
  private ensureDocumentProvenance(
    documentId: string,
    sha256: string,
    zoteroItem: ZoteroItemRow,
    resolution: ResolvedAttachment,
    mode: string,
    attachment: ZoteroAttachmentRow,
  ): void {
    const sourceRef = attachmentSourceRef(zoteroItem.key);
    const existing = this.recueil.db
      .select({ id: schema.documentProvenance.id })
      .from(schema.documentProvenance)
      .where(
        and(
          eq(schema.documentProvenance.documentId, documentId),
          eq(schema.documentProvenance.sourceRef, sourceRef),
        ),
      )
      .get();
    if (existing !== undefined) return;

    this.recueil.db
      .insert(schema.documentProvenance)
      .values({
        id: newId(),
        documentId,
        sha256,
        sourceKind: 'import',
        sourceRef,
        sourceDetail: JSON.stringify({
          zoteroKey: zoteroItem.key,
          origin: resolution.origin,
          source: resolution.source,
          linkMode: mode,
        }),
        originalFilename: resolution.filename,
        declaredMimeType: attachment.contentType,
        isFirst: false,
        observedAt: mapZoteroTimestamp(zoteroItem.dateAdded) ?? nowTimestamp(),
        jobId: this.jobId,
        createdByUserId: null,
        createdAt: nowTimestamp(),
      })
      .run();
  }

  /** `primary` for the first file on an item, `supplement` afterwards (`ux_attachments_primary`). */
  private roleFor(itemId: string): 'primary' | 'supplement' {
    const primary = this.recueil.db
      .select({ id: schema.attachments.id })
      .from(schema.attachments)
      .where(
        and(
          eq(schema.attachments.itemId, itemId),
          eq(schema.attachments.role, 'primary'),
          isNull(schema.attachments.trashedAt),
        ),
      )
      .get();
    return primary === undefined ? 'primary' : 'supplement';
  }

  /**
   * The host item a standalone Zotero attachment needs.
   *
   * `attachments.item_id` is not nullable — an attachment in Recueil is always an attachment *to*
   * something — so a Zotero attachment with no parent gets an item of the type that exists for
   * exactly this, `attachment_only`. It carries the attachment's own Zotero key as its source id,
   * so a re-run finds it, and the report counts it apart from item-count parity, because there is
   * no Zotero regular item behind it.
   */
  private ensureAttachmentHostItem(zoteroItem: ZoteroItemRow, title: string | null): string {
    const existing = this.findItemByZoteroKey(zoteroItem.key);
    if (existing !== undefined) {
      this.itemIdByKey.set(zoteroItem.key, existing);
      return existing;
    }

    const record = this.recueil.library.createItem(
      {
        itemType: 'attachment_only',
        title,
        sourceSystem: SOURCE_SYSTEM,
        sourceId: zoteroItem.key,
        dateAdded: mapZoteroTimestamp(zoteroItem.dateAdded) ?? nowTimestamp(),
        provenance: { source: IMPORT_SOURCE, lock: false },
      },
      this.actor,
    );
    this.itemIdByKey.set(zoteroItem.key, record.item.id);

    this.assignTags(zoteroItem.itemID, record.item.id);
    this.fileInCollections(zoteroItem.itemID, record.item.id);
    return record.item.id;
  }

  /** Insert or find an attachment row that carries no document: a bookmark, or a missing file. */
  private recordAttachmentRow(
    itemId: string,
    zoteroKey: string,
    input: {
      linkMode: 'linked_file' | 'linked_url';
      title: string | null;
      url: string | null;
      linkedPath: string | null;
      contentTypeHint: string | null;
    },
  ): void {
    const rows = this.recueil.db
      .select({
        id: schema.attachments.id,
        url: schema.attachments.url,
        linkedPath: schema.attachments.linkedPath,
      })
      .from(schema.attachments)
      .where(eq(schema.attachments.itemId, itemId))
      .all();

    const existing = rows.find((row) =>
      input.linkMode === 'linked_url' ? row.url === input.url : row.linkedPath === input.linkedPath,
    );
    if (existing !== undefined) {
      this.attachmentIdByKey.set(zoteroKey, existing.id);
      return;
    }

    const now = nowTimestamp();
    const id = newId();
    this.recueil.db.transaction((tx) => {
      tx.insert(schema.attachments)
        .values({
          id,
          itemId,
          documentId: null,
          role: 'other',
          linkMode: input.linkMode,
          title: input.title,
          url: input.url,
          linkedPath: input.linkedPath,
          contentTypeHint: input.contentTypeHint,
          hasAnnotations: false,
          annotationCount: 0,
          position: rows.length,
          addedAt: now,
          addedByUserId: null,
          source: 'import',
          updatedAt: now,
          trashedAt: null,
        })
        .run();
      this.recueil.audit.record(
        {
          actor: this.actor,
          action: 'attachment.added',
          entityType: 'attachment',
          entityId: id,
          after: { itemId, linkMode: input.linkMode, url: input.url, linkedPath: input.linkedPath },
          reason: `imported from Zotero attachment ${zoteroKey}`,
        },
        tx,
      );
    });
    this.attachmentIdByKey.set(zoteroKey, id);
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Notes                                                                                       */
  /* ---------------------------------------------------------------------------------------- */

  private importNote(note: ZoteroNoteRow): void {
    const zoteroItem = this.library.itemsById().get(note.itemID);
    if (zoteroItem === undefined) return;

    const parentKey =
      note.parentItemID === null ? null : (this.library.itemsById().get(note.parentItemID)?.key ?? null);
    const itemId = parentKey === null ? null : (this.itemIdByKey.get(parentKey) ?? null);
    if (parentKey !== null && itemId === null) {
      this.skip({
        kind: 'note',
        zoteroKey: zoteroItem.key,
        subject: note.title ?? zoteroItem.key,
        reason: `its parent item '${parentKey}' was not imported`,
      });
      return;
    }

    if (this.findNote(itemId, note.note) === undefined) {
      this.recueil.notes.create(
        {
          itemId,
          contentHtml: note.note,
          title: note.title ?? null,
          createdAt: mapZoteroTimestamp(zoteroItem.dateAdded) ?? nowTimestamp(),
        },
        this.actor,
      );
    }
    this.reportNoteAttachments(zoteroItem);
  }

  /**
   * A Zotero note's own tags and collection memberships, neither of which Recueil has a place for.
   *
   * `item_tags` and `collection_items` both reference an item, and a note is not an item. Both are
   * therefore reported with the reason rather than quietly moved to the note's parent, which would
   * put a tag on a paper because somebody tagged a note about it.
   */
  private reportNoteAttachments(zoteroItem: ZoteroItemRow): void {
    for (const assignment of this.library.itemTagsByItem().get(zoteroItem.itemID) ?? []) {
      const name = this.library.tagsById().get(assignment.tagID)?.name ?? String(assignment.tagID);
      this.skip({
        kind: 'note_tag',
        zoteroKey: zoteroItem.key,
        subject: name,
        reason: 'Recueil tags items and annotations; a note carries no tags (§4.4, §4.5)',
      });
      this.review({
        kind: 'note_tag',
        zoteroKey: zoteroItem.key,
        subject: name,
        reason: 'the tag was on a Zotero note, and a note has no tag join in Recueil',
        proposedAction: 'tag the note’s parent item instead, if the tag was about the source',
      });
    }
    for (const membership of this.library.collectionItemsByItem().get(zoteroItem.itemID) ?? []) {
      const name =
        this.library.collections().find((row) => row.collectionID === membership.collectionID)
          ?.collectionName ?? String(membership.collectionID);
      this.skip({
        kind: 'note_collection',
        zoteroKey: zoteroItem.key,
        subject: name,
        reason: 'Recueil files items in collections; a note is reached through its parent (§4.2)',
      });
    }
  }

  /**
   * Find the note this Zotero note became.
   *
   * The key is the parent plus the verbatim source HTML, which `notes.content_original` keeps for
   * exactly this sort of reason (N1, P10). Two byte-identical notes on one item — which Zotero
   * allows — are matched one for one, because each match is consumed.
   */
  private findNote(itemId: string | null, html: string): string | undefined {
    const key = `${itemId ?? ''} ${html}`;
    if (this.noteIndex === null) {
      this.noteIndex = new Map();
      for (const row of this.recueil.db
        .select({
          id: schema.notes.id,
          itemId: schema.notes.itemId,
          original: schema.notes.contentOriginal,
        })
        .from(schema.notes)
        .all()) {
        if (row.original === null) continue;
        const rowKey = `${row.itemId ?? ''} ${row.original}`;
        const list = this.noteIndex.get(rowKey) ?? [];
        list.push(row.id);
        this.noteIndex.set(rowKey, list);
      }
    }
    return this.noteIndex.get(key)?.shift();
  }

  private noteIndex: Map<string, string[]> | null = null;

  /* ---------------------------------------------------------------------------------------- */
  /* Annotations                                                                                 */
  /* ---------------------------------------------------------------------------------------- */

  private async importAnnotation(row: ZoteroAnnotationRow): Promise<void> {
    const zoteroItem = this.library.itemsById().get(row.itemID);
    const parent = this.library.itemsById().get(row.parentItemID);
    if (zoteroItem === undefined || parent === undefined) return;

    const documentId = await this.documentForAttachment(parent);
    if (documentId === null) {
      this.skip({
        kind: 'annotation',
        zoteroKey: zoteroItem.key,
        subject: row.text ?? row.comment ?? zoteroItem.key,
        reason: `its attachment '${parent.key}' has no file in the library, and an annotation targets bytes (ADR-0009)`,
      });
      this.review({
        kind: 'annotation',
        zoteroKey: zoteroItem.key,
        subject: row.text ?? row.comment ?? zoteroItem.key,
        reason: `the annotated file '${parent.key}' could not be resolved`,
        proposedAction: 'restore the file and run the import again; the annotation will attach to it',
      });
      return;
    }

    let mapped;
    try {
      mapped = mapZoteroAnnotation(row);
    } catch (error) {
      if (!(error instanceof UnmappableAnnotationError)) throw error;
      this.skip({
        kind: 'annotation',
        zoteroKey: zoteroItem.key,
        subject: row.text ?? row.comment ?? zoteroItem.key,
        reason: error.message,
      });
      return;
    }

    const externalRef = attachmentSourceRef(zoteroItem.key);
    const existing = this.recueil.db
      .select({ id: schema.annotations.id })
      .from(schema.annotations)
      .where(
        and(eq(schema.annotations.documentId, documentId), eq(schema.annotations.externalRef, externalRef)),
      )
      .get();

    const attachmentId = this.attachmentIdByKey.get(parent.key) ?? null;
    const itemId =
      attachmentId === null
        ? null
        : (this.recueil.db
            .select({ itemId: schema.attachments.itemId })
            .from(schema.attachments)
            .where(eq(schema.attachments.id, attachmentId))
            .get()?.itemId ?? null);

    const now = nowTimestamp();
    const annotationId = existing?.id ?? newId();

    if (existing === undefined) {
      this.recueil.db.transaction((tx) => {
        tx.insert(schema.annotations)
          .values({
            id: annotationId,
            publicId: newPublicId(),
            documentId,
            itemId,
            attachmentId,
            annotationType: mapped.annotationType,
            motivation: mapped.motivation,
            selector: JSON.stringify(mapped.selector),
            quotedText: mapped.quotedText,
            prefixText: null,
            suffixText: null,
            bodyText: mapped.bodyText,
            bodyFormat: 'text',
            colour: mapped.colour,
            pageIndex: mapped.pageIndex,
            pageLabel: mapped.pageLabel,
            positionSortKey: mapped.positionSortKey,
            authorUserId: null,
            authorName: mapped.authorName,
            isExternal: mapped.isExternal,
            externalRef,
            version: 1,
            createdAt: mapZoteroTimestamp(zoteroItem.dateAdded) ?? now,
            updatedAt: now,
            trashedAt: null,
          })
          .run();
        this.recueil.audit.record(
          {
            actor: this.actor,
            action: 'annotation.created',
            entityType: 'annotation',
            entityId: annotationId,
            after: { documentId, itemId, annotationType: mapped.annotationType, externalRef },
          },
          tx,
        );
      });
      if (attachmentId !== null) this.refreshAnnotationCount(attachmentId);
    }

    for (const assignment of this.library.itemTagsByItem().get(row.itemID) ?? []) {
      const tagId = this.tagIdByZoteroId.get(assignment.tagID);
      if (tagId === undefined) continue;
      const already = this.recueil.db
        .select({ tagId: schema.annotationTags.tagId })
        .from(schema.annotationTags)
        .where(
          and(
            eq(schema.annotationTags.annotationId, annotationId),
            eq(schema.annotationTags.tagId, tagId),
          ),
        )
        .get();
      if (already === undefined) {
        this.recueil.db.insert(schema.annotationTags).values({ annotationId, tagId, addedAt: now }).run();
      }
    }
  }

  /**
   * The document behind an annotation's attachment.
   *
   * The in-memory map answers this during a normal run. After a resume the attachments stage did
   * not execute in this process, so the map was rebuilt from `document_provenance`; only a file
   * that is in neither is resolved again here.
   */
  private async documentForAttachment(parent: ZoteroItemRow): Promise<string | null> {
    const known = this.documentIdByAttachmentKey.get(parent.key);
    if (known !== undefined) return known;

    const attachment = this.library.attachmentsById().get(parent.itemID);
    if (attachment === undefined || !claimsFile(attachment.linkMode)) return null;

    const resolution = resolveAttachment(attachment, parent.key, this.sources);
    if (resolution.status !== 'resolved') return null;

    const document = this.recueil.documents.findBySha256(resolution.sha256);
    if (document === null) return null;
    this.documentIdByAttachmentKey.set(parent.key, document.id);
    return document.id;
  }

  private refreshAnnotationCount(attachmentId: string): void {
    const count = this.recueil.db
      .select({ id: schema.annotations.id })
      .from(schema.annotations)
      .where(and(eq(schema.annotations.attachmentId, attachmentId), isNull(schema.annotations.trashedAt)))
      .all().length;
    this.recueil.db
      .update(schema.attachments)
      .set({ hasAnnotations: count > 0, annotationCount: count, updatedAt: nowTimestamp() })
      .where(eq(schema.attachments.id, attachmentId))
      .run();
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Relations                                                                                   */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * Zotero's `itemRelations`, carried in a custom field.
   *
   * Recueil's home for a typed edge between two items is the graph layer, and `spec/data-model.md`
   * §11 puts `graph_edges` in the phase that serves it — it does not exist in Phase 1. Dropping the
   * relations until then would lose them, so each item's are written to a `zotero_relations` JSON
   * custom field: resolved to the Recueil item where the target is in this library, kept as the raw
   * Zotero URI where it is not. When the graph tables arrive, this field is the migration's input,
   * rather than a second pass over the user's Zotero library.
   */
  private importRelations(group: { zoteroKey: string; relations: RelationRecord[] }): void {
    const itemId = this.itemIdByKey.get(group.zoteroKey);
    if (itemId === undefined) return;

    const payload = group.relations.map((relation) => {
      const targetItemId =
        relation.targetKey === null ? null : (this.itemIdByKey.get(relation.targetKey) ?? null);
      if (targetItemId === null) {
        this.review({
          kind: 'relation',
          zoteroKey: group.zoteroKey,
          subject: relation.object,
          reason: 'the related item is not in this library (a group library, or an item since deleted)',
          proposedAction: 'import the other library, or accept the relation as a dangling reference',
          detail: { predicate: relation.predicate },
        });
      }
      return {
        predicate: relation.predicate,
        object: relation.object,
        targetZoteroKey: relation.targetKey,
        targetItemId,
      };
    });

    this.ensureCustomField('zotero_relations', 'Zotero: related items', 'json');
    this.recueil.customFields.setValue(
      { fieldKey: 'zotero_relations', itemId, content: { type: 'json', value: payload } },
      this.actor,
    );
  }

  /**
   * Group `itemRelations` by the item that carries them, resolving each object URI to an item key.
   *
   * Zotero writes the object as `http://zotero.org/users/local/<userKey>/items/<itemKey>` for a
   * local library and `http://zotero.org/groups/<id>/items/<itemKey>` for a group one. Only the
   * trailing key matters here; whether it names an item in *this* library is decided when the group
   * is imported, because that is when the item map is complete.
   */
  private relationGroups(): Array<{ zoteroKey: string; relations: RelationRecord[] }> {
    const byId = this.library.itemsById();
    const groups = new Map<string, RelationRecord[]>();
    for (const relation of this.library.relations()) {
      const key = byId.get(relation.itemID)?.key;
      if (key === undefined) continue;
      const match = /\/items\/([A-Za-z0-9]+)\s*$/u.exec(relation.object);
      const list = groups.get(key) ?? [];
      list.push({
        predicate: relation.predicate,
        object: relation.object,
        targetKey: match === null ? null : (match[1] as string),
      });
      groups.set(key, list);
    }
    return [...groups].map(([zoteroKey, relations]) => ({ zoteroKey, relations }));
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Trash                                                                                       */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * Zotero's `deletedItems` and `deletedCollections`, applied last.
   *
   * `LibraryService.trashItem` cascades to the item's live attachments, notes and annotations,
   * which is what Zotero does too — a trashed parent hides its children without listing them — so
   * the parents go first and the individually deleted children afterwards, where the cascade has
   * not already reached them.
   */
  private applyTrash(items: readonly ZoteroItemRow[]): void {
    const deleted = items.filter((row) => row.dateDeleted !== null);

    for (const zotero of deleted) {
      if (NON_REGULAR_ZOTERO_TYPES.has(zotero.itemType)) continue;
      const itemId = this.itemIdByKey.get(zotero.key);
      if (itemId === undefined) continue;
      this.recueil.library.trashItem(itemId, this.actor, {
        reason: 'user',
        reasonDetail: `in the Zotero trash since ${zotero.dateDeleted ?? 'an unrecorded date'}`,
      });
    }

    for (const zotero of deleted) {
      if (zotero.itemType === 'note') this.trashNote(zotero);
      if (zotero.itemType === 'attachment') this.trashAttachment(zotero);
      if (zotero.itemType === 'annotation') this.trashAnnotation(zotero);
    }

    for (const collection of this.library.collections()) {
      if (collection.dateDeleted === null) continue;
      const id = this.collectionIdByZoteroId.get(collection.collectionID);
      if (id === undefined) continue;
      const row = this.recueil.db
        .select({ trashedAt: schema.collections.trashedAt })
        .from(schema.collections)
        .where(eq(schema.collections.id, id))
        .get();
      if (row?.trashedAt != null) continue;
      this.recueil.collections.trash(id, this.actor, {
        reason: 'user',
        reasonDetail: `in the Zotero trash since ${collection.dateDeleted}`,
      });
    }
  }

  private trashNote(zotero: ZoteroItemRow): void {
    const source = this.library.notes().find((row) => row.itemID === zotero.itemID);
    if (source === undefined) return;
    const parentKey =
      source.parentItemID === null
        ? null
        : (this.library.itemsById().get(source.parentItemID)?.key ?? null);
    const itemId = parentKey === null ? null : (this.itemIdByKey.get(parentKey) ?? null);

    // `findNote` consumes its matches, and the notes stage has already consumed this one; the
    // lookup here is over the database, unconsumed.
    const row = this.recueil.db
      .select({
        id: schema.notes.id,
        itemId: schema.notes.itemId,
        original: schema.notes.contentOriginal,
        trashedAt: schema.notes.trashedAt,
      })
      .from(schema.notes)
      .all()
      .find((note) => (note.itemId ?? null) === itemId && note.original === source.note);
    if (row === undefined || row.trashedAt !== null) return;

    this.recueil.notes.trash(row.id, this.actor, {
      reason: 'user',
      reasonDetail: `in the Zotero trash since ${zotero.dateDeleted ?? 'an unrecorded date'}`,
    });
  }

  private trashAttachment(zotero: ZoteroItemRow): void {
    const attachmentId = this.attachmentIdByKey.get(zotero.key);
    if (attachmentId === undefined) return;
    this.recueil.documents.detachDocument(attachmentId, this.actor, {
      reason: 'user',
      reasonDetail: `in the Zotero trash since ${zotero.dateDeleted ?? 'an unrecorded date'}`,
    });
  }

  private trashAnnotation(zotero: ZoteroItemRow): void {
    const externalRef = attachmentSourceRef(zotero.key);
    const row = this.recueil.db
      .select({ id: schema.annotations.id, trashedAt: schema.annotations.trashedAt })
      .from(schema.annotations)
      .where(eq(schema.annotations.externalRef, externalRef))
      .get();
    if (row === undefined || row.trashedAt !== null) return;

    const now = nowTimestamp();
    this.recueil.db.transaction((tx) => {
      tx.update(schema.annotations)
        .set({ trashedAt: now, updatedAt: now })
        .where(eq(schema.annotations.id, row.id))
        .run();
      tx.insert(schema.trash)
        .values({
          id: newId(),
          entityType: 'annotation',
          entityId: row.id,
          groupId: newId(),
          trashedAt: now,
          trashedByUserId: null,
          reason: 'user',
          reasonDetail: `in the Zotero trash since ${zotero.dateDeleted ?? 'an unrecorded date'}`,
          restorePayload: '{}',
        })
        .run();
      this.recueil.audit.record(
        {
          actor: this.actor,
          action: 'annotation.trashed',
          entityType: 'annotation',
          entityId: row.id,
          after: { trashedAt: now },
        },
        tx,
      );
    });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Finalise                                                                                    */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * The writes that had to wait for the trash, and the timestamp the services do not accept.
   *
   * A DOI or a citation key held by a live twin becomes free once this item is trashed, because
   * both unique indexes are partial on `item_trashed_at IS NULL`. `date_modified` is set here for
   * every item because `LibraryService` owns that column — it will preserve `date_added`, but a
   * migrated library whose every item was "modified" at the moment of the import sorts uselessly.
   */
  private finaliseItem(plan: ItemPlan): void {
    const itemId = this.itemIdByKey.get(plan.zotero.key);
    if (itemId === undefined) return;

    const patch: Record<string, unknown> = {};
    if (plan.deferredDoi !== null) patch['doi'] = plan.deferredDoi;
    if (plan.deferredCitationKey !== null) {
      patch['citationKey'] = plan.deferredCitationKey;
      patch['citationKeyLocked'] = true;
    }
    if (Object.keys(patch).length > 0) {
      patch['updatedAt'] = nowTimestamp();
      this.recueil.db
        .update(schema.itemBibliographic)
        .set(patch)
        .where(eq(schema.itemBibliographic.itemId, itemId))
        .run();
    }

    const dateModified = mapZoteroTimestamp(plan.zotero.dateModified);
    if (dateModified !== null) {
      this.recueil.db.update(schema.items).set({ dateModified }).where(eq(schema.items.id, itemId)).run();
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Shared helpers                                                                              */
  /* ---------------------------------------------------------------------------------------- */

  private writeCarriedFields(itemId: string, carried: readonly CarriedField[]): void {
    for (const field of carried) {
      this.ensureCustomField(field.fieldKey, field.label, 'long_text');
      this.recueil.customFields.setValue(
        { fieldKey: field.fieldKey, itemId, content: { type: 'long_text', value: field.value } },
        this.actor,
      );
    }
  }

  private ensureCustomField(fieldKey: string, name: string, dataType: 'long_text' | 'json'): void {
    if (this.definedCustomFields.has(fieldKey)) return;
    try {
      this.recueil.customFields.getFieldByKey(fieldKey);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      this.recueil.customFields.define(
        {
          fieldKey,
          name,
          description: 'Carried across by the Zotero importer, because the facet has no column for it.',
          dataType,
        },
        this.actor,
      );
    }
    this.definedCustomFields.add(fieldKey);
  }

  private findTrashedItemByZoteroKey(key: string): string | undefined {
    const row = this.recueil.db
      .select({ id: schema.items.id, trashedAt: schema.items.trashedAt })
      .from(schema.items)
      .where(and(eq(schema.items.sourceSystem, SOURCE_SYSTEM), eq(schema.items.sourceId, key)))
      .get();
    return row !== undefined && row.trashedAt !== null ? row.id : undefined;
  }

  private findItemByZoteroKey(key: string): string | undefined {
    return this.recueil.db
      .select({ id: schema.items.id })
      .from(schema.items)
      .where(and(eq(schema.items.sourceSystem, SOURCE_SYSTEM), eq(schema.items.sourceId, key)))
      .get()?.id;
  }

  private parentKeyOf(attachment: ZoteroAttachmentRow): string | null {
    if (attachment.parentItemID === null) return null;
    return this.library.itemsById().get(attachment.parentItemID)?.key ?? null;
  }

  private hostItemIdFor(attachment: ZoteroAttachmentRow, zoteroItem: ZoteroItemRow): string | undefined {
    const parentKey = this.parentKeyOf(attachment);
    const key = parentKey ?? zoteroItem.key;
    return this.itemIdByKey.get(key) ?? this.findItemByZoteroKey(key);
  }

  private attachmentUrl(zoteroItemId: number): string | null {
    return (
      this.library
        .fieldValues()
        .get(zoteroItemId)
        ?.find((field) => field.baseField === 'url')?.value ?? null
    );
  }

  /* -- Observations, written where a resumed run can still find them (§6.4) -------------------- */

  private attachmentOutcome(entry: AttachmentReportEntry): void {
    logJob(this.recueil, this.jobId, {
      level: entry.status === 'resolved' || entry.status === 'no_file' ? 'info' : 'warn',
      message: 'attachment',
      data: entry as unknown as Record<string, unknown>,
      subjectType: 'attachment',
      subjectId: entry.zoteroKey,
    });
  }

  private review(entry: ReviewEntry): void {
    logJob(this.recueil, this.jobId, {
      level: 'warn',
      message: 'review',
      data: entry as unknown as Record<string, unknown>,
      subjectType: entry.kind,
      ...(entry.zoteroKey === null ? {} : { subjectId: entry.zoteroKey }),
    });
  }

  private skip(entry: SkippedRecord): void {
    logJob(this.recueil, this.jobId, {
      level: 'info',
      message: 'skipped',
      data: entry as unknown as Record<string, unknown>,
      subjectType: entry.kind,
      ...(entry.zoteroKey === null ? {} : { subjectId: entry.zoteroKey }),
    });
  }
}

interface RelationRecord {
  predicate: string;
  object: string;
  targetKey: string | null;
}

const existingOrNull = (path: string): string | null => (existsSync(path) ? path : null);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
