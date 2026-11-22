/**
 * Systematic reviews: setup, search runs, records with source tracking, within-review
 * deduplication, screening and the live PRISMA 2020 counts (CONCEPT §5.10, `spec/data-model.md`
 * §8, `spec/systematic-review.md`).
 *
 * - The unit PRISMA counts is a `review_records` row; every number is computed from the rows, never
 *   tallied (RR1). Duplicates are kept and marked, never deleted (RR3).
 * - Screening decisions are append-only; undo and change are supersessions (SD1). The status
 *   columns on the record are caches of the current decisions, rewritten in the same transaction
 *   (RR2), and `verifyCaches` recomputes them to prove it.
 * - Whether a decision was tool-assisted is decided here from the actor, not by the caller (SD2).
 */
import { and, asc, desc, eq, isNull } from 'drizzle-orm';

import type { RecueilDatabase } from '../db/client.js';
import {
  apiTokens,
  documents,
  itemBibliographic,
  items,
  prismaCounts,
  reviewRecordSources,
  reviewRecords,
  reviews,
  screeningDecisions,
  searchRuns,
  users,
} from '../db/schema.js';
import type { PRISMA_STAGE_KEYS } from '../db/schema.js';
import type {
  ReviewRecordRow,
  ReviewRecordSourceRow,
  ReviewRow,
  ScreeningDecisionRow,
  SearchRunRow,
} from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { newId, newPublicId } from '../ids.js';
import { normalise, normaliseDoi } from '../normalise.js';
import { nowTimestamp } from '../time.js';
import type { Actor } from './actor.js';
import type { AuditService } from './audit.js';
import type { CreatorService } from './creators.js';
import type { BibliographicInput, LibraryService } from './library.js';

export type ScreeningStage = 'title_abstract' | 'full_text';
export type ScreeningDecisionValue = 'include' | 'exclude' | 'maybe';
export type PrismaStageKey = (typeof PRISMA_STAGE_KEYS)[number];

export interface ExclusionReason {
  code: string;
  label: string;
  /** Which stage offers the reason; `any` for both. */
  stage: ScreeningStage | 'any';
}

export interface CreateReviewInput {
  title: string;
  question?: string | null;
  protocol?: Record<string, unknown>;
  registrationId?: string | null;
  registrationUrl?: string | null;
  exclusionReasons?: ExclusionReason[];
  automationDisclosure?: boolean;
}

export interface UpdateReviewInput extends Partial<CreateReviewInput> {
  status?: ReviewRow['status'];
}

export interface AddSearchRunInput {
  sourceDatabase: string;
  interface?: string | null;
  queryString: string;
  queryTranslated?: string | null;
  filters?: Record<string, unknown>;
  dateLimitFrom?: string | null;
  dateLimitTo?: string | null;
  executedAt?: string;
  recordsReturned?: number | null;
  sourceFileDocumentId?: string | null;
  rerunOfSearchRunId?: string | null;
  notes?: string | null;
}

/** One imported record, already mapped from its file format (the mapping lives in `@recueil/sr`). */
export interface ImportedRecordInput {
  itemType: string;
  title?: string | null;
  bibliographic?: BibliographicInput;
  creators?: { familyName?: string | null; givenName?: string | null; literalName?: string | null; kind?: 'person' | 'organisation' }[];
  /** The accession in the source database: PMID, WoS UT, Scopus EID. */
  externalRecordId?: string | null;
  /** The record as received, before mapping. */
  raw?: unknown;
}

export interface AddRecordOutcome {
  record: ReviewRecordRow;
  /** `new`: a new review record. `source_added`: another database had already found it. `repeat`: this run already had it. */
  outcome: 'new' | 'source_added' | 'repeat';
  itemCreated: boolean;
}

export interface RecordView {
  record: ReviewRecordRow;
  title: string | null;
  abstract: string | null;
  year: number | null;
  venue: string | null;
  doi: string | null;
  pmid: string | null;
  authors: string[];
  sources: string[];
  current: { titleAbstract: ScreeningDecisionRow | null; fullText: ScreeningDecisionRow | null };
}

export interface DecideInput {
  stage: ScreeningStage;
  decision: ScreeningDecisionValue;
  reasonCode?: string | null;
  reasonNote?: string | null;
  durationMs?: number | null;
  /** What assisted, when something did. Recorded only for tool-assisted decisions (SD2). */
  toolDetail?: Record<string, unknown> | null;
}

export interface PrismaCell {
  stageKey: PrismaStageKey;
  count: number;
  sourceLabel: string | null;
  searchRunId: string | null;
  exclusionReasonCode: string | null;
}

/** The PRISMA 2020 numbers, and the "other methods" column the snapshot keys fold into one box. */
export interface PrismaFlow {
  cells: PrismaCell[];
  other: { identified: number; sought: number; notRetrieved: number; assessed: number; excluded: { code: string | null; count: number }[]; included: number };
}

/** Databases on the "databases and registers" side of the PRISMA diagram. */
const OTHER_SOURCES = new Set(['grey_literature', 'citation_search', 'manual', 'other']);
const REGISTER = 'registry';

const STAGE_ORDER: Record<ReviewRecordRow['stage'], number> = {
  identified: 0,
  deduplicated: 1,
  title_abstract: 2,
  full_text: 3,
  included: 4,
  excluded: 4,
};

const tokens = (text: string): Set<string> =>
  new Set(
    normalise(text)
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/u)
      .filter((token) => token.length > 1),
  );

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
};

const parseReasons = (row: ReviewRow): ExclusionReason[] => JSON.parse(row.exclusionReasons) as ExclusionReason[];

const validateReasons = (reasons: readonly ExclusionReason[]): void => {
  const seen = new Set<string>();
  for (const reason of reasons) {
    if (typeof reason.code !== 'string' || !/^[a-z0-9_.-]{1,64}$/u.test(reason.code)) {
      throw new ValidationError(`Exclusion reason codes are short slugs (a-z, 0-9, _ . -); got '${String(reason.code)}'.`);
    }
    if (seen.has(reason.code)) throw new ValidationError(`Exclusion reason '${reason.code}' appears twice.`);
    seen.add(reason.code);
    if (typeof reason.label !== 'string' || reason.label.trim() === '') throw new ValidationError(`Exclusion reason '${reason.code}' needs a label.`);
    if (!['title_abstract', 'full_text', 'any'].includes(reason.stage)) {
      throw new ValidationError(`Exclusion reason '${reason.code}' has stage '${String(reason.stage)}'; use title_abstract, full_text or any.`);
    }
  }
};

export class ReviewService {
  constructor(
    private readonly db: RecueilDatabase,
    private readonly audit: AuditService,
    private readonly library: LibraryService,
    private readonly creators: CreatorService,
    private readonly userId: string,
  ) {}

  /* ---------------------------------------------------------------------------------------- */
  /* Reviews                                                                                     */
  /* ---------------------------------------------------------------------------------------- */

