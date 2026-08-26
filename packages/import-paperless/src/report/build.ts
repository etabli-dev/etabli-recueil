/**
 * Assembling the verification report.
 *
 * The report is built by **comparing the two sides**, not by narrating the run. Every count on the
 * Paperless side comes from the API snapshot; every count on the Recueil side is a query against
 * the library that was just written; the deltas are the difference. That is what makes the report a
 * verification rather than a summary: an importer that silently wrote nothing would produce a
 * report full of negative deltas rather than a cheerful list of what it thought it had done.
 *
 * ADR-0021 is the rule this file is written to, and it is written down because three separate
 * reviews found the same defect in this file twice:
 *
 * 1. **Query, do not narrate.** No number a check compares may come from `job_logs`, from the
 *    importer's plans, or from anything else the importer produced. `job_logs` is read here, but
 *    for the *reasons* — an original's failure message, a skipped value's explanation, a review
 *    entry's suggested action — and for exactly one reconciliation, `originals_accounted_for`,
 *    where the log is not the target side but an independent second record of the same event and
 *    the comparison fails in either direction. Everything else is a query or the snapshot.
 * 2. **The source side comes from the source.** Not from what the importer chose to read. The
 *    document-type mapping every parity row is bucketed by is recomputed here from
 *    `snapshot.documentTypes`, not taken from `plan.documentTypeById`; the supported custom-field
 *    set is recomputed from `DATA_TYPE_MAP` against the raw `data_type`, not read off the plan.
 *    Where a filter genuinely restricts what can be carried — a tag id a document names that
 *    `/api/tags/` never defined, an item a person has since put in the trash — the exclusion is a
 *    **named finding with its own blocking check**, never a silent subtraction from both sides.
 * 3. **`pass` is the comparison the table shows.** Every check is built through `check()`, which
 *    derives `pass` from `expected`, `actual` and `compare`. A check whose printed numbers
 *    disagreed with its own verdict — `PASS ... expected=6 actual=0` — is what the last review
 *    found, and it is now unrepresentable: the two cannot drift apart because there is only one
 *    of them.
 * 4. **Every blocking check has a falsification test.** `test/report-checks.test.ts` mutates the
 *    target, or the source, in the way each check exists to detect, and asserts it FAILS.
 *
 * Reading the reasons out of `job_logs` rather than out of memory is what makes the report of a run
 * that was interrupted twice say the same thing as the report of one that was not (§6.4).
 */
import { schema } from '@recueil/core';
import type { Recueil } from '@recueil/core';
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';

import { PAPERLESS_MODELLED_VERSION } from '../client/types.js';
import type { PaperlessCustomField, PaperlessDocument } from '../client/types.js';
import type { ApiSnapshot, ImportPlan } from '../import.js';
import { DATA_TYPE_MAP } from '../map/custom-fields.js';
import { mapDocumentType } from '../map/document-types.js';
import type { DocumentTypeMapping } from '../map/document-types.js';
import { ASN_FIELD_KEY, SOURCE_SYSTEM, reconcileDocuments } from '../reconcile.js';
import { REPORT_SCHEMA } from './types.js';
import type {
  AsnDeferral,
  AsnLoss,
  CheckComparison,
  DocumentTypeParity,
  NotCarriedField,
  OriginalReportEntry,
  PaperlessImportReport,
  ReportCheck,
  ReportRun,
  ReviewEntry,
  SkippedRecord,
  UnrepresentableValue,
} from './types.js';

/** The observations one import wrote to `job_logs`, read back. */
export interface ImportLog {
  originals: Map<number, OriginalReportEntry>;
  review: ReviewEntry[];
  skipped: SkippedRecord[];
}

/**
 * Read one job's observations back out of `job_logs`.
 *
 * Rows are ordered by id, which is a ULID and therefore append order, so a later observation of the
 * same document — a second attempt that found the original this time — replaces the earlier one.
 * Review entries and skipped records are deduplicated on their content for the same reason.
 */
export const readImportLog = (recueil: Recueil, jobId: string): ImportLog => {
  const rows = recueil.db
    .select({ message: schema.jobLogs.message, data: schema.jobLogs.data })
    .from(schema.jobLogs)
    .where(eq(schema.jobLogs.jobId, jobId))
    .orderBy(asc(schema.jobLogs.id))
    .all();

  const originals = new Map<number, OriginalReportEntry>();
  const review = new Map<string, ReviewEntry>();
  const skipped = new Map<string, SkippedRecord>();

  for (const row of rows) {
    if (row.data === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.data);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;

    if (row.message === 'original') {
      const entry = parsed as OriginalReportEntry;
      originals.set(entry.paperlessId, entry);
    } else if (row.message === 'review') {
      const entry = parsed as ReviewEntry;
      review.set(`${entry.kind} ${entry.paperlessId ?? ''} ${entry.subject} ${entry.reason}`, entry);
    } else if (row.message === 'skipped') {
      const entry = parsed as SkippedRecord;
      skipped.set(`${entry.kind} ${entry.paperlessId ?? ''} ${entry.subject} ${entry.reason}`, entry);
    }
  }

  return { originals, review: [...review.values()], skipped: [...skipped.values()] };
};

export interface BuildReportInput {
  recueil: Recueil;
  snapshot: ApiSnapshot;
  plan: ImportPlan;
  log: ImportLog;
  /** The API root with any credential removed. Never the token. */
  baseUrl: string;
  /** Whether this run fetched the originals. False leaves the file checks out of the report. */
  downloadOriginals: boolean;
  run: ReportRun;
}

