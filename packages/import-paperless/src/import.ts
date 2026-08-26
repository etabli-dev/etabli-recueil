/**
 * The Paperless-ngx importer (CONCEPT §6, §7 Phase 2: "Paperless decommissioned after verified
 * import").
 *
 * The order of the stages is the whole design, so it is worth stating before the code.
 *
 * 1. **Vocabularies** — correspondents, document types, tags, storage paths. Everything a document
 *    refers to, fetched once and held, because a document body carries ids and not names.
 * 2. **Custom fields** — the Recueil definitions, before any value can be written into one. Types
 *    are preserved one-for-one where Recueil has the type (`src/map/custom-fields.ts`).
 * 3. **Documents** — one pass per document, in ascending id: the item and its Office facet, the
 *    tags, the notes, the original (fetched, hashed, ingested, attached) and every value except a
 *    document link. A document whose original cannot be fetched does **not** fail the run: it
 *    becomes a review entry and the item is still there (P3, CONCEPT §6).
 * 4. **Links** — `documentlink` values, which need every item on both ends to exist.
 * 5. **Finalise** — `items.date_modified`, which the services will not take as an argument because
 *    an ordinary write must not be able to lie about when it happened.
 *
 * Three properties are load-bearing.
 *
 * **Idempotence (P9).** Every write is keyed by something Paperless owns: an item by
 * `(source_system, source_id) = ('paperless', '<document id>')`, a document by the SHA-256 of its
 * bytes, a tag by its name, a custom field by its key, a value by its `(field, item, group,
 * ordinal)` slot, a note by its item and its text. Importing the same server twice therefore
 * produces the same library, not a doubled one, and there is no bookkeeping table to keep in step.
 * A second run also *compares before writing*: an item whose columns already match is left alone
 * rather than rewritten, so `items.version` — which is the REST ETag — does not move for nothing.
 *
 * **Resumability (P9, IK4).** The `jobs` row carries `{stage, index, lastDocumentId}`, written
 * after every document. A resumed run skips the stages that finished, rebuilds from the database
 * the identifier maps those stages would have produced, and skips the documents whose id is at or
 * below the checkpoint. Re-processing the checkpoint document itself is harmless, for the reason
 * above.
 *
 * **A report that survives a resume.** Every observation — an original's outcome, a skipped value,
 * a review entry — is written to `job_logs` as it happens rather than accumulated in memory, and
 * the verification report is assembled at the end from those rows plus queries against the API side
 * and the target database. So the report of a run that was interrupted twice says the same thing as
 * the report of one that was not (§6.4).
 */
import { createHash } from 'node:crypto';

import { nowTimestamp, schema } from '@recueil/core';
import type { Actor, AttachmentRole, OfficeInput, Recueil } from '@recueil/core';
import { and, eq, isNull, ne } from 'drizzle-orm';

import { PaperlessClient, safeBasename } from './client/client.js';
import type { FetchLike, PaperlessClientOptions } from './client/client.js';
import { PaperlessNotFoundError } from './client/errors.js';
import type {
  PaperlessCorrespondent,
  PaperlessCustomField,
  PaperlessDocument,
  PaperlessDocumentType,
  PaperlessServerInfo,
  PaperlessStoragePath,
  PaperlessTag,
} from './client/types.js';
import {
  IMPORT_STAGES,
  checkpoint,
  claimImportJob,
  clearJobLog,
  finishJob,
  importIdempotencyKey,
  logJob,
  serverHash,
  setProgressTotal,
} from './job.js';
import type { ImportCursor, ImportProgress, ImportStage } from './job.js';
import { planCustomField, planValue } from './map/custom-fields.js';
import type { CustomFieldPlan } from './map/custom-fields.js';
import { toInstant } from './map/dates.js';
import { parseMonetary } from './map/money.js';
import { mapDocumentType } from './map/document-types.js';
import type { DocumentTypeMapping } from './map/document-types.js';
import { DEFAULT_MISSING_CORRESPONDENT, chooseFacetSources, mapOffice } from './map/office.js';
import type { FacetSourceNominations, FacetSources } from './map/office.js';
import { slugify, uniqueSlug } from './map/slug.js';
import {
  ASN_FIELD_KEY,
  DOCUMENT_TYPE_FIELD_KEY,
  SOURCE_SYSTEM,
  STORAGE_PATH_FIELD_KEY,
  documentSourceRef,
  importedItemIds,
} from './reconcile.js';
import { buildReport, readImportLog } from './report/build.js';
import type { OriginalReportEntry, PaperlessImportReport, ReviewEntry, SkippedRecord } from './report/types.js';
import { writeReport } from './report/write.js';

export { SOURCE_SYSTEM } from './reconcile.js';

/** The `custom_fields` row, as the schema declares it. */
type CustomFieldRow = schema.CustomFieldRow;

/** The provenance source every facet field this importer writes carries (§3.6). */
export const IMPORT_SOURCE = 'import:paperless';

/*
 * The three custom-field keys this importer owns are declared in `reconcile.ts` and re-exported
 * here, because the verification report has to find their values in the target by key and must not
 * hold a second copy of the string.
 */
export {
  ASN_FIELD_KEY,
  DOCUMENT_TYPE_FIELD_KEY,
  STORAGE_PATH_FIELD_KEY,
} from './reconcile.js';

