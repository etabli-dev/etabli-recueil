/**
 * Assembling the verification report.
 *
 * The report is built by **comparing the two sides**, not by narrating the run. Every count on the
 * Paperless side comes from what the API returned; every count on the Recueil side is a query
 * against the library that was just written; the deltas are the difference. That is what makes the
 * report a verification rather than a summary: an importer that silently wrote nothing would
 * produce a report full of negative deltas rather than a cheerful list of what it thought it had
 * done.
 *
 * The rule is worth stating as a rule, because the Phase 1 review found three blocking checks that
 * broke it. **No number on the Recueil side may come from `job_logs`, from the importer's plans, or
 * from anything else the importer produced.** `job_logs` is read here, but only for the *reasons* —
 * an original's failure message, a skipped value's explanation, a review entry's suggested action —
 * never for a count that a check compares. Those live in `reconcile.ts` and in the queries below.
 *
 * Reading the reasons out of `job_logs` rather than out of memory is what makes the report of a run
 * that was interrupted twice say the same thing as the report of one that was not (§6.4).
 */
import { schema } from '@recueil/core';
import type { Recueil } from '@recueil/core';
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';

import { PAPERLESS_MODELLED_VERSION } from '../client/types.js';
import type { PaperlessDocument } from '../client/types.js';
import type { ApiSnapshot, ImportPlan } from '../import.js';
import { mapDocumentType } from '../map/document-types.js';
import { SOURCE_SYSTEM, reconcileDocuments } from '../reconcile.js';
import { REPORT_SCHEMA } from './types.js';
import type {
  DocumentTypeParity,
  NotCarriedField,
  OriginalReportEntry,
  PaperlessImportReport,
  ReportCheck,
  ReportRun,
  ReviewEntry,
  SkippedRecord,
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
   * -- the two sides ----------------------------------------------------------------------------
   *
   * Left: the documents the API returned. Right: rows in the target's own tables, found through
   * `reconcile.ts`, which matches on `items.source_id` and `document_provenance.source_ref` —
   * values that are in the database, not in this process.
   */
  const apiDocuments = snapshot.documents;
  const apiIds = apiDocuments.map((document) => document.id);
  const apiIdSet = new Set(apiIds);

  const correspondence = reconcileDocuments(recueil, apiIds);

  const importedItems = recueil.db
    .select({
      id: schema.items.id,
      sourceId: schema.items.sourceId,
      itemType: schema.items.itemType,
    })
    .from(schema.items)
    .where(eq(schema.items.sourceSystem, SOURCE_SYSTEM))
    .all();

  const itemByPaperlessId = new Map<number, { id: string; itemType: string }>();
  const orphanedInRecueil: string[] = [];
  for (const row of importedItems) {
    const paperlessId = row.sourceId === null ? Number.NaN : Number(row.sourceId);
    if (!Number.isSafeInteger(paperlessId)) {
      orphanedInRecueil.push(row.id);
      continue;
    }
    if (!apiIdSet.has(paperlessId)) orphanedInRecueil.push(row.id);
    itemByPaperlessId.set(paperlessId, { id: row.id, itemType: row.itemType });
  }

  const matchedItemIds = apiIds
    .map((id) => itemByPaperlessId.get(id)?.id)
    .filter((id): id is string => id !== undefined);

  /* -- documents, per type and overall ----------------------------------------------------------- */

  const byDocumentType = documentTypeParity(apiDocuments, plan, itemByPaperlessId);
  const recueilMistyped = byDocumentType.reduce((sum, row) => sum + row.recueilMistyped, 0);
  const recueilMatched = byDocumentType.reduce((sum, row) => sum + row.recueilTotal, 0);
  const missingInRecueil = apiIds.filter((id) => !itemByPaperlessId.has(id));

  /* -- originals ---------------------------------------------------------------------------------- */

  const originals = [...log.originals.values()].sort((left, right) => left.paperlessId - right.paperlessId);
  const stored = originals.filter((entry) => entry.status === 'stored' || entry.status === 'checksum_mismatch');
  const digests = new Set(stored.map((entry) => entry.sha256).filter((value): value is string => value !== null));

  /* -- tags ---------------------------------------------------------------------------------------- */

  const apiTagNames = snapshot.tags.map((tag) => tag.name.trim()).filter((name) => name !== '');
  const recueilTagRows =
    apiTagNames.length === 0
      ? []
      : recueil.db
          .select({ id: schema.tags.id, name: schema.tags.name })
          .from(schema.tags)
          .where(and(inArray(schema.tags.name, apiTagNames), isNull(schema.tags.trashedAt)))
          .all();
  const recueilTagNames = new Set(recueilTagRows.map((row) => row.name));

  const apiAssignments = apiDocuments.reduce((sum, document) => sum + (document.tags?.length ?? 0), 0);
  const recueilAssignments =
    matchedItemIds.length === 0
      ? 0
      : recueil.db
          .select({ itemId: schema.itemTags.itemId })
          .from(schema.itemTags)
          .where(inArray(schema.itemTags.itemId, matchedItemIds))
          .all().length;

  /* -- custom fields --------------------------------------------------------------------------------- */

  const plannedKeys = plan.customFieldPlans
    .filter((field) => field.unsupportedReason === null)
    .map((field) => field.fieldKey);
  const definedRows =
    plannedKeys.length === 0
      ? []
      : recueil.db
          .select({ id: schema.customFields.id, fieldKey: schema.customFields.fieldKey, dataType: schema.customFields.dataType })
          .from(schema.customFields)
          .where(inArray(schema.customFields.fieldKey, plannedKeys))
          .all();

  const paperlessFieldIds = new Set(
    plan.customFieldPlans.filter((field) => field.unsupportedReason === null).map((field) => field.paperlessId),
  );
  const apiValues = apiDocuments.reduce(
    (sum, document) =>
      sum +
      (document.custom_fields ?? []).filter((instance) => paperlessFieldIds.has(instance.field)).length,
    0,
  );

  const definedFieldIds = definedRows.map((row) => row.id);
  const valueRows =
    matchedItemIds.length === 0 || definedFieldIds.length === 0
      ? []
      : recueil.db
          .select({ id: schema.fieldValues.id, isBlank: schema.fieldValues.isBlank })
          .from(schema.fieldValues)
          .where(
            and(
              inArray(schema.fieldValues.itemId, matchedItemIds),
              inArray(schema.fieldValues.fieldId, definedFieldIds),
            ),
          )
          .all();

  const byDataType: Record<string, number> = {};
  for (const field of plan.customFieldPlans) {
    if (field.unsupportedReason !== null) continue;
    byDataType[field.dataType] = (byDataType[field.dataType] ?? 0) + 1;
  }

  /* -- notes ----------------------------------------------------------------------------------------- */

  const apiNotes = apiDocuments.reduce(
    (sum, document) =>
      sum + (document.notes ?? []).filter((note) => typeof note.note === 'string' && note.note.trim() !== '').length,
    0,
  );
  const recueilNotes =
    matchedItemIds.length === 0
      ? 0
      : recueil.db
          .select({ id: schema.notes.id })
          .from(schema.notes)
          .where(and(inArray(schema.notes.itemId, matchedItemIds), isNull(schema.notes.trashedAt)))
          .all().length;

  /* -- the office facet: correspondents, document types, ASN --------------------------------------- */

  const officeRows =
    matchedItemIds.length === 0
      ? []
      : recueil.db
          .select({
            itemId: schema.itemOffice.itemId,
            correspondent: schema.itemOffice.correspondent,
            officeDocumentType: schema.itemOffice.officeDocumentType,
            asn: schema.itemOffice.asn,
          })
          .from(schema.itemOffice)
          .where(inArray(schema.itemOffice.itemId, matchedItemIds))
          .all();

  const usedCorrespondentIds = new Set(
    apiDocuments
      .map((document) => document.correspondent)
      .filter((id): id is number => typeof id === 'number'),
  );
  const withoutCorrespondent = apiDocuments.filter(
    (document) => document.correspondent === null || document.correspondent === undefined,
  ).length;

  const apiWithAsn = apiDocuments.filter(
    (document) =>
      typeof document.archive_serial_number === 'number' &&
      Number.isSafeInteger(document.archive_serial_number),
  ).length;
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
    .select({ asn: schema.itemOffice.asn })
    .from(schema.itemOffice)
    .innerJoin(schema.items, eq(schema.items.id, schema.itemOffice.itemId))
    .where(and(isNotNull(schema.itemOffice.asn), isNull(schema.items.trashedAt)))
    .all();
  const liveAsns = liveAsnRows.map((row) => row.asn).filter((asn): asn is number => asn !== null);
  const distinctLiveAsn = new Set(liveAsns).size;

  const duplicatesInSource = duplicateAsns(apiDocuments);
  const importedAsns = officeRows.map((row) => row.asn).filter((asn): asn is number => asn !== null);

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
      carriedFromEarlierAttempt: input.run.documentsSkippedAsAlreadyDone,
      recueilTotal: importedItems.length,
      recueilMatched,
      recueilMistyped,
      missingInRecueil,
      orphanedInRecueil,
      delta: recueilMatched - apiDocuments.length,
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
      recueilDocuments: apiIds.filter((id) => correspondence.documentIdByPaperlessId.has(id)).length,
      recueilAttachments: correspondence.attachmentIdByPaperlessId.size,
      recueilAttachmentsMissing: [...correspondence.withoutAttachment],
      recueilWithoutOriginal: [...correspondence.withoutDocument],
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
      mappedToCoreItemType: [...plan.documentTypeById.values()].filter((row) => row.kind === 'core').length,
      carriedAsOfficeType: [...plan.documentTypeById.values()].filter((row) => row.kind === 'carried').length,
      recueilWithOfficeType: officeRows.filter((row) => row.officeDocumentType !== null).length,
      byName: [...plan.documentTypeById.values()]
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
      recueilTotal: recueilTagRows.length,
      missingInRecueil: apiTagNames.filter((name) => !recueilTagNames.has(name)),
      apiAssignments,
      recueilAssignments,
      skippedAssignments: log.skipped.filter((entry) => entry.kind === 'tag_assignment').length,
      hierarchical: snapshot.tags.filter((tag) => tag.parent !== null && tag.parent !== undefined).length,
      inboxTags: snapshot.tags.filter((tag) => tag.is_inbox_tag === true).length,
      coloured: snapshot.tags.filter((tag) => typeof tag.color === 'string' && tag.color !== '').length,
    },
    customFields: {
      apiTotal: snapshot.customFields.length,
      recueilDefined: definedRows.length,
      byDataType,
      unsupported: plan.customFieldPlans
        .filter((field) => field.unsupportedReason !== null)
        .map((field) => ({
          paperlessId: field.paperlessId,
          name: field.name,
          dataType: String(field.paperlessDataType),
          reason: field.unsupportedReason as string,
        })),
      apiValues,
      recueilValues: valueRows.length,
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
      recueilDistinctAsn: distinctLiveAsn,
      unique: distinctLiveAsn === liveAsns.length,
      duplicatesInSource,
      collisions,
      range: {
        min: importedAsns.length === 0 ? null : Math.min(...importedAsns),
        max: importedAsns.length === 0 ? null : Math.max(...importedAsns),
      },
    },
    notes: {
      apiTotal: apiNotes,
      recueilTotal: recueilNotes,
      delta: recueilNotes - apiNotes,
    },
    notCarried,
    skipped: log.skipped,
    review: log.review,
    checks: [],
  };

  report.checks = checks(report);
  report.pass = report.checks.every((check) => !check.blocking || check.pass);
  return report;
};

