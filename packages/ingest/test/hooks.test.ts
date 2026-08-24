/**
 * The `ingestStage` hook (`spec/hooks.md` §6.5).
 *
 * The ordering guarantee is tested directly against the comparator, because "the order does not
 * change between restarts" is a property of the sort and not of any particular pipeline run. The
 * three actions — continue with a patch, review, stop — are tested through a real pipeline, because
 * what they mean is what the library looks like afterwards.
 */
import { schema } from '@recueil/core';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FakeMetadataExtractor,
  IngestPipeline,
  IngestStageRegistry,
  bufferCandidate,
  compareStages,
  reviewQueue,
} from '../src/index.js';
import type { IngestStage, IngestStageResult, PipelineAnchor } from '../src/index.js';
import { makeLibrary, makePdf, scholarlyLines } from './helpers.js';
import type { TestLibrary } from './helpers.js';

let library: TestLibrary;

beforeEach(() => {
  library = makeLibrary();
});

afterEach(() => {
  library.dispose();
});

const stage = (
  id: string,
  anchor: PipelineAnchor,
  position: 'before' | 'after',
  result: IngestStageResult | (() => IngestStageResult),
  extra: { priority?: number; pluginName?: string } = {},
): IngestStage => ({
  id,
  anchor,
  position,
  ...extra,
  run: async () => (typeof result === 'function' ? result() : result),
});

const itemCount = (): number =>
  library.db.select({ n: sql<number>`count(*)` }).from(schema.items).get()?.n ?? 0;

describe('ordering', () => {
  it('is anchor, then before/after, then priority, then plugin name, then hook id', () => {
    const stages: IngestStage[] = [
      stage('z', 'commit', 'after', { action: 'continue' }),
      stage('a', 'hash', 'after', { action: 'continue' }),
      stage('b', 'hash', 'before', { action: 'continue' }),
      stage('low', 'ocr', 'before', { action: 'continue' }, { priority: 1 }),
      stage('high', 'ocr', 'before', { action: 'continue' }, { priority: 9 }),
      stage('p2', 'rules', 'after', { action: 'continue' }, { pluginName: 'beta' }),
      stage('p1', 'rules', 'after', { action: 'continue' }, { pluginName: 'alpha' }),
    ];

    const forwards = new IngestStageRegistry(stages);
    const backwards = new IngestStageRegistry([...stages].reverse());

    const order = ['b', 'a', 'high', 'low', 'p1', 'p2', 'z'];
    expect(forwards.all.map((entry) => entry.id)).toEqual(order);
    expect(backwards.all.map((entry) => entry.id)).toEqual(order);
    expect([...stages].sort(compareStages).map((entry) => entry.id)).toEqual(order);
  });

  it('refuses a second registration of the same hook id', () => {
    const registry = new IngestStageRegistry([stage('a', 'hash', 'after', { action: 'continue' })]);
    expect(() => registry.register(stage('a', 'ocr', 'after', { action: 'continue' }))).toThrowError(
      /already registered/u,
    );
  });

  it('refuses an anchor that is not one of the ten stages', () => {
    const registry = new IngestStageRegistry();
    expect(() =>
      registry.register(stage('x', 'nonsense' as PipelineAnchor, 'after', { action: 'continue' })),
    ).toThrowError(/which is not one of/u);
  });
});

describe('a stage that continues', () => {
  it('has its patch applied to the proposal and its delta added to the score', async () => {
    const registry = new IngestStageRegistry([
      stage('stamp-reader', 'rules', 'after', {
        action: 'continue',
        patch: { addTags: ['stamped'], itemType: 'report' },
        confidenceDelta: 0.4,
        notes: ['read a stamp in the top right corner'],
      }),
    ]);

    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root },
      stages: registry,
      extractors: [new FakeMetadataExtractor({ fallback: { title: 'Stamped', confidence: 0.4 } })],
    });

    const bytes = makePdf({ lines: scholarlyLines({ title: 'Stamped', doi: '10.1/stamp' }) });
    const report = await pipeline.run([bufferCandidate(bytes, { externalId: 'stamped.pdf' })], {
      runLabel: 'hooks',
    });

    expect(report.outcomes[0]!.outcome.status).toBe('ingested');
    const item = library.db.select().from(schema.items).get()!;
    expect(item.itemType).toBe('report');
    const tags = library.tags.forItem(item.id);
    expect(tags.map((tag) => tag.name)).toContain('stamped');
  });

  it('sees the stages that have already run', async () => {
    const seen: string[][] = [];
    const registry = new IngestStageRegistry([
      {
        id: 'watcher',
        anchor: 'rules',
        position: 'after',
        run: async (input) => {
          seen.push([...input.previousStages]);
          return { action: 'continue' };
        },
      },
    ]);

    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root },
      stages: registry,
      extractors: [new FakeMetadataExtractor({ fallback: { title: 'X', confidence: 0.95 } })],
    });

    await pipeline.run([bufferCandidate(makePdf({ lines: ['Abstract', 'doi:10.1/x'] }))], {
      runLabel: 'previous',
    });

    expect(seen[0]).toEqual([
      'hash',
      'duplicate_check',
      'archive_extraction',
      'type_detection',
      'ocr',
      'metadata_extraction',
      'resolution',
      'rules',
    ]);
  });
});

