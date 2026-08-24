/**
 * `/api/v1/rules` — the rule table, the dry run, and the proof that a stored rule really runs.
 *
 * The last of those is the point of the file. A CRUD surface over a rule table is easy to write and
 * worthless if nothing reads it, so the final describe uploads a document through the real pipeline
 * and asserts that the stored rule filed it — the same rule the dry run predicted, evaluated by the
 * same engine.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { body, harness, multipart } from './helpers.js';
import type { Harness } from './helpers.js';

const INVOICE_RULE = {
  ruleId: 'stadtwerke-invoices',
  kind: 'ingestion' as const,
  description: 'Utility bills from the Stadtwerke',
  priority: 10,
  when: { type: 'text', match: { contains: 'Stadtwerke' } },
  then: [
    { type: 'set-item-type', itemType: 'invoice' },
    { type: 'add-tags', tags: ['utilities', 'ulm'] },
    { type: 'set-correspondent', correspondent: 'Stadtwerke Ulm' },
  ],
};

const SUBJECTS = [
  { id: 'a', text: 'Rechnung der Stadtwerke Ulm', path: '/consume/a.pdf', mime: 'application/pdf' },
  { id: 'b', text: 'A conference proceedings paper', path: '/consume/b.pdf', mime: 'application/pdf' },
];

describe('/api/v1/rules', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });

  afterEach(async () => {
    await h.close();
  });

  const create = async (overrides: Record<string, unknown> = {}) =>
    h.app.inject({ method: 'POST', url: '/api/v1/rules', payload: { ...INVOICE_RULE, ...overrides } });

  it('stores a rule in the engine’s own format', async () => {
    const response = await create();
    expect(response.statusCode).toBe(201);

    const rule = body<{ id: string; ruleId: string; priority: number; enabled: boolean; then: unknown[] }>(
      response,
    );
    expect(rule.ruleId).toBe('stadtwerke-invoices');
    expect(rule.priority).toBe(10);
    expect(rule.enabled).toBe(true);
    expect(rule.then).toHaveLength(3);
    expect(response.headers['location']).toBe(`/api/v1/rules/${rule.id}`);
  });

  it('refuses a rule the engine could not run', async () => {
    const response = await create({ then: [{ type: 'set-item-type' }] });
    expect(response.statusCode).toBe(422);

    const problem = body<{ errors: { path: string; message: string }[] }>(response);
    expect(problem.errors.length).toBeGreaterThan(0);
    // The path names the offending part rather than the whole body.
    expect(problem.errors[0]?.path.startsWith('body')).toBe(true);
  });

  it('refuses a backtracking regular expression', async () => {
    // A catastrophic-backtracking pattern is refused by the linear engine's compiler, not accepted
    // and then run slowly. A rule set arrives over the API, so this is a real defence.
    const response = await create({
      when: { type: 'text', match: { matches: '(?=lookahead)x' } },
    });
    expect(response.statusCode).toBe(422);
    expect(body<{ detail: string }>(response).detail).toMatch(/lookahead|not supported/iu);
  });

  it('refuses two rules with the same rule id', async () => {
    expect((await create()).statusCode).toBe(201);
    const clash = await create({ description: 'a second one' });
    expect(clash.statusCode).toBe(409);
  });

  it('updates and deletes', async () => {
    const id = body<{ id: string }>(await create()).id;

    const patched = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/rules/${id}`,
      payload: { enabled: false, priority: 50 },
    });
    expect(body<{ enabled: boolean; priority: number; version: number }>(patched)).toMatchObject({
      enabled: false,
      priority: 50,
      version: 2,
    });

    expect((await h.app.inject({ method: 'DELETE', url: `/api/v1/rules/${id}` })).statusCode).toBe(204);
    expect((await h.app.inject({ method: 'GET', url: `/api/v1/rules/${id}` })).statusCode).toBe(404);

    const audit = h.recueil.connection
      .prepare(`select action from audit_log where entity_type = 'rule' order by id`)
      .all() as { action: string }[];
    expect(audit.map((row) => row.action)).toEqual(['rule.created', 'rule.updated', 'rule.removed']);
  });

  it('lists in evaluation order', async () => {
    await create({ ruleId: 'low', priority: 1 });
    await create({ ruleId: 'high', priority: 99 });
    await create({ ruleId: 'middle', priority: 50 });

    const listed = body<{ data: { ruleId: string; priority: number }[] }>(
      await h.app.inject({ method: 'GET', url: '/api/v1/rules' }),
    );
    expect(listed.data.map((rule) => rule.ruleId)).toEqual(['low', 'middle', 'high']);
  });
});

describe('POST /api/v1/rules/dry-run', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('returns the engine’s trace for an unsaved rule and writes nothing', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/v1/rules/dry-run',
      payload: { rules: [INVOICE_RULE], subjects: SUBJECTS },
    });
    expect(response.statusCode).toBe(200);

    const report = body<{
      ruleSet: string;
      subjectCount: number;
      entries: {
        subjectId: string;
        outcome: { itemType?: { value: string }; tags: { value: string }[]; untouched: boolean };
        trace: { rules: { ruleId: string; outcome: string }[]; matchedRuleIds: string[] };
      }[];
      rules: { ruleId: string; matched: number; notMatched: number }[];
      unmatchedSubjectIds: string[];
    }>(response);

    expect(report.ruleSet).toBe('inline');
    expect(report.subjectCount).toBe(2);

    const matched = report.entries.find((entry) => entry.subjectId === 'a');
    expect(matched?.outcome.itemType?.value).toBe('invoice');
    expect(matched?.outcome.tags.map((tag) => tag.value)).toEqual(['utilities', 'ulm']);
    expect(matched?.trace.matchedRuleIds).toEqual(['stadtwerke-invoices']);

    const skipped = report.entries.find((entry) => entry.subjectId === 'b');
    expect(skipped?.outcome.untouched).toBe(true);
    expect(skipped?.trace.rules[0]?.outcome).toBe('not-matched');

    // One row per rule whatever its outcome: a rule that never fires is news.
    expect(report.rules).toEqual([
      expect.objectContaining({ ruleId: 'stadtwerke-invoices', matched: 1, notMatched: 1 }),
    ]);
    expect(report.unmatchedSubjectIds).toEqual(['b']);

    // Nothing was stored, structurally: the dry run cannot write because the evaluator holds no
    // database. The assertion is here anyway, because that is the promise the endpoint makes.
    const stored = h.recueil.connection.prepare('select count(*) as n from rules').get() as { n: number };
    expect(stored.n).toBe(0);
  });

  it('runs the stored rules when none are supplied', async () => {
    await h.app.inject({ method: 'POST', url: '/api/v1/rules', payload: INVOICE_RULE });
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/rules',
      payload: { ...INVOICE_RULE, ruleId: 'switched-off', enabled: false },
    });

    const report = body<{ ruleSet: string; rules: { ruleId: string }[] }>(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/rules/dry-run',
        payload: { subjects: SUBJECTS },
      }),
    );
    expect(report.ruleSet).toBe('stored:ingestion');
    expect(report.rules.map((rule) => rule.ruleId)).toEqual(['stadtwerke-invoices']);

    const withDisabled = body<{ rules: { ruleId: string; disabled: number }[] }>(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/rules/dry-run',
        payload: { subjects: SUBJECTS, includeDisabled: true },
      }),
    );
    expect(withDisabled.rules.map((rule) => rule.ruleId).sort()).toEqual([
      'stadtwerke-invoices',
      'switched-off',
    ]);
    // A disabled rule is traced as skipped rather than omitted, which is itself informative.
    expect(withDisabled.rules.find((rule) => rule.ruleId === 'switched-off')?.disabled).toBe(2);
  });

  it('refuses a dedup dry run rather than evaluating the wrong subject', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/v1/rules/dry-run',
      payload: { kind: 'dedup', subjects: SUBJECTS },
    });
    expect(response.statusCode).toBe(422);
    expect(body<{ detail: string }>(response).detail).toMatch(/candidate pairs/iu);
  });
});

describe('a stored rule and the pipeline', () => {
  let h: Harness;

  beforeEach(async () => {
    // A gate of zero, so the assertion is about what the rule did and not about the confidence
    // score: the review path is covered in `ingestion.test.ts`.
    h = await harness({ env: { RECUEIL_INGEST_CONFIDENCE_THRESHOLD: '0' } });
  });

  afterEach(async () => {
    await h.close();
  });

  it('files an upload the way the dry run said it would', async () => {
    await h.app.inject({ method: 'POST', url: '/api/v1/rules', payload: INVOICE_RULE });

    const text = 'Stadtwerke Ulm\nRechnung Nr. 2026-0042\nBetrag: 84,20 EUR';

    // What the dry run predicts…
    const predicted = body<{ entries: { outcome: { itemType?: { value: string } } }[] }>(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/rules/dry-run',
        payload: { subjects: [{ id: 'x', text, filename: 'invoice.txt', mime: 'text/plain' }] },
      }),
    );
    expect(predicted.entries[0]?.outcome.itemType?.value).toBe('invoice');

    // …is what the pipeline does.
    const part = multipart({
      name: 'file',
      filename: 'invoice.txt',
      contentType: 'text/plain',
      bytes: text,
    });
    const uploaded = await h.app.inject({
      method: 'POST',
      url: '/api/v1/ingestion/upload',
      payload: part.payload,
      headers: part.headers,
    });
    expect(uploaded.statusCode).toBe(201);

    const result = body<{ outcome: string; item: { id: string } | null }>(uploaded);
    expect(result.outcome).toBe('ingested');

    const item = body<{ itemType: string; office: { correspondent: string } | null; tags: unknown }>(
      await h.app.inject({ method: 'GET', url: `/api/v1/items/${result.item?.id ?? ''}` }),
    );
    expect(item.itemType).toBe('invoice');
    expect(item.office?.correspondent).toBe('Stadtwerke Ulm');

    const tags = body<{ data: { name: string }[] }>(
      await h.app.inject({ method: 'GET', url: `/api/v1/items/${result.item?.id ?? ''}/tags` }),
    );
    expect(tags.data.map((tag) => tag.name).sort()).toEqual(['ulm', 'utilities']);
  });

  it('files nothing extra when the rule does not match', async () => {
    await h.app.inject({ method: 'POST', url: '/api/v1/rules', payload: INVOICE_RULE });

    const part = multipart({
      name: 'file',
      filename: 'paper.txt',
      contentType: 'text/plain',
      bytes: 'A conference proceedings paper about nothing in particular.',
    });
    const uploaded = await h.app.inject({
      method: 'POST',
      url: '/api/v1/ingestion/upload',
      payload: part.payload,
      headers: part.headers,
    });

    const result = body<{ item: { id: string } | null }>(uploaded);
    const item = body<{ itemType: string; office: unknown }>(
      await h.app.inject({ method: 'GET', url: `/api/v1/items/${result.item?.id ?? ''}` }),
    );
    expect(item.itemType).not.toBe('invoice');
    expect(item.office).toBeNull();
  });
});
