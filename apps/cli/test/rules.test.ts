/**
 * `recueil rules test` — the dry-run evaluator.
 *
 * The property worth testing is not "it prints a table". It is that the dry run is a *prediction*:
 * the rule that fires here is the rule that fires when the same set is handed to `recueil ingest
 * --rules`, because both go through `@recueil/rules`. The last test in this file asserts exactly
 * that, by running the same rule set both ways over the same document and comparing the answers.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fixture, makeWorkspace, runCli, runJson, sha256OfFile, type Workspace } from './ingest-fixture.js';

const RULE_SET = [
  'version: 1',
  'kind: ingestion',
  'name: office',
  'mode: all-match',
  'rules:',
  '  - id: stadtwerke-invoice',
  '    description: The specific rule, and it stops.',
  '    priority: 100',
  '    when:',
  '      all:',
  '        - type: source',
  '          match: { equals: mail }',
  '        - type: sender',
  '          match: { equals: rechnung@stadtwerke-ulm.example }',
  '    then:',
  '      - type: set-item-type',
  '        itemType: invoice',
  '      - type: add-tags',
  '        tags: [Rechnung]',
  '      - type: set-correspondent',
  '        correspondent: Stadtwerke Ulm',
  '      - type: stop',
  '  - id: any-pdf',
  '    priority: 10',
  '    when:',
  '      type: mime',
  '      match: { equals: application/pdf }',
  '    then:',
  '      - type: add-tags',
  '        tags: [pdf]',
  '  - id: never-fires',
  '    when:',
  '      type: filename',
  '      match: { equals: nothing-is-called-this.xyz }',
  '    then:',
  '      - type: add-tags',
  '        tags: [impossible]',
  '',
].join('\n');

const CORPUS = {
  subjects: [
    {
      id: 'a-mail-invoice',
      source: 'mail',
      sender: 'rechnung@stadtwerke-ulm.example',
      subject: 'Ihre Rechnung 2023-004417',
      mime: 'application/pdf',
      text: 'Stadtwerke Ulm GmbH\nRechnungsnummer: 2023-004417',
    },
    {
      id: 'a-scanned-pdf',
      source: 'scanner',
      path: '/scans/2026-08-19.pdf',
      mime: 'application/pdf',
      text: 'nothing in particular',
    },
    {
      id: 'a-plain-note',
      source: 'folder',
      path: '/notes/todo.txt',
      mime: 'text/plain',
      text: 'buy milk',
    },
  ],
};

interface RulesJson {
  ruleSet: string;
  subjectCount: number;
  exitCode: number;
  rules: Array<{ ruleId: string; matched: number; notMatched: number; notReached: number; errors: number }>;
  unmatchedSubjectIds: string[];
  erroredSubjectIds: string[];
  entries: Array<{
    subjectId: string;
    matched: string[];
    itemType: string | null;
    correspondent: string | null;
    tags: string[];
    stopped: boolean;
    trace?: string;
  }>;
  summary: { itemTypes: Record<string, number>; tags: Record<string, number> };
}

let work: Workspace;

beforeEach(() => {
  work = makeWorkspace('recueil-cli-rules-');
});

afterEach(() => {
  work.dispose();
});

const ruleFile = (): string => work.file('office.yaml', RULE_SET);
const corpusFile = (): string => work.file('corpus.json', JSON.stringify(CORPUS, null, 2));

describe('a JSON corpus', () => {
  it('reports which rules fired on which subject, and which never fired', async () => {
    const { code, json } = await runJson<RulesJson>(['rules', 'test', ruleFile(), '--against', corpusFile()]);

    expect(json.subjectCount).toBe(3);

    const invoice = json.entries.find((entry) => entry.subjectId === 'a-mail-invoice')!;
    expect(invoice.matched).toEqual(['stadtwerke-invoice']);
    expect(invoice.itemType).toBe('invoice');
    expect(invoice.correspondent).toBe('Stadtwerke Ulm');
    expect(invoice.tags).toEqual(['Rechnung']);
    // The specific rule stops, so the generic PDF rule is never reached for this subject.
    expect(invoice.stopped).toBe(true);
    expect(invoice.tags).not.toContain('pdf');

    const scan = json.entries.find((entry) => entry.subjectId === 'a-scanned-pdf')!;
    expect(scan.matched).toEqual(['any-pdf']);
    expect(scan.tags).toEqual(['pdf']);

    // A subject no rule matched is a note, not a failure: it is what the report exists to show.
    expect(json.unmatchedSubjectIds).toEqual(['a-plain-note']);
    expect(json.erroredSubjectIds).toEqual([]);
    expect(code).toBe(4);

    const idle = json.rules.find((rule) => rule.ruleId === 'never-fires')!;
    expect(idle.matched).toBe(0);
    expect(idle.notMatched).toBeGreaterThan(0);

    const notReached = json.rules.find((rule) => rule.ruleId === 'any-pdf')!;
    expect(notReached.notReached).toBe(1);
  });

  it('exits zero when every subject matched something', async () => {
    const corpus = work.file(
      'matched.json',
      JSON.stringify({ subjects: CORPUS.subjects.filter((subject) => subject.mime === 'application/pdf') }),
    );
    const { code, json } = await runJson<RulesJson>(['rules', 'test', ruleFile(), '--against', corpus]);
    expect(json.unmatchedSubjectIds).toEqual([]);
    expect(code).toBe(0);
  });

  it('prints the condition-by-condition trace with --trace', async () => {
    const result = await runCli(['rules', 'test', ruleFile(), '--against', corpusFile(), '--trace']);
    expect(result.stdout).toMatch(/stadtwerke-invoice \(priority 100\): matched/u);
    expect(result.stdout).toMatch(/✗ filename/u);
    expect(result.stdout).toMatch(/stopped by stadtwerke-invoice/u);
  });

  it('writes the Markdown report where it is told to', async () => {
    const out = join(work.root, 'report.md');
    await runCli(['rules', 'test', ruleFile(), '--against', corpusFile(), '--markdown', out]);
    const markdown = readFileSync(out, 'utf8');
    expect(markdown).toMatch(/# Dry run — office/u);
    expect(markdown).toMatch(/Rules, in evaluation order/u);
    expect(markdown).toMatch(/Nothing was written/u);
  });

  it("reads the repository's own rule-case corpus", async () => {
    const { json } = await runJson<RulesJson>([
      'rules',
      'test',
      ruleFile(),
      '--against',
      fixture('rules', 'cases.json'),
    ]);
    // Every case with an inline input becomes a subject; the one that points at an input file
    // instead is reported as not offered rather than invented.
    expect(json.subjectCount).toBeGreaterThan(5);
    expect(json.entries.some((entry) => entry.subjectId === 'stadtwerke-invoice-stops-the-rest')).toBe(true);
  });
});

describe('a directory corpus', () => {
  it('sniffs each file and offers the text a rule would actually see', async () => {
    const textRules = work.file(
      'text.yaml',
      [
        'version: 1',
        'kind: ingestion',
        'name: text-layer',
        'rules:',
        '  - id: has-a-text-layer',
        '    when:',
        '      type: text',
        '      match: { contains: Recueil }',
        '    then:',
        '      - type: add-tags',
        '        tags: [readable]',
        '',
      ].join('\n'),
    );

    const consume = work.stage(
      'consume',
      fixture('scans', 'born-digital.pdf'),
      fixture('scans', 'invoice-image-only.pdf'),
    );

    const { json } = await runJson<RulesJson>(['rules', 'test', textRules, '--against', consume]);
    expect(json.subjectCount).toBe(2);

    // `invoice-image-only.pdf` has no text layer at all, so a text rule cannot match it, and the
    // report must say so rather than pretending an OCR pass had already happened.
    expect(json.unmatchedSubjectIds).toContain('invoice-image-only.pdf');
  });
});

describe('refusals', () => {
  it('refuses an invalid rule set and names every fault', async () => {
    const bad = work.file('bad.yaml', 'version: 1\nkind: nonsense\nrules: []\n');
    const result = await runCli(['rules', 'test', bad, '--against', corpusFile()]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/is not a valid rule set/u);
    expect(result.stderr).toMatch(/kind/u);
  });

  it('refuses a corpus that is not there', async () => {
    const result = await runCli(['rules', 'test', ruleFile(), '--against', join(work.root, 'nope.json')]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/could not read the corpus/u);
  });

  it('validates a rule set on its own', async () => {
    const { json } = await runJson<{ valid: boolean; kind: string; rules: number }>([
      'rules',
      'validate',
      ruleFile(),
    ]);
    expect(json.valid).toBe(true);
    expect(json.kind).toBe('ingestion');
    expect(json.rules).toBe(3);
  });
});

/**
 * The claim the whole command rests on.
 *
 * If `rules test` and `ingest --rules` disagreed, the dry run would be a report about a program
 * nobody runs. They are the same engine, and this proves it over one real document.
 */