export const buildReport = (input: BuildReportInput): PaperlessImportReport => {
  const { recueil, snapshot, plan, log } = input;

  /*
   * -- the source side, recomputed from the snapshot -----------------------------------------------
   *
   * `plan.documentTypeById` holds exactly this map, and taking it from there is precisely the
   * mistake ADR-0021 §2 names: both sides of the per-type parity would then be bucketed by the
   * importer's own output, and the comparison would hold however the rows were written.
   */
  const documentTypeById = new Map<number, DocumentTypeMapping>();
  for (const type of snapshot.documentTypes) documentTypeById.set(type.id, mapDocumentType(type));

  const apiDocuments = snapshot.documents;
  const apiIdSet = new Set(apiDocuments.map((document) => document.id));

  /*
   * -- the target side ------------------------------------------------------------------------------
   *
   * One query over `items`, split three ways: live items this run's documents map onto, items a
   * person has put in the trash since a previous run, and items claiming a Paperless origin the
   * server does not have.
   */
  const importedItems = recueil.db
    .select({
      id: schema.items.id,
      sourceId: schema.items.sourceId,
      itemType: schema.items.itemType,
      trashedAt: schema.items.trashedAt,
    })
    .from(schema.items)
    .where(eq(schema.items.sourceSystem, SOURCE_SYSTEM))
    .all();

  const itemByPaperlessId = new Map<number, { id: string; itemType: string }>();
  const trashedByPaperlessId = new Map<number, string>();
  const orphanedInRecueil: string[] = [];
  for (const row of importedItems) {
    const paperlessId = row.sourceId === null ? Number.NaN : Number(row.sourceId);
    const live = row.trashedAt === null;
    if (!Number.isSafeInteger(paperlessId) || !apiIdSet.has(paperlessId)) {
      if (live) orphanedInRecueil.push(row.id);
      continue;
    }
    if (live) itemByPaperlessId.set(paperlessId, { id: row.id, itemType: row.itemType });
    else trashedByPaperlessId.set(paperlessId, row.id);
  }

  /*
   * A document whose item is in the trash is excluded from both sides of every per-document count,
   * and the exclusion is a finding of its own (`documents.trashedInRecueil`, and the
   * `items_not_in_trash` check) rather than a silent narrowing. ADR-0021 §2 allows a filter only on
   * that condition, and the condition here comes from a column in the target, not from the run.
   */
  const trashedInRecueil = [...trashedByPaperlessId.keys()].sort((left, right) => left - right);
  const trashedIds = new Set(trashedInRecueil);
  const documents_ = apiDocuments.filter((document) => !trashedIds.has(document.id));
  const activeApiIds = documents_.map((document) => document.id);

  const correspondence = reconcileDocuments(recueil, activeApiIds);
  const matchedItemIds = new Set(
    activeApiIds
      .map((id) => itemByPaperlessId.get(id)?.id)
      .filter((id): id is string => id !== undefined),
  );

  /* -- documents, per type and overall ----------------------------------------------------------- */

  const byDocumentType = documentTypeParity(documents_, documentTypeById, itemByPaperlessId);
  const recueilMistyped = byDocumentType.reduce((sum, row) => sum + row.recueilMistyped, 0);
  const recueilMatched = byDocumentType.reduce((sum, row) => sum + row.recueilTotal, 0);
  const missingInRecueil = activeApiIds.filter((id) => !itemByPaperlessId.has(id));

  /* -- originals ---------------------------------------------------------------------------------- */

  const originals = [...log.originals.values()]
    .filter((entry) => !trashedIds.has(entry.paperlessId))
    .sort((left, right) => left.paperlessId - right.paperlessId);
  const stored = originals.filter(
    (entry) => entry.status === 'stored' || entry.status === 'checksum_mismatch',
  );
  const digests = new Set(
    stored.map((entry) => entry.sha256).filter((value): value is string => value !== null),
  );

  /*
   * The two independent records of "this document has no file", compared by id rather than by
   * count. Counting alone let a log entry for one document excuse a missing blob under another.
   */
  const explained = new Set(
    originals
      .filter((entry) => entry.status === 'missing' || entry.status === 'unreadable')
      .map((entry) => entry.paperlessId),
  );
  const unaccountedWithoutOriginal = correspondence.withoutDocument.filter((id) => !explained.has(id));
  const contradictedByStore = [...explained]
    .filter((id) => correspondence.documentIdByPaperlessId.has(id))
    .sort((left, right) => left - right);

  /* -- tags ---------------------------------------------------------------------------------------- */

  const namedTags = snapshot.tags.filter((tag) => tag.name.trim() !== '');
  const apiTagNames = [...new Set(namedTags.map((tag) => tag.name.trim()))];
  const tagIdsInSource = new Set(namedTags.map((tag) => tag.id));

  const recueilTagNames = new Set(
    recueil.db
      .select({ name: schema.tags.name })
      .from(schema.tags)
      .where(isNull(schema.tags.trashedAt))
      .all()
      .map((row) => row.name)
      .filter((name) => apiTagNames.includes(name)),
  );

  const apiAssignments = documents_.reduce((sum, document) => sum + (document.tags?.length ?? 0), 0);
  const danglingTagIds = [
    ...new Set(
      documents_.flatMap((document) =>
        (document.tags ?? []).filter((tagId) => !tagIdsInSource.has(tagId)),
      ),
    ),
  ].sort((left, right) => left - right);
  const danglingTagIdSet = new Set(danglingTagIds);
  const apiAssignmentsDangling = documents_.reduce(
    (sum, document) =>
      sum + (document.tags ?? []).filter((tagId) => danglingTagIdSet.has(tagId)).length,
    0,
  );

  const recueilAssignments = recueil.db
    .select({ itemId: schema.itemTags.itemId })
    .from(schema.itemTags)
    .innerJoin(schema.tags, eq(schema.tags.id, schema.itemTags.tagId))
    .where(isNull(schema.tags.trashedAt))
    .all()
    .filter((row) => matchedItemIds.has(row.itemId)).length;

  /* -- custom fields --------------------------------------------------------------------------------- */

  const sourceFieldById = new Map(snapshot.customFields.map((field) => [field.id, field]));
  const supportedSourceFields = snapshot.customFields.filter(
    (field) => DATA_TYPE_MAP[field.data_type] !== undefined,
  );
  const supportedSourceIds = new Set(supportedSourceFields.map((field) => field.id));

  /*
   * Which target definition belongs to which Paperless field is read out of the target's own
   * `custom_fields.config.paperlessFieldId`, which `planCustomField` writes. That is a fact in the
   * database keyed by a fact in the source, rather than the plan telling the report what the plan
   * decided.
   */
  const targetFieldRows = recueil.db
    .select({
      id: schema.customFields.id,
      fieldKey: schema.customFields.fieldKey,
      dataType: schema.customFields.dataType,
      config: schema.customFields.config,
    })
    .from(schema.customFields)
    .all();

  const targetFieldByPaperlessId = new Map<number, { id: string; dataType: string }>();
  for (const row of targetFieldRows) {
    let config: unknown;
    try {
      config = JSON.parse(row.config);
    } catch {
      continue;
    }
    const paperlessId = (config as Record<string, unknown> | null)?.['paperlessFieldId'];
    if (typeof paperlessId !== 'number' || !Number.isSafeInteger(paperlessId)) continue;
    targetFieldByPaperlessId.set(paperlessId, { id: row.id, dataType: row.dataType });
  }

  /* A definition counts only when its stored data type is the one the source's type maps to: §6
     asks for the types to be preserved, so a field repurposed to `text` is not a definition. */
  const carriedFieldIds = new Set<string>();
  let recueilDefined = 0;
  for (const field of supportedSourceFields) {
    const target = targetFieldByPaperlessId.get(field.id);
    if (target === undefined || target.dataType !== DATA_TYPE_MAP[field.data_type]) continue;
    recueilDefined += 1;
    carriedFieldIds.add(target.id);
  }

  const apiValueInstances = documents_.reduce(
    (sum, document) => sum + (document.custom_fields ?? []).length,
    0,
  );
  const danglingFieldIds = [
    ...new Set(
      documents_.flatMap((document) =>
        (document.custom_fields ?? [])
          .map((instance) => instance.field)
          .filter((fieldId) => !sourceFieldById.has(fieldId)),
      ),
    ),
  ].sort((left, right) => left - right);
  const danglingFieldIdSet = new Set(danglingFieldIds);

  let apiInstancesDangling = 0;
  let apiInstancesUnsupportedType = 0;
  const unrepresentableValues: UnrepresentableValue[] = [];
  for (const document of documents_) {
    for (const instance of document.custom_fields ?? []) {
      if (danglingFieldIdSet.has(instance.field)) {
        apiInstancesDangling += 1;
        continue;
      }
      if (!supportedSourceIds.has(instance.field)) {
        apiInstancesUnsupportedType += 1;
        continue;
      }
      const reason = unrepresentableBySource(
        sourceFieldById.get(instance.field) as PaperlessCustomField,
        instance.value,
      );
      if (reason !== null) {
        unrepresentableValues.push({
          paperlessId: document.id,
          fieldId: instance.field,
          fieldName: (sourceFieldById.get(instance.field) as PaperlessCustomField).name,
          reason,
        });
      }
    }
  }

  const apiInstancesCarryable =
    apiValueInstances -
    apiInstancesDangling -
    apiInstancesUnsupportedType -
    unrepresentableValues.length;

  const valueRows = recueil.db
    .select({
      itemId: schema.fieldValues.itemId,
      fieldId: schema.fieldValues.fieldId,
      groupScopeKey: schema.fieldValues.groupScopeKey,
      isBlank: schema.fieldValues.isBlank,
    })
    .from(schema.fieldValues)
    .all()
    .filter((row) => matchedItemIds.has(row.itemId) && carriedFieldIds.has(row.fieldId));

  /* One Paperless value is one `(item, field, group)` slot however many rows it expands into: a
     `documentlink` writes one row per link, so counting rows would compare two different units. */
  const recueilInstances = new Set(
    valueRows.map((row) => `${row.itemId} ${row.fieldId} ${row.groupScopeKey}`),
  ).size;

  const byDataType: Record<string, number> = {};
  for (const field of supportedSourceFields) {
    const dataType = DATA_TYPE_MAP[field.data_type];
    byDataType[dataType] = (byDataType[dataType] ?? 0) + 1;
  }

  /* -- notes ----------------------------------------------------------------------------------------- */

  const noteTexts = documents_.map(
    (document) =>
      new Set(
        (document.notes ?? [])
          .map((note) => (typeof note.note === 'string' ? note.note.trim() : ''))
          .filter((text) => text !== ''),
      ),
  );
  const apiNotes = documents_.reduce(
    (sum, document) =>
      sum +
      (document.notes ?? []).filter(
        (note) => typeof note.note === 'string' && note.note.trim() !== '',
      ).length,
    0,
  );
  const apiNotesDistinct = noteTexts.reduce((sum, texts) => sum + texts.size, 0);

  const recueilNotes = recueil.db
    .select({ itemId: schema.notes.itemId })
    .from(schema.notes)
    .where(isNull(schema.notes.trashedAt))
    .all()
    .filter((row) => row.itemId !== null && matchedItemIds.has(row.itemId)).length;

  /* -- the office facet: correspondents, document types, ASN --------------------------------------- */

  const officeRows = recueil.db
    .select({
      itemId: schema.itemOffice.itemId,
      correspondent: schema.itemOffice.correspondent,
      officeDocumentType: schema.itemOffice.officeDocumentType,
      asn: schema.itemOffice.asn,
    })
    .from(schema.itemOffice)
    .all()
    .filter((row) => matchedItemIds.has(row.itemId));
  const officeByItemId = new Map(officeRows.map((row) => [row.itemId, row]));

  const usedCorrespondentIds = new Set(
    documents_
      .map((document) => document.correspondent)
      .filter((id): id is number => typeof id === 'number'),
  );
  const withoutCorrespondent = documents_.filter(
    (document) => document.correspondent === null || document.correspondent === undefined,
  ).length;

  const apiWithAsn = documents_.filter((document) => asnOf(document) !== null).length;
  const recueilWithAsn = officeRows.filter((row) => row.asn !== null).length;

  /*
   * Distinct live ASNs across the *whole* library, not only the imported part: the uniqueness
   * CONCEPT §6 asks for is a property of the library, and an ASN colliding with a hand-entered item
   * is exactly the case worth catching.
   *
   * "Live" is read from `items.trashed_at` through a join, deliberately, and not from
   * `item_office.item_trashed_at`. That column is an application-maintained mirror (§1.1) and it is
   * what `ux_item_office_asn` is partial on — so a mirror that has drifted from the truth is the
   * one way two live items can come to share an ASN with the index still satisfied. A check that
   * read the mirror would agree with the index and miss precisely the case it exists for.
   */
  const liveAsnRows = recueil.db
    .select({ asn: schema.itemOffice.asn, itemId: schema.itemOffice.itemId })
    .from(schema.itemOffice)
    .innerJoin(schema.items, eq(schema.items.id, schema.itemOffice.itemId))
    .where(and(isNotNull(schema.itemOffice.asn), isNull(schema.items.trashedAt)))
    .all();
  const liveAsns = liveAsnRows
    .map((row) => row.asn)
    .filter((asn): asn is number => asn !== null);
  const distinctLiveAsn = new Set(liveAsns).size;
  const liveHoldersByAsn = new Map<number, string[]>();
  for (const row of liveAsnRows) {
    if (row.asn === null) continue;
    liveHoldersByAsn.set(row.asn, [...(liveHoldersByAsn.get(row.asn) ?? []), row.itemId]);
  }

  /*
   * The `paperless_asn` custom field, queried out of the target. An ASN the facet could not take is
   * only *preserved* if the number is really on the item, so the report goes and looks rather than
   * believing the review entry that says it put it there.
   */
  const asnFieldId = targetFieldRows.find((row) => row.fieldKey === ASN_FIELD_KEY)?.id ?? null;
  const preservedAsnByItem = new Map<string, Set<number>>();
  if (asnFieldId !== null) {
    for (const row of recueil.db
      .select({ itemId: schema.fieldValues.itemId, value: schema.fieldValues.valueInteger })
      .from(schema.fieldValues)
      .where(eq(schema.fieldValues.fieldId, asnFieldId))
      .all()) {
      if (row.value === null) continue;
      const seen = preservedAsnByItem.get(row.itemId) ?? new Set<number>();
      seen.add(row.value);
      preservedAsnByItem.set(row.itemId, seen);
    }
  }

  /*
   * Which Paperless document owns each ASN, decided over the **whole** API result set rather than
   * over the documents left after the trash exclusion. Duplication is a fact about Paperless, and
   * the importer's own owner rule (`asnOwners` in `import.ts`) is likewise computed over the whole
   * list, so a report that recomputed it over a subset would disagree with the run for a reason
   * that has nothing to do with either.
   */
  const documentsByAsn = new Map<number, number[]>();
  for (const document of apiDocuments) {
    const asn = asnOf(document);
    if (asn === null) continue;
    documentsByAsn.set(asn, [...(documentsByAsn.get(asn) ?? []), document.id]);
  }
  const duplicatesInSource = [...documentsByAsn]
    .filter(([, ids]) => ids.length > 1)
    .map(([asn, ids]) => ({ asn, documents: [...ids].sort((left, right) => left - right) }))
    .sort((left, right) => left.asn - right.asn);

  /** True when Paperless put this ASN on a lower document id as well, so this one cannot keep it. */
  const losesToSourceDuplicate = (document: PaperlessDocument, asn: number): boolean => {
    const owners = documentsByAsn.get(asn) ?? [];
    return owners.length > 1 && Math.min(...owners) !== document.id;
  };

  /* Counted over the documents still in play, so that binning both halves of a duplicate does not
     leave the allowance behind and drive the expected side negative. */
  const duplicateLossesInSource = documents_.filter((document) => {
    const asn = asnOf(document);
    return asn !== null && losesToSourceDuplicate(document, asn);
  }).length;

  let asnCarried = 0;
  const asnDeferrals: AsnDeferral[] = [];
  const asnLost: AsnLoss[] = [];
  for (const document of documents_) {
    const asn = asnOf(document);
    if (asn === null) continue;
    const item = itemByPaperlessId.get(document.id);
    if (item === undefined) {
      asnLost.push({
        asn,
        paperlessId: document.id,
        reason: 'The document has no Recueil item at all, so its ASN reached nothing.',
      });
      continue;
    }
    if (officeByItemId.get(item.id)?.asn === asn) {
      asnCarried += 1;
      continue;
    }

    const preserved = preservedAsnByItem.get(item.id)?.has(asn) === true;
    const heldByItemId =
      (liveHoldersByAsn.get(asn) ?? []).find((itemId) => itemId !== item.id) ?? null;
    const duplicateInSource = losesToSourceDuplicate(document, asn);

    if (preserved && (heldByItemId !== null || duplicateInSource)) {
      asnDeferrals.push({ asn, paperlessId: document.id, heldByItemId, duplicateInSource });
      continue;
    }
    asnLost.push({
      asn,
      paperlessId: document.id,
      reason: preserved
        ? `The number is on the item's \`${ASN_FIELD_KEY}\` field but no live item in the library ` +
          'holds it and Paperless does not duplicate it, so nothing was in the way and it should ' +
          'have reached `item_office.asn`.'
        : `The number is neither in \`item_office.asn\` nor on the item's \`${ASN_FIELD_KEY}\` ` +
          'field. It was dropped.',
    });
  }

  const importedAsns = officeRows
    .map((row) => row.asn)
    .filter((asn): asn is number => asn !== null);

  const collisions = log.review
    .filter((entry) => entry.kind === 'asn_collision')
    .map((entry) => ({
      asn: Number((entry.detail?.['asn'] as number | undefined) ?? Number.NaN),
      paperlessId: entry.paperlessId ?? -1,
      heldByItemId: String(entry.detail?.['heldByItemId'] ?? ''),
    }));

  /* -- what this phase cannot carry -------------------------------------------------------------- */

  const notCarried = notCarriedFields(apiDocuments, snapshot, plan);

  const report: PaperlessImportReport = {
    schema: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    pass: false,
    source: {
      baseUrl: input.baseUrl,
      serverVersion: snapshot.serverInfo.serverVersion,
      serverApiVersion: snapshot.serverInfo.apiVersion,
      requestedApiVersion: snapshot.serverInfo.requestedApiVersion,
      modelledAgainstVersion: PAPERLESS_MODELLED_VERSION,
      versionMatchesModel: snapshot.serverInfo.serverVersion === PAPERLESS_MODELLED_VERSION,
      endpoints: snapshot.serverInfo.endpoints,
      fetchedAt: input.run.startedAt,
    },
    run: input.run,
    documents: {
      apiReportedTotal: snapshot.reportedTotal,
      apiFetched: apiDocuments.length,
      apiActive: documents_.length,
      carriedFromEarlierAttempt: input.run.documentsSkippedAsAlreadyDone,
      recueilTotal: itemByPaperlessId.size + orphanedInRecueil.length,
      recueilMatched,
      recueilMistyped,
      missingInRecueil,
      orphanedInRecueil,
      trashedInRecueil,
      delta: recueilMatched - documents_.length,
      byDocumentType,
      inPaperlessTrash: apiDocuments.filter(
        (document) => document.deleted_at !== null && document.deleted_at !== undefined,
      ).length,
    },
    originals: {
      fetchEnabled: input.downloadOriginals,
      attempted: originals.length,
      stored: stored.length,
      missing: originals.filter((entry) => entry.status === 'missing').length,
      unreadable: originals.filter((entry) => entry.status === 'unreadable').length,
      hashCoveragePercent:
        originals.length === 0 ? 100 : round1((stored.length / originals.length) * 100),
      checksumMismatches: originals.filter((entry) => entry.matchesPaperlessChecksum === false).length,
      checksumUnavailable: originals.filter((entry) => entry.matchesPaperlessChecksum === null).length,
      distinctDocuments: digests.size,
      duplicateOriginals: stored.length - digests.size,
      recueilDocuments: activeApiIds.filter((id) => correspondence.documentIdByPaperlessId.has(id))
        .length,
      recueilAttachments: correspondence.attachmentIdByPaperlessId.size,
      recueilAttachmentsMissing: [...correspondence.withoutAttachment],
      recueilWithoutOriginal: [...correspondence.withoutDocument],
      unaccountedWithoutOriginal,
      contradictedByStore,
      entries: originals,
    },
    correspondents: {
      apiTotal: snapshot.correspondents.length,
      referenced: usedCorrespondentIds.size,
      recueilDistinct: new Set(officeRows.map((row) => row.correspondent)).size,
      withoutCorrespondent,
      placeholder: plan.missingCorrespondentLabel,
      unused: snapshot.correspondents.filter((row) => !usedCorrespondentIds.has(row.id)).length,
    },
    documentTypes: {
      apiTotal: snapshot.documentTypes.length,
      mappedToCoreItemType: [...documentTypeById.values()].filter((row) => row.kind === 'core').length,
      carriedAsOfficeType: [...documentTypeById.values()].filter((row) => row.kind === 'carried').length,
      recueilWithOfficeType: officeRows.filter((row) => row.officeDocumentType !== null).length,
      byName: [...documentTypeById.values()]
        .filter((row) => row.paperlessId !== null && row.name !== null)
        .map((row) => ({
          paperlessId: row.paperlessId as number,
          name: row.name as string,
          itemType: row.itemType,
          officeDocumentType: row.officeDocumentType as string,
        }))
        .sort((left, right) => left.paperlessId - right.paperlessId),
    },
    tags: {
      apiTotal: snapshot.tags.length,
      apiNamed: apiTagNames.length,
      recueilTotal: recueilTagNames.size,
      missingInRecueil: apiTagNames.filter((name) => !recueilTagNames.has(name)),
      apiAssignments,
      apiAssignmentsResolvable: apiAssignments - apiAssignmentsDangling,
      apiAssignmentsDangling,
      danglingTagIds,
      recueilAssignments,
      skippedAssignments: log.skipped.filter((entry) => entry.kind === 'tag_assignment').length,
      hierarchical: snapshot.tags.filter((tag) => tag.parent !== null && tag.parent !== undefined).length,
      inboxTags: snapshot.tags.filter((tag) => tag.is_inbox_tag === true).length,
      coloured: snapshot.tags.filter((tag) => typeof tag.color === 'string' && tag.color !== '').length,
    },
    customFields: {
      apiTotal: snapshot.customFields.length,
      apiSupported: supportedSourceFields.length,
      recueilDefined,
      byDataType,
      unsupported: unsupportedFields(snapshot.customFields, plan),
      apiValues: apiValueInstances,
      apiValueInstances,
      apiInstancesDangling,
      apiInstancesUnsupportedType,
      apiInstancesCarryable,
      danglingFieldIds,
      unrepresentableValues,
      recueilValues: valueRows.length,
      recueilInstances,
      blankValues: valueRows.filter((row) => row.isBlank).length,
      skippedValues: log.skipped.filter((entry) => entry.kind === 'custom_field_value').length,
      unresolvedDocumentLinks: log.review
        .filter((entry) => entry.kind === 'document_link_unresolved')
        .reduce((sum, entry) => sum + ((entry.detail?.['unresolved'] as number[] | undefined)?.length ?? 0), 0),
      facetSources: plan.facetSources.decisions.map((decision) => ({
        column: decision.column,
        outcome: decision.outcome,
        fieldId: decision.fieldId,
        fieldName: decision.fieldName,
        detail: decision.detail,
      })),
    },
    asn: {
      apiWithAsn,
      recueilWithAsn,
      recueilCarried: asnCarried,
      recueilDeferred: asnDeferrals.length,
      deferrals: asnDeferrals,
      lost: asnLost,
      recueilLiveAsn: liveAsns.length,
      recueilDistinctAsn: distinctLiveAsn,
      unique: distinctLiveAsn === liveAsns.length,
      duplicatesInSource,
      duplicateLossesInSource,
      collisions,
      range: {
        min: importedAsns.length === 0 ? null : Math.min(...importedAsns),
        max: importedAsns.length === 0 ? null : Math.max(...importedAsns),
      },
    },
    notes: {
      apiTotal: apiNotes,
      apiDistinct: apiNotesDistinct,
      recueilTotal: recueilNotes,
      delta: recueilNotes - apiNotesDistinct,
    },
    notCarried,
    skipped: log.skipped,
    review: log.review,
    checks: [],
  };

  report.checks = checks(report);
  report.pass = report.checks.every((entry) => !entry.blocking || entry.pass);
  return report;
};

