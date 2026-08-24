/**
 * The review queue (P3, `spec/data-model.md` §6.1).
 *
 * The two invariants worth testing are the ones a re-run depends on: at most one *open* entry per
 * problem, and superseding recorded rather than silent.
 */
import { schema } from '@recueil/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ReviewQueueService, ensureIngestSchema, reviewDedupeKey, reviewQueue } from '../src/index.js';
import { makeLibrary } from './helpers.js';
import type { TestLibrary } from './helpers.js';

let library: TestLibrary;
let queue: ReviewQueueService;

beforeEach(() => {
  library = makeLibrary();
  ensureIngestSchema(library.connection);
  queue = new ReviewQueueService(library.db, library.audit);
});

afterEach(() => {
  library.dispose();
});

const raise = (overrides: Partial<Parameters<ReviewQueueService['raise']>[0]> = {}) =>
  queue.raise({
    subjectType: 'document',
    subjectId: 'doc-1',
    reasonCode: 'low_confidence_metadata',
    explanation: 'The pipeline was not sure.',
    proposedAction: 'create_item',
    confidence: 0.4,
    sourceStage: 'ingest.9',
    actor: library.actor,
    ...overrides,
  });

describe('ensureIngestSchema', () => {
  it('is idempotent', () => {
    expect(() => {
      ensureIngestSchema(library.connection);
      ensureIngestSchema(library.connection);
    }).not.toThrow();
  });

  it('refuses a table that exists but is missing a column', () => {
    const fresh = makeLibrary();
    try {
      fresh.connection.exec('create table review_queue (id text primary key)');
      expect(() => ensureIngestSchema(fresh.connection)).toThrowError(/is missing/u);
    } finally {
      fresh.dispose();
    }
  });
});

describe('raising an entry', () => {
  it('stores the sentence, the proposal and the stage', () => {
    const row = raise();
    expect(row.status).toBe('open');
    expect(row.explanation).toBe('The pipeline was not sure.');
    expect(row.sourceStage).toBe('ingest.9');
    expect(row.severity).toBe('warning');
    expect(row.dedupeKey).toBe(
      reviewDedupeKey({
        subjectType: 'document',
        subjectId: 'doc-1',
        reasonCode: 'low_confidence_metadata',
      }),
    );
  });

  it('writes an audit row carrying the reason', () => {
    const row = raise();
    const audit = library.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, row.id))
      .all();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('review_queue.raised');
    expect(audit[0]!.reason).toBe('The pipeline was not sure.');
  });

  it('refreshes the open entry instead of opening a second one for the same problem', () => {
    const first = raise();
    const second = raise({ explanation: 'Still not sure, and now for a better reason.', confidence: 0.5 });

    expect(second.id).toBe(first.id);
    expect(second.explanation).toBe('Still not sure, and now for a better reason.');
    expect(library.db.select().from(reviewQueue).all()).toHaveLength(1);
  });

  it('opens a new entry for a different reason on the same subject', () => {
    raise();
    raise({ reasonCode: 'ocr_failed', explanation: 'OCR fell over.' });
    expect(library.db.select().from(reviewQueue).all()).toHaveLength(2);
  });

  it('lets a resolved problem come back', () => {
    const first = raise();
    queue.supersede([first.id], { actor: library.actor, note: 'fixed by a later run' });
    const second = raise();
    expect(second.id).not.toBe(first.id);
    expect(library.db.select().from(reviewQueue).where(eq(reviewQueue.status, 'open')).all()).toHaveLength(
      1,
    );
  });
});

describe('superseding', () => {
  it('records who did it and why, rather than closing the entry silently (RQ2)', () => {
    const row = raise();
    const closed = queue.supersede([row.id], { actor: library.actor, note: 'the file reappeared' });

    expect(closed).toBe(1);
    const after = queue.get(row.id)!;
    expect(after.status).toBe('superseded');
    expect(after.resolutionNote).toBe('the file reappeared');
    expect(after.resolvedAt).not.toBeNull();

    const audit = library.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'review_queue.superseded'))
      .all();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.reason).toBe('the file reappeared');
  });

  it('does nothing to an entry that is already closed', () => {
    const row = raise();
    queue.supersede([row.id], { actor: library.actor, note: 'once' });
    expect(queue.supersede([row.id], { actor: library.actor, note: 'twice' })).toBe(0);
  });
});

describe('listing', () => {
  it('filters by status, reason and subject', () => {
    raise();
    raise({ subjectId: 'doc-2', reasonCode: 'ocr_failed', explanation: 'no text' });
    expect(queue.list({ status: 'open' })).toHaveLength(2);
    expect(queue.list({ reasonCode: 'ocr_failed' })).toHaveLength(1);
    expect(queue.openForSubject('document', 'doc-2')).toHaveLength(1);
  });
});
