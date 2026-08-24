/**
 * Configuration, concurrency, scratch and the confidence ledger.
 *
 * The concurrency test is the one that matters: "configurable concurrency with a conservative
 * default" is a claim about how many candidates are in flight at once, and the only way to test it
 * is to watch.
 */
import { schema } from '@recueil/core';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONFIDENCE_WEIGHTS,
  ConfidenceLedger,
  DEFAULT_INGEST_CONFIG,
  FakeMetadataExtractor,
  IngestPipeline,
  ScratchManager,
  bufferCandidate,
  coerceFieldValue,
  resolveConfig,
} from '../src/index.js';
import type { IngestCandidate } from '../src/index.js';
import { makeLibrary, makePdf, makeTempDir, scholarlyLines } from './helpers.js';
import type { TestLibrary } from './helpers.js';

let library: TestLibrary;

beforeEach(() => {
  library = makeLibrary();
});

afterEach(() => {
  library.dispose();
});

describe('configuration', () => {
  it('defaults to a conservative concurrency', () => {
    expect(DEFAULT_INGEST_CONFIG.concurrency).toBe(2);
    expect(DEFAULT_INGEST_CONFIG.confidenceThreshold).toBe(0.75);
  });

  it('refuses a nonsensical setting rather than clamping it silently', () => {
    expect(() => resolveConfig({ concurrency: 0 })).toThrowError(RangeError);
    expect(() => resolveConfig({ concurrency: 1.5 })).toThrowError(RangeError);
    expect(() => resolveConfig({ confidenceThreshold: 2 })).toThrowError(RangeError);
    expect(() => resolveConfig({ baseConfidence: -1 })).toThrowError(RangeError);
  });
});

describe('concurrency', () => {
  const slowCandidates = (count: number, watch: { live: number; peak: number }): IngestCandidate[] =>
    Array.from({ length: count }, (_, index) =>
      bufferCandidate(makePdf({ lines: scholarlyLines({ title: `P${String(index)}`, doi: `10.1/${String(index)}` }) }), {
        externalId: `p${String(index)}.pdf`,
        filename: `p${String(index)}.pdf`,
      }),
    ).map((candidate) => ({
      ...candidate,
      read: async () => {
        watch.live += 1;
        watch.peak = Math.max(watch.peak, watch.live);
        await new Promise((resolve) => setTimeout(resolve, 15));
        watch.live -= 1;
        return candidate.read();
      },
    }));

  it('keeps at most `concurrency` candidates in flight', async () => {
    const watch = { live: 0, peak: 0 };
    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root, concurrency: 3 },
      extractors: [new FakeMetadataExtractor({ fallback: { title: 'P', confidence: 0.95 } })],
    });

    await pipeline.run(slowCandidates(8, watch), { runLabel: 'concurrent' });

    expect(watch.peak).toBeGreaterThan(1);
    expect(watch.peak).toBeLessThanOrEqual(3);
    expect(library.db.select({ n: sql<number>`count(*)` }).from(schema.items).get()?.n).toBe(8);
  });

  it('is genuinely serial at concurrency 1', async () => {
    const watch = { live: 0, peak: 0 };
    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root, concurrency: 1 },
      extractors: [new FakeMetadataExtractor({ fallback: { title: 'P', confidence: 0.95 } })],
    });

    await pipeline.run(slowCandidates(4, watch), { runLabel: 'serial' });
    expect(watch.peak).toBe(1);
  });
});

describe('ScratchManager', () => {
  it('disposes a space even when the body throws', async () => {
    const temp = makeTempDir('recueil-scratch-');
    try {
      const manager = new ScratchManager(temp.path);
      let path = '';

      await expect(
        manager.with('x-', async (space) => {
          path = space.path;
          throw new Error('boom');
        }),
      ).rejects.toThrowError('boom');

      expect(path).not.toBe('');
      expect(manager.outstanding).toBe(0);
      expect(await manager.isEmpty()).toBe(true);
      await manager.dispose();
      expect(manager.rootPath).toBe(null);
    } finally {
      temp.dispose();
    }
  });

  it('reports itself empty before anything has needed scratch', async () => {
    const manager = new ScratchManager();
    expect(await manager.isEmpty()).toBe(true);
    expect(manager.rootPath).toBe(null);
  });
});