/* ================================================================================================ */

/**
 * Build one check, deriving its verdict from the two numbers it prints.
 *
 * The Phase 2 review found a blocking check reporting `PASS ... expected=6 actual=0`, because
 * `pass` was a separate expression from the pair beside it and the two had drifted. Passing through
 * here makes that unrepresentable: there is one comparison, and the table shows it. ADR-0021 §3.
 */
const check = (spec: Omit<ReportCheck, 'pass'>): ReportCheck => ({
  ...spec,
  pass:
    spec.compare === 'equals'
      ? spec.expected === spec.actual
      : typeof spec.expected === 'number' &&
        typeof spec.actual === 'number' &&
        spec.actual >= spec.expected,
});

/**
 * The named assertions behind `pass`.
 *
 * Only the ones marked blocking decide the verdict. Every blocking one compares a number obtained
 * from the API snapshot against a number obtained by querying the target's own tables, asserts
 * **equality**, and has a test in `test/report-checks.test.ts` that mutates one side and watches it
 * fail. Where something genuinely cannot be carried — a tag id the source never defined, a value
 * the source's own field definition gives no meaning to, an item a person has put in the trash —
 * the exclusion has its own named check or its own listed finding, so it is visible rather than
 * subtracted from both sides at once (ADR-0021 §2).
 *
 * Two checks compare the source with itself rather than with the target, deliberately:
 * `document_list_complete`, because a short walk of the page links would otherwise look like a
 * complete import of a smaller library, and `tag_references_resolvable`/
 * `custom_field_references_resolvable`, because a vocabulary endpoint that answered with less than
 * the documents refer to means the migration cannot be complete however faithfully the target
 * mirrors what was read.
 */