describe('a stage that asks for review', () => {
  it('writes a review entry and creates no item', async () => {
    const registry = new IngestStageRegistry([
      stage('suspicious', 'commit', 'before', {
        action: 'review',
        reasonCode: 'plugin_requested_review',
        explanation: 'The stamp says CONFIDENTIAL, so a person should decide where this goes.',
      }),
    ]);

    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root },
      stages: registry,
      extractors: [new FakeMetadataExtractor({ fallback: { title: 'Secret', confidence: 0.95 } })],
    });

    const report = await pipeline.run(
      [bufferCandidate(makePdf({ lines: scholarlyLines({ title: 'Secret', doi: '10.1/s' }) }))],
      { runLabel: 'plugin-review' },
    );

    expect(report.outcomes[0]!.outcome.status).toBe('review');
    expect(itemCount()).toBe(0);
    const entry = library.db
      .select()
      .from(reviewQueue)
      .where(eq(reviewQueue.reasonCode, 'plugin_requested_review'))
      .get();
    expect(entry?.explanation).toContain('CONFIDENTIAL');
  });
});

describe('a stage that stops', () => {
  it('files nothing and records why', async () => {
    const registry = new IngestStageRegistry([
      stage('separator-pages', 'type_detection', 'after', {
        action: 'stop',
        reasonCode: 'scanner_separator_page',
        explanation: 'This is the blank sheet the scanner puts between documents.',
      }),
    ]);

    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root },
      stages: registry,
    });

    const report = await pipeline.run([bufferCandidate(makePdf({ salt: 'blank' }))], {
      runLabel: 'stop',
    });

    const outcome = report.outcomes[0]!.outcome;
    expect(outcome.status).toBe('stopped');
    if (outcome.status === 'stopped') expect(outcome.reasonCode).toBe('scanner_separator_page');
    expect(itemCount()).toBe(0);
    // The bytes are still kept: stopping is a decision about filing, not about deletion (P5).
    expect(library.db.select({ n: sql<number>`count(*)` }).from(schema.documents).get()?.n).toBe(1);
  });
});

describe('a stage that throws', () => {
  it('rolls the candidate back and, after the attempt limit, routes it to review', async () => {
    let calls = 0;
    const registry = new IngestStageRegistry([
      {
        id: 'always-throws',
        anchor: 'commit',
        position: 'before',
        run: async () => {
          calls += 1;
          throw new Error('the plugin exploded');
        },
      },
    ]);

    const pipeline = new IngestPipeline({
      recueil: library,
      config: { scratchRoot: library.root, maxAttemptsPerCandidate: 3 },
      stages: registry,
      extractors: [new FakeMetadataExtractor({ fallback: { title: 'Boom', confidence: 0.95 } })],
    });

    const report = await pipeline.run(
      [bufferCandidate(makePdf({ lines: scholarlyLines({ title: 'Boom', doi: '10.1/boom' }) }))],
      { runLabel: 'throwing' },
    );

    expect(calls).toBe(3);
    expect(report.counts.failed).toBe(1);
    expect(itemCount()).toBe(0);

    const entry = library.db
      .select()
      .from(reviewQueue)
      .where(eq(reviewQueue.severity, 'blocker'))
      .get();
    expect(entry?.explanation).toContain('the plugin exploded');
    expect(entry?.proposedAction).toBe('retry');
  });
});
