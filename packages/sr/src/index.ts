/**
 * Systematic review I/O (`spec/systematic-review.md`): search exports into a review, and the
 * PRISMA 2020, robvis, extraction and audit tables out.
 *
 * The review logic itself — records, deduplication, screening, counts — is `@recueil/core`'s
 * `ReviewService` and `ExtractionService`; this package converts files to and from them.
 */
import { ValidationError } from '@recueil/core';
import type { Actor, BibliographicInput, ImportedRecordInput, PrismaCell, PrismaFlow, Recueil } from '@recueil/core';
import { importBibtex, importCslJson, importMedline, importRis } from '@recueil/formats';
import type { FormatRecord, ImportResult, LossEntry } from '@recueil/formats';

export type SearchFileFormat = 'ris' | 'medline' | 'bibtex' | 'csl-json';

/** Guess the format of a search export from its first lines. */
export const detectFormat = (text: string): SearchFileFormat | null => {
  const head = text.replace(/^\uFEFF/u, '').trimStart().slice(0, 4000);
  if (/^PMID-\s/mu.test(head)) return 'medline';
  if (/^TY {2}- /mu.test(head)) return 'ris';
  if (/^@\w+\s*[{(]/mu.test(head)) return 'bibtex';
  if (head.startsWith('[') || head.startsWith('{')) return 'csl-json';
  return null;
};

export const parseSearchFile = (text: string, format: SearchFileFormat): ImportResult => {
  switch (format) {
    case 'ris':
      return importRis(text);
    case 'medline':
      return importMedline(text);
    case 'bibtex':
      return importBibtex(text);
    case 'csl-json':
      return importCslJson(text);
  }
};

/** A parsed record as the review service takes it. Citation keys are not carried: a search hit is not a cited work yet. */
export const toImportedRecord = (record: FormatRecord): ImportedRecordInput => {
  const bibliographic = { ...(record.bibliographic ?? {}) } as BibliographicInput & Record<string, unknown>;
  delete bibliographic.citationKey;
  delete bibliographic.citationKeyLocked;
  const pmid = typeof bibliographic.pmid === 'string' ? bibliographic.pmid : null;
  return {
    itemType: record.itemType,
    title: record.title ?? (typeof bibliographic.title === 'string' ? bibliographic.title : null),
    bibliographic,
    creators: (record.creators ?? [])
      .filter((creator) => creator.role === 'author')
      .map((creator) => ({ familyName: creator.familyName ?? null, givenName: creator.givenName ?? null, literalName: creator.literalName ?? null, kind: creator.kind ?? 'person' })),
    externalRecordId: pmid ?? (record.id !== undefined && !/^record\d+$/u.test(record.id) ? record.id : null),
    raw: { id: record.id ?? null, itemType: record.itemType, title: record.title ?? null, keywords: record.keywords ?? [], bibliographic: record.bibliographic ?? {} },
  };
};

export interface SearchImportSummary {
  format: SearchFileFormat;
  parsed: number;
  /** New review records. */
  added: number;
  /** Records another search of this review had already found: a second source on the same record. */
  sourceAdded: number;
  /** Records this run had already (the same file twice). */
  repeated: number;
  itemsCreated: number;
  /** Items that were already in the library and are now part of the review. */
  itemsReused: number;
  failures: { index: number; title: string | null; reason: string }[];
  losses: readonly LossEntry[];
  /** `records_returned` and `records_imported` disagreeing is itself reportable (SR1). */
  returnedDiffers: boolean;
}

/** Import one search export into its search run. */
export const importSearchFile = (
  recueil: Recueil,
  searchRunId: string,
  text: string,
  options: { format?: SearchFileFormat; actor?: Actor } = {},
): SearchImportSummary => {
  const actor = options.actor ?? recueil.actor;
  const format = options.format ?? detectFormat(text);
  if (format === null) throw new ValidationError('Could not tell the format of the search export; name it (ris, medline, bibtex, csl-json).');
  const parsed = parseSearchFile(text, format);
  const summary: SearchImportSummary = { format, parsed: parsed.records.length, added: 0, sourceAdded: 0, repeated: 0, itemsCreated: 0, itemsReused: 0, failures: [], losses: parsed.losses, returnedDiffers: false };
  parsed.records.forEach((record, index) => {
    try {
      const outcome = recueil.reviews.addRecord(searchRunId, toImportedRecord(record), actor);
      if (outcome.outcome === 'new') summary.added += 1;
      else if (outcome.outcome === 'source_added') summary.sourceAdded += 1;
      else summary.repeated += 1;
      if (outcome.itemCreated) summary.itemsCreated += 1;
      else summary.itemsReused += 1;
    } catch (error) {
      summary.failures.push({ index, title: record.title ?? null, reason: error instanceof Error ? error.message : String(error) });
    }
  });
  const run = recueil.reviews.finishImport(searchRunId, parsed.records.length - summary.failures.length, actor);
  summary.returnedDiffers = run.recordsReturned !== null && run.recordsReturned !== run.recordsImported;
  return summary;
};

/**
 * Store the export file as a document, link it to the run, then import it. The bytes are kept
 * even when every record already existed, because the file is the search's evidence (P10).
 */
export const storeAndImportSearchFile = async (
  recueil: Recueil,
  searchRunId: string,
  text: string,
  options: { format?: SearchFileFormat; actor?: Actor; filename?: string } = {},
): Promise<SearchImportSummary & { documentId: string }> => {
  const actor = options.actor ?? recueil.actor;
  const format = options.format ?? detectFormat(text);
  if (format === null) throw new ValidationError('Could not tell the format of the search export; name it (ris, medline, bibtex, csl-json).');
  const mime = { ris: 'application/x-research-info-systems', medline: 'application/nbib', bibtex: 'application/x-bibtex', 'csl-json': 'application/vnd.citationstyles.csl+json' }[format];
  const stored = await recueil.documents.ingestBuffer(Buffer.from(text, 'utf8'), {
    sourceKind: 'import',
    sourceRef: `search_run:${searchRunId}`,
    originalFilename: options.filename ?? `search-${searchRunId}.${format === 'csl-json' ? 'json' : format === 'medline' ? 'nbib' : format === 'bibtex' ? 'bib' : 'ris'}`,
    declaredMimeType: mime,
    actor,
  });
  recueil.reviews.attachSourceFile(searchRunId, stored.document.id, actor);
  return { ...importSearchFile(recueil, searchRunId, text, { format, actor }), documentId: stored.document.id };
};

/** A frozen snapshot as a flow, for the same exports; the other-methods column is folded into one box there. */
export const flowFromSnapshot = (cells: PrismaCell[]): PrismaFlow => ({
  cells,
  other: { identified: cells.find((cell) => cell.stageKey === 'records_identified_other')?.count ?? 0, sought: 0, notRetrieved: 0, assessed: 0, excluded: [], included: 0 },
});

/* -------------------------------------------------------------------------------------------- */
/* Tables                                                                                          */
/* -------------------------------------------------------------------------------------------- */

const csvCell = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : String(value);
  return /[",\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
};

export const toCsv = (header: readonly string[], rows: readonly (readonly unknown[])[]): string =>
  [header.map(csvCell).join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\n') + '\n';

/**
 * The PRISMA 2020 numbers keyed by the `data` names of the PRISMA2020 R package's template CSV,
 * so `rc_sr_prisma()` (or a reader by hand) fills the template's `n` column and
 * `PRISMA2020::PRISMA_flowdiagram()` draws the diagram.
 */
export const prismaData = (flow: PrismaFlow, reasonLabels: Record<string, string> = {}): [string, string][] => {
  const total = (key: string) => flow.cells.find((cell) => cell.stageKey === key && cell.sourceLabel === null && cell.exclusionReasonCode === null)?.count ?? 0;
  const perSource = (key: string) =>
    flow.cells
      .filter((cell) => cell.stageKey === key && cell.sourceLabel !== null)
      .map((cell) => `${cell.sourceLabel!.replace(/[,;]/gu, ' ')}, ${cell.count}`)
      .join('; ');
  const reasons = flow.cells
    .filter((cell) => cell.stageKey === 'reports_excluded' && cell.exclusionReasonCode !== null)
    .map((cell) => `${(reasonLabels[cell.exclusionReasonCode!] ?? cell.exclusionReasonCode!).replace(/[,;]/gu, ' ')}, ${cell.count}`)
    .join('; ');
  const otherReasons = flow.other.excluded.map((entry) => `${(reasonLabels[entry.code ?? ''] ?? entry.code ?? 'unspecified').replace(/[,;]/gu, ' ')}, ${entry.count}`).join('; ');
  const n = (value: number) => String(value);
  return [
    ['previous_studies', ''],
    ['previous_reports', ''],
    ['database_results', n(total('records_identified_databases'))],
    ['database_specific_results', perSource('records_identified_databases')],
    ['register_results', n(total('records_identified_registers'))],
    ['register_specific_results', perSource('records_identified_registers')],
    ['website_results', ''],
    ['organisation_results', ''],
    ['citations_results', n(flow.other.identified)],
    ['duplicates', n(total('records_removed_duplicates'))],
    ['excluded_automatic', n(total('records_removed_automation'))],
    ['excluded_other', n(total('records_removed_other'))],
    ['records_screened', n(total('records_screened'))],
    ['records_excluded', n(total('records_excluded'))],
    ['dbr_sought_reports', n(total('reports_sought'))],
    ['dbr_notretrieved_reports', n(total('reports_not_retrieved'))],
    ['other_sought_reports', n(flow.other.sought)],
    ['other_notretrieved_reports', n(flow.other.notRetrieved)],
    ['dbr_assessed', n(total('reports_assessed'))],
    ['dbr_excluded', reasons === '' ? n(total('reports_excluded')) : reasons],
    ['other_assessed', n(flow.other.assessed)],
    ['other_excluded', otherReasons === '' ? '0' : otherReasons],
    ['new_studies', n(total('studies_included'))],
    ['new_reports', n(total('reports_of_included_studies'))],
    ['total_studies', n(total('studies_included'))],
    ['total_reports', n(total('reports_of_included_studies'))],
  ];
};

export const prismaCsv = (flow: PrismaFlow, reasonLabels: Record<string, string> = {}): string => toCsv(['data', 'n'], prismaData(flow, reasonLabels));

const esc = (text: string): string => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');

/** A plain PRISMA 2020 flow diagram for a quick look; publication figures come from the PRISMA2020 package. */
export const prismaSvg = (flow: PrismaFlow, title: string, reasonLabels: Record<string, string> = {}): string => {
  const total = (key: string) => flow.cells.find((cell) => cell.stageKey === key && cell.sourceLabel === null && cell.exclusionReasonCode === null)?.count ?? 0;
  const reasons = flow.cells.filter((cell) => cell.stageKey === 'reports_excluded' && cell.exclusionReasonCode !== null);
  const boxes: { x: number; y: number; w: number; lines: string[] }[] = [
    { x: 20, y: 40, w: 300, lines: [`Records identified from databases (n = ${total('records_identified_databases')})`, `and registers (n = ${total('records_identified_registers')})`] },
    { x: 380, y: 40, w: 300, lines: [`Records removed before screening:`, `duplicates (n = ${total('records_removed_duplicates')})`] },
    { x: 20, y: 150, w: 300, lines: [`Records screened (n = ${total('records_screened')})`] },
    { x: 380, y: 150, w: 300, lines: [`Records excluded (n = ${total('records_excluded')})`] },
    { x: 20, y: 240, w: 300, lines: [`Reports sought for retrieval (n = ${total('reports_sought')})`] },
    { x: 380, y: 240, w: 300, lines: [`Reports not retrieved (n = ${total('reports_not_retrieved')})`] },
    { x: 20, y: 330, w: 300, lines: [`Reports assessed for eligibility (n = ${total('reports_assessed')})`] },
    { x: 380, y: 330, w: 300, lines: [`Reports excluded (n = ${total('reports_excluded')})`, ...reasons.map((cell) => `${reasonLabels[cell.exclusionReasonCode!] ?? cell.exclusionReasonCode} (n = ${cell.count})`)] },
    { x: 20, y: 470, w: 300, lines: [`Studies included in review (n = ${total('studies_included')})`, `Reports of included studies (n = ${total('reports_of_included_studies')})`] },
  ];
  const height = (box: (typeof boxes)[number]) => 16 + box.lines.length * 16;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 ${Math.max(560, 330 + height(boxes[7]!) + 40)}" font-family="sans-serif" font-size="12">`,
    `  <title>${esc(title)} — PRISMA 2020 flow (live counts)</title>`,
    `  <desc>Draft rendering from Recueil. For publication, draw it with the PRISMA2020 R package from the exported counts.</desc>`,
    '  <defs><marker id="a" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L10,5L0,10z"/></marker></defs>',
  ];
  for (const box of boxes) {
    out.push(`  <rect x="${box.x}" y="${box.y}" width="${box.w}" height="${height(box)}" fill="white" stroke="black"/>`);
    box.lines.forEach((line, index) => out.push(`  <text x="${box.x + 8}" y="${box.y + 20 + index * 16}">${esc(line)}</text>`));
  }
  const arrow = (x1: number, y1: number, x2: number, y2: number) => out.push(`  <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="black" marker-end="url(#a)"/>`);
  for (const [from, to] of [[0, 2], [2, 4], [4, 6], [6, 8]] as const) arrow(170, boxes[from]!.y + height(boxes[from]!), 170, boxes[to]!.y);
  for (const [from, to] of [[0, 1], [2, 3], [4, 5], [6, 7]] as const) arrow(320, boxes[from]!.y + 20, 380, boxes[to]!.y + 20);
  out.push('</svg>', '');
  return out.join('\n');
};

/**
 * The robvis input for one tool: `Study, D1 … Dn, Overall, Weight`, with robvis's judgement labels
 * (RB1). One row per current assessment; an outcome-level assessment names its outcome in the study
 * column, as robvis has no outcome column.
 */
export const robvisCsv = (recueil: Recueil, reviewId: string, tool: string): string => {
  const instrument = recueil.extraction.instrument(tool);
  if (instrument.robvis === null) throw new ValidationError(`${instrument.name} has no robvis template.`);
  const labels = recueil.extraction.studyLabels(reviewId);
  const label = (judgement: string | null | undefined) => (judgement == null ? '' : (instrument.robvis!.labels[judgement] ?? judgement));
  const rows = recueil.extraction.assessments(reviewId, { tool }).map((assessment) => {
    const domains = JSON.parse(assessment.domainJudgements) as Record<string, { judgement: string }>;
    const study = labels.get(assessment.reviewRecordId) ?? assessment.reviewRecordId;
    return [assessment.outcomeLabel === null ? study : `${study} (${assessment.outcomeLabel})`, ...instrument.domains.map((domain) => label(domains[domain.key]?.judgement)), label(assessment.overallJudgement), 1];
  });
  return toCsv(['Study', ...instrument.domains.map((domain) => domain.key), 'Overall', 'Weight'], rows);
};

/**
 * Extraction data. `long`: one row per value. `wide`: one row per study and group instance, one
 * column per field — the shape `metafor::escalc()` takes, with the field keys as column names.
 */
export const extractionCsv = (recueil: Recueil, reviewId: string, shape: 'long' | 'wide'): string => {
  const rows = recueil.extraction.table(reviewId);
  if (shape === 'long') {
    return toCsv(
      ['study', 'record_id', 'item_id', 'group', 'field', 'value', 'blank', 'form_version'],
      rows.map((row) => [row.study, row.recordId, row.itemId, row.group, row.field, row.value, row.blank ? 'TRUE' : 'FALSE', row.formVersion]),
    );
  }
  const fields = [...new Set(rows.map((row) => (row.ordinal === 0 ? row.field : `${row.field}_${row.ordinal + 1}`)))];
  const studyLevel = new Set(rows.filter((row) => row.group === null).map((row) => (row.ordinal === 0 ? row.field : `${row.field}_${row.ordinal + 1}`)));
  const byKey = new Map<string, { study: string; recordId: string; group: string | null; values: Map<string, unknown> }>();
  const studyValues = new Map<string, Map<string, unknown>>();
  for (const row of rows) {
    if (row.group === null) {
      const values = studyValues.get(row.recordId) ?? new Map<string, unknown>();
      values.set(row.ordinal === 0 ? row.field : `${row.field}_${row.ordinal + 1}`, row.value);
      studyValues.set(row.recordId, values);
    }
  }
  for (const row of rows) {
    const key = `${row.recordId}\u0000${row.group ?? ''}`;
    if (row.group === null && rows.some((other) => other.recordId === row.recordId && other.group !== null)) continue;
    const entry = byKey.get(key) ?? { study: row.study, recordId: row.recordId, group: row.group, values: new Map(studyValues.get(row.recordId) ?? []) };
    // A repeatable field's later entries get their own columns rather than overwriting the first.
    entry.values.set(row.ordinal === 0 ? row.field : `${row.field}_${row.ordinal + 1}`, row.value);
    byKey.set(key, entry);
  }
  const ordered = [...fields.filter((field) => studyLevel.has(field)), ...fields.filter((field) => !studyLevel.has(field))];
  return toCsv(['study', 'record_id', 'group', ...ordered], [...byKey.values()].map((entry) => [entry.study, entry.recordId, entry.group, ...ordered.map((field) => entry.values.get(field) ?? null)]));
};

/**
 * Every screening decision, oldest first. With the review's automation disclosure on (ADR-020),
 * the tool-assisted flag and what assisted are included.
 */
export const screeningAuditCsv = (recueil: Recueil, reviewId: string): string => {
  const review = recueil.reviews.get(reviewId);
  const labels = recueil.extraction.studyLabels(reviewId);
  const disclose = review.automationDisclosure;
  const header = ['decision_id', 'record_id', 'study', 'stage', 'decision', 'reason', 'note', 'decided_at', 'screener', 'is_current', 'supersedes', ...(disclose ? ['tool_assisted', 'tool_detail'] : [])];
  const rows = recueil.reviews.reviewDecisions(reviewId).map((decision) => [
    decision.id,
    decision.reviewRecordId,
    labels.get(decision.reviewRecordId) ?? '',
    decision.stage,
    decision.decision,
    decision.exclusionReasonCode,
    decision.exclusionReasonNote,
    decision.decidedAt,
    decision.screenerUserId,
    decision.isCurrent ? 'TRUE' : 'FALSE',
    decision.supersedesId,
    ...(disclose ? [decision.toolAssisted ? 'TRUE' : 'FALSE', decision.toolDetail] : []),
  ]);
  return toCsv(header, rows);
};

/** Included studies with their bibliographic core, for a characteristics table or `meta`. */
export const includedStudiesCsv = (recueil: Recueil, reviewId: string): string => {
  const labels = recueil.extraction.studyLabels(reviewId);
  const rows = recueil.reviews
    .records(reviewId)
    .filter((record) => record.stage === 'included')
    .map((record) => {
      const view = recueil.reviews.view(record.id);
      return [labels.get(record.id) ?? record.id, record.id, record.itemId, view.title, view.authors.join('; '), view.year, view.venue, view.doi, view.pmid, record.studyGroupKey, record.extractionStatus];
    });
  return toCsv(['study', 'record_id', 'item_id', 'title', 'authors', 'year', 'venue', 'doi', 'pmid', 'study_group', 'extraction_status'], rows);
};