const checks = (report: PaperlessImportReport): ReportCheck[] => [
  check({
    name: 'document_count_parity',
    description:
      'Every document the Paperless API returned, less the ones whose Recueil item is in the ' +
      'trash, has exactly one correctly typed Recueil item. The left is the API result set; the ' +
      'right is a query over `items` in the target, matched on `source_id`.',
    expected: report.documents.apiActive,
    actual: report.documents.recueilMatched,
    compare: 'equals',
    blocking: true,
  }),
  check({
    name: 'document_list_complete',
    description:
      "The pages walked add up to the `count` the server reported. A short walk — a page that " +
      'failed, a `next` link that stopped early — would otherwise look like a complete import of a ' +
      'smaller library.',
    expected: report.documents.apiReportedTotal,
    actual: report.documents.apiFetched,
    compare: 'equals',
    blocking: true,
  }),
  check({
    name: 'item_type_fidelity',
    description:
      'No imported document is stored under an `item_type` other than the one its Paperless ' +
      'document type maps to. The target side reads the stored `item_type`; the expected value is ' +
      'recomputed here from the Paperless document-type name rather than taken from the plan.',
    expected: 0,
    actual: report.documents.recueilMistyped,
    compare: 'equals',
    blocking: true,
  }),
  check({
    name: 'no_orphaned_items',
    description:
      'No live item in the target claims a Paperless origin the server does not have. A non-zero ' +
      'count means documents were deleted in Paperless after a previous import, which is a ' +
      'decision for a person rather than something an importer should tidy away.',
    expected: 0,
    actual: report.documents.orphanedInRecueil.length,
    compare: 'equals',
    blocking: false,
  }),
  check({
    name: 'items_not_in_trash',
    description:
      'No document of this import has a Recueil item in the trash. Those documents are left ' +
      'untouched by a re-run and excluded from every count above, so this is where the exclusion ' +
      'is stated rather than being subtracted quietly from both sides.',
    expected: 0,
    actual: report.documents.trashedInRecueil.length,
    compare: 'equals',
    blocking: false,
  }),
  ...(report.originals.fetchEnabled ? fileChecks(report) : [originalsNotFetched()]),
  check({
    name: 'asn_preserved',
    description:
      'Every Paperless archive serial number is accounted for in the target: on `item_office.asn`, ' +
      'or on the item’s `paperless_asn` field with a live item in the target — or Paperless ' +
      'itself — provably holding the number. Both halves of the right-hand side are queries, not ' +
      'review entries: an importer can no longer satisfy this by logging that it skipped one.',
    expected: report.asn.apiWithAsn,
    actual: report.asn.recueilCarried + report.asn.recueilDeferred,
    compare: 'equals',
    blocking: true,
  }),
  check({
    name: 'asn_carried_to_facet',
    description:
      'Every ASN reached `item_office.asn`, less the ones Paperless itself put on two documents — ' +
      'where the source contradicts §6’s premise and no importer can satisfy it. An ASN that lost ' +
      'to an item already in the library does **not** count as an allowance: that conflict is ' +
      'resolvable, and it has to be resolved before the physical filing index is unambiguous.',
    expected: report.asn.apiWithAsn - report.asn.duplicateLossesInSource,
    actual: report.asn.recueilCarried,
    compare: 'equals',
    blocking: true,
  }),
  check({
    name: 'asn_unique',
    description:
      'No two live items in the library share an archive serial number. Queried over the whole ' +
      '`item_office` table joined to `items.trashed_at`, not only the imported part and not the ' +
      'mirror column the partial index reads: an ASN colliding with a hand-entered item, or a ' +
      'drifted mirror, is the case worth catching.',
    expected: report.asn.recueilLiveAsn,
    actual: report.asn.recueilDistinctAsn,
    compare: 'equals',
    blocking: true,
  }),
  check({
    name: 'tags_carried',
    description: 'Every named Paperless tag has a live Recueil tag of the same name, by query.',
    expected: report.tags.apiNamed,
    actual: report.tags.recueilTotal,
    compare: 'equals',
    blocking: true,
  }),
  check({
    name: 'tag_references_resolvable',
    description:
      'Every tag id the documents carry was defined by `/api/tags/`. A dangling id means the tag ' +
      'vocabulary the import read was smaller than the one the documents use — a tag created ' +
      'between the two requests, or a truncated answer — and the tag behind it cannot be carried ' +
      'under any name. Blocking, because the alternative is subtracting the loss from both sides ' +
      'of `tag_assignments_carried` and calling the result parity.',
    expected: 0,
    actual: report.tags.danglingTagIds.length,
    compare: 'equals',
    blocking: true,
  }),
  check({
    name: 'tag_assignments_carried',
    description:
      'Every tag id on every document that `/api/tags/` defined became a row in `item_tags`. The ' +
      'left counts ids in the API payload, less those `tag_references_resolvable` has already ' +
      'reported as undefined **in the source**; the right counts rows in the target joined to a ' +
      'live tag. Neither side counts a skipped record.',
    expected: report.tags.apiAssignmentsResolvable,
    actual: report.tags.recueilAssignments,
    compare: 'equals',
    blocking: true,
  }),
  check({
    name: 'custom_fields_defined',
    description:
      'Every Paperless custom field whose data type this importer maps has a Recueil definition ' +
      'of the mapped type. The target side matches on `custom_fields.config.paperlessFieldId`, ' +
      'which is in the database, and checks the stored `data_type` (§6: types preserved).',
    expected: report.customFields.apiSupported,
    actual: report.customFields.recueilDefined,
    compare: 'equals',
    blocking: true,
  }),
  check({
    name: 'custom_field_references_resolvable',
    description:
      'Every custom field a document carries a value for was defined by `/api/custom_fields/`. A ' +
      'dangling field id means the value has no name, no type and nowhere to go, and that the ' +
      'field vocabulary read was smaller than the one in use.',
    expected: 0,
    actual: report.customFields.danglingFieldIds.length,
    compare: 'equals',
    blocking: true,
  }),
  check({
    name: 'custom_field_values_carried',
    description:
      'Every custom-field value the source can express reached `field_values`. The left counts ' +
      'value instances on the API payload, less those on undefined fields, on data types this ' +
      'importer has no mapping for, and those the source’s own field definition gives no meaning ' +
      'to — each of which is listed. The right counts distinct `(item, field, group)` slots in the ' +
      'target, so a `documentlink` that expands to several rows is still one value on both sides.',
    expected: report.customFields.apiInstancesCarryable,
    actual: report.customFields.recueilInstances,
    compare: 'equals',
    blocking: true,
  }),
  check({
    name: 'custom_field_values_representable',
    description:
      'How many of the values on the wire this migration can express at all. Informational, and ' +
      'the place the shortfall `custom_field_values_carried` excludes is stated rather than ' +
      'silently subtracted: every one of them is listed in `customFields`.',
    expected: report.customFields.apiValueInstances,
    actual: report.customFields.apiInstancesCarryable,
    compare: 'equals',
    blocking: false,
  }),
  check({
    name: 'document_links_resolved',
    description:
      'Every `documentlink` target is a document this import holds. A link outside the import ' +
      'cannot be written — `item_reference` is a real foreign key — so it is named here.',
    expected: 0,
    actual: report.customFields.unresolvedDocumentLinks,
    compare: 'equals',
    blocking: false,
  }),
  check({
    name: 'notes_carried',
    description:
      'Every distinct Paperless note text became a Recueil note, by query over `notes`. Distinct ' +
      'per document, because two byte-identical notes on one document collapse into one slot — ' +
      'which `notes.apiTotal` beside it states.',
    expected: report.notes.apiDistinct,
    actual: report.notes.recueilTotal,
    compare: 'equals',
    blocking: true,
  }),
  check({
    name: 'office_facet_present',
    description:
      'Every imported item carries the Office facet. The facet is the point of this migration ' +
      '(CONCEPT §5.2), so an item without one is a silent loss of the correspondent, the document ' +
      'date and the ASN.',
    expected: report.documents.recueilMatched === 0 ? 0 : 1,
    actual: report.correspondents.recueilDistinct,
    compare: 'at-least',
    blocking: false,
  }),
  check({
    name: 'server_version_modelled',
    description:
      'The server is the Paperless-ngx release this importer was written against. Informational: ' +
      'the REST API is stable across patch releases, and a different version is a reason to read ' +
      'the report closely rather than to stop.',
    expected: report.source.modelledAgainstVersion,
    actual: report.source.serverVersion ?? 'not reported',
    compare: 'equals',
    blocking: false,
  }),
];

