/**
 * The Markdown rendering of the verification report.
 *
 * A view of `report.json` and nothing more: every number here is read out of the object, never
 * recomputed, so the document a person reads and the document a test asserts against cannot drift
 * apart. The order is the order someone deciding whether to switch Paperless off actually reads in
 * — the verdict, then the document counts the verdict is about, then the files, then the ASN, then
 * everything that needs a human.
 */
import type { PaperlessImportReport } from './types.js';

export const renderReportMarkdown = (report: PaperlessImportReport): string => {
  const out: string[] = [];
  const line = (text = ''): void => void out.push(text);

  line('# Paperless-ngx import — verification report');
  line();
  line(`**${report.pass ? 'PASS' : 'FAIL'}** — ${verdict(report)}`);
  line();
  line('| | |');
  line('|---|---|');
  line(`| Generated | ${report.generatedAt} |`);
  line(`| Server | \`${report.source.baseUrl}\` |`);
  line(`| Server version | ${report.source.serverVersion ?? 'not reported'} |`);
  line(
    `| API version | requested ${report.source.requestedApiVersion}, server allows ` +
      `${report.source.serverApiVersion ?? 'unknown'} |`,
  );
  line(
    `| Modelled against | Paperless-ngx ${report.source.modelledAgainstVersion} ` +
      `(${report.source.versionMatchesModel ? 'matches' : '**differs from**'} this server) |`,
  );
  line(`| Job | \`${report.run.jobId}\` (attempt ${report.run.attempt}) |`);
  line(`| Idempotency key | \`${report.run.idempotencyKey}\` |`);
  line(
    `| Duration | ${(report.run.durationMs / 1000).toFixed(1)} s${
      report.run.resumedFromStage === null
        ? ''
        : `, resumed at stage \`${report.run.resumedFromStage}\` after document ` +
          `${report.run.resumedAfterDocumentId ?? 0}`
    } |`,
  );
  if (report.run.documentsSkippedAsAlreadyDone > 0) {
    line(
      `| Carried from an earlier attempt | ${report.run.documentsSkippedAsAlreadyDone} document(s) |`,
    );
  }
  line();

  line('## Checks');
  line();
  line('| Check | Result | Expected | Actual | |');
  line('|---|---|---:|---:|---|');
  for (const check of report.checks) {
    line(
      `| \`${check.name}\` | ${check.pass ? 'pass' : 'FAIL'} | ${check.expected} | ${check.actual} | ${
        check.blocking ? 'blocking' : 'informational'
      } |`,
    );
  }
  line();
  for (const check of report.checks) line(`- \`${check.name}\` — ${check.description}`);
  line();

  line('## Documents');
  line();
  line('| | |');
  line('|---|---:|');
  line(`| Paperless reported | ${report.documents.apiReportedTotal} |`);
  line(`| Fetched | ${report.documents.apiFetched} |`);
  line(`| Recueil items from Paperless | ${report.documents.recueilTotal} |`);
  line(`| Matched to a fetched document | ${report.documents.recueilMatched} |`);
  line(`| Stored under the wrong item type | ${report.documents.recueilMistyped} |`);
  line(`| Missing in Recueil | ${report.documents.missingInRecueil.length} |`);
  line(`| Orphaned in Recueil | ${report.documents.orphanedInRecueil.length} |`);
  line(`| Δ | ${report.documents.delta} |`);
  line();

  line('| Paperless document type | Recueil item type | `office_document_type` | Paperless | Recueil | Mistyped | Δ |');
  line('|---|---|---|---:|---:|---:|---:|');
  for (const row of report.documents.byDocumentType) {
    line(
      `| ${row.paperlessName ?? '_(none)_'} | \`${row.recueilItemType}\` | ` +
        `${row.officeDocumentType === null ? '—' : `\`${row.officeDocumentType}\``} | ` +
        `${row.paperlessTotal} | ${row.recueilTotal} | ${row.recueilMistyped} | ${row.delta} |`,
    );
  }
  line();

  if (report.documents.missingInRecueil.length > 0) {
    line(
      `**Missing in Recueil:** ${report.documents.missingInRecueil.slice(0, 50).join(', ')}` +
        `${report.documents.missingInRecueil.length > 50 ? ', …' : ''}`,
    );
    line();
  }

  line('## Originals');
  line();
  if (!report.originals.fetchEnabled) {
    line(
      'This run was asked not to fetch the originals, so it says nothing about them. The four ' +
        'file checks are absent from the table above rather than passing on no evidence.',
    );
    line();
  }
  line('| | |');
  line('|---|---:|');
  line(`| Attempted | ${report.originals.attempted} |`);
  line(`| Stored | ${report.originals.stored} |`);
  line(`| Missing | ${report.originals.missing} |`);
  line(`| Unreadable | ${report.originals.unreadable} |`);
  line(`| Hash coverage | ${report.originals.hashCoveragePercent}% |`);
  line(`| Checksum mismatches vs Paperless | ${report.originals.checksumMismatches} |`);
  line(`| Paperless recorded no checksum | ${report.originals.checksumUnavailable} |`);
  line(`| Distinct documents (by SHA-256) | ${report.originals.distinctDocuments} |`);
  line(`| Duplicate originals | ${report.originals.duplicateOriginals} |`);
  line(`| Attachment rows in Recueil | ${report.originals.recueilAttachments} |`);
  line(`| Documents with no attachment row | ${report.originals.recueilAttachmentsMissing.length} |`);
  line();

  const problems = report.originals.entries.filter((entry) => entry.status !== 'stored');

  if (problems.length > 0) {
    line('| Document | Title | Status | Reason |');
    line('|---:|---|---|---|');
    for (const entry of problems.slice(0, 200)) {
      line(
        `| ${entry.paperlessId} | ${escapePipes(entry.title)} | ${entry.status} | ` +
          `${escapePipes(entry.reason ?? '—')} |`,
      );
    }
    line();
  }

  line('## Archive serial numbers');
  line();
  line('| | |');
  line('|---|---:|');
  line(`| Paperless documents with an ASN | ${report.asn.apiWithAsn} |`);
  line(`| Recueil items with an ASN | ${report.asn.recueilWithAsn} |`);
  line(`| Distinct live ASNs in the library | ${report.asn.recueilDistinctAsn} |`);
  line(`| Unique | ${yesNo(report.asn.unique)} |`);
  line(
    `| Range | ${report.asn.range.min ?? '—'} – ${report.asn.range.max ?? '—'} |`,
  );
  line(`| Duplicated in Paperless | ${report.asn.duplicatesInSource.length} |`);
  line(`| Collided with an existing item | ${report.asn.collisions.length} |`);
  line();
  for (const duplicate of report.asn.duplicatesInSource) {
    line(`- ASN **${duplicate.asn}** is on Paperless documents ${duplicate.documents.join(', ')}.`);
  }
  for (const collision of report.asn.collisions) {
    line(
      `- ASN **${collision.asn}** (document ${collision.paperlessId}) is already held by item ` +
        `\`${collision.heldByItemId}\`.`,
    );
  }
  if (report.asn.duplicatesInSource.length > 0 || report.asn.collisions.length > 0) line();

  line('## Correspondents, document types, tags');
  line();
  line('| | Paperless | Recueil |');
  line('|---|---:|---:|');
  line(
    `| Correspondents | ${report.correspondents.apiTotal} (${report.correspondents.referenced} used) | ` +
      `${report.correspondents.recueilDistinct} distinct |`,
  );
  line(
    `| Document types | ${report.documentTypes.apiTotal} | ` +
      `${report.documentTypes.recueilWithOfficeType} items with a type |`,
  );
  line(`| Tags | ${report.tags.apiTotal} | ${report.tags.recueilTotal} |`);
  line(`| Tag assignments | ${report.tags.apiAssignments} | ${report.tags.recueilAssignments} |`);
  line(`| Notes | ${report.notes.apiTotal} | ${report.notes.recueilTotal} |`);
  line();
  line(
    `${report.correspondents.withoutCorrespondent} document(s) had no Paperless correspondent and ` +
      `carry the placeholder \`${report.correspondents.placeholder}\`. ` +
      `${report.documentTypes.mappedToCoreItemType} document type(s) mapped onto a core Recueil ` +
      `item type; ${report.documentTypes.carriedAsOfficeType} are carried in ` +
      '`office_document_type` alone.',
  );
  line();

  line('## Custom fields');
  line();
  line('| | |');
  line('|---|---:|');
  line(`| Paperless fields | ${report.customFields.apiTotal} |`);
  line(`| Defined in Recueil | ${report.customFields.recueilDefined} |`);
  line(`| Unsupported types | ${report.customFields.unsupported.length} |`);
  line(`| Values in Paperless | ${report.customFields.apiValues} |`);
  line(`| Values in Recueil | ${report.customFields.recueilValues} |`);
  line(`| Recorded blank | ${report.customFields.blankValues} |`);
  line(`| Skipped | ${report.customFields.skippedValues} |`);
  line(`| Unresolved document links | ${report.customFields.unresolvedDocumentLinks} |`);
  line();
  const dataTypes = Object.entries(report.customFields.byDataType).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (dataTypes.length > 0) {
    line(`By Recueil data type: ${dataTypes.map(([type, count]) => `\`${type}\` ${count}`).join(', ')}.`);
    line();
  }

  line('### Which field feeds which Office column');
  line();
  line('| Column | Outcome | Paperless field | |');
  line('|---|---|---|---|');
  for (const source of report.customFields.facetSources) {
    line(
      `| \`${source.column}\` | ${source.outcome} | ${source.fieldName ?? '—'} | ` +
        `${escapePipes(source.detail)} |`,
    );
  }
  line();

  line('## What is not carried');
  line();
  line('| Field | Affected | Why |');
  line('|---|---:|---|');
  for (const row of report.notCarried) {
    line(`| \`${row.field}\` | ${row.count} | ${escapePipes(row.reason)} |`);
  }
  line();

  line('## Skipped');
  line();
  if (report.skipped.length === 0) {
    line('Nothing was skipped.');
  } else {
    line('| Kind | Document | Subject | Reason |');
    line('|---|---:|---|---|');
    for (const entry of report.skipped.slice(0, 500)) {
      line(
        `| ${entry.kind} | ${entry.paperlessId ?? '—'} | ${escapePipes(entry.subject)} | ` +
          `${escapePipes(entry.reason)} |`,
      );
    }
    if (report.skipped.length > 500) line();
    if (report.skipped.length > 500) line(`_… and ${report.skipped.length - 500} more._`);
  }
  line();

  line('## Review queue');
  line();
  if (report.review.length === 0) {
    line('Nothing needs a decision.');
  } else {
    line(
      `${report.review.length} entr${report.review.length === 1 ? 'y' : 'ies'}, one file each in ` +
        '`_REVIEW/`.',
    );
    line();
    line('| Kind | Document | Subject |');
    line('|---|---:|---|');
    for (const entry of report.review.slice(0, 500)) {
      line(`| ${entry.kind} | ${entry.paperlessId ?? '—'} | ${escapePipes(entry.subject)} |`);
    }
  }
  line();

  return `${out.join('\n')}\n`;
};

const verdict = (report: PaperlessImportReport): string => {
  const failed = report.checks.filter((check) => check.blocking && !check.pass);
  if (failed.length === 0) {
    const files = report.originals.fetchEnabled
      ? `${report.originals.stored} originals hashed into the store ` +
        `(${report.originals.hashCoveragePercent}% coverage), `
      : 'originals not fetched, ';
    return (
      `${report.documents.recueilMatched} of ${report.documents.apiFetched} documents imported, ` +
      files +
      `${report.review.length} entr${report.review.length === 1 ? 'y' : 'ies'} for review.`
    );
  }
  return `${failed.length} blocking check(s) failed: ${failed.map((check) => check.name).join(', ')}.`;
};

const yesNo = (value: boolean): string => (value ? 'yes' : '**no**');

const escapePipes = (value: string): string => value.replaceAll('|', '\\|').replaceAll('\n', ' ');