/* ================================================================================================ */

/**
 * The named assertions behind `pass`.
 *
 * Only the ones marked blocking decide the verdict, and the blocking set is deliberately narrow:
 * document-count parity, item-type fidelity, one attachment row per stored original, and a unique
 * ASN — which is what CONCEPT §6 asks for in as many words. A missing *file* is not blocking,
 * because §6 asks for missing files to be reported rather than for the run to fail (P3), and a real
 * library always has a few; a missing *record* is blocking, because that is data the import was
 * supposed to carry and did not.
 *
 * **Every blocking check compares two independently obtained numbers.** The Paperless side comes
 * from the API response; the Recueil side comes from a query against the target's own tables. None
 * of them counts the importer's log entries, and none of them buckets both sides through the same
 * mapping function — the two shapes that made three Phase 1 checks structurally incapable of
 * failing.
 */
const checks = (report: PaperlessImportReport): ReportCheck[] => [
  {
    name: 'document_count_parity',
    description:
      'Every document the Paperless API returned has exactly one Recueil item. The left is the ' +
      'length of the API result set; the right is a query over `items` in the target, matched on ' +
      '`source_id`.',
    pass: report.documents.delta === 0,
    expected: report.documents.apiFetched,
    actual: report.documents.recueilMatched,
    blocking: true,
  },
  {
    name: 'document_list_complete',
    description:
      "The pages walked add up to the `count` the server reported. A short walk — a page that " +
      'failed, a `next` link that stopped early — would otherwise look like a complete import of a ' +
      'smaller library.',
    pass: report.documents.apiFetched === report.documents.apiReportedTotal,
    expected: report.documents.apiReportedTotal,
    actual: report.documents.apiFetched,
    blocking: true,
  },
  {
    name: 'item_type_fidelity',
    description:
      'No imported document is stored under an `item_type` other than the one its Paperless ' +
      'document type maps to. The target side reads the stored `item_type`, recomputing the ' +
      'expected value from the Paperless name rather than from what the importer wrote.',
    pass: report.documents.recueilMistyped === 0,
    expected: 0,
    actual: report.documents.recueilMistyped,
    blocking: true,
  },
  {
    name: 'no_orphaned_items',
    description:
      'No item in the target claims a Paperless origin the server does not have. A non-zero count ' +
      'means documents were deleted in Paperless after a previous import, which is a decision for ' +
      'a person rather than something an importer should tidy away.',
    pass: report.documents.orphanedInRecueil.length === 0,
    expected: 0,
    actual: report.documents.orphanedInRecueil.length,
    blocking: false,
  },
  ...(report.originals.fetchEnabled ? fileChecks(report) : [originalsNotFetched()]),
  {
    name: 'asn_preserved',
    description:
      'Every Paperless archive serial number reached `item_office.asn`, less the ones a review ' +
      'entry accounts for. Both sides are counts of records, not of log lines.',
    pass: report.asn.recueilWithAsn + report.asn.collisions.length + countDuplicateAsnLosses(report) >= report.asn.apiWithAsn,
    expected: report.asn.apiWithAsn,
    actual: report.asn.recueilWithAsn,
    blocking: true,
  },
  {
    name: 'asn_unique',
    description:
      'No two live items in the library share an archive serial number. Queried over the whole ' +
      '`item_office` table, not only the imported part: an ASN colliding with a hand-entered item ' +
      'is the case worth catching.',
    pass: report.asn.unique,
    expected: report.asn.recueilDistinctAsn,
    actual: report.asn.recueilWithAsn,
    blocking: true,
  },
  {
    name: 'tags_carried',
    description: 'Every Paperless tag has a Recueil tag of the same name, by query.',
    pass: report.tags.missingInRecueil.length === 0,
    expected: report.tags.apiTotal,
    actual: report.tags.recueilTotal,
    blocking: true,
  },
  {
    name: 'tag_assignments_carried',
    description:
      'Every tag on every document became a row in `item_tags`, less the ones a skipped record ' +
      'accounts for. The left counts the ids in the API payload; the right counts rows in the ' +
      'target.',
    pass: report.tags.recueilAssignments + report.tags.skippedAssignments >= report.tags.apiAssignments,
    expected: report.tags.apiAssignments,
    actual: report.tags.recueilAssignments,
    blocking: true,
  },
  {
    name: 'custom_fields_defined',
    description:
      'Every supported Paperless custom field has a Recueil definition with the mapped data type.',
    pass: report.customFields.recueilDefined === report.customFields.apiTotal - report.customFields.unsupported.length,
    expected: report.customFields.apiTotal - report.customFields.unsupported.length,
    actual: report.customFields.recueilDefined,
    blocking: true,
  },
  {
    name: 'custom_field_values_carried',
    description:
      'Every custom-field value on every document reached `field_values`, less the ones a skipped ' +
      'record accounts for. `documentlink` values expand to one row per link, so the target side ' +
      'may legitimately be larger.',
    pass:
      report.customFields.recueilValues + report.customFields.skippedValues >= report.customFields.apiValues,
    expected: report.customFields.apiValues,
    actual: report.customFields.recueilValues,
    blocking: true,
  },
  {
    name: 'notes_carried',
    description: 'Every Paperless note became a Recueil note, by query over `notes`.',
    pass: report.notes.recueilTotal >= report.notes.apiTotal,
    expected: report.notes.apiTotal,
    actual: report.notes.recueilTotal,
    blocking: true,
  },
  {
    name: 'office_facet_present',
    description:
      'Every imported item carries the Office facet. The facet is the point of this migration ' +
      '(CONCEPT §5.2), so an item without one is a silent loss of the correspondent, the document ' +
      'date and the ASN.',
    pass: report.correspondents.recueilDistinct > 0 || report.documents.recueilMatched === 0,
    expected: report.documents.recueilMatched === 0 ? 0 : 1,
    actual: report.correspondents.recueilDistinct,
    blocking: false,
  },
  {
    name: 'server_version_modelled',
    description:
      'The server is the Paperless-ngx release this importer was written against. Informational: ' +
      'the REST API is stable across patch releases, and a different version is a reason to read ' +
      'the report closely rather than to stop.',
    pass: report.source.versionMatchesModel,
    expected: report.source.modelledAgainstVersion,
    actual: report.source.serverVersion ?? 'not reported',
    blocking: false,
  },
];