  create(input: CreateReviewInput, actor: Actor): ReviewRow {
    if (input.title.trim() === '') throw new ValidationError('A review needs a title.');
    const reasons = input.exclusionReasons ?? [];
    validateReasons(reasons);
    const now = nowTimestamp();
    const row: ReviewRow = {
      id: newId(),
      publicId: newPublicId(),
      title: input.title.trim(),
      question: input.question ?? null,
      protocol: JSON.stringify(input.protocol ?? {}),
      registrationId: input.registrationId ?? null,
      registrationUrl: input.registrationUrl ?? null,
      status: 'draft',
      screenerCount: 1,
      blindMode: false,
      conflictPolicy: null,
      exclusionReasons: JSON.stringify(reasons),
      automationDisclosure: input.automationDisclosure ?? false,
      ownerUserId: actor.userId ?? this.userId,
      createdAt: now,
      updatedAt: now,
      trashedAt: null,
    };
    return this.db.transaction((tx) => {
      tx.insert(reviews).values(row).run();
      this.audit.record({ actor, action: 'review.created', entityType: 'review', entityId: row.id, after: { title: row.title } }, tx);
      return row;
    });
  }

  get(id: string): ReviewRow {
    const row = this.db.select().from(reviews).where(eq(reviews.id, id)).get();
    if (row === undefined || row.trashedAt !== null) throw new NotFoundError('review', id);
    return row;
  }

  list(): ReviewRow[] {
    return this.db.select().from(reviews).where(isNull(reviews.trashedAt)).orderBy(desc(reviews.updatedAt)).all();
  }

  reasons(reviewId: string): ExclusionReason[] {
    return parseReasons(this.get(reviewId));
  }

  update(id: string, patch: UpdateReviewInput, actor: Actor): ReviewRow {
    const current = this.get(id);
    if (patch.exclusionReasons !== undefined) {
      validateReasons(patch.exclusionReasons);
      // A reason in use cannot disappear: the decisions that cite it would point at nothing.
      const used = new Set(
        this.db
          .select({ code: screeningDecisions.exclusionReasonCode })
          .from(screeningDecisions)
          .where(and(eq(screeningDecisions.reviewId, id), eq(screeningDecisions.isCurrent, true)))
          .all()
          .map((row) => row.code)
          .filter((code): code is string => code !== null),
      );
      const kept = new Set(patch.exclusionReasons.map((reason) => reason.code));
      const dropped = [...used].filter((code) => !kept.has(code));
      if (dropped.length > 0) throw new ConflictError(`Exclusion reasons still in use cannot be removed: ${dropped.join(', ')}.`, { codes: dropped });
    }
    if (patch.title !== undefined && patch.title.trim() === '') throw new ValidationError('A review needs a title.');
    const next = {
      title: patch.title?.trim() ?? current.title,
      question: patch.question === undefined ? current.question : patch.question,
      protocol: patch.protocol === undefined ? current.protocol : JSON.stringify(patch.protocol),
      registrationId: patch.registrationId === undefined ? current.registrationId : patch.registrationId,
      registrationUrl: patch.registrationUrl === undefined ? current.registrationUrl : patch.registrationUrl,
      exclusionReasons: patch.exclusionReasons === undefined ? current.exclusionReasons : JSON.stringify(patch.exclusionReasons),
      automationDisclosure: patch.automationDisclosure ?? current.automationDisclosure,
      status: patch.status ?? current.status,
      updatedAt: nowTimestamp(),
    };
    return this.db.transaction((tx) => {
      tx.update(reviews).set(next).where(eq(reviews.id, id)).run();
      this.audit.record({ actor, action: 'review.updated', entityType: 'review', entityId: id, before: { status: current.status }, after: { status: next.status } }, tx);
      return { ...current, ...next };
    });
  }

