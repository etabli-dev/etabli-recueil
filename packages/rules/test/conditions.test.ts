import { describe, expect, it } from 'vitest';

import { evaluateIngestion } from '../src/evaluate.js';
import { parseRuleSetOrThrow } from '../src/parse.js';
import type { IngestionCondition, IngestionRuleSet } from '../src/schema/ingestion.js';
import type { IngestionSubject } from '../src/ingestion/subject.js';
import { CORPUS, NEGATION_YAML } from './fixtures.js';

/** One rule, one condition, one tag — enough to read the verdict off the outcome. */
const oneRule = (when: IngestionCondition): IngestionRuleSet => ({
  version: 1,
  kind: 'ingestion',
  name: 'one rule',
  rules: [{ id: 'probe', when, then: [{ type: 'add-tags', tags: ['hit'] }] }],
});

const fired = (when: IngestionCondition, subject: IngestionSubject): boolean =>
  evaluateIngestion(oneRule(when), subject).trace.matchedRuleIds.includes('probe');

const scan = CORPUS[1]!;
const payroll = CORPUS[2]!;
const acme = CORPUS[0]!;

describe('negation', () => {
  const ruleSet = (() => {
    const parsed = parseRuleSetOrThrow(NEGATION_YAML);
    if (parsed.kind !== 'ingestion') throw new Error('fixture is not an ingestion rule set');
    return parsed;
  })();

  it('fires when neither negated member matches', () => {
    const { outcome } = evaluateIngestion(ruleSet, scan);
    expect(outcome.tags.map((tag) => tag.value)).toEqual(['needs-filing']);
  });

  it('does not fire when a negated member matches', () => {
    const { outcome } = evaluateIngestion(ruleSet, payroll);
    expect(outcome.tags).toEqual([]);
  });

  it('does not fire when the other negated member matches', () => {
    const alreadyFiled = { ...scan, tags: ['scanned', 'filed'] };
    expect(evaluateIngestion(ruleSet, alreadyFiled).outcome.tags).toEqual([]);
  });

  it('explains itself in both directions', () => {
    const negatedPath = evaluateIngestion(ruleSet, payroll).trace.rules[0]!.condition!.children!.at(-1)!;
    expect(negatedPath.type).toBe('not');
    expect(negatedPath.matched).toBe(false);
    expect(negatedPath.detail).toBe('the member matched, so `not` does not');
    expect(negatedPath.children![0]!.matched).toBe(true);

    const passing = evaluateIngestion(ruleSet, scan).trace.rules[0]!.condition!.children!.at(-1)!;
    expect(passing.matched).toBe(true);
    expect(passing.detail).toBe('the member did not match');
  });

  it('double negation is the original', () => {
    const inner: IngestionCondition = { type: 'source', match: { equals: 'scanner' } };
    expect(fired({ not: { not: inner } }, scan)).toBe(true);
    expect(fired({ not: { not: inner } }, acme)).toBe(false);
  });

  it('a `not` over a missing field matches, because the field could not match', () => {
    expect(fired({ not: { type: 'sender', match: { contains: 'acme' } } }, scan)).toBe(true);
  });

  it('does not leak captures out of a `not`', () => {
    const ruleWithCapture: IngestionRuleSet = {
      version: 1,
      kind: 'ingestion',
      rules: [
        {
          id: 'probe',
          when: { all: [{ not: { type: 'filename', match: { matches: '(?<who>ACME)' } } }, { type: 'source', match: { equals: 'scanner' } }] },
          then: [{ type: 'add-tags', tags: ['from-${who}'] }],
        },
      ],
    };
    const { outcome, trace } = evaluateIngestion(ruleWithCapture, scan);
    expect(trace.matchedRuleIds).toEqual(['probe']);
    expect(outcome.tags).toEqual([]);
    expect(trace.rules[0]!.actions[0]).toMatchObject({ outcome: 'skipped' });
    expect(trace.rules[0]!.actions[0]!.detail).toContain('${who}');
  });
});

describe('boolean composition', () => {
  it('`all` short-circuits at the first member that does not match', () => {
    const { trace } = evaluateIngestion(
      oneRule({
        all: [
          { type: 'source', match: { equals: 'nowhere' } },
          { type: 'mime', match: { equals: 'application/pdf' } },
        ],
      }),
      scan,
    );
    const condition = trace.rules[0]!.condition!;
    expect(condition.matched).toBe(false);
    expect(condition.children).toHaveLength(1);
    expect(condition.detail).toContain('1 of 2 evaluated');
  });

  it('`any` short-circuits at the first member that matches', () => {
    const { trace } = evaluateIngestion(
      oneRule({
        any: [
          { type: 'source', match: { equals: 'scanner' } },
          { type: 'mime', match: { equals: 'application/pdf' } },
        ],
      }),
      scan,
    );
    const condition = trace.rules[0]!.condition!;
    expect(condition.matched).toBe(true);
    expect(condition.children).toHaveLength(1);
  });

  it('nests to any depth', () => {
    expect(
      fired(
        {
          all: [
            { any: [{ type: 'source', match: { equals: 'scanner' } }, { type: 'source', match: { equals: 'imap' } }] },
            { not: { all: [{ type: 'mime', match: { startsWith: 'image/' } }] } },
          ],
        },
        scan,
      ),
    ).toBe(true);
  });
});

