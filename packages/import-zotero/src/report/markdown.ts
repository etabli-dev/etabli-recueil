/**
 * The Markdown rendering of the verification report.
 *
 * A view of `report.json` and nothing more: every number here is read out of the object, never
 * recomputed, so the document a person reads and the document a test asserts against cannot drift
 * apart. The order is the order someone checking a migration actually reads in — the verdict, then
 * the item counts the verdict is about, then the attachments, then everything that needs a human.
 */
import type { ZoteroImportReport } from './types.js';

export const renderReportMarkdown = (report: ZoteroImportReport): string => {
  const out: string[] = [];
  const line = (text = ''): void => void out.push(text);

  line('# Zotero import — verification report');
  line();
  line(`**${report.pass ? 'PASS' : 'FAIL'}** — ${verdict(report)}`);
  line();
  line('| | |');
  line('|---|---|');
  line(`| Generated | ${report.generatedAt} |`);
  line(`| Source | \`${report.source.databasePath}\` |`);
  line(`| Zotero library | ${report.source.libraryId} (${report.source.libraryType ?? 'unknown'}) |`);
  line(`| Zotero userdata schema | ${report.source.zoteroUserdataVersion ?? '—'} |`);
  line(`| Zotero global schema | ${report.source.zoteroGlobalSchemaVersion ?? '—'} |`);
  line(`| Better BibTeX | ${report.source.betterBibtexPath ?? 'not present'} |`);
  line(`| Storage directory | ${report.source.storageDirectory ?? 'not configured'} |`);
  line(`| Linked-attachment base | ${report.source.linkedAttachmentBase ?? 'not configured'} |`);
  line(`| WebDAV directory | ${report.source.webdavDirectory ?? 'not configured'} |`);
  line(`| Source unchanged by the run | ${yesNo(report.source.sourceUnchanged)} |`);
  line(`| Job | \`${report.run.jobId}\` (attempt ${report.run.attempt}) |`);
  line(`| Idempotency key | \`${report.run.idempotencyKey}\` |`);
  line(
    `| Duration | ${(report.run.durationMs / 1000).toFixed(1)} s${
      report.run.resumedFromStage === null ? '' : `, resumed at stage \`${report.run.resumedFromStage}\``
    } |`,
  );
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

  line('## Libraries in the source file');
  line();
  line('| Library | Type | Imported | Regular items | Notes | Attachments |');
  line('|---:|---|---|---:|---:|---:|');
  for (const row of report.source.libraries) {
    line(
      `| ${row.libraryID} | ${row.libraryType ?? '—'} | ${row.imported ? 'yes' : '**no**'} | ` +
        `${row.regularItems} | ${row.notes} | ${row.attachments} |`,
    );
  }
  line();
  if (report.source.itemsInOtherLibraries > 0) {
    line(
      `**${report.source.itemsInOtherLibraries} regular items live in a library this run did not ` +
        'read and were not imported.** Recueil is single-library, so a Zotero group library has ' +
        'nowhere to go; `_REVIEW/` names each one.',
    );
    line();
  }

  line('## Items');
  line();
  line('| Zotero type | Recueil type | Zotero (live/trash) | Recueil (live/trash) | Mistyped | Δ |');
  line('|---|---|---:|---:|---:|---:|');
  for (const row of report.items.byType) {
    line(
      `| \`${row.zoteroType}\` | \`${row.recueilType}\` | ${row.zoteroTotal} (${row.zoteroLive}/${row.zoteroTrashed}) ` +
        `| ${row.recueilTotal} (${row.recueilLive}/${row.recueilTrashed}) | ${row.recueilMistyped} | ${signed(row.delta)} |`,
    );
  }
  line(
    `| **total** | | **${report.items.zoteroRegularTotal}** | **${report.items.recueilRegularTotal}** | ` +
      `**${report.items.recueilMistyped}** | **${signed(report.items.delta)}** |`,
  );
  line();
  if (report.items.recueilMistyped > 0) {
    line(
      `**${report.items.recueilMistyped} imported items are stored under an \`item_type\` other ` +
        'than the one their Zotero type maps to.** They are in the library and they are the wrong ' +
        'kind of record.',
    );
    line();
  }
  if (report.items.missingInRecueil > 0) {
    line(`**${report.items.missingInRecueil} Zotero items have no Recueil row at all.**`);
    line();
  }
  if (report.items.derived > 0) {
    line(
      `${report.items.derived} further item${report.items.derived === 1 ? ' was' : 's were'} created and is ` +
        `not counted in the parity above: ${report.items.derivedReason}.`,
    );
    line();
  }

  line('## Attachments and hash coverage');
  line();
  line('| | |');
  line('|---|---:|');
  line(`| Zotero attachments | ${report.attachments.total} |`);
  for (const [mode, count] of Object.entries(report.attachments.byLinkMode)) {
    line(`| — \`${mode}\` | ${count} |`);
  }
  line(`| Claiming a file | ${report.attachments.claimingFile} |`);
  line(`| Resolved and hashed | ${report.attachments.resolved} |`);
  line(`| Missing | ${report.attachments.missing} |`);
  line(`| Unreadable | ${report.attachments.unreadable} |`);
  line(`| Bookmarks (linked URL) | ${report.attachments.bookmarks} |`);
  line(`| **Hash coverage** | **${report.attachments.hashCoveragePercent}%** |`);
  line(`| Distinct documents | ${report.attachments.distinctDocuments} |`);
  line(`| Attachment records found in Recueil | ${report.attachments.recueilAttachments} |`);
  line(`| Attachment records not found | ${report.attachments.recueilAttachmentsMissing.length} |`);
  line(`| Files whose bytes no longer match Zotero's MD5 | ${report.attachments.hashMismatches} |`);
  line();

  const problems = report.attachments.entries.filter((entry) => entry.status !== 'resolved' && entry.status !== 'no_file');
  if (problems.length > 0) {
    line('### Attachments without a file');
    line();
    line('| Zotero key | Title | Link mode | Status | Reason |');
    line('|---|---|---|---|---|');
    for (const entry of problems) {
      line(
        `| \`${entry.zoteroKey}\` | ${escapeCell(entry.title ?? '—')} | \`${entry.linkMode}\` | ${entry.status} ` +
          `| ${escapeCell(entry.reason ?? '')} |`,
      );
    }
    line();
  }

  line('## Organisation and content');
  line();
  line('| | Zotero | Recueil |');
  line('|---|---:|---:|');
  line(
    `| Collections | ${report.collections.zoteroTotal} | ${report.collections.recueilTotal} ` +
      `(${report.collections.matchedByName} matched by name) |`,
  );
  line(
    `| — of those, trashed | ${report.collections.zoteroTrashed} | ${report.collections.recueilTrashed} |`,
  );
  line(
    `| Collection memberships | ${report.collections.zoteroMemberships} | ${report.collections.recueilMemberships} |`,
  );
  line(
    `| Tags | ${report.tags.zoteroTotal} | ${report.tags.recueilTotal} ` +
      `(${report.tags.matchedByName} matched by name) |`,
  );
  line(
    `| Tag assignments | ${report.tags.zoteroAssignments} | ${
      report.tags.itemAssignments + report.tags.annotationAssignments
    } |`,
  );
  line(`| Notes | ${report.notes.zoteroTotal} | ${report.notes.recueilTotal} |`);
  line(`| Annotations | ${report.annotations.zoteroTotal} | ${report.annotations.recueilTotal} |`);
  line(`| Creators | ${report.creators.zoteroTotal} | ${report.creators.recueilTotal} |`);
  line(`| Creator appearances | ${report.creators.zoteroAppearances} | ${report.creators.recueilAppearances} |`);
  line(
    `| — on the imported items | ${report.creators.zoteroAppearancesOnImported} | ` +
      `${report.creators.recueilAppearancesOnImported} |`,
  );
  line();
  line(
    `Collection memberships not carried: ${report.collections.membershipsSkipped} ` +
      '(a note filed in a collection; Recueil files items). ' +
      `Tag assignments not carried: ${report.tags.assignmentsSkipped} (a tag on a note).`,
  );
  line();

  line('## Notes, annotations, relations and trash');
  line();
  line('| | |');
  line('|---|---:|');
  line(`| Notes on an item / standalone | ${report.notes.recueilChild} / ${report.notes.recueilStandalone} |`);
  line(`| Notes in the trash | ${report.notes.recueilTrashed} |`);
  line(`| Annotations carried | ${report.annotations.recueilTotal} of ${report.annotations.zoteroTotal} |`);
  line(`| — extracted from the PDF itself | ${report.annotations.external} |`);
  line(`| Relations | ${report.relations.zoteroTotal} |`);
  line(`| — resolved within this library | ${report.relations.resolved} |`);
  line(`| — dangling | ${report.relations.dangling} |`);
  line(`| Items carrying a relation | ${report.relations.itemsCarrying} |`);
  line(`| Zotero trash rows | ${report.trash.zoteroDeletedRows} |`);
  line(
    `| — items / notes / attachments | ${report.trash.zoteroDeletedItems} / ${report.trash.zoteroDeletedNotes} / ` +
      `${report.trash.zoteroDeletedAttachments} |`,
  );
  line(
    `| Recueil trash: items / notes / attachments / collections | ${report.trash.recueilTrashedItems} / ` +
      `${report.trash.recueilTrashedNotes} / ${report.trash.recueilTrashedAttachments} / ` +
      `${report.trash.recueilTrashedCollections} |`,
  );
  line(`| — of those, trashed by cascade from a parent | ${report.trash.cascaded} |`);
  line(
    `| Zotero-deleted rows with an item, of which trashed here | ` +
      `${report.trash.zoteroDeletedWithItem} / ${report.trash.recueilTrashedFromZotero} |`,
  );
  line(`| Trashed here that Zotero had not deleted | ${report.trash.trashedNotDeletedInZotero} |`);
  line();

  line('## Citation keys');
  line();
  line('| | |');
  line('|---|---:|');
  line(`| Items with a key | ${report.citationKeys.itemsWithKey} |`);
  line(`| Items without one | ${report.citationKeys.itemsWithoutKey} |`);
  for (const [source, count] of Object.entries(report.citationKeys.bySource)) {
    line(`| — from \`${source}\` | ${count} |`);
  }
  line(`| Imported pinned (ADR-0016) | ${report.citationKeys.pinned} |`);
  line(`| Sources disagreeing | ${report.citationKeys.conflicts} |`);
  line(`| Refused, key already taken | ${report.citationKeys.collisions} |`);
  line(`| Better BibTeX rows | ${report.citationKeys.betterBibtexRows} |`);
  line(`| — naming an item not in this library | ${report.citationKeys.betterBibtexStale} |`);
  line();

  if (report.carriedFields.length > 0) {
    line('## Fields carried into custom fields');
    line();
    line('Zotero fields the bibliographic facet has no column for. Nothing was dropped.');
    line();
    line('| Zotero field | Custom field | Reason | Items |');
    line('|---|---|---|---:|');
    for (const field of report.carriedFields) {
      line(`| \`${field.zoteroField}\` | \`${field.fieldKey}\` | ${field.reason} | ${field.count} |`);
    }
    line();
  }

  line('## Skipped records');
  line();
  if (report.skipped.length === 0) {
    line('None.');
  } else {
    line('| Kind | Zotero key | Subject | Reason |');
    line('|---|---|---|---|');
    for (const entry of report.skipped) {
      line(
        `| ${entry.kind} | ${entry.zoteroKey === null ? '—' : `\`${entry.zoteroKey}\``} | ` +
          `${escapeCell(entry.subject)} | ${escapeCell(entry.reason)} |`,
      );
    }
  }
  line();

  line('## Review queue');
  line();
  if (report.review.length === 0) {
    line('Nothing needs a decision.');
  } else {
    line(`${report.review.length} entr${report.review.length === 1 ? 'y needs' : 'ies need'} a decision (P3).`);
    line();
    line('| Kind | Zotero key | Subject | Reason | Suggested action |');
    line('|---|---|---|---|---|');
    for (const entry of report.review) {
      line(
        `| ${entry.kind} | ${entry.zoteroKey === null ? '—' : `\`${entry.zoteroKey}\``} | ` +
          `${escapeCell(entry.subject)} | ${escapeCell(entry.reason)} | ${escapeCell(entry.proposedAction)} |`,
      );
    }
  }
  line();

  return `${out.join('\n')}\n`;
};

const verdict = (report: ZoteroImportReport): string => {
  const failed = report.checks.filter((check) => check.blocking && !check.pass);
  if (failed.length === 0) {
    return (
      `${report.items.recueilRegularTotal} of ${report.items.zoteroRegularTotal} items, ` +
      `${report.attachments.hashCoveragePercent}% attachment-hash coverage, ` +
      `${report.review.length} entr${report.review.length === 1 ? 'y' : 'ies'} for review.`
    );
  }
  return `${failed.length} blocking check${failed.length === 1 ? '' : 's'} failed: ${failed
    .map((check) => check.name)
    .join(', ')}.`;
};

const signed = (value: number): string => (value > 0 ? `+${value}` : String(value));

const yesNo = (value: boolean): string => (value ? 'yes' : 'NO');

/** A table cell may not contain a raw pipe or a newline. */
const escapeCell = (value: string): string => value.replace(/\|/gu, '\\|').replace(/\s*\n\s*/gu, ' ');