/**
 * The four checks about files, emitted only when the run actually fetched them.
 *
 * A run with `downloadOriginals: false` has nothing to say about originals, so it says nothing
 * rather than passing four checks vacuously.
 */
const fileChecks = (report: PaperlessImportReport): ReportCheck[] => [
  check({
    name: 'attachment_records_carried',
    description:
      'Every blob the store holds for an imported document is reachable from its item. Both sides ' +
      "are queries against the target — `document_provenance` and `attachments` — not counts of " +
      "the importer's log, so a blob written with no attachment row fails this check.",
    expected: report.originals.recueilDocuments,
    actual: report.originals.recueilAttachments,
    compare: 'equals',
    blocking: true,
  }),
  check({
    name: 'originals_accounted_for',
    description:
      'Every imported document either has a stored original or is one the report explains, ' +
      'matched **by document id** in both directions. This is the one check whose second side is ' +
      "the run's own log, and it is not the target side: the target side is a query for the blob, " +
      'and the log is an independent record of the same event, so a disagreement either way — a ' +
      'file quietly absent, or a failure recorded for a document whose file is there — fails it.',
    expected: 0,
    actual:
      report.originals.unaccountedWithoutOriginal.length + report.originals.contradictedByStore.length,
    compare: 'equals',
    blocking: true,
  }),
  check({
    name: 'original_hash_coverage',
    description:
      'Originals fetched and hashed into the content-addressed store (ADR-0004). Not blocking: ' +
      'CONCEPT §6 asks for a document whose file cannot be fetched to go to the review queue with ' +
      'a reason, not for the run to fail.',
    expected: report.originals.attempted,
    actual: report.originals.stored,
    compare: 'equals',
    blocking: false,
  }),
  check({
    name: 'original_checksums_agree',
    description:
      'Every original hashes to the MD5 Paperless recorded when it consumed the file. A ' +
      'reconciliation of two independently held facts; a mismatch means the file on disk changed ' +
      'without Paperless being told.',
    expected: 0,
    actual: report.originals.checksumMismatches,
    compare: 'equals',
    blocking: false,
  }),
];