describe('the leaf conditions', () => {
  it('reads the source, the sender, the subject and the MIME type', () => {
    expect(fired({ type: 'source', match: { equals: 'imap' } }, acme)).toBe(true);
    expect(fired({ type: 'sender', match: { endsWith: '@acme.example' } }, acme)).toBe(true);
    expect(fired({ type: 'subject', match: { contains: 'invoice' } }, acme)).toBe(true);
    expect(fired({ type: 'mime', match: { equals: 'APPLICATION/PDF' } }, acme)).toBe(true);
    expect(fired({ type: 'mime', match: { equals: 'APPLICATION/PDF', caseSensitive: true } }, acme)).toBe(false);
  });

  it('matches any one recipient and any one tag', () => {
    expect(fired({ type: 'recipient', match: { contains: 'example.org' } }, acme)).toBe(true);
    expect(fired({ type: 'recipient', match: { contains: 'nobody' } }, acme)).toBe(false);
    expect(fired({ type: 'tag', match: { equals: 'scanned' } }, scan)).toBe(true);
  });

  it('matches a path by glob, after normalising it', () => {
    expect(fired({ type: 'path', match: { glob: 'Scans/**/*.pdf' } }, scan)).toBe(true);
    expect(fired({ type: 'path', match: { glob: 'Other/**' } }, scan)).toBe(false);
    const messy: IngestionSubject = { id: 'messy', path: 'Scans/2026//08/./scan-0007.pdf' };
    expect(fired({ type: 'path', match: { equals: 'Scans/2026/08/scan-0007.pdf' } }, messy)).toBe(true);
  });

  it('will not let a traversal masquerade as a path inside the root', () => {
    const hostile: IngestionSubject = { id: 'hostile', path: 'Scans/../../etc/shadow' };
    expect(fired({ type: 'path', match: { glob: 'Scans/**' } }, hostile)).toBe(false);

    const { trace } = evaluateIngestion(oneRule({ type: 'path', match: { glob: 'Scans/**' } }), hostile);
    expect(trace.rules[0]!.condition!.detail).toContain('climbs above its own root');
    expect(trace.warnings.join(' ')).toContain('climbs above its own root');
  });

  it('derives the filename from the path when the caller did not supply one', () => {
    expect(fired({ type: 'filename', match: { matches: '^scan-\\d+\\.pdf$' } }, scan)).toBe(true);
  });

  it('reads the extracted text, and reports a truncation rather than hiding it', () => {
    const long: IngestionSubject = { id: 'long', text: `${'x'.repeat(200)}needle` };
    expect(fired({ type: 'text', match: { contains: 'needle' } }, long)).toBe(true);

    const { trace } = evaluateIngestion(oneRule({ type: 'text', match: { contains: 'needle' } }), long, {
      limits: { maxTextLength: 50 },
    });
    expect(trace.matchedRuleIds).toEqual([]);
    expect(trace.rules[0]!.condition!.detail).toContain('text truncated to 50 of 206 characters');
    expect(trace.warnings.join(' ')).toContain('saw only the beginning of the document');
  });

  it('reads a resolver outcome, by resolver and by confidence', () => {
    const paper = CORPUS[4]!;
    expect(fired({ type: 'resolver', resolver: 'crossref', outcome: 'hit' }, paper)).toBe(true);
    expect(fired({ type: 'resolver', resolver: 'crossref', outcome: ['miss', 'ambiguous'] }, paper)).toBe(false);
    expect(fired({ type: 'resolver', outcome: 'hit', minConfidence: 0.5 }, paper)).toBe(true);
    expect(fired({ type: 'resolver', outcome: 'hit', minConfidence: 0.999 }, paper)).toBe(false);
    expect(fired({ type: 'resolver', resolver: 'openalex', outcome: 'hit' }, paper)).toBe(false);
  });

  it('distinguishes "no value" from "did not match"', () => {
    const { trace } = evaluateIngestion(oneRule({ type: 'sender', match: { contains: 'acme' } }), scan);
    expect(trace.rules[0]!.condition!.detail).toContain('no value to test');
  });
});

describe('a condition that cannot be decided', () => {
  it('is an error, not a non-match, and the rule is put on the record as undecided', () => {
    const subject: IngestionSubject = { id: 'huge', text: 'a1b2c3'.repeat(200_000) };
    const { outcome, trace } = evaluateIngestion(oneRule({ type: 'text', match: { matches: '(?:[a-z]|[0-9])*!' } }), subject, {
      limits: { maxSteps: 5000 },
    });
    expect(trace.rules[0]!.outcome).toBe('error');
    expect(trace.rules[0]!.condition!.error).toContain('exceeded its budget');
    expect(trace.warnings.join(' ')).toContain('needs a human');
    expect(outcome.tags).toEqual([]);
    expect(trace.matchedRuleIds).toEqual([]);
  });

  it('an undecidable member also stops an `any` from claiming a verdict', () => {
    const subject: IngestionSubject = { id: 'huge', text: 'a1b2c3'.repeat(200_000) };
    const { trace } = evaluateIngestion(
      oneRule({ any: [{ type: 'text', match: { matches: '(?:[a-z]|[0-9])*!' } }, { type: 'always' }] }),
      subject,
      { limits: { maxSteps: 5000 } },
    );
    expect(trace.rules[0]!.outcome).toBe('error');
  });
});
