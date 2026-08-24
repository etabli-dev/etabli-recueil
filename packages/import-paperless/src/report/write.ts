/**
 * Writing the report to disk, including the `_REVIEW/` directory CONCEPT §6 names.
 *
 * Three artefacts, and the reason there are three:
 *
 * - `report.json` — the report itself. Machine-readable, and what the exit-criterion test asserts
 *   against.
 * - `report.md` — the same numbers for a person, rendered from the JSON so the two cannot drift.
 * - `_REVIEW/` — one file per thing that needs a decision, plus an index. A list inside a long
 *   report is easy to scroll past; a directory with fourteen files in it is not, and a directory is
 *   also something a person can work through and delete from as they go.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderReportMarkdown } from './markdown.js';
import type { PaperlessImportReport, ReviewEntry } from './types.js';

export interface ReportPaths {
  json: string;
  markdown: string;
  review: string;
}

export const writeReport = (directory: string, report: PaperlessImportReport): ReportPaths => {
  mkdirSync(directory, { recursive: true });

  const json = join(directory, 'report.json');
  const markdown = join(directory, 'report.md');
  const review = join(directory, '_REVIEW');

  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(markdown, renderReportMarkdown(report), 'utf8');

  // The review directory describes one run. Leaving a previous run's entries in it would mean a
  // document whose file has since been found still shows up as missing.
  rmSync(review, { recursive: true, force: true });
  mkdirSync(review, { recursive: true });

  writeFileSync(
    join(review, 'index.json'),
    `${JSON.stringify({ generatedAt: report.generatedAt, count: report.review.length, entries: report.review }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(join(review, 'README.md'), reviewReadme(report), 'utf8');

  const used = new Map<string, number>();
  for (const entry of report.review) {
    const base = fileNameFor(entry);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    const name = seen === 0 ? `${base}.md` : `${base}-${seen + 1}.md`;
    writeFileSync(join(review, name), reviewEntryMarkdown(entry), 'utf8');
  }

  return { json, markdown, review };
};

const reviewReadme = (report: PaperlessImportReport): string =>
  [
    '# Review queue',
    '',
    `${report.review.length} entr${report.review.length === 1 ? 'y' : 'ies'} from the Paperless-ngx ` +
      `import of ${report.generatedAt}.`,
    '',
    'Each file describes one thing the importer would not guess at (P3: flag, never guess). None of',
    'them stopped the import: the library is complete apart from what is listed here, and the counts',
    'in `../report.md` include every document, whether or not its original was fetched.',
    '',
    '`index.json` holds the same entries in machine-readable form.',
    '',
    '## By kind',
    '',
    ...kindCounts(report.review).map(([kind, count]) => `- **${kind}** — ${count}`),
    '',
  ].join('\n');

const reviewEntryMarkdown = (entry: ReviewEntry): string =>
  [
    `# ${entry.subject}`,
    '',
    '| | |',
    '|---|---|',
    `| Kind | ${entry.kind} |`,
    `| Paperless document | ${entry.paperlessId === null ? '—' : entry.paperlessId} |`,
    '',
    '## What happened',
    '',
    entry.reason,
    '',
    '## Suggested action',
    '',
    entry.proposedAction,
    '',
    ...(entry.detail === undefined
      ? []
      : ['## Detail', '', '```json', JSON.stringify(entry.detail, null, 2), '```', '']),
  ].join('\n');

const kindCounts = (entries: readonly ReviewEntry[]): Array<[string, number]> => {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  return [...counts].sort((left, right) => right[1] - left[1]);
};

/** A filename that is stable across runs and safe on every filesystem Recueil runs on. */
const fileNameFor = (entry: ReviewEntry): string => {
  const slug = (entry.paperlessId === null ? entry.subject : `document-${entry.paperlessId}`)
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)
    .toLowerCase();
  return `${entry.kind}-${slug === '' ? 'entry' : slug}`;
};