describe('the dry run predicts the ingest', () => {
  it('fires the same rule and reaches the same decision', async () => {
    const scan = fixture('scans', 'invoice-image-only.pdf');
    const corpus = work.file('ocr.json', JSON.stringify({ [sha256OfFile(scan)]: 'Rechnungsnummer: 2023-004417' }));

    const rules = work.file(
      'predict.yaml',
      [
        'version: 1',
        'kind: ingestion',
        'name: predict',
        'rules:',
        '  - id: an-invoice',
        '    when:',
        '      type: text',
        '      match: { contains: Rechnungsnummer }',
        '    then:',
        '      - type: set-item-type',
        '        itemType: invoice',
        '      - type: add-tags',
        '        tags: [Rechnung]',
        '      - type: set-confidence',
        '        confidence: 0.9',
        '',
      ].join('\n'),
    );

    // The dry run's corpus is the file's own text, which without OCR is nothing — so the honest
    // prediction here comes from a subject carrying the text the OCR engine will produce.
    const subjects = work.file(
      'subjects.json',
      JSON.stringify({
        subjects: [{ id: scan, source: 'scanner', path: scan, mime: 'application/pdf', text: 'Rechnungsnummer: 2023-004417' }],
      }),
    );

    const predicted = await runJson<RulesJson>(['rules', 'test', rules, '--against', subjects]);
    expect(predicted.json.entries[0]?.matched).toEqual(['an-invoice']);
    expect(predicted.json.entries[0]?.itemType).toBe('invoice');

    const actual = await runJson<{
      results: Array<{ rules: string; confidence: number | null }>;
      counts: { ingested: number };
    }>([
      'ingest',
      scan,
      ...work.libraryArgs,
      '--source-kind',
      'scanner',
      '--ocr',
      'fake',
      '--ocr-corpus',
      corpus,
      '--rules',
      rules,
      '--no-progress',
    ]);

    expect(actual.json.results[0]?.rules).toBe('an-invoice');
    expect(actual.json.results[0]?.confidence).toBeCloseTo(0.9, 2);
    expect(actual.json.counts.ingested).toBe(1);
  });
});
