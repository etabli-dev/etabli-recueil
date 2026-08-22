/**
 * The report as a deliverable.
 *
 * The exit criterion names an artefact, not a log line, so these tests are about the artefact: that
 * the JSON is on disk and is what the run returned, that the Markdown says the same numbers, and
 * that `_REVIEW/` holds one file per thing a person has to decide (CONCEPT §6).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { importZoteroLibrary } from '../src/import.js';
import { renderReportMarkdown } from '../src/report/markdown.js';
import { REPORT_SCHEMA } from '../src/report/types.js';
import type { ZoteroImportReport } from '../src/report/types.js';
import { fixtureImportOptions, makeLibrary } from './helpers.js';
import type { TestLibrary } from './helpers.js';

let library: TestLibrary;
let report: ZoteroImportReport;
let paths: { json: string; markdown: string; review: string };

beforeAll(async () => {
  library = makeLibrary();
  const result = await importZoteroLibrary(
    library,
    fixtureImportOptions({ reportDirectory: library.reportDirectory }),
  );
  report = result.report;
  paths = result.reportPaths!;
}, 120_000);

afterAll(() => {
  library.dispose();
});

describe('report.json', () => {
  it('is written, and is exactly what the run returned', () => {
    expect(existsSync(paths.json)).toBe(true);
    expect(JSON.parse(readFileSync(paths.json, 'utf8'))).toEqual(JSON.parse(JSON.stringify(report)));
  });

  it('is versioned, so a consumer can tell one shape from another', () => {
    expect(report.schema).toBe(REPORT_SCHEMA);
  });

  it('records where its numbers came from, including the digest of the source', () => {
    expect(report.source.databasePath).toMatch(/zotero\.sqlite$/u);
    expect(report.source.databaseSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.source.zoteroUserdataVersion).toBe(129);
    expect(report.source.zoteroGlobalSchemaVersion).toBe(45);
    expect(report.source.localUserKey).toBe('v3aG8nQf');
    expect(report.source.libraryType).toBe('user');
    expect(report.source.betterBibtexPath).toMatch(/better-bibtex\.sqlite$/u);
  });

  it('records the run, so the report can be traced to the job that made it', () => {
    expect(report.run.jobId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(report.run.idempotencyKey).toMatch(/^import\.zotero:/u);
    expect(report.run.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.run.attempt).toBe(1);
    expect(report.run.resumedFromStage).toBeNull();
  });

  it('lists an entry per attachment, whatever happened to it', () => {
    expect(report.attachments.entries).toHaveLength(report.attachments.total);
    for (const entry of report.attachments.entries) {
      expect(entry.zoteroKey).toMatch(/^[A-Z0-9]{8}$/u);
      expect(['resolved', 'missing', 'unreadable', 'no_file']).toContain(entry.status);
      if (entry.status === 'resolved') {
        expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(entry.byteSize).toBeGreaterThan(0);
      } else {
        expect(entry.sha256).toBeNull();
      }
    }
  });
});

describe('report.md', () => {
  it('is written, and renders from the JSON', () => {
    const markdown = readFileSync(paths.markdown, 'utf8');
    expect(markdown).toBe(renderReportMarkdown(report));
  });

  it('leads with the verdict', () => {
    const markdown = readFileSync(paths.markdown, 'utf8');
    expect(markdown.split('\n')[0]).toBe('# Zotero import — verification report');
    expect(markdown).toContain('**PASS**');
  });

  it('shows the per-type parity table the exit criterion is judged on', () => {
    const markdown = readFileSync(paths.markdown, 'utf8');
    expect(markdown).toContain('| `journalArticle` | `article` | 21 (20/1) | 21 (20/1) | 0 |');
    expect(markdown).toContain(`| **total** | | **${report.items.zoteroRegularTotal}** |`);
  });

  it('shows the attachment-hash coverage, and names every file it could not find', () => {
    const markdown = readFileSync(paths.markdown, 'utf8');
    expect(markdown).toContain(`| **Hash coverage** | **${report.attachments.hashCoveragePercent}%** |`);
    expect(markdown).toContain('### Attachments without a file');
    for (const entry of report.attachments.entries.filter((row) => row.status === 'missing')) {
      expect(markdown).toContain(entry.zoteroKey);
    }
  });

  it('shows the reconciliations and the review queue', () => {
    const markdown = readFileSync(paths.markdown, 'utf8');
    for (const heading of [
      '## Checks',
      '## Items',
      '## Attachments and hash coverage',
      '## Organisation and content',
      '## Notes, annotations, relations and trash',
      '## Citation keys',
      '## Fields carried into custom fields',
      '## Skipped records',
      '## Review queue',
    ]) {
      expect(markdown, heading).toContain(heading);
    }
  });

  it('escapes a value that would break the table', () => {
    const rendered = renderReportMarkdown({
      ...report,
      review: [
        {
          kind: 'attachment',
          zoteroKey: 'AAAAAAAA',
          subject: 'a | b',
          reason: 'line one\nline two',
          proposedAction: 'do | something',
        },
      ],
    });
    expect(rendered).toContain('| a \\| b | line one line two | do \\| something |');
  });
});

describe('_REVIEW/', () => {
  it('holds one file per entry, plus an index and a README', () => {
    const files = readdirSync(paths.review);
    expect(files).toContain('index.json');
    expect(files).toContain('README.md');
    expect(files.filter((name) => name.endsWith('.md') && name !== 'README.md')).toHaveLength(
      report.review.length,
    );

    const index = JSON.parse(readFileSync(join(paths.review, 'index.json'), 'utf8')) as {
      count: number;
      entries: unknown[];
    };
    expect(index.count).toBe(report.review.length);
    expect(index.entries).toEqual(JSON.parse(JSON.stringify(report.review)));
  });

  it('gives each entry its reason and a suggested action', () => {
    for (const name of readdirSync(paths.review).filter(
      (file) => file.endsWith('.md') && file !== 'README.md',
    )) {
      const text = readFileSync(join(paths.review, name), 'utf8');
      expect(text, name).toContain('## What happened');
      expect(text, name).toContain('## Suggested action');
    }
  });

  it('names the missing attachments after their Zotero keys, so a re-run overwrites them', () => {
    const missing = report.attachments.entries.filter((entry) => entry.status === 'missing');
    for (const entry of missing) {
      expect(existsSync(join(paths.review, `attachment-${entry.zoteroKey.toLowerCase()}.md`))).toBe(true);
    }
  });
});