export interface PaperlessImportOptions {
  /** The Paperless-ngx root, with or without a trailing `/api`. Ignored when `client` is given. */
  baseUrl?: string;
  /** An API token. Ignored when `client` is given. */
  token?: string;
  /** DRF Accept-header version. Defaults to `10`. */
  apiVersion?: string;
  /** Records per page. Defaults to 100. */
  pageSize?: number;
  /** Attempts per request, the first included. Defaults to 4. */
  attempts?: number;
  /** Base backoff between attempts, doubled each time. Defaults to 250 ms. */
  retryDelayMs?: number;
  /** Per-request timeout. Defaults to 60 s. */
  timeoutMs?: number;
  /** Injected transport, for a caller with its own agent or proxy settings. */
  fetch?: FetchLike;
  /** A client built by the caller. Overrides `baseUrl`/`token`/`apiVersion`/`pageSize`/`fetch`. */
  client?: PaperlessClient;
  /** Distinguishes two deliberate imports of the same server. Part of the idempotency key (IK1). */
  runLabel?: string;
  /** Where `report.json`, `report.md` and `_REVIEW/` are written. Nothing is written when absent. */
  reportDirectory?: string | null;
  /** What a document with no Paperless correspondent gets, since the column is `NOT NULL` (§3.7). */
  missingCorrespondentLabel?: string;
  /** ISO-4217 code for a monetary value that carries none. Without one, the facet stays empty. */
  defaultCurrency?: string | null;
  /** Which Paperless custom field feeds which Office column. Auto-detected when not given. */
  facetSources?: FacetSourceNominations;
  /** The role every imported original is attached with. Defaults to `scan`. */
  attachmentRole?: AttachmentRole;
  /**
   * Fetch the originals. Default true.
   *
   * False imports the metadata alone, which is what a rehearsal on a slow link wants; the report
   * says `attempted: 0` and the hash-coverage check is skipped rather than reported as 100%.
   */
  downloadOriginals?: boolean;
  /** Called after every record. Returning true stops the run cleanly at the next checkpoint. */
  abortAfter?: (progress: ImportProgress) => boolean;
}

export interface PaperlessImportResult {
  report: PaperlessImportReport;
  jobId: string;
  /** Where the report was written, when `reportDirectory` was given. */
  reportPaths: { json: string; markdown: string; review: string } | null;
  /**
   * Everything the run fetched from the API.
   *
   * Exposed so that the report can be rebuilt against the library later — after a repair, or as an
   * adversarial test that damages the target and checks that the checks notice — without asking the
   * server for it all again. `buildReport` takes exactly this, the plan below, and the job log.
   */
  snapshot: ApiSnapshot;
  /** What the run decided before its first write: field keys, type mappings, facet sources. */
  plan: ImportPlan;
}

/** Thrown when `abortAfter` stopped the run. The job keeps its cursor and can be resumed. */
export class ImportCancelledError extends Error {
  readonly jobId: string;

  readonly cursor: ImportCursor;

  constructor(jobId: string, cursor: ImportCursor) {
    super(
      `Paperless import cancelled during stage '${cursor.stage}' after ${cursor.index} records ` +
        `(last document ${cursor.lastDocumentId}). The job keeps its cursor; running the import ` +
        'again resumes it.',
    );
    this.name = 'ImportCancelledError';
    this.jobId = jobId;
    this.cursor = cursor;
  }
}

/** Import a Paperless-ngx server into an open Recueil library. */
export const importPaperless = async (
  recueil: Recueil,
  options: PaperlessImportOptions,
): Promise<PaperlessImportResult> => new PaperlessImporter(recueil, options).run();

/* ================================================================================================ */

/** Everything the run fetched from the API, kept for the report to compare against. */
export interface ApiSnapshot {
  serverInfo: PaperlessServerInfo;
  correspondents: PaperlessCorrespondent[];
  documentTypes: PaperlessDocumentType[];
  tags: PaperlessTag[];
  storagePaths: PaperlessStoragePath[];
  customFields: PaperlessCustomField[];
  /** Every document the API returned, in id order, with `content` dropped. */
  documents: PaperlessDocument[];
  /** `count` from the first page of `/api/documents/`. */
  reportedTotal: number;
}

/** What the importer decided, once, before the first document. */
export interface ImportPlan {
  documentTypeById: ReadonlyMap<number, DocumentTypeMapping>;
  customFieldPlans: readonly CustomFieldPlan[];
  facetSources: FacetSources;
  missingCorrespondentLabel: string;
  /**
   * ASN → the Paperless document that keeps it: the lowest id carrying it.
   *
   * Computed from the whole document list rather than accumulated as the run goes, because a
   * resumed run does not see the documents it already finished. Deciding the owner from run state
   * would make the same duplicate produce `asn_duplicate_in_paperless` on an uninterrupted run and
   * `asn_collision` on a resumed one — the same outcome, reported two different ways, which is
   * precisely the property "the report survives a resume" denies.
   */
  asnOwner: ReadonlyMap<number, number>;
}

class PaperlessImporter {
  private readonly recueil: Recueil;

  private readonly options: PaperlessImportOptions;

  private readonly client: PaperlessClient;

  private readonly actor: Actor;

  private jobId = '';

  private resumeStageIndex = 0;

  private resumeAfterDocumentId = 0;

  private skippedAsAlreadyDone = 0;

  private stage: ImportStage = 'vocabularies';

  private stageIndex = 0;

  private stageTotal = 0;

  private done = 0;

  private lastDocumentId = 0;

  /* Paperless identity → Recueil id. Populated as the run goes, rebuilt from the database on resume. */
  private readonly itemIdByDocumentId = new Map<number, string>();

  private readonly tagIdByPaperlessId = new Map<number, string>();

  private readonly fieldIdByPaperlessId = new Map<number, string>();

  private readonly definedHelperFields = new Map<string, CustomFieldRow>();

  private snapshot: ApiSnapshot | null = null;

  private plan: ImportPlan | null = null;

  constructor(recueil: Recueil, options: PaperlessImportOptions) {
    this.recueil = recueil;
    this.options = options;
    this.actor = { type: 'import' };
    this.client = options.client ?? new PaperlessClient(clientOptions(options));
  }