describe('the confidence ledger', () => {
  it('sums its contributions and clamps to 0..1', () => {
    const ledger = new ConfidenceLedger(0.2);
    ledger.add({ stage: 'type_detection', source: 'detector', delta: 0.2, reason: 'it looks like a paper' });
    ledger.add({ stage: 'metadata_extraction', source: 'grobid', delta: 0.9, reason: 'grobid read six fields' });
    expect(ledger.score).toBe(1);

    const negative = new ConfidenceLedger(0.2);
    negative.add({ stage: 'resolution', source: 'x', delta: -0.9, reason: 'no identifier' });
    expect(negative.score).toBe(0);
  });

  it('explains itself in terms a person can act on', () => {
    const ledger = new ConfidenceLedger(0.2);
    ledger.add({ stage: 'resolution', source: 'x', delta: -0.15, reason: 'it carries no identifier' });
    const explanation = ledger.explain();
    expect(explanation).toContain('it carries no identifier');
    expect(explanation).toContain('-0.15');
    expect(explanation).toContain('0.05');
  });

  it('does not record a contribution of zero', () => {
    const ledger = new ConfidenceLedger(0.2);
    ledger.add({ stage: 'ocr', source: 'none', delta: 0, reason: 'nothing happened' });
    expect(ledger.contributions).toHaveLength(1);
  });

  it('publishes its weights, because they are judgement calls that will be tuned', () => {
    expect(CONFIDENCE_WEIGHTS.metadata).toBeGreaterThan(CONFIDENCE_WEIGHTS.detection);
    expect(CONFIDENCE_WEIGHTS.detection).toBeGreaterThan(CONFIDENCE_WEIGHTS.ocr);
  });
});

describe('coercing a rule value onto a custom field', () => {
  it('honours the field type and refuses a value that does not fit', () => {
    expect(coerceFieldValue('text', 'hello')).toEqual({ type: 'text', value: 'hello' });
    expect(coerceFieldValue('integer', 3)).toEqual({ type: 'integer', value: 3 });
    expect(coerceFieldValue('integer', 3.5)).toBe(null);
    expect(coerceFieldValue('boolean', 'yes')).toBe(null);
    expect(coerceFieldValue('boolean', true)).toEqual({ type: 'boolean', value: true });
    expect(coerceFieldValue('date', '2026-03-14')).toEqual({ type: 'date', value: '2026-03-14' });
    expect(coerceFieldValue('date', '14/03/2026')).toBe(null);
    expect(coerceFieldValue('multi_choice', ['a', 'b'])).toEqual({
      type: 'multi_choice',
      value: ['a', 'b'],
    });
    expect(coerceFieldValue('multi_choice', 'a')).toBe(null);
    expect(coerceFieldValue('nonsense', 'a')).toBe(null);
  });
});

describe('a rule that names a custom field the library does not have', () => {
  it('files the item anyway and says what it could not do', async () => {
    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root },
      extractors: [new FakeMetadataExtractor({ fallback: { title: 'X', confidence: 0.95 } })],
      rules: [
        {
          id: 'sets-a-ghost',
          match: {},
          actions: { setCustomFields: { not_defined_here: 'value' } },
        },
      ],
    });

    const report = await pipeline.run(
      [bufferCandidate(makePdf({ lines: scholarlyLines({ title: 'X', doi: '10.1/x' }) }))],
      { runLabel: 'ghost-field' },
    );

    expect(report.outcomes[0]!.outcome.status).toBe('ingested');
    const entry = library.connection
      .prepare(`select reason_code, explanation, severity from review_queue`)
      .get() as { reason_code: string; explanation: string; severity: string } | undefined;
    expect(entry?.explanation).toContain("'not_defined_here'");
    expect(entry?.severity).toBe('info');
  });
});