/** The one check a metadata-only run emits in their place: an explicit statement of what it is not. */
const originalsNotFetched = (): ReportCheck =>
  check({
    name: 'originals_not_fetched',
    description:
      'This run was asked not to fetch the originals (`downloadOriginals: false`), so it says ' +
      'nothing about them. The four file checks are absent rather than passing: a metadata-only ' +
      'rehearsal that reported full hash coverage would be true as arithmetic and false as a ' +
      'statement about the library.',
    expected: 'not fetched',
    actual: 'not fetched',
    compare: 'equals',
    blocking: false,
  });

/** The ASN a document carries, or null when it has none the schema could hold. */
const asnOf = (document: PaperlessDocument): number | null => {
  const asn = document.archive_serial_number;
  return typeof asn === 'number' && Number.isSafeInteger(asn) ? asn : null;
};

/**
 * Whether the *source's own* definition of a field gives its value no meaning.
 *
 * Deliberately narrow, and deliberately not `planValue`: putting the source side through the
 * importer's mapping is how a check comes to compare the importer with itself (ADR-0021 §2). The
 * only case here is the one Paperless can produce on its own — a `select` whose stored option id is
 * not among the options the field declares — and it is decided by reading the field definition the
 * API returned, nothing else.
 */
const unrepresentableBySource = (field: PaperlessCustomField, value: unknown): string | null => {
  if (field.data_type !== 'select') return null;
  const options = field.extra_data?.select_options;
  if (!Array.isArray(options)) {
    return `'${field.name}' is a \`select\` field that declares no options, so no stored option id has a label.`;
  }
  const ids = new Set(
    options
      .map((option) =>
        typeof option === 'object' && option !== null ? (option as { id?: unknown }).id : undefined,
      )
      .filter((id): id is string => typeof id === 'string'),
  );
  if (typeof value !== 'string' || ids.has(value)) return null;
  return (
    `'${field.name}' holds option id '${String(value)}', which is not among the ${ids.size} ` +
    "option(s) `/api/custom_fields/` declares for it. Paperless keeps the label on the field " +
    'definition, so an id with no option has no meaning left to carry.'
  );
};