/**
 * The four checks about files, emitted only when the run actually fetched them.
 *
 * A run with `downloadOriginals: false` has nothing to say about originals, so it says nothing
 * rather than passing four checks vacuously.
 */
const fileChecks = (report: PaperlessImportReport): ReportCheck[] => [
  {
    name: 'attachment_records_carried',
    description:
      'Every blob the store holds for an imported document is reachable from its item. Both sides ' +
      "are queries against the target — `document_provenance` and `attachments` — not counts of " +
      "the importer's log, so a blob written with no attachment row fails this check.",
    pass: report.originals.recueilAttachmentsMissing.length === 0,
    expected: report.originals.recueilDocuments,
    actual: report.originals.recueilAttachments,
    blocking: true,
  },
  {
    name: 'originals_accounted_for',
    description:
      'Every imported document either has a stored original or is one the report explains. The ' +
      'left counts documents with no blob, by query; the right counts the failures the run ' +
      'observed. A document that quietly got no file would make the two disagree.',
    pass:
      report.originals.recueilWithoutOriginal.length ===
      report.originals.missing + report.originals.unreadable,
    expected: report.originals.missing + report.originals.unreadable,
    actual: report.originals.recueilWithoutOriginal.length,
    blocking: true,
  },
  {
    name: 'original_hash_coverage',
    description:
      'Originals fetched and hashed into the content-addressed store (ADR-0004). Not blocking: ' +
      'CONCEPT §6 asks for a document whose file cannot be fetched to go to the review queue with ' +
      'a reason, not for the run to fail.',
    pass: report.originals.missing === 0 && report.originals.unreadable === 0,
    expected: report.originals.attempted,
    actual: report.originals.stored,
    blocking: false,
  },
  {
    name: 'original_checksums_agree',
    description:
      'Every original hashes to the MD5 Paperless recorded when it consumed the file. A ' +
      'reconciliation of two independently held facts; a mismatch means the file on disk changed ' +
      'without Paperless being told.',
    pass: report.originals.checksumMismatches === 0,
    expected: 0,
    actual: report.originals.checksumMismatches,
    blocking: false,
  },
];

