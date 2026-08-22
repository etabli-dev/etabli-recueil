/**
 * Field-level provenance and the manual lock (§3.6, P4).
 *
 * This is the file that decides whether CONCEPT §5.4's "manual edits locked per field and never
 * overwritten" is true. The four assertions map one-to-one onto the four invariants:
 *
 * - P4-1: every bibliographic write leaves a provenance row, and a manual one locks the field;
 * - P4-2: a resolver's write is refused on a locked field, and a human's is not;
 * - P4-3: unlocking is explicit, audited, and lets the resolver back in;
 * - P4-4: what was refused is reported to the caller, not silently dropped.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { schema } from '../src/index.js';
import { makeLibrary } from './helpers.js';
import type { TestLibrary } from './helpers.js';

let library: TestLibrary;

beforeEach(() => {
  library = makeLibrary();
});

afterEach(() => {
  library.dispose();
});

const article = () =>
  library.library.createItem(
    {
      itemType: 'article',
      bibliographic: {
        title: 'Early antibiotics in sepsis',
        doi: '10.1136/bmj.n71',
        containerTitle: 'BMJ',
      },
    },
    library.actor,
  );

describe('provenance — P4-1: every write is recorded', () => {
  it('writes a provenance row for every bibliographic field, on create', () => {
    const created = article();
    const provenance = library.library.bibliographicProvenance(created.item.id);

    expect(Object.keys(provenance).sort()).toEqual(['containerTitle', 'doi', 'title']);
    for (const row of Object.values(provenance)) {
      expect(row.source).toBe('manual');
      expect(row.entityType).toBe('item_bibliographic');
      expect(row.entityId).toBe(created.item.id);
      expect(row.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
      expect(row.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    }
  });

  it('records the resolver, its confidence and its record id when one writes', () => {
    const created = article();
    library.library.writeBibliographic(
      created.item.id,
      { abstract: 'Antibiotics within one hour.' },
      library.actor,
      {
        provenance: {
          source: 'crossref',
          sourceRecordId: '10.1136/bmj.n71',
          sourceVersion: '2026-01-04',
          confidence: 0.92,
          fetchedAt: '2026-01-04T00:00:00.000Z',
        },
      },
    );

    const row = library.library.bibliographicProvenance(created.item.id)['abstract'];
    expect(row?.source).toBe('crossref');
    expect(row?.sourceRecordId).toBe('10.1136/bmj.n71');
    expect(row?.sourceVersion).toBe('2026-01-04');
    expect(row?.confidence).toBeCloseTo(0.92);
    expect(row?.fetchedAt).toBe('2026-01-04T00:00:00.000Z');
    // An automated write does not lock: only a human's does (P4-1).
    expect(row?.locked).toBe(false);
  });

  it('locks a hand-typed value by the act of typing it, and keeps what it replaced', () => {
    const created = article();
    library.library.writeBibliographic(created.item.id, { volume: '372' }, library.actor);
    library.library.writeBibliographic(created.item.id, { volume: '373' }, library.actor);

    const row = library.library.bibliographicProvenance(created.item.id)['volume'];
    expect(row?.locked).toBe(true);
    expect(row?.lockedAt).not.toBeNull();
    expect(row?.lockedByUserId).toBe(library.user.id);
    expect(row?.previousValue).toBe('372');
  });

  it('records provenance for the office facet too', () => {
    const created = library.library.createItem(
      { itemType: 'invoice', office: { correspondent: 'Stadtwerke Ulm', asn: 4711 } },
      library.actor,
    );

    const provenance = library.library.officeProvenance(created.item.id);
    expect(Object.keys(provenance).sort()).toEqual(['asn', 'correspondent']);
    expect(provenance['correspondent']?.locked).toBe(true);
  });
});

describe('provenance — P4-2: a lock refuses a resolver but not a human', () => {
  it('blocks an automated overwrite of a locked field and leaves the value alone', () => {
    const created = article();
    expect(library.library.lockedBibliographicFields(created.item.id).sort()).toEqual([
      'containerTitle',
      'doi',
      'title',
    ]);

    const outcome = library.library.writeBibliographic(
      created.item.id,
      { title: 'Something a resolver invented', abstract: 'A new abstract.' },
      library.actor,
      { provenance: { source: 'openalex', confidence: 0.8 } },
    );

    // The locked field is untouched; the unlocked one is written.
    expect(outcome.record.bibliographic?.title).toBe('Early antibiotics in sepsis');
    expect(outcome.record.bibliographic?.abstract).toBe('A new abstract.');
    // I3: the item's mirrored title did not move either.
    expect(library.library.getItem(created.item.id).item.title).toBe('Early antibiotics in sepsis');
    // The lock's own provenance row is not overwritten by the refused write.
    expect(library.library.bibliographicProvenance(created.item.id)['title']?.source).toBe('manual');
  });

  it('lets a human overwrite the same field', () => {
    const created = article();

    const outcome = library.library.writeBibliographic(
      created.item.id,
      { title: 'Early antibiotics in sepsis: a reappraisal' },
      library.actor,
    );

    expect(outcome.skipped).toHaveLength(0);
    expect(outcome.record.bibliographic?.title).toBe('Early antibiotics in sepsis: a reappraisal');
    expect(library.library.getItem(created.item.id).item.title).toBe(
      'Early antibiotics in sepsis: a reappraisal',
    );
  });

  it('lets a resolver write a field no one has claimed, then refuses the next resolver only if locked', () => {
    const created = library.library.createItem({ itemType: 'article' }, library.actor);

    const first = library.library.writeBibliographic(
      created.item.id,
      { issn: '0959-8138' },
      library.actor,
      { provenance: { source: 'crossref' } },
    );
    expect(first.applied).toContain('bibliographic.issn');

    // Unlocked, so a second resolver may correct it.
    const second = library.library.writeBibliographic(
      created.item.id,
      { issn: '1756-1833' },
      library.actor,
      { provenance: { source: 'openalex' } },
    );
    expect(second.skipped).toHaveLength(0);
    expect(second.record.bibliographic?.issn).toBe('1756-1833');

    // A resolver may ask for a lock explicitly; after that, the next one is refused.
    library.library.writeBibliographic(created.item.id, { issn: '0959-8138' }, library.actor, {
      provenance: { source: 'crossref', lock: true },
    });
    const third = library.library.writeBibliographic(
      created.item.id,
      { issn: '9999-9999' },
      library.actor,
      { provenance: { source: 'openalex' } },
    );
    expect(third.skipped.map((entry) => entry.fieldPath)).toEqual(['issn']);
    expect(third.record.bibliographic?.issn).toBe('0959-8138');
  });
});

describe('provenance — P4-3 and P4-4', () => {
  it('reports every refusal to the caller, with the source holding the lock (P4-4)', () => {
    const created = article();

    const outcome = library.library.writeBibliographic(
      created.item.id,
      { title: 'x', doi: '10.9999/nope', containerTitle: 'Nope', abstract: 'allowed' },
      library.actor,
      { provenance: { source: 'plugin:resolver-openalex' } },
    );

    expect(outcome.skipped.map((entry) => entry.fieldPath).sort()).toEqual([
      'containerTitle',
      'doi',
      'title',
    ]);
    for (const entry of outcome.skipped) {
      expect(entry.lockedBy).toBe('manual');
      expect(entry.lockedAt).not.toBeNull();
    }
    expect(outcome.applied).toEqual(['bibliographic.abstract']);
  });

  it('names the refusals in the audit trail as well as the return value', () => {
    const created = article();
    library.library.writeBibliographic(created.item.id, { doi: '10.9999/nope' }, library.actor, {
      provenance: { source: 'crossref' },
    });

    const entry = library.audit
      .forEntity('item', created.item.id)
      .find((row) => row.action === 'item.updated');
    expect(entry).toBeDefined();
    const after = JSON.parse(entry?.after ?? '{}') as { skippedLockedFields?: Array<{ fieldPath: string }> };
    expect(after.skippedLockedFields?.map((row) => row.fieldPath)).toEqual(['doi']);
  });

  it('unlocks explicitly, audits it, and lets the resolver back in (P4-3)', () => {
    const created = article();

    const unlocked = library.library.unlockBibliographicField(created.item.id, 'doi', library.actor);
    expect(unlocked.locked).toBe(false);
    expect(unlocked.lockedAt).toBeNull();

    const audit = library.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'field.unlocked'))
      .all();
    expect(audit).toHaveLength(1);

    const outcome = library.library.writeBibliographic(
      created.item.id,
      { doi: '10.9999/corrected' },
      library.actor,
      { provenance: { source: 'crossref' } },
    );
    expect(outcome.skipped).toHaveLength(0);
    expect(outcome.record.bibliographic?.doi).toBe('10.9999/corrected');
    // P4-3: the previous value is retained on the provenance row.
    expect(library.library.bibliographicProvenance(created.item.id)['doi']?.previousValue).toBe(
      '10.1136/bmj.n71',
    );
  });

  it('locks a resolver-written field on request, and refuses to lock a field never written', () => {
    const created = library.library.createItem({ itemType: 'article' }, library.actor);
    library.library.writeBibliographic(created.item.id, { pmid: '33782057' }, library.actor, {
      provenance: { source: 'pubmed' },
    });

    const locked = library.library.lockBibliographicField(created.item.id, 'pmid', library.actor);
    expect(locked.locked).toBe(true);

    expect(() =>
      library.library.lockBibliographicField(created.item.id, 'issue', library.actor),
    ).toThrow(/nothing to lock/iu);
  });

  it('keeps one current row per field, however many times it is written', () => {
    const created = article();
    for (const volume of ['1', '2', '3', '4']) {
      library.library.writeBibliographic(created.item.id, { volume }, library.actor);
    }

    const rows = library.db
      .select()
      .from(schema.fieldProvenance)
      .where(eq(schema.fieldProvenance.entityId, created.item.id))
      .all()
      .filter((row) => row.fieldPath === 'volume');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.previousValue).toBe('3');
  });
});