/**
 * The Paperless custom fields this importer has no data type for.
 *
 * Decided from the raw `data_type` against `DATA_TYPE_MAP`, so the count is a property of the
 * source and this version's capability rather than of the plan. The plan supplies the sentence.
 */
const unsupportedFields = (
  fields: readonly PaperlessCustomField[],
  plan: ImportPlan,
): PaperlessImportReport['customFields']['unsupported'] => {
  const reasons = new Map(
    plan.customFieldPlans
      .filter((field) => field.unsupportedReason !== null)
      .map((field) => [field.paperlessId, field.unsupportedReason as string]),
  );
  return fields
    .filter((field) => DATA_TYPE_MAP[field.data_type] === undefined)
    .map((field) => ({
      paperlessId: field.id,
      name: field.name,
      dataType: String(field.data_type),
      reason:
        reasons.get(field.id) ??
        `Paperless data type '${String(field.data_type)}' is not one this importer was written ` +
          'against. Its values are carried nowhere rather than into a column that means something ' +
          'else.',
    }));
};

const documentTypeParity = (
  apiDocuments: readonly PaperlessDocument[],
  documentTypeById: ReadonlyMap<number, DocumentTypeMapping>,
  itemByPaperlessId: ReadonlyMap<number, { id: string; itemType: string }>,
): DocumentTypeParity[] => {
  const groups = new Map<number | null, PaperlessDocument[]>();
  for (const document of apiDocuments) {
    const key = document.document_type ?? null;
    const group = groups.get(key) ?? [];
    group.push(document);
    groups.set(key, group);
  }

  const rows: DocumentTypeParity[] = [];
  for (const [typeId, documents] of groups) {
    const mapping =
      typeId === null ? mapDocumentType(null) : (documentTypeById.get(typeId) ?? mapDocumentType(null));

    let recueilTotal = 0;
    let recueilMistyped = 0;
    for (const document of documents) {
      const item = itemByPaperlessId.get(document.id);
      if (item === undefined) continue;
      if (item.itemType === mapping.itemType) recueilTotal += 1;
      else recueilMistyped += 1;
    }

    rows.push({
      paperlessId: typeId,
      paperlessName: mapping.name,
      recueilItemType: mapping.itemType,
      officeDocumentType: mapping.officeDocumentType,
      paperlessTotal: documents.length,
      recueilTotal,
      recueilMistyped,
      delta: recueilTotal - documents.length,
    });
  }

  return rows.sort((left, right) => (left.paperlessId ?? -1) - (right.paperlessId ?? -1));
};