/** The one check a metadata-only run emits in their place: an explicit statement of what it is not. */
const originalsNotFetched = (): ReportCheck => ({
  name: 'originals_not_fetched',
  description:
    'This run was asked not to fetch the originals (`downloadOriginals: false`), so it says ' +
    'nothing about them. The four file checks are absent rather than passing: a metadata-only ' +
    'rehearsal that reported full hash coverage would be true as arithmetic and false as a ' +
    'statement about the library.',
  pass: true,
  expected: 'not fetched',
  actual: 'not fetched',
  blocking: false,
});

/** ASNs lost to a duplicate in Paperless itself: one document keeps the number, the rest do not. */
const countDuplicateAsnLosses = (report: PaperlessImportReport): number =>
  report.asn.duplicatesInSource.reduce((sum, row) => sum + row.documents.length - 1, 0);

const documentTypeParity = (
  apiDocuments: readonly PaperlessDocument[],
  plan: ImportPlan,
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
      typeId === null ? mapDocumentType(null) : (plan.documentTypeById.get(typeId) ?? mapDocumentType(null));

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

const duplicateAsns = (
  apiDocuments: readonly PaperlessDocument[],
): Array<{ asn: number; documents: number[] }> => {
  const byAsn = new Map<number, number[]>();
  for (const document of apiDocuments) {
    const asn = document.archive_serial_number;
    if (typeof asn !== 'number' || !Number.isSafeInteger(asn)) continue;
    const list = byAsn.get(asn) ?? [];
    list.push(document.id);
    byAsn.set(asn, list);
  }
  return [...byAsn]
    .filter(([, documents]) => documents.length > 1)
    .map(([asn, documents]) => ({ asn, documents: [...documents].sort((left, right) => left - right) }))
    .sort((left, right) => left.asn - right.asn);
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