  trash(id: string, actor: Actor): void {
    this.get(id);
    this.db.transaction((tx) => {
      tx.update(reviews).set({ trashedAt: nowTimestamp() }).where(eq(reviews.id, id)).run();
      this.audit.record({ actor, action: 'review.trashed', entityType: 'review', entityId: id }, tx);
    });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Search runs                                                                                 */
  /* ---------------------------------------------------------------------------------------- */

  addSearchRun(reviewId: string, input: AddSearchRunInput, actor: Actor): SearchRunRow {
    this.get(reviewId);
    if (!/^[a-z][a-z0-9_]{1,63}$/u.test(input.sourceDatabase)) {
      throw new ValidationError(`A source database is a slug like 'pubmed' or 'web_of_science'; got '${input.sourceDatabase}'.`);
    }
    if (input.queryString.trim() === '') throw new ValidationError('A search run records its query verbatim (PRISMA-S); the query is empty.');
    if (input.recordsReturned != null && (!Number.isInteger(input.recordsReturned) || input.recordsReturned < 0)) {
      throw new ValidationError('recordsReturned is a count.');
    }
    if (input.rerunOfSearchRunId != null) {
      const original = this.searchRun(input.rerunOfSearchRunId);
      if (original.reviewId !== reviewId) throw new ValidationError('An update search reruns a search of the same review.');
    }
    if (input.sourceFileDocumentId != null && this.db.select({ id: documents.id }).from(documents).where(eq(documents.id, input.sourceFileDocumentId)).get() === undefined) {
      throw new NotFoundError('document', input.sourceFileDocumentId);
    }
    const now = nowTimestamp();
    const row: SearchRunRow = {
      id: newId(),
      reviewId,
      sourceDatabase: input.sourceDatabase,
      interface: input.interface ?? null,
      queryString: input.queryString,
      queryTranslated: input.queryTranslated ?? null,
      filters: JSON.stringify(input.filters ?? {}),
      dateLimitFrom: input.dateLimitFrom ?? null,
      dateLimitTo: input.dateLimitTo ?? null,
      executedAt: input.executedAt ?? now,
      executedByUserId: actor.userId ?? this.userId,
      recordsReturned: input.recordsReturned ?? null,
      recordsImported: null,
      duplicatesRemoved: null,
      sourceFileDocumentId: input.sourceFileDocumentId ?? null,
      importJobId: null,
      rerunOfSearchRunId: input.rerunOfSearchRunId ?? null,
      notes: input.notes ?? null,
      createdAt: now,
    };
    return this.db.transaction((tx) => {
      tx.insert(searchRuns).values(row).run();
      tx.update(reviews).set({ updatedAt: now }).where(eq(reviews.id, reviewId)).run();
      this.audit.record({ actor, action: 'search_run.created', entityType: 'search_run', entityId: row.id, after: { reviewId, sourceDatabase: row.sourceDatabase, recordsReturned: row.recordsReturned } }, tx);
      return row;
    });
  }

  searchRun(id: string): SearchRunRow {
    const row = this.db.select().from(searchRuns).where(eq(searchRuns.id, id)).get();
    if (row === undefined) throw new NotFoundError('search_run', id);
    return row;
  }

  searchRuns(reviewId: string): SearchRunRow[] {
    return this.db.select().from(searchRuns).where(eq(searchRuns.reviewId, reviewId)).orderBy(asc(searchRuns.executedAt), asc(searchRuns.createdAt)).all();
  }

  /** Keep the export file as bytes (P10): the search is then reproducible from the library alone. */
  attachSourceFile(searchRunId: string, documentId: string, actor: Actor): SearchRunRow {
    const run = this.searchRun(searchRunId);
    if (this.db.select({ id: documents.id }).from(documents).where(eq(documents.id, documentId)).get() === undefined) throw new NotFoundError('document', documentId);
    this.db.transaction((tx) => {
      tx.update(searchRuns).set({ sourceFileDocumentId: documentId }).where(eq(searchRuns.id, searchRunId)).run();
      this.audit.record({ actor, action: 'search_run.source_file', entityType: 'search_run', entityId: searchRunId, before: { documentId: run.sourceFileDocumentId }, after: { documentId } }, tx);
    });
    return { ...run, sourceFileDocumentId: documentId };
  }

  /** SR2: refused once any record is attributed to the run, because PRISMA counts would silently change. */
  deleteSearchRun(id: string, actor: Actor): void {
    const run = this.searchRun(id);
    const attributed = this.db.select({ id: reviewRecordSources.reviewRecordId }).from(reviewRecordSources).where(eq(reviewRecordSources.searchRunId, id)).limit(1).get();
    if (attributed !== undefined) throw new ConflictError('Records are attributed to this search run; deleting it would change the PRISMA counts (SR2).', { searchRunId: id });
    this.db.transaction((tx) => {
      tx.delete(searchRuns).where(eq(searchRuns.id, id)).run();
      this.audit.record({ actor, action: 'search_run.deleted', entityType: 'search_run', entityId: id, before: { reviewId: run.reviewId, sourceDatabase: run.sourceDatabase } }, tx);
    });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Records                                                                                     */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * Add one imported record to a review, attributed to a search run.
   *
   * The item is matched by DOI, then PMID — two live items may not share a DOI (B1) — and reused;
   * otherwise one is created. If the review already holds that item, this run becomes another
   * source of the same record: deduplication with source tracking.
   */
  addRecord(searchRunId: string, input: ImportedRecordInput, actor: Actor): AddRecordOutcome {
    const run = this.searchRun(searchRunId);
    return this.db.transaction(() => {
      let itemId = this.matchItem(input.bibliographic);
      let itemCreated = false;
      if (itemId === undefined) {
        itemId = this.library.createItem(
          {
            itemType: input.itemType,
            title: input.title ?? input.bibliographic?.title ?? null,
            sourceSystem: `sr:${run.sourceDatabase}`,
            ...(input.externalRecordId == null ? {} : { sourceId: input.externalRecordId }),
            bibliographic: input.bibliographic ?? {},
            provenance: { source: `import:${run.sourceDatabase}`, lock: false },
          },
          actor,
        ).item.id;
        itemCreated = true;
        this.writeCreators(itemId, input.creators ?? [], actor);
      }
      const now = nowTimestamp();
      const existing = this.db.select().from(reviewRecords).where(and(eq(reviewRecords.reviewId, run.reviewId), eq(reviewRecords.itemId, itemId))).get();
      const source = (primary: boolean, recordId: string): ReviewRecordSourceRow => ({
        reviewRecordId: recordId,
        searchRunId,
        externalRecordId: input.externalRecordId ?? null,
        rawRecord: input.raw === undefined ? null : JSON.stringify(input.raw),
        isPrimarySource: primary,
        importedAt: now,
      });
      if (existing !== undefined) {
        const already = this.db
          .select({ id: reviewRecordSources.reviewRecordId })
          .from(reviewRecordSources)
          .where(and(eq(reviewRecordSources.reviewRecordId, existing.id), eq(reviewRecordSources.searchRunId, searchRunId)))
          .get();
        if (already !== undefined) return { record: existing, outcome: 'repeat' as const, itemCreated };
        this.db.insert(reviewRecordSources).values(source(false, existing.id)).run();
        return { record: existing, outcome: 'source_added' as const, itemCreated };
      }
      const record: ReviewRecordRow = {
        id: newId(),
        reviewId: run.reviewId,
        itemId,
        stage: 'identified',
        dedupStatus: 'unique',
        duplicateOfId: null,
        screeningStatus: 'pending',
        exclusionReasonCode: null,
        retrievalStatus: 'not_attempted',
        retrievalNote: null,
        fullTextDocumentId: null,
        extractionStatus: 'not_started',
        isSnowballed: false,
        snowballFromItemId: null,
        studyGroupKey: null,
        addedAt: now,
        updatedAt: now,
      };
      this.db.insert(reviewRecords).values(record).run();
      this.db.insert(reviewRecordSources).values(source(true, record.id)).run();
      return { record, outcome: 'new' as const, itemCreated };
    });
  }

  /** After an import: `records_imported` is what arrived; `duplicates_removed` is recomputed for every run. */
  finishImport(searchRunId: string, recordsImported: number, actor: Actor): SearchRunRow {
    const run = this.searchRun(searchRunId);
    this.db.transaction((tx) => {
      tx.update(searchRuns).set({ recordsImported }).where(eq(searchRuns.id, searchRunId)).run();
      tx.update(reviews).set({ updatedAt: nowTimestamp(), ...(this.get(run.reviewId).status === 'draft' ? { status: 'searching' as const } : {}) }).where(eq(reviews.id, run.reviewId)).run();
      this.audit.record({ actor, action: 'search_run.imported', entityType: 'search_run', entityId: searchRunId, after: { recordsImported, recordsReturned: run.recordsReturned } }, tx);
    });
    this.recountDuplicates(run.reviewId);
    return this.searchRun(searchRunId);
  }

  /**
   * Add an item found by snowballing from an included study (PRISMA-S; reported in the "other
   * methods" column). An item already in the review is left as it is.
   */
  addSnowballed(reviewId: string, itemId: string, fromItemId: string, actor: Actor): ReviewRecordRow {
    this.get(reviewId);
    this.library.getItem(itemId);
    const existing = this.db.select().from(reviewRecords).where(and(eq(reviewRecords.reviewId, reviewId), eq(reviewRecords.itemId, itemId))).get();
    if (existing !== undefined) return existing;
    const now = nowTimestamp();
    const record: ReviewRecordRow = {
      id: newId(),
      reviewId,
      itemId,
      stage: 'identified',
      dedupStatus: 'unique',
      duplicateOfId: null,
      screeningStatus: 'pending',
      exclusionReasonCode: null,
      retrievalStatus: 'not_attempted',
      retrievalNote: null,
      fullTextDocumentId: null,
      extractionStatus: 'not_started',
      isSnowballed: true,
      snowballFromItemId: fromItemId,
      studyGroupKey: null,
      addedAt: now,
      updatedAt: now,
    };
    this.db.transaction((tx) => {
      tx.insert(reviewRecords).values(record).run();
      this.audit.record({ actor, action: 'review_record.snowballed', entityType: 'review_record', entityId: record.id, after: { reviewId, itemId, fromItemId } }, tx);
    });
    return record;
  }

  record(id: string): ReviewRecordRow {
    const row = this.db.select().from(reviewRecords).where(eq(reviewRecords.id, id)).get();
    if (row === undefined) throw new NotFoundError('review_record', id);
    return row;
  }

  records(reviewId: string): ReviewRecordRow[] {
    return this.db.select().from(reviewRecords).where(eq(reviewRecords.reviewId, reviewId)).orderBy(asc(reviewRecords.addedAt), asc(reviewRecords.id)).all();
  }

  sources(recordId: string): (ReviewRecordSourceRow & { sourceDatabase: string })[] {
    return this.db
      .select({ source: reviewRecordSources, sourceDatabase: searchRuns.sourceDatabase })
      .from(reviewRecordSources)
      .innerJoin(searchRuns, eq(searchRuns.id, reviewRecordSources.searchRunId))
      .where(eq(reviewRecordSources.reviewRecordId, recordId))
      .all()
      .map((row) => ({ ...row.source, sourceDatabase: row.sourceDatabase }));
  }

  /** A record with what a screener needs to see. */
  view(recordId: string): RecordView {
    const record = this.record(recordId);
    const bib = this.db.select().from(itemBibliographic).where(eq(itemBibliographic.itemId, record.itemId)).get();
    const item = this.db.select().from(items).where(eq(items.id, record.itemId)).get();
    const authors = this.creators.forItem(record.itemId).map(({ creator }) => creator.displayName);
    return {
      record,
      title: bib?.title ?? item?.title ?? null,
      abstract: bib?.abstract ?? null,
      year: bib?.issuedYear ?? null,
      venue: bib?.containerTitle ?? null,
      doi: bib?.doi ?? null,
      pmid: bib?.pmid ?? null,
      authors,
      sources: [...new Set(this.sources(recordId).map((source) => source.sourceDatabase))],
      current: { titleAbstract: this.currentDecision(recordId, 'title_abstract'), fullText: this.currentDecision(recordId, 'full_text') },
    };
  }

  /**
   * The screening worklist: unique records for a stage, pending first, in the order they arrived.
   * Full text lists only records that passed title/abstract.
   */
  worklist(reviewId: string, stage: ScreeningStage, options: { status?: 'pending' | 'decided' | 'all'; limit?: number; offset?: number } = {}): { total: number; pending: number; records: RecordView[] } {
    this.get(reviewId);
    const candidates = this.records(reviewId).filter((record) => record.dedupStatus !== 'duplicate');
    const eligible = stage === 'title_abstract' ? candidates : candidates.filter((record) => this.passedTitleAbstract(record.id));
    const decided = new Set(
      this.db
        .select({ id: screeningDecisions.reviewRecordId })
        .from(screeningDecisions)
        .where(and(eq(screeningDecisions.reviewId, reviewId), eq(screeningDecisions.stage, stage), eq(screeningDecisions.isCurrent, true)))
        .all()
        .map((row) => row.id),
    );
    const status = options.status ?? 'all';
    const filtered = eligible.filter((record) => (status === 'all' ? true : status === 'pending' ? !decided.has(record.id) : decided.has(record.id)));
    filtered.sort((a, b) => Number(decided.has(a.id)) - Number(decided.has(b.id)));
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    return {
      total: eligible.length,
      pending: eligible.filter((record) => !decided.has(record.id)).length,
      records: filtered.slice(offset, offset + limit).map((record) => this.view(record.id)),
    };
  }

  setRetrieval(recordId: string, input: { status: ReviewRecordRow['retrievalStatus']; note?: string | null; documentId?: string | null }, actor: Actor): ReviewRecordRow {
    const record = this.record(recordId);
    if (input.status !== 'not_attempted' && !this.passedTitleAbstract(recordId)) {
      throw new ConflictError('Full text is sought only for records that passed title/abstract screening.', { recordId });
    }
    if (input.documentId != null && this.db.select({ id: documents.id }).from(documents).where(eq(documents.id, input.documentId)).get() === undefined) {
      throw new NotFoundError('document', input.documentId);
    }
    const next = {
      retrievalStatus: input.status,
      retrievalNote: input.note === undefined ? record.retrievalNote : input.note,
      fullTextDocumentId: input.documentId === undefined ? record.fullTextDocumentId : input.documentId,
      updatedAt: nowTimestamp(),
    };
    this.db.transaction((tx) => {
      tx.update(reviewRecords).set(next).where(eq(reviewRecords.id, recordId)).run();
      this.audit.record({ actor, action: 'review_record.retrieval', entityType: 'review_record', entityId: recordId, before: { status: record.retrievalStatus }, after: { status: input.status } }, tx);
    });
    return { ...record, ...next };
  }

  /** Several reports of one study share a key; PRISMA counts studies and reports separately. */
  setStudyGroup(recordId: string, key: string | null, actor: Actor): ReviewRecordRow {
    const record = this.record(recordId);
    const studyGroupKey = key === null || key.trim() === '' ? null : key.trim();
    this.db.transaction((tx) => {
      tx.update(reviewRecords).set({ studyGroupKey, updatedAt: nowTimestamp() }).where(eq(reviewRecords.id, recordId)).run();
      this.audit.record({ actor, action: 'review_record.study_group', entityType: 'review_record', entityId: recordId, before: { studyGroupKey: record.studyGroupKey }, after: { studyGroupKey } }, tx);
    });
    return { ...record, studyGroupKey };
  }

  setExtractionStatus(recordId: string, status: ReviewRecordRow['extractionStatus'], actor: Actor): ReviewRecordRow {
    const record = this.record(recordId);
    if (status !== 'not_started' && status !== 'not_applicable' && record.stage !== 'included') {
      throw new ConflictError('Data are extracted from included studies only.', { recordId, stage: record.stage });
    }
    this.db.transaction((tx) => {
      tx.update(reviewRecords).set({ extractionStatus: status, updatedAt: nowTimestamp() }).where(eq(reviewRecords.id, recordId)).run();
      this.audit.record({ actor, action: 'review_record.extraction_status', entityType: 'review_record', entityId: recordId, before: { status: record.extractionStatus }, after: { status } }, tx);
    });
    return { ...record, extractionStatus: status };
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Deduplication within a review                                                               */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * Find the duplicates identifiers could not: near-identical title, year within one, compatible
   * first author. The later record is marked; the earlier becomes the master. Library items are
   * left alone — a review does not rewrite the library.
   */
  dedup(reviewId: string, actor: Actor, options: { threshold?: number; dryRun?: boolean } = {}): { pairs: { duplicateId: string; masterId: string; similarity: number }[] } {
    this.get(reviewId);
    const threshold = options.threshold ?? 0.93;
    const rows = this.records(reviewId).filter((record) => record.dedupStatus !== 'duplicate');
    const facts = rows.map((record) => {
      const bib = this.db.select().from(itemBibliographic).where(eq(itemBibliographic.itemId, record.itemId)).get();
      const first = this.creators.forItem(record.itemId)[0]?.creator;
      return {
        record,
        tokens: tokens(bib?.title ?? ''),
        year: bib?.issuedYear ?? null,
        doi: bib?.doi ?? null,
        author: first?.familyName ?? first?.literalName ?? null,
      };
    });
    const pairs: { duplicateId: string; masterId: string; similarity: number }[] = [];
    const taken = new Set<string>();
    for (let i = 0; i < facts.length; i += 1) {
      const master = facts[i]!;
      if (taken.has(master.record.id)) continue;
      for (let j = i + 1; j < facts.length; j += 1) {
        const other = facts[j]!;
        if (taken.has(other.record.id)) continue;
        if (master.doi !== null && other.doi !== null && master.doi !== other.doi) continue;
        if (master.year !== null && other.year !== null && Math.abs(master.year - other.year) > 1) continue;
        if (master.author !== null && other.author !== null && normalise(master.author) !== normalise(other.author)) continue;
        const similarity = jaccard(master.tokens, other.tokens);
        if (similarity < threshold) continue;
        pairs.push({ duplicateId: other.record.id, masterId: master.record.id, similarity: Math.round(similarity * 1000) / 1000 });
        taken.add(other.record.id);
      }
    }
    if (options.dryRun === true) return { pairs };
    this.db.transaction((tx) => {
      for (const pair of pairs) this.markDuplicateIn(tx, pair.duplicateId, pair.masterId);
      const now = nowTimestamp();
      for (const record of this.records(reviewId)) {
        if (record.dedupStatus !== 'duplicate' && record.stage === 'identified') {
          tx.update(reviewRecords).set({ stage: 'deduplicated', updatedAt: now }).where(eq(reviewRecords.id, record.id)).run();
        }
      }
      this.audit.record({ actor, action: 'review.dedup', entityType: 'review', entityId: reviewId, after: { duplicates: pairs.length, threshold } }, tx);
    });
    this.recountDuplicates(reviewId);
    return { pairs };
  }

  markDuplicate(recordId: string, masterId: string, actor: Actor): ReviewRecordRow {
    const record = this.record(recordId);
    const master = this.record(masterId);
    if (record.reviewId !== master.reviewId) throw new ValidationError('Both records must belong to the same review.');
    if (record.id === master.id) throw new ValidationError('A record cannot duplicate itself.');
    if (master.dedupStatus === 'duplicate') throw new ConflictError('The master is itself a duplicate; point at its master instead.', { masterId: master.duplicateOfId });
    if (this.currentDecision(recordId, 'title_abstract') !== null) throw new ConflictError('The record has screening decisions; undo them before marking it a duplicate.', { recordId });
    this.db.transaction((tx) => {
      this.markDuplicateIn(tx, recordId, masterId);
      this.audit.record({ actor, action: 'review_record.duplicate', entityType: 'review_record', entityId: recordId, after: { duplicateOfId: masterId } }, tx);
    });
    this.recountDuplicates(record.reviewId);
    return this.record(recordId);
  }

  /** Reverse a wrong duplicate call (RR3: nothing was deleted, so nothing is lost). */
  undoDuplicate(recordId: string, actor: Actor): ReviewRecordRow {
    const record = this.record(recordId);
    if (record.dedupStatus !== 'duplicate') throw new ConflictError('The record is not marked as a duplicate.', { recordId });
    const masterId = record.duplicateOfId!;
    this.db.transaction((tx) => {
      tx.update(reviewRecords).set({ dedupStatus: 'unique', duplicateOfId: null, stage: 'deduplicated', updatedAt: nowTimestamp() }).where(eq(reviewRecords.id, recordId)).run();
      const remaining = tx.select({ id: reviewRecords.id }).from(reviewRecords).where(eq(reviewRecords.duplicateOfId, masterId)).all();
      if (remaining.length === 0) tx.update(reviewRecords).set({ dedupStatus: 'unique' }).where(eq(reviewRecords.id, masterId)).run();
      this.audit.record({ actor, action: 'review_record.duplicate_undone', entityType: 'review_record', entityId: recordId, before: { duplicateOfId: masterId } }, tx);
    });
    this.recountDuplicates(record.reviewId);
    return this.record(recordId);
  }

  private markDuplicateIn(tx: Pick<RecueilDatabase, 'update'>, recordId: string, masterId: string): void {
    const now = nowTimestamp();
    tx.update(reviewRecords).set({ dedupStatus: 'duplicate', duplicateOfId: masterId, stage: 'identified', screeningStatus: 'pending', exclusionReasonCode: null, updatedAt: now }).where(eq(reviewRecords.id, recordId)).run();
    tx.update(reviewRecords).set({ dedupStatus: 'merged_master', updatedAt: now }).where(eq(reviewRecords.id, masterId)).run();
  }

  /**
   * `search_runs.duplicates_removed`, recomputed for every run of the review: a source row is a
   * duplicate when it is not the primary source of a unique record.
   */
  private recountDuplicates(reviewId: string): void {
    const rows = this.db
      .select({ runId: reviewRecordSources.searchRunId, primary: reviewRecordSources.isPrimarySource, dedup: reviewRecords.dedupStatus })
      .from(reviewRecordSources)
      .innerJoin(reviewRecords, eq(reviewRecords.id, reviewRecordSources.reviewRecordId))
      .where(eq(reviewRecords.reviewId, reviewId))
      .all();
    const byRun = new Map<string, number>();
    for (const run of this.searchRuns(reviewId)) byRun.set(run.id, 0);
    for (const row of rows) if (!row.primary || row.dedup === 'duplicate') byRun.set(row.runId, (byRun.get(row.runId) ?? 0) + 1);
    this.db.transaction((tx) => {
      for (const [runId, count] of byRun) tx.update(searchRuns).set({ duplicatesRemoved: count }).where(eq(searchRuns.id, runId)).run();
    });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Screening                                                                                   */
  /* ---------------------------------------------------------------------------------------- */

  currentDecision(recordId: string, stage: ScreeningStage): ScreeningDecisionRow | null {
    return (
      this.db
        .select()
        .from(screeningDecisions)
        .where(and(eq(screeningDecisions.reviewRecordId, recordId), eq(screeningDecisions.stage, stage), eq(screeningDecisions.isCurrent, true)))
        .orderBy(desc(screeningDecisions.decidedAt))
        .get() ?? null
    );
  }

  /** Every decision on a record, oldest first — the audit trail. */
  decisions(recordId: string): ScreeningDecisionRow[] {
    return this.db.select().from(screeningDecisions).where(eq(screeningDecisions.reviewRecordId, recordId)).orderBy(asc(screeningDecisions.createdAt), asc(screeningDecisions.id)).all();
  }

  /** Every decision in a review, for the audit export. */
  reviewDecisions(reviewId: string): ScreeningDecisionRow[] {
    return this.db.select().from(screeningDecisions).where(eq(screeningDecisions.reviewId, reviewId)).orderBy(asc(screeningDecisions.createdAt), asc(screeningDecisions.id)).all();
  }

  private passedTitleAbstract(recordId: string): boolean {
    const current = this.currentDecision(recordId, 'title_abstract');
    return current !== null && current.decision !== 'exclude';
  }

  /** SD2: decided from the actor. An MCP token or a plugin is a tool; the user and the CLI are not. */
  private isToolAssisted(actor: Actor): boolean {
    if (actor.type === 'mcp' || actor.type === 'plugin') return true;
    if (actor.type === 'token' && actor.tokenId != null) {
      const token = this.db.select({ client: apiTokens.client }).from(apiTokens).where(eq(apiTokens.id, actor.tokenId)).get();
      return token?.client === 'mcp';
    }
    return false;
  }

  private screenerOf(actor: Actor): string {
    const id = actor.userId ?? this.userId;
    if (this.db.select({ id: users.id }).from(users).where(eq(users.id, id)).get() === undefined) throw new NotFoundError('user', id);
    return id;
  }

  decide(recordId: string, input: DecideInput, actor: Actor): ScreeningDecisionRow {
    const record = this.record(recordId);
    const review = this.get(record.reviewId);
    if (record.dedupStatus === 'duplicate') throw new ConflictError('Duplicates are not screened; undo the duplicate call first.', { recordId, duplicateOfId: record.duplicateOfId });
    if (input.stage === 'full_text') {
      if (!this.passedTitleAbstract(recordId)) throw new ConflictError('Full-text screening follows a title/abstract include or maybe.', { recordId });
      if (record.retrievalStatus !== 'retrieved') throw new ConflictError('Full-text screening needs the full text; mark it retrieved first.', { recordId, retrievalStatus: record.retrievalStatus });
    }
    const reasonCode = input.decision === 'exclude' ? (input.reasonCode ?? null) : null;
    if (input.decision === 'exclude' && input.stage === 'full_text' && reasonCode === null) {
      throw new ValidationError('A full-text exclusion needs a reason (CONCEPT §5.10).', { recordId });
    }
    if (input.decision !== 'exclude' && input.reasonCode != null) throw new ValidationError('Only an exclusion carries a reason.');
    if (reasonCode !== null) {
      const reason = parseReasons(review).find((candidate) => candidate.code === reasonCode);
      if (reason === undefined) throw new ValidationError(`'${reasonCode}' is not one of this review's exclusion reasons.`, { reasonCode });
      if (reason.stage !== 'any' && reason.stage !== input.stage) throw new ValidationError(`Reason '${reasonCode}' belongs to ${reason.stage} screening.`, { reasonCode });
    }
    if (input.durationMs != null && (!Number.isInteger(input.durationMs) || input.durationMs < 0)) throw new ValidationError('durationMs is a non-negative integer.');
    const screener = this.screenerOf(actor);
    const toolAssisted = this.isToolAssisted(actor);
    const now = nowTimestamp();
    return this.db.transaction((tx) => {
      const previous = tx
        .select()
        .from(screeningDecisions)
        .where(and(eq(screeningDecisions.reviewRecordId, recordId), eq(screeningDecisions.stage, input.stage), eq(screeningDecisions.screenerUserId, screener), eq(screeningDecisions.isCurrent, true)))
        .get();
      const row: ScreeningDecisionRow = {
        id: newId(),
        reviewId: record.reviewId,
        reviewRecordId: recordId,
        stage: input.stage,
        screenerUserId: screener,
        decision: input.decision,
        exclusionReasonCode: reasonCode,
        exclusionReasonNote: input.decision === 'exclude' ? (input.reasonNote ?? null) : null,
        decidedAt: now,
        durationMs: input.durationMs ?? null,
        isCurrent: true,
        supersedesId: previous?.id ?? null,
        supersededById: null,
        toolAssisted,
        toolDetail: toolAssisted && input.toolDetail != null ? JSON.stringify(input.toolDetail) : null,
        isConflictResolution: false,
        resolvesConflictBetween: null,
        createdAt: now,
      };
      if (previous !== undefined) tx.update(screeningDecisions).set({ isCurrent: false }).where(eq(screeningDecisions.id, previous.id)).run();
      tx.insert(screeningDecisions).values(row).run();
      if (previous !== undefined) tx.update(screeningDecisions).set({ supersededById: row.id }).where(eq(screeningDecisions.id, previous.id)).run();
      this.writeCache(tx, recordId);
      if (review.status === 'draft' || review.status === 'searching') tx.update(reviews).set({ status: 'screening', updatedAt: now }).where(eq(reviews.id, review.id)).run();
      this.audit.record(
        { actor, action: 'screening.decided', entityType: 'review_record', entityId: recordId, before: previous === undefined ? null : { decision: previous.decision }, after: { stage: row.stage, decision: row.decision, reason: reasonCode, toolAssisted } },
        tx,
      );
      return row;
    });
  }

  /**
   * Undo the current decision of a stage. The previous decision is restored as a new row, or, when
   * there was none, the current one is superseded with no successor; nothing is ever updated except
   * `is_current` and `superseded_by_id` (SD1). Undoing a title/abstract decision that a full-text
   * decision depends on is refused.
   */
  undo(recordId: string, stage: ScreeningStage, actor: Actor): ScreeningDecisionRow | null {
    this.record(recordId);
    const screener = this.screenerOf(actor);
    const current = this.db
      .select()
      .from(screeningDecisions)
      .where(and(eq(screeningDecisions.reviewRecordId, recordId), eq(screeningDecisions.stage, stage), eq(screeningDecisions.screenerUserId, screener), eq(screeningDecisions.isCurrent, true)))
      .get();
    if (current === undefined) throw new ConflictError('There is no decision to undo at this stage.', { recordId, stage });
    if (stage === 'title_abstract' && this.currentDecision(recordId, 'full_text') !== null) {
      throw new ConflictError('A full-text decision depends on this title/abstract decision; undo that first.', { recordId });
    }
    const previous = current.supersedesId === null ? undefined : this.db.select().from(screeningDecisions).where(eq(screeningDecisions.id, current.supersedesId)).get();
    const now = nowTimestamp();
    return this.db.transaction((tx) => {
      tx.update(screeningDecisions).set({ isCurrent: false }).where(eq(screeningDecisions.id, current.id)).run();
      let restored: ScreeningDecisionRow | null = null;
      if (previous !== undefined) {
        restored = {
          ...previous,
          id: newId(),
          decidedAt: now,
          isCurrent: true,
          supersedesId: current.id,
          supersededById: null,
          toolAssisted: this.isToolAssisted(actor),
          toolDetail: null,
          durationMs: null,
          createdAt: now,
        };
        tx.insert(screeningDecisions).values(restored).run();
        tx.update(screeningDecisions).set({ supersededById: restored.id }).where(eq(screeningDecisions.id, current.id)).run();
      }
      this.writeCache(tx, recordId);
      this.audit.record({ actor, action: 'screening.undone', entityType: 'review_record', entityId: recordId, before: { stage, decision: current.decision }, after: restored === null ? null : { decision: restored.decision } }, tx);
      return restored;
    });
  }

  /** RR2: the caches the decisions imply. */
  private derivedCache(tx: Pick<RecueilDatabase, 'select'>, record: ReviewRecordRow): Pick<ReviewRecordRow, 'stage' | 'screeningStatus' | 'exclusionReasonCode'> {
    const current = (stage: ScreeningStage) =>
      tx
        .select()
        .from(screeningDecisions)
        .where(and(eq(screeningDecisions.reviewRecordId, record.id), eq(screeningDecisions.stage, stage), eq(screeningDecisions.isCurrent, true)))
        .get();
    if (record.dedupStatus === 'duplicate') return { stage: 'identified', screeningStatus: 'pending', exclusionReasonCode: null };
    const ta = current('title_abstract');
    const ft = current('full_text');
    const base = STAGE_ORDER[record.stage] >= 1 ? 'deduplicated' : 'identified';
    if (ta === undefined) return { stage: base, screeningStatus: 'pending', exclusionReasonCode: null };
    if (ta.decision === 'exclude') return { stage: 'excluded', screeningStatus: 'excluded', exclusionReasonCode: ta.exclusionReasonCode };
    if (ft === undefined) return { stage: 'title_abstract', screeningStatus: ta.decision === 'include' ? 'included' : 'maybe', exclusionReasonCode: null };
    if (ft.decision === 'include') return { stage: 'included', screeningStatus: 'included', exclusionReasonCode: null };
    if (ft.decision === 'exclude') return { stage: 'excluded', screeningStatus: 'excluded', exclusionReasonCode: ft.exclusionReasonCode };
    return { stage: 'full_text', screeningStatus: 'maybe', exclusionReasonCode: null };
  }

  private writeCache(tx: Pick<RecueilDatabase, 'select' | 'update'>, recordId: string): void {
    const record = tx.select().from(reviewRecords).where(eq(reviewRecords.id, recordId)).get()!;
    // A record that was ever deduplicated stays at least `deduplicated` when its decisions are undone.
    const everDeduplicated = record.stage !== 'identified';
    const cache = this.derivedCache(tx, { ...record, stage: everDeduplicated ? 'deduplicated' : 'identified' });
    tx.update(reviewRecords).set({ ...cache, updatedAt: nowTimestamp() }).where(eq(reviewRecords.id, recordId)).run();
  }

  /** RR2's consistency test: recompute every cache and report the records that disagree. */
  verifyCaches(reviewId: string): { recordId: string; stored: unknown; derived: unknown }[] {
    const problems: { recordId: string; stored: unknown; derived: unknown }[] = [];
    for (const record of this.records(reviewId)) {
      const derived = this.derivedCache(this.db, { ...record, stage: record.stage === 'identified' ? 'identified' : 'deduplicated' });
      const stored = { stage: record.stage, screeningStatus: record.screeningStatus, exclusionReasonCode: record.exclusionReasonCode };
      if (stored.stage !== derived.stage || stored.screeningStatus !== derived.screeningStatus || stored.exclusionReasonCode !== derived.exclusionReasonCode) {
        problems.push({ recordId: record.id, stored, derived });
      }
    }
    return problems;
  }

  /* ---------------------------------------------------------------------------------------- */
  /* PRISMA 2020                                                                                 */
  /* ---------------------------------------------------------------------------------------- */

  /** The live flow, computed from the rows (RR1); definitions in `spec/systematic-review.md` §4. */
  prisma(reviewId: string): PrismaFlow {
    this.get(reviewId);
    const records = this.records(reviewId);
    const runs = new Map(this.searchRuns(reviewId).map((run) => [run.id, run]));
    const sourceRows = this.db
      .select({ source: reviewRecordSources })
      .from(reviewRecordSources)
      .innerJoin(reviewRecords, eq(reviewRecords.id, reviewRecordSources.reviewRecordId))
      .where(eq(reviewRecords.reviewId, reviewId))
      .all()
      .map((row) => row.source);
    const recordsById = new Map(records.map((record) => [record.id, record]));
    const primaryRun = new Map(sourceRows.filter((row) => row.isPrimarySource).map((row) => [row.reviewRecordId, runs.get(row.searchRunId)!]));
    const isOtherMethod = (record: ReviewRecordRow): boolean => record.isSnowballed || OTHER_SOURCES.has(primaryRun.get(record.id)?.sourceDatabase ?? 'other');

    const cells: PrismaCell[] = [];
    const cell = (stageKey: PrismaStageKey, count: number, extra: Partial<PrismaCell> = {}): void => {
      cells.push({ stageKey, count, sourceLabel: null, searchRunId: null, exclusionReasonCode: null, ...extra });
    };

    // Identification: one count per source row, per run, on records not found by other methods.
    const perRun = new Map<string, number>();
    for (const row of sourceRows) {
      const record = recordsById.get(row.reviewRecordId)!;
      if (record.isSnowballed) continue;
      perRun.set(row.searchRunId, (perRun.get(row.searchRunId) ?? 0) + 1);
    }
    let databases = 0;
    let registers = 0;
    let otherIdentified = records.filter((record) => record.isSnowballed).length;
    for (const [runId, count] of perRun) {
      const run = runs.get(runId)!;
      if (OTHER_SOURCES.has(run.sourceDatabase)) otherIdentified += count;
      else if (run.sourceDatabase === REGISTER) registers += count;
      else databases += count;
    }
    cell('records_identified_databases', databases);
    for (const run of runs.values()) {
      if (run.sourceDatabase !== REGISTER && !OTHER_SOURCES.has(run.sourceDatabase)) {
        cell('records_identified_databases', perRun.get(run.id) ?? 0, { sourceLabel: `${run.sourceDatabase}${run.interface === null ? '' : ` (${run.interface})`} ${run.executedAt.slice(0, 10)}`, searchRunId: run.id });
      }
    }
    cell('records_identified_registers', registers);
    for (const run of runs.values()) {
      if (run.sourceDatabase === REGISTER) cell('records_identified_registers', perRun.get(run.id) ?? 0, { sourceLabel: `${run.sourceDatabase} ${run.executedAt.slice(0, 10)}`, searchRunId: run.id });
    }
    cell('records_identified_other', otherIdentified);

    const unique = records.filter((record) => record.dedupStatus !== 'duplicate');
    const main = unique.filter((record) => !isOtherMethod(record));
    const other = unique.filter((record) => isOtherMethod(record));
    cell('records_removed_duplicates', databases + registers - main.length);
    cell('records_removed_automation', 0);
    cell('records_removed_other', 0);

    const current = new Map<string, { ta?: ScreeningDecisionRow; ft?: ScreeningDecisionRow }>();
    for (const decision of this.db
      .select()
      .from(screeningDecisions)
      .where(and(eq(screeningDecisions.reviewId, reviewId), eq(screeningDecisions.isCurrent, true)))
      .all()) {
      const entry = current.get(decision.reviewRecordId) ?? {};
      if (decision.stage === 'title_abstract') entry.ta = decision;
      else entry.ft = decision;
      current.set(decision.reviewRecordId, entry);
    }
    const flow = (set: ReviewRecordRow[]) => {
      const excludedAtScreening = set.filter((record) => current.get(record.id)?.ta?.decision === 'exclude').length;
      const sought = set.filter((record) => {
        const ta = current.get(record.id)?.ta;
        return ta !== undefined && ta.decision !== 'exclude';
      });
      const notRetrieved = sought.filter((record) => record.retrievalStatus === 'not_retrieved').length;
      const assessed = sought.filter((record) => current.get(record.id)?.ft !== undefined);
      const excludedReports = assessed.filter((record) => current.get(record.id)!.ft!.decision === 'exclude');
      const byReason = new Map<string | null, number>();
      for (const record of excludedReports) {
        const code = current.get(record.id)!.ft!.exclusionReasonCode;
        byReason.set(code, (byReason.get(code) ?? 0) + 1);
      }
      const included = assessed.filter((record) => current.get(record.id)!.ft!.decision === 'include');
      const studies = new Set(included.map((record) => record.studyGroupKey ?? record.id)).size;
      return { excludedAtScreening, sought: sought.length, notRetrieved, assessed: assessed.length, excludedReports: excludedReports.length, byReason, included: included.length, studies };
    };
    const m = flow(main);
    const o = flow(other);
    cell('records_screened', main.length);
    cell('records_excluded', m.excludedAtScreening);
    cell('reports_sought', m.sought);
    cell('reports_not_retrieved', m.notRetrieved);
    cell('reports_assessed', m.assessed);
    cell('reports_excluded', m.excludedReports);
    const order = this.reasons(reviewId).map((reason) => reason.code);
    const reasonRank = (code: string | null) => (code === null ? Number.MAX_SAFE_INTEGER : order.indexOf(code));
    for (const [code, count] of [...m.byReason].sort((a, b) => reasonRank(a[0]) - reasonRank(b[0]))) cell('reports_excluded', count, { exclusionReasonCode: code ?? 'unspecified' });
    // Studies and reports included combine both columns, as the PRISMA 2020 diagram does.
    const allIncluded = unique.filter((record) => current.get(record.id)?.ft?.decision === 'include');
    cell('studies_included', new Set(allIncluded.map((record) => record.studyGroupKey ?? record.id)).size);
    cell('reports_of_included_studies', allIncluded.length);
    return {
      cells,
      other: {
        identified: otherIdentified,
        sought: o.sought,
        notRetrieved: o.notRetrieved,
        assessed: o.assessed,
        excluded: [...o.byReason].map(([code, count]) => ({ code, count })),
        included: o.included,
      },
    };
  }

  /** Freeze the live numbers (PC1: a snapshot is never recomputed). */
  freezePrisma(reviewId: string, label: string | null, actor: Actor): { snapshotAt: string; cells: PrismaCell[] } {
    const { cells } = this.prisma(reviewId);
    const snapshotAt = nowTimestamp();
    this.db.transaction((tx) => {
      for (const cell of cells) {
        tx.insert(prismaCounts)
          .values({
            id: newId(),
            reviewId,
            snapshotAt,
            snapshotLabel: label,
            stageKey: cell.stageKey,
            sourceLabel: cell.sourceLabel,
            sourceScopeKey: cell.sourceLabel ?? '',
            searchRunId: cell.searchRunId,
            exclusionReasonCode: cell.exclusionReasonCode,
            reasonScopeKey: cell.exclusionReasonCode ?? '',
            countValue: cell.count,
            computedBy: 'frozen',
            createdAt: snapshotAt,
          })
          .run();
      }
      this.audit.record({ actor, action: 'prisma.frozen', entityType: 'review', entityId: reviewId, after: { snapshotAt, label, cells: cells.length } }, tx);
    });
    return { snapshotAt, cells };
  }

  snapshots(reviewId: string): { snapshotAt: string; label: string | null }[] {
    const rows = this.db.select({ snapshotAt: prismaCounts.snapshotAt, label: prismaCounts.snapshotLabel }).from(prismaCounts).where(eq(prismaCounts.reviewId, reviewId)).orderBy(asc(prismaCounts.snapshotAt)).all();
    const seen = new Map<string, string | null>();
    for (const row of rows) if (!seen.has(row.snapshotAt)) seen.set(row.snapshotAt, row.label);
    return [...seen].map(([snapshotAt, label]) => ({ snapshotAt, label }));
  }

  snapshot(reviewId: string, snapshotAt: string): PrismaCell[] {
    const rows = this.db.select().from(prismaCounts).where(and(eq(prismaCounts.reviewId, reviewId), eq(prismaCounts.snapshotAt, snapshotAt))).all();
    if (rows.length === 0) throw new NotFoundError('prisma_snapshot', snapshotAt);
    return rows.map((row) => ({ stageKey: row.stageKey, count: row.countValue, sourceLabel: row.sourceLabel, searchRunId: row.searchRunId, exclusionReasonCode: row.exclusionReasonCode }));
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Internals                                                                                   */
  /* ---------------------------------------------------------------------------------------- */

  private matchItem(bibliographic: BibliographicInput | undefined): string | undefined {
    const live = (condition: ReturnType<typeof eq>) =>
      this.db
        .select({ id: items.id })
        .from(itemBibliographic)
        .innerJoin(items, eq(items.id, itemBibliographic.itemId))
        .where(and(condition, isNull(items.trashedAt)))
        .get()?.id;
    const doi = typeof bibliographic?.doi === 'string' && bibliographic.doi.trim() !== '' ? normaliseDoi(bibliographic.doi) : null;
    if (doi !== null) {
      const hit = live(eq(itemBibliographic.doi, doi));
      if (hit !== undefined) return hit;
    }
    const pmid = typeof bibliographic?.pmid === 'string' && bibliographic.pmid.trim() !== '' ? bibliographic.pmid.trim() : null;
    if (pmid !== null) return live(eq(itemBibliographic.pmid, pmid));
    return undefined;
  }

  private writeCreators(itemId: string, creators: NonNullable<ImportedRecordInput['creators']>, actor: Actor): void {
    const entries: { creatorId: string; role: 'author'; rawName: string | null }[] = [];
    const seen = new Set<string>();
    for (const creator of creators) {
      const family = creator.familyName?.trim() || null;
      const literal = creator.literalName?.trim() || null;
      if (family === null && literal === null) continue;
      const given = creator.givenName?.trim() || null;
      const sortName = normalise(literal !== null && family === null ? literal : given === null ? family! : `${family}, ${given}`);
      const existing = this.creators
        .findBySortName(sortName)
        .find((candidate) => (candidate.familyName ?? null) === family && (candidate.givenName ?? null) === given && (candidate.literalName ?? null) === literal);
      const creatorId =
        existing?.id ??
        this.creators.create({ kind: creator.kind ?? (literal !== null && family === null ? 'organisation' : 'person'), familyName: family, givenName: given, literalName: literal }, actor).id;
      if (seen.has(creatorId)) continue;
      seen.add(creatorId);
      entries.push({ creatorId, role: 'author', rawName: literal ?? [given, family].filter((part) => part !== null).join(' ') });
    }
    if (entries.length > 0) this.creators.setItemCreators(itemId, entries, actor);
  }
}