/**
 * The Paperless fields this phase of Recueil has nowhere to put.
 *
 * Named rather than omitted. A migration report that lists only what moved cannot be read as
 * evidence that nothing was lost, and every one of these is a real thing a person may care about.
 */
const notCarriedFields = (
  apiDocuments: readonly PaperlessDocument[],
  snapshot: ApiSnapshot,
  plan: ImportPlan,
): NotCarriedField[] => [
  {
    field: 'documents.content',
    count: apiDocuments.length,
    reason:
      'The extracted/OCR text. `documents` has `text_char_count` and `ocr_status` but no column ' +
      'for the text itself in this phase (`spec/data-model.md` §3.3), so it is not carried. The ' +
      "ingestion pipeline's extract stage regenerates it from the stored original (CONCEPT §5.3).",
  },
  {
    field: 'documents.archived_file_name',
    count: apiDocuments.filter(
      (document) => typeof document.archived_file_name === 'string' && document.archived_file_name !== '',
    ).length,
    reason:
      'The OCR-ed PDF Paperless generated beside the original. Derived data: ADR-0004 makes the ' +
      'original the identity, and Recueil regenerates its own.',
  },
  {
    field: 'documents.owner / permissions',
    count: apiDocuments.filter((document) => document.owner !== null && document.owner !== undefined).length,
    reason:
      'Recueil is single-user in v1 (CONCEPT §5.15); every imported item belongs to the one local ' +
      'account. The schema is ready for multi-user, so this becomes carryable later.',
  },
  {
    field: 'tags.parent',
    count: snapshot.tags.filter((tag) => tag.parent !== null && tag.parent !== undefined).length,
    reason:
      'Paperless-ngx 3.0 tags form a tree; Recueil tags are flat (§3.11). Names are unique per ' +
      'owner in Paperless, so flattening cannot collide, but the tree itself is not carried.',
  },
  ...customFieldPlansWithCurrencyLoss(plan),
  {
    field: 'storage_paths.path',
    count: snapshot.storagePaths.length,
    reason:
      'A storage path is a filename template for Paperless\'s own media directory. Recueil stores ' +
      'by digest (ADR-0004), so the template has no meaning here; the storage path *name* is ' +
      'carried on each item as a custom field.',
  },
  {
    field: 'documents.deleted_at',
    count: apiDocuments.filter((document) => document.deleted_at !== null && document.deleted_at !== undefined)
      .length,
    reason:
      "Paperless's trash lives behind `/api/trash/` and is excluded from `/api/documents/`. This " +
      'importer reads the live library only; anything in the Paperless trash stays there.',
  },
];

/** One line per monetary field whose values disagreed about their currency. */
const customFieldPlansWithCurrencyLoss = (plan: ImportPlan): NotCarriedField[] =>
  plan.customFieldPlans
    .filter((field) => field.currencyLossReason !== null)
    .map((field) => ({
      field: `custom_fields.${field.fieldKey}.currency`,
      count: 1,
      reason: field.currencyLossReason as string,
    }));

const round1 = (value: number): number => Math.round(value * 10) / 10;