  async run(): Promise<PaperlessImportResult> {
    const startedAt = nowTimestamp();
    const startedMs = Date.now();

    const job = claimImportJob(this.recueil, {
      idempotencyKey: importIdempotencyKey(
        serverHash(this.client.apiRoot),
        this.options.runLabel ?? 'default',
      ),
      params: {
        baseUrl: this.client.displayUrl,
        apiVersion: this.client.apiVersion,
        pageSize: this.client.pageSize,
        downloadOriginals: this.options.downloadOriginals !== false,
        attachmentRole: this.options.attachmentRole ?? 'scan',
      },
    });
    this.jobId = job.id;
    this.resumeStageIndex =
      job.resumedFrom === null ? 0 : Math.max(0, IMPORT_STAGES.indexOf(job.resumedFrom.stage));
    this.resumeAfterDocumentId = job.resumedFrom?.lastDocumentId ?? 0;
    this.lastDocumentId = this.resumeAfterDocumentId;

    // A run that starts from the beginning re-observes everything, so the previous attempt's
    // observations would be stale duplicates. A resumed run keeps them: they are the record of the
    // documents it is about to skip.
    if (job.resumedFrom === null) clearJobLog(this.recueil, this.jobId);

    try {
      const report = await this.execute({
        startedAt,
        startedMs,
        attempt: job.attempt,
        idempotencyKey: job.idempotencyKey,
        resumedFromStage: job.resumedFrom?.stage ?? null,
      });

      finishJob(this.recueil, this.jobId, {
        state: 'succeeded',
        result: {
          pass: report.pass,
          documents: report.documents.recueilTotal,
          originalsStored: report.originals.stored,
          originalsMissing: report.originals.missing,
          review: report.review.length,
        },
      });

      const reportPaths =
        this.options.reportDirectory == null ? null : writeReport(this.options.reportDirectory, report);

      return {
        report,
        jobId: this.jobId,
        reportPaths,
        snapshot: this.snapshot as ApiSnapshot,
        plan: this.plan as ImportPlan,
      };
    } catch (error) {
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
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* The stages                                                                                  */
  /* ---------------------------------------------------------------------------------------- */

  private async execute(context: {
    startedAt: string;
    startedMs: number;
    attempt: number;
    idempotencyKey: string;
    resumedFromStage: ImportStage | null;
  }): Promise<PaperlessImportReport> {
    const snapshot = await this.fetchSnapshot();
    this.snapshot = snapshot;
    this.plan = this.buildPlan(snapshot);

    setProgressTotal(
      this.recueil,
      this.jobId,
      snapshot.tags.length + snapshot.customFields.length + snapshot.documents.length * 2,
    );

    this.runStage('vocabularies', snapshot.tags, (tag) => this.importTag(tag));
    this.runStage('custom_fields', this.plan.customFieldPlans, (field) => this.defineCustomField(field));
    await this.runStageAsync('documents', snapshot.documents, (document) =>
      this.importDocument(document),
    );
    this.runStage('links', snapshot.documents, (document) => this.importDocumentLinks(document));
    this.runStage('finalise', snapshot.documents, (document) => this.finaliseDocument(document));

    return buildReport({
      recueil: this.recueil,
      snapshot,
      plan: this.plan,
      log: readImportLog(this.recueil, this.jobId),
      baseUrl: this.client.displayUrl,
      downloadOriginals: this.options.downloadOriginals !== false,
      run: {
        jobId: this.jobId,
        idempotencyKey: context.idempotencyKey,
        runLabel: this.options.runLabel ?? 'default',
        startedAt: context.startedAt,
        finishedAt: nowTimestamp(),
        durationMs: Date.now() - context.startedMs,
        attempt: context.attempt,
        resumedFromStage: context.resumedFromStage,
        resumedAfterDocumentId: context.resumedFromStage === null ? null : this.resumeAfterDocumentId,
        documentsSkippedAsAlreadyDone: this.skippedAsAlreadyDone,
      },
    });
  }

  /**
   * Fetch everything, before anything is written.
   *
   * The document list is walked in full even on a resumed run. It has to be: the verification
   * report compares the whole API side against the whole target, and a report built from the tail
   * of a resumed run would compare the tail against everything and call the difference a loss.
   * `content` — the OCR text, which is by far the largest field and which this phase has nowhere to
   * put (§3.3 has no text column) — is dropped as each page arrives, so the retained snapshot is
   * metadata only.
   */
  private async fetchSnapshot(): Promise<ApiSnapshot> {
    const serverInfo = await this.client.probe();

    const [correspondents, documentTypes, tags, storagePaths, customFields] = await Promise.all([
      this.client.listCorrespondents(),
      this.client.listDocumentTypes(),
      this.client.listTags(),
      this.client.listStoragePaths(),
      this.client.listCustomFields(),
    ]);

    const documents: PaperlessDocument[] = [];
    let reportedTotal = 0;
    for await (const page of this.client.documents()) {
      if (page.page === 1) reportedTotal = page.total;
      for (const document of page.documents) {
        delete document.content;
        documents.push(document);
      }
    }
    documents.sort((left, right) => left.id - right.id);

    return {
      serverInfo,
      correspondents,
      documentTypes,
      tags,
      storagePaths,
      customFields,
      documents,
      reportedTotal,
    };
  }

  /**
   * The decisions that need the whole vocabulary before the first write.
   *
   * Pure: it reads the snapshot and nothing else, so it runs identically on a resumed attempt.
   * That is what lets the report's custom-field and facet-source sections be correct after a
   * resume, and what lets `rehydrate` match a skipped stage's field keys by recomputing them
   * rather than by remembering them.
   */
  private buildPlan(snapshot: ApiSnapshot): ImportPlan {
    const documentTypeById = new Map<number, DocumentTypeMapping>();
    for (const type of snapshot.documentTypes) documentTypeById.set(type.id, mapDocumentType(type));

    // Field keys are decided over the whole set, in Paperless id order, so two fields whose names
    // slug the same get `_2` deterministically rather than in whatever order a page arrived.
    const taken = new Set<string>([DOCUMENT_TYPE_FIELD_KEY, STORAGE_PATH_FIELD_KEY, ASN_FIELD_KEY]);
    const ordered = [...snapshot.customFields].sort((left, right) => left.id - right.id);
    const currencies = observedCurrencies(snapshot);
    const customFieldPlans = ordered.map((field) =>
      planCustomField(field, uniqueSlug(slugify(field.name), taken), {
        defaultCurrency: this.options.defaultCurrency ?? null,
        observedCurrencies: currencies.get(field.id) ?? new Set<string>(),
      }),
    );

    return {
      documentTypeById,
      customFieldPlans,
      facetSources: chooseFacetSources(snapshot.customFields, this.options.facetSources ?? {}),
      missingCorrespondentLabel:
        this.options.missingCorrespondentLabel ?? DEFAULT_MISSING_CORRESPONDENT,
      asnOwner: asnOwners(snapshot.documents),
    };
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Stage drivers                                                                               */
  /* ---------------------------------------------------------------------------------------- */

  private runStage<TRecord>(
    stage: ImportStage,
    records: readonly TRecord[],
    handle: (record: TRecord) => void,
  ): void {
    if (!this.beginStage(stage, records.length)) return;
    for (const record of records) {
      handle(record);
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
    checkpoint(
      this.recueil,
      this.jobId,
      { stage, index: 0, lastDocumentId: this.lastDocumentId },
      this.done,
    );
    return true;
  }

  private advance(): void {
    this.stageIndex += 1;
    this.done += 1;
    const cursor: ImportCursor = {
      stage: this.stage,
      index: this.stageIndex,
      lastDocumentId: this.lastDocumentId,
    };
    checkpoint(this.recueil, this.jobId, cursor, this.done);
    if (this.options.abortAfter?.({ ...cursor, total: this.stageTotal }) === true) {
      throw new ImportCancelledError(this.jobId, cursor);
    }
  }

  /** Rebuild the identifier map a skipped stage would have produced, by query. */
  private rehydrate(stage: ImportStage): void {
    const snapshot = this.snapshot;
    const plan = this.plan;
    /* c8 ignore next -- both are set before any stage runs. */
    if (snapshot === null || plan === null) return;

    switch (stage) {
      case 'vocabularies':
        for (const tag of snapshot.tags) {
          const found = this.recueil.tags.findByName(tag.name);
          if (found !== undefined) this.tagIdByPaperlessId.set(tag.id, found.id);
        }
        return;
      case 'custom_fields':
        for (const field of plan.customFieldPlans) {
          const found = this.findFieldByKey(field.fieldKey);
          if (found !== undefined) this.fieldIdByPaperlessId.set(field.paperlessId, found.id);
        }
        return;
      case 'documents':
        for (const [paperlessId, itemId] of importedItemIds(this.recueil)) {
          this.itemIdByDocumentId.set(paperlessId, itemId);
        }
        return;
      default:
        return;
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Stage 1 — tags                                                                              */
  /* ---------------------------------------------------------------------------------------- */

  private importTag(tag: PaperlessTag): void {
    const name = tag.name.trim();
    if (name === '') {
      this.skip({
        kind: 'tag',
        paperlessId: tag.id,
        subject: `tag ${tag.id}`,
        reason: 'The tag has an empty name, which Recueil refuses (§3.11).',
      });
      return;
    }

    const colour = normaliseColour(tag.color);
    const existing = this.recueil.tags.findByName(name);
    if (existing !== undefined) {
      this.tagIdByPaperlessId.set(tag.id, existing.id);
      return;
    }

    const created = this.recueil.tags.create(
      { name, colour, scheme: 'imported' },
      this.actor,
    );
    this.tagIdByPaperlessId.set(tag.id, created.id);
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Stage 2 — custom field definitions                                                          */
  /* ---------------------------------------------------------------------------------------- */

  private defineCustomField(field: CustomFieldPlan): void {
    if (field.unsupportedReason !== null) {
      this.skip({
        kind: 'custom_field',
        paperlessId: field.paperlessId,
        subject: field.name,
        reason: field.unsupportedReason,
      });
      return;
    }

    const existing = this.findFieldByKey(field.fieldKey);
    if (existing !== undefined) {
      if (existing.dataType !== field.dataType) {
        // CF1: the data type is immutable once a value exists, and changing it in place would
        // silently move values into the wrong column.
        this.skip({
          kind: 'custom_field',
          paperlessId: field.paperlessId,
          subject: field.name,
          reason:
            `Recueil already has a field '${field.fieldKey}' of type '${existing.dataType}', and ` +
            `Paperless declares '${field.dataType}'. The data type is immutable (CF1), so this ` +
            'importer will not repurpose the existing field. Rename one of them and run again.',
        });
        return;
      }
      this.fieldIdByPaperlessId.set(field.paperlessId, existing.id);
      return;
    }

    const created = this.recueil.customFields.define(
      {
        fieldKey: field.fieldKey,
        name: field.name,
        dataType: field.dataType,
        config: field.config,
        isRepeatable: field.isRepeatable,
        description: `Imported from Paperless-ngx custom field ${field.paperlessId}.`,
      },
      this.actor,
    );
    this.fieldIdByPaperlessId.set(field.paperlessId, created.id);
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Stage 3 — one document                                                                      */
  /* ---------------------------------------------------------------------------------------- */

  private async importDocument(document: PaperlessDocument): Promise<void> {
    const plan = this.plan as ImportPlan;
    const snapshot = this.snapshot as ApiSnapshot;

    if (document.id <= this.resumeAfterDocumentId) {
      // Already finished by an earlier attempt of this job. Its observations are still in
      // `job_logs`, which is why they were not cleared on a resume.
      this.skippedAsAlreadyDone += 1;
      const existing = this.recueil.db
        .select({ id: schema.items.id })
        .from(schema.items)
        .where(
          and(
            eq(schema.items.sourceSystem, SOURCE_SYSTEM),
            eq(schema.items.sourceId, String(document.id)),
            // Live only: a trashed item is not a link target, for the reason `leaveTrashedItemAlone`
            // gives below.
            isNull(schema.items.trashedAt),
          ),
        )
        .get();
      if (existing !== undefined) this.itemIdByDocumentId.set(document.id, existing.id);
      return;
    }

    if (this.leaveTrashedItemAlone(document)) return;

    const mapping =
      document.document_type === null || document.document_type === undefined
        ? mapDocumentType(null)
        : (plan.documentTypeById.get(document.document_type) ?? mapDocumentType(null));

    const correspondent =
      document.correspondent === null || document.correspondent === undefined
        ? null
        : (snapshot.correspondents.find((row) => row.id === document.correspondent)?.name ?? null);

    const values = new Map<number, unknown>();
    for (const instance of document.custom_fields ?? []) values.set(instance.field, instance.value);

    const office = mapOffice(document, {
      correspondentName: correspondent,
      sources: plan.facetSources,
      values,
      fields: new Map(snapshot.customFields.map((field) => [field.id, field])),
      missingCorrespondentLabel: plan.missingCorrespondentLabel,
      defaultCurrency: this.options.defaultCurrency ?? null,
    });

    for (const note of office.notes) {
      this.skip({
        kind: 'office_field',
        paperlessId: document.id,
        subject: document.title,
        reason: note,
      });
    }

    const itemId = this.upsertItem(document, mapping, office);
    this.itemIdByDocumentId.set(document.id, itemId);

    this.applyTags(document, itemId);
    this.applyNotes(document, itemId);
    this.applyHelperFields(document, itemId, mapping, snapshot);
    this.applyValues(document, itemId);

    await this.importOriginal(document, itemId);

    this.lastDocumentId = Math.max(this.lastDocumentId, document.id);
  }

  /**
   * Leave a document alone whose Recueil item is in the trash, and say so.
   *
   * A person who bins two obvious duplicates in the freshly migrated library has done an ordinary
   * thing, and P9 promises the import can then be re-run until the report is clean. Before this
   * check existed it could not be: `NoteService.create` and `LibraryService.updateItem` both refuse
   * a trashed item with `ConflictError`, nothing caught it, and the exception left `importPaperless`
   * entirely — a failed job, no report at all, and a cursor that never advanced past the offending
   * document, so every later attempt failed identically. One bin action bricked the importer and
   * with it the M2 exit artefact.
   *
   * Restoring the item would be worse than failing: the trash is a decision a person made about
   * their own library (P5), and an importer that quietly undid it would be the one thing a
   * migration tool must never be. So the document is skipped whole — no item write, no tags, no
   * notes, no values, no original — and it goes into the report as a review entry naming the item.
   *
   * The item id is deliberately **not** put into `itemIdByDocumentId`. A `documentlink` pointing at
   * a trashed item is written as an unresolved link rather than as a foreign key into the trash,
   * which is the same answer the link stage gives for a document outside the import.
   */
  private leaveTrashedItemAlone(document: PaperlessDocument): boolean {
    const existing = this.recueil.db
      .select({ id: schema.items.id, trashedAt: schema.items.trashedAt })
      .from(schema.items)
      .where(
        and(
          eq(schema.items.sourceSystem, SOURCE_SYSTEM),
          eq(schema.items.sourceId, String(document.id)),
        ),
      )
      .get();

    if (existing === undefined || existing.trashedAt === null) return false;

    this.review({
      kind: 'item_in_trash',
      paperlessId: document.id,
      subject: document.title,
      reason:
        `Paperless document ${document.id} was imported before and its Recueil item ` +
        `${existing.id} has since been put in the trash. The item was left exactly as it is: ` +
        'nothing was written to it, and it was not restored, because emptying or keeping the ' +
        'trash is a decision for a person (P5).',
      proposedAction:
        'Restore the item and run the import again if the document should come back, or delete it ' +
        'in Paperless if it should not. Until one of those happens this document is not part of ' +
        'the verification, and the report says so here rather than counting it as imported.',
      detail: { paperlessId: document.id, itemId: existing.id, trashedAt: existing.trashedAt },
    });

    this.lastDocumentId = Math.max(this.lastDocumentId, document.id);
    return true;
  }

  /**
   * Create the item, or bring an existing one into line — and do nothing at all when it already is.
   *
   * The comparison before the write is not an optimisation. `items.version` is the REST ETag, so a
   * re-run that rewrote every unchanged row would invalidate every client's conditional-write token
   * for no reason at all.
   */
  private upsertItem(
    document: PaperlessDocument,
    mapping: DocumentTypeMapping,
    office: ReturnType<typeof mapOffice>,
  ): string {
    const title = document.title.trim() === '' ? `Paperless document ${document.id}` : document.title;

    const asn = this.allocateAsn(document, office.asn);
    const officeInput: OfficeInput = {
      correspondent: office.correspondent,
      correspondentNormalised: office.correspondentNormalised,
      officeDocumentType: mapping.officeDocumentType,
      documentDate: office.documentDate,
      asn,
      referenceNumber: office.referenceNumber,
      amountMinor: office.amountMinor,
      amountCurrency: office.amountCurrency,
      dueDate: office.dueDate,
      periodStart: office.periodStart,
      periodEnd: office.periodEnd,
    };

    const existing = this.recueil.db
      .select()
      .from(schema.items)
      .where(
        and(
          eq(schema.items.sourceSystem, SOURCE_SYSTEM),
          eq(schema.items.sourceId, String(document.id)),
        ),
      )
      .get();

    if (existing === undefined) {
      const record = this.recueil.library.createItem(
        {
          itemType: mapping.itemType,
          title,
          sourceSystem: SOURCE_SYSTEM,
          sourceId: String(document.id),
          dateAdded: toInstant(document.added) ?? nowTimestamp(),
          office: officeInput,
          provenance: { source: IMPORT_SOURCE, sourceRecordId: String(document.id) },
        },
        this.actor,
      );
      return record.item.id;
    }

    const currentOffice = this.recueil.db
      .select()
      .from(schema.itemOffice)
      .where(eq(schema.itemOffice.itemId, existing.id))
      .get();

    const unchanged =
      existing.itemType === mapping.itemType &&
      existing.title === title &&
      currentOffice !== undefined &&
      (Object.keys(officeInput) as Array<keyof OfficeInput>).every(
        (key) => (currentOffice as Record<string, unknown>)[key] === officeInput[key],
      );

    if (!unchanged) {
      this.recueil.library.updateItem(
        existing.id,
        { itemType: mapping.itemType, title, office: officeInput },
        this.actor,
        { provenance: { source: IMPORT_SOURCE, sourceRecordId: String(document.id) } },
      );
    }
    return existing.id;
  }

  /**
   * Decide whether this document may keep its ASN.
   *
   * `ux_item_office_asn` is unique among live items, and CONCEPT §6 asks for the archive serial
   * number to be "preserved and unique". Both are satisfiable at once only by asking the database
   * who holds the number before writing it. Three outcomes:
   *
   * - free, or held by this very document on a re-run — keep it;
   * - held by another *Paperless* document, which means Paperless itself has a duplicate — the
   *   lower document id keeps it, because that answer does not depend on the order pages arrived;
   * - held by an item that is not from this import — the ASN is not written, it goes to the
   *   `paperless_asn` custom field so nothing is lost, and a review entry names both claimants.
   */
  private allocateAsn(document: PaperlessDocument, asn: number | null): number | null {
    if (asn === null) return null;

    const owner = (this.plan as ImportPlan).asnOwner.get(asn);
    if (owner !== undefined && owner !== document.id) {
      this.review({
        kind: 'asn_duplicate_in_paperless',
        paperlessId: document.id,
        subject: `ASN ${asn} on '${document.title}'`,
        reason:
          `Paperless returned ASN ${asn} on both document ${owner} and document ${document.id}. ` +
          'An ASN is a physical filing number and ux_item_office_asn makes it unique among live ' +
          'items, so only the lower document id can keep it.',
        proposedAction:
          `Decide in Paperless which document holds ASN ${asn}, clear the other, and run the ` +
          'import again. Until then the number is on this item\'s `paperless_asn` custom field.',
        detail: { asn, keptBy: owner, refusedFor: document.id },
      });
      return null;
    }

    const holder = this.recueil.db
      .select({ itemId: schema.itemOffice.itemId, sourceId: schema.items.sourceId })
      .from(schema.itemOffice)
      .innerJoin(schema.items, eq(schema.items.id, schema.itemOffice.itemId))
      .where(and(eq(schema.itemOffice.asn, asn), isNull(schema.itemOffice.itemTrashedAt)))
      .get();

    if (holder === undefined) return asn;
    if (holder.sourceId === String(document.id)) return asn;

    this.review({
      kind: 'asn_collision',
      paperlessId: document.id,
      subject: `ASN ${asn} on '${document.title}'`,
      reason:
        `Recueil item ${holder.itemId} already holds ASN ${asn} and the index ` +
        'ux_item_office_asn makes it unique among live items. Writing it would have failed the ' +
        'whole run, so it was left off this item.',
      proposedAction:
        `Check which document really has ASN ${asn}, clear the other, and run the import again. ` +
        'The number is on this item\'s `paperless_asn` custom field in the meantime.',
      detail: { asn, heldByItemId: holder.itemId, paperlessId: document.id },
    });
    return null;
  }

  private applyTags(document: PaperlessDocument, itemId: string): void {
    for (const tagId of document.tags ?? []) {
      const recueilTagId = this.tagIdByPaperlessId.get(tagId);
      if (recueilTagId === undefined) {
        this.skip({
          kind: 'tag_assignment',
          paperlessId: document.id,
          subject: `tag ${tagId} on '${document.title}'`,
          reason:
            `Paperless document ${document.id} carries tag ${tagId}, which was not in ` +
            '`/api/tags/`. A tag created between the two requests would do this; re-running the ' +
            'import picks it up.',
        });
        continue;
      }
      this.recueil.tags.assign(itemId, recueilTagId, this.actor, { source: 'import' });
    }
  }

  /**
   * Carry the Paperless notes across.
   *
   * Keyed by item and text, because a Paperless note has an id but Recueil notes have nowhere to
   * put a foreign one, and re-running an import must not double them. Two genuinely identical notes
   * on one document collapse into one, which is stated in the report rather than hidden.
   */
  private applyNotes(document: PaperlessDocument, itemId: string): void {
    const notes = document.notes ?? [];
    if (notes.length === 0) return;

    const existing = new Set(
      this.recueil.notes.forItem(itemId).map((row) => row.contentMarkdown.trim()),
    );

    for (const note of notes) {
      const text = typeof note.note === 'string' ? note.note.trim() : '';
      if (text === '') continue;
      if (existing.has(text)) continue;
      existing.add(text);
      this.recueil.notes.create(
        {
          itemId,
          contentMarkdown: text,
          noteKind: 'note',
          createdAt: toInstant(note.created) ?? nowTimestamp(),
        },
        this.actor,
      );
    }
  }

  /** The three fields this importer owns: the document-type name, the storage path, a refused ASN. */
  private applyHelperFields(
    document: PaperlessDocument,
    itemId: string,
    mapping: DocumentTypeMapping,
    snapshot: ApiSnapshot,
  ): void {
    if (mapping.name !== null) {
      this.setHelperValue(itemId, DOCUMENT_TYPE_FIELD_KEY, 'Paperless document type', 'text', {
        type: 'text',
        value: mapping.name,
      });
    }

    if (document.storage_path !== null && document.storage_path !== undefined) {
      const path = snapshot.storagePaths.find((row) => row.id === document.storage_path);
      if (path !== undefined) {
        this.setHelperValue(itemId, STORAGE_PATH_FIELD_KEY, 'Paperless storage path', 'text', {
          type: 'text',
          value: path.name,
        });
      }
    }

    // Written whenever Paperless has an ASN, refused or not: the column may be empty because
    // another item holds the number, and the report's ASN section is checked against both.
    const asn = document.archive_serial_number;
    if (typeof asn === 'number' && Number.isSafeInteger(asn)) {
      this.setHelperValue(itemId, ASN_FIELD_KEY, 'Paperless archive serial number', 'integer', {
        type: 'integer',
        value: asn,
      });
    }
  }

  private applyValues(document: PaperlessDocument, itemId: string): void {
    const plan = this.plan as ImportPlan;
    const byPaperlessId = new Map(plan.customFieldPlans.map((field) => [field.paperlessId, field]));

    for (const instance of document.custom_fields ?? []) {
      const fieldPlan = byPaperlessId.get(instance.field);
      if (fieldPlan === undefined) {
        this.skip({
          kind: 'custom_field_value',
          paperlessId: document.id,
          subject: `custom field ${instance.field} on '${document.title}'`,
          reason:
            `Paperless document ${document.id} carries a value for custom field ` +
            `${instance.field}, which was not in \`/api/custom_fields/\`.`,
        });
        continue;
      }
      // Document links need every item to exist, so they wait for the `links` stage.
      if (fieldPlan.paperlessDataType === 'documentlink') continue;
      this.writeValue(document, itemId, fieldPlan, instance.value);
    }
  }

  /** Fetch, hash, ingest and attach the original (ADR-0004). A failure is a review entry, not a stop. */
  private async importOriginal(document: PaperlessDocument, itemId: string): Promise<void> {
    if (this.options.downloadOriginals === false) return;

    let metadataChecksum: string | null = null;
    let metadataSize: number | null = null;
    let metadataFilename: string | null = null;
    try {
      const metadata = await this.client.documentMetadata(document.id);
      metadataChecksum =
        typeof metadata.original_checksum === 'string' ? metadata.original_checksum : null;
      metadataSize = typeof metadata.original_size === 'number' ? metadata.original_size : null;
      metadataFilename =
        typeof metadata.original_filename === 'string' ? metadata.original_filename : null;
    } catch (error) {
      // Metadata is a cross-check, not the file. Losing it costs the checksum comparison for this
      // one document and nothing else, so it is recorded and the download goes ahead.
      logJob(this.recueil, this.jobId, {
        level: 'warn',
        message: 'metadata_unavailable',
        subjectType: 'document',
        subjectId: String(document.id),
        data: { reason: error instanceof Error ? error.message : String(error) },
      });
    }

    /*
     * The filename is a string a person typed into Paperless, so it is hostile until it has been
     * reduced: `../../../etc/passwd` is a perfectly valid `original_file_name`. Nothing in this
     * package opens a file by it — the store is content-addressed — but it reaches
     * `documents.original_filename`, and P10 says exports mirror importers, so the day something
     * writes a file by that name it must not be able to leave its directory. The raw string is kept
     * in the provenance JSON, where it is data and never a path.
     */
    const rawFilename = document.original_file_name ?? metadataFilename ?? null;
    const filename = rawFilename === null ? null : safeBasename(rawFilename);

    const entry: OriginalReportEntry = {
      paperlessId: document.id,
      title: document.title,
      status: 'missing',
      sha256: null,
      byteSize: null,
      paperlessChecksum: metadataChecksum,
      matchesPaperlessChecksum: null,
      paperlessSize: metadataSize,
      originalFilename: filename,
      mimeType: document.mime_type ?? null,
      reason: null,
    };

    let file;
    try {
      file = await this.client.downloadOriginal(document.id);
    } catch (error) {
      const missing = error instanceof PaperlessNotFoundError;
      entry.status = missing ? 'missing' : 'unreadable';
      entry.reason = error instanceof Error ? error.message : String(error);
      this.observeOriginal(entry);
      this.review({
        kind: missing ? 'original_missing' : 'original_unreadable',
        paperlessId: document.id,
        subject: document.title,
        reason:
          `The original of Paperless document ${document.id} could not be fetched: ${entry.reason}` +
          ' The item, its Office facet, its tags and its custom fields are all imported; only the ' +
          'file is not.',
        proposedAction:
          'Check the document in Paperless. If the file is really gone, the item is still a ' +
          'complete record of it; if it is a permissions or a network problem, run the import ' +
          'again and the file will be attached to the item that is already there.',
        detail: { paperlessId: document.id, itemId },
      });
      return;
    }

    if (file.bytes.length === 0) {
      entry.status = 'unreadable';
      entry.byteSize = 0;
      entry.reason = 'Paperless returned an empty body for the original.';
      this.observeOriginal(entry);
      this.review({
        kind: 'original_unreadable',
        paperlessId: document.id,
        subject: document.title,
        reason: entry.reason,
        proposedAction: 'Check the file in Paperless; an empty original is not a document.',
        detail: { paperlessId: document.id, itemId },
      });
      return;
    }

    const md5 = createHash('md5').update(file.bytes).digest('hex');
    entry.matchesPaperlessChecksum =
      metadataChecksum === null ? null : md5.toLowerCase() === metadataChecksum.toLowerCase();

    const result = await this.recueil.documents.ingestBuffer(file.bytes, {
      sourceKind: 'import',
      sourceRef: documentSourceRef(document.id),
      sourceDetail: {
        paperlessId: document.id,
        paperlessTitle: document.title,
        paperlessChecksumMd5: metadataChecksum,
        paperlessSize: metadataSize,
        paperlessOriginalFilename: rawFilename,
      },
      originalFilename: filename ?? file.filename,
      declaredMimeType: document.mime_type ?? file.contentType,
      observedAt: toInstant(document.added) ?? nowTimestamp(),
      jobId: this.jobId,
      actor: this.actor,
      attachTo: {
        itemId,
        role: this.options.attachmentRole ?? 'scan',
        title: document.title,
      },
    });

    entry.status = entry.matchesPaperlessChecksum === false ? 'checksum_mismatch' : 'stored';
    entry.sha256 = result.document.sha256;
    entry.byteSize = result.document.byteSize;
    entry.mimeType = result.document.mimeType;

    if (entry.matchesPaperlessChecksum === false) {
      entry.reason =
        `Paperless recorded MD5 ${metadataChecksum} for this original and the bytes it sent hash ` +
        `to ${md5}. The bytes are stored under their own SHA-256, so nothing is lost, but the two ` +
        'sides disagree about what the file is.';
      this.review({
        kind: 'checksum_mismatch',
        paperlessId: document.id,
        subject: document.title,
        reason: entry.reason,
        proposedAction:
          'Check the document in Paperless. A mismatch usually means the file on disk was ' +
          'replaced without Paperless being told, which is worth knowing before Paperless is ' +
          'decommissioned.',
        detail: { paperlessId: document.id, itemId, paperlessMd5: metadataChecksum, fetchedMd5: md5 },
      });
    }

    this.observeOriginal(entry);
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Stage 4 — document links                                                                    */
  /* ---------------------------------------------------------------------------------------- */

  private importDocumentLinks(document: PaperlessDocument): void {
    const plan = this.plan as ImportPlan;
    const itemId = this.itemIdByDocumentId.get(document.id);
    if (itemId === undefined) return;

    const byPaperlessId = new Map(plan.customFieldPlans.map((field) => [field.paperlessId, field]));
    for (const instance of document.custom_fields ?? []) {
      const fieldPlan = byPaperlessId.get(instance.field);
      if (fieldPlan === undefined || fieldPlan.paperlessDataType !== 'documentlink') continue;
      this.writeValue(document, itemId, fieldPlan, instance.value);
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Stage 5 — finalise                                                                          */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * Restore `items.date_modified` to the Paperless value.
   *
   * The services set it to the moment of the write, deliberately: an ordinary edit must not be able
   * to claim it happened at some other time. An importer is the one caller that legitimately knows
   * better, so it says so here, in one direct write, after everything else is done.
   */
  private finaliseDocument(document: PaperlessDocument): void {
    const itemId = this.itemIdByDocumentId.get(document.id);
    if (itemId === undefined) return;
    const modified = toInstant(document.modified);
    if (modified === null) return;

    this.recueil.db
      .update(schema.items)
      .set({ dateModified: modified })
      .where(and(eq(schema.items.id, itemId), ne(schema.items.dateModified, modified)))
      .run();
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Writing one value                                                                           */
  /* ---------------------------------------------------------------------------------------- */

  private writeValue(
    document: PaperlessDocument,
    itemId: string,
    fieldPlan: CustomFieldPlan,
    raw: unknown,
  ): void {
    const fieldId = this.fieldIdByPaperlessId.get(fieldPlan.paperlessId);
    if (fieldId === undefined) return;

    const planned = planValue(fieldPlan, raw, {
      resolveDocument: (paperlessId) => this.itemIdByDocumentId.get(paperlessId),
      defaultCurrency: this.options.defaultCurrency ?? null,
    });

    switch (planned.kind) {
      case 'absent':
        return;

      case 'blank':
        this.recueil.customFields.setValue({ fieldId, itemId, isBlank: true }, this.actor);
        return;

      case 'skipped':
        this.skip({
          kind: 'custom_field_value',
          paperlessId: document.id,
          subject: `${fieldPlan.name} on '${document.title}'`,
          reason: planned.reason,
        });
        return;

      case 'values':
        for (const value of planned.values) {
          this.recueil.customFields.setValue(
            { fieldId, itemId, ordinal: value.ordinal, content: value.content },
            this.actor,
          );
        }
        return;

      case 'partial': {
        for (const value of planned.values) {
          this.recueil.customFields.setValue(
            { fieldId, itemId, ordinal: value.ordinal, content: value.content },
            this.actor,
          );
        }
        this.review({
          kind: 'document_link_unresolved',
          paperlessId: document.id,
          subject: `${fieldPlan.name} on '${document.title}'`,
          reason: planned.reason,
          proposedAction:
            'Check that the linked documents are visible to the token this import used, then run ' +
            'the import again: the links are written into the slots that are already there.',
          detail: {
            paperlessId: document.id,
            field: fieldPlan.name,
            unresolved: planned.unresolved,
          },
        });
        return;
      }
    }
  }

  /**
   * Write one value into a field this importer owns, defining the field the first time it is used.
   *
   * Lazily, because a library that has never seen a Paperless storage path should not grow an empty
   * `paperless_storage_path` field to prove it.
   */
  private setHelperValue(
    itemId: string,
    fieldKey: string,
    name: string,
    dataType: 'text' | 'integer',
    content: { type: 'text'; value: string } | { type: 'integer'; value: number },
  ): void {
    let field = this.definedHelperFields.get(fieldKey);
    if (field === undefined) {
      field =
        this.findFieldByKey(fieldKey) ??
        this.recueil.customFields.define(
          {
            fieldKey,
            name,
            dataType,
            description: 'Written by the Paperless-ngx importer so that nothing is lost (P10).',
          },
          this.actor,
        );
      this.definedHelperFields.set(fieldKey, field);
    }
    if (field.dataType !== dataType) return;
    this.recueil.customFields.setValue({ fieldId: field.id, itemId, content }, this.actor);
  }

  private findFieldByKey(fieldKey: string): CustomFieldRow | undefined {
    return this.recueil.db
      .select()
      .from(schema.customFields)
      .where(eq(schema.customFields.fieldKey, fieldKey))
      .get();
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Observations (§6.4): written as they happen, read back by the report                        */
  /* ---------------------------------------------------------------------------------------- */

  private observeOriginal(entry: OriginalReportEntry): void {
    logJob(this.recueil, this.jobId, {
      level: entry.status === 'stored' ? 'info' : 'warn',
      message: 'original',
      subjectType: 'document',
      subjectId: String(entry.paperlessId),
      data: entry as unknown as Record<string, unknown>,
    });
  }

  private skip(entry: SkippedRecord): void {
    logJob(this.recueil, this.jobId, {
      level: 'warn',
      message: 'skipped',
      subjectType: 'document',
      subjectId: entry.paperlessId === null ? undefined : String(entry.paperlessId),
      data: entry as unknown as Record<string, unknown>,
    });
  }

  private review(entry: ReviewEntry): void {
    logJob(this.recueil, this.jobId, {
      level: 'warn',
      message: 'review',
      subjectType: 'document',
      subjectId: entry.paperlessId === null ? undefined : String(entry.paperlessId),
      data: entry as unknown as Record<string, unknown>,
    });
  }
}

/* ================================================================================================ */

const clientOptions = (options: PaperlessImportOptions): PaperlessClientOptions => {
  if (options.baseUrl === undefined || options.token === undefined) {
    throw new TypeError('Give `baseUrl` and `token`, or a ready-made `client`.');
  }
  return {
    baseUrl: options.baseUrl,
    token: options.token,
    ...(options.apiVersion === undefined ? {} : { apiVersion: options.apiVersion }),
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
    ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  };
};

/** ASN → the lowest Paperless document id carrying it. Deterministic, and independent of run state. */
const asnOwners = (documents: readonly PaperlessDocument[]): Map<number, number> => {
  const owners = new Map<number, number>();
  for (const document of documents) {
    const asn = document.archive_serial_number;
    if (typeof asn !== 'number' || !Number.isSafeInteger(asn)) continue;
    const current = owners.get(asn);
    if (current === undefined || document.id < current) owners.set(asn, document.id);
  }
  return owners;
};

/**
 * Every currency code each monetary field's values carry, across the whole library.
 *
 * Read from the snapshot before the first field is defined, which is what makes it possible to put
 * a per-value currency onto a per-field column when — and only when — the values agree.
 */
const observedCurrencies = (snapshot: ApiSnapshot): Map<number, Set<string>> => {
  const monetary = new Set(
    snapshot.customFields.filter((field) => field.data_type === 'monetary').map((field) => field.id),
  );
  const byField = new Map<number, Set<string>>();

  for (const document of snapshot.documents) {
    for (const instance of document.custom_fields ?? []) {
      if (!monetary.has(instance.field)) continue;
      const money = parseMonetary(instance.value);
      if (money?.currency == null) continue;
      const seen = byField.get(instance.field) ?? new Set<string>();
      seen.add(money.currency);
      byField.set(instance.field, seen);
    }
  }
  return byField;
};

/** `#RRGGBB`, lowercased. Anything else is dropped rather than stored as a colour that is not one. */
const normaliseColour = (colour: string | null | undefined): string | null => {
  if (typeof colour !== 'string') return null;
  const trimmed = colour.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/u.test(trimmed) ? trimmed : null;
};

