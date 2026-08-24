/**
 * The office facet on the item routes, and the one constraint that has teeth.
 *
 * `spec/data-model.md` §3.7 makes the archive serial number "unique across live items". A schema
 * that says so and an API that answers 500 when it is broken is a constraint nobody can use, so
 * these tests are about the answer: a 409 that names the item already holding the number, from
 * every route that can set one, and a number that becomes available again when its item is trashed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { body, harness } from './helpers.js';
import type { Harness } from './helpers.js';

const invoice = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  itemType: 'invoice',
  title: 'Stadtwerke, March',
  office: {
    correspondent: 'Stadtwerke Ulm',
    documentDate: '2026-03-12',
    asn: 4711,
    referenceNumber: '2026-0042',
    amountMinor: 8420,
    amountCurrency: 'EUR',
  },
  ...overrides,
});

describe('the office facet on /api/v1/items', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('round-trips every field §5.2 names', async () => {
    const created = await h.app.inject({ method: 'POST', url: '/api/v1/items', payload: invoice() });
    expect(created.statusCode).toBe(201);

    const item = body<{
      id: string;
      office: {
        correspondent: string;
        documentDate: string;
        asn: number;
        referenceNumber: string;
        amountMinor: number;
        amountCurrency: string;
      };
    }>(created);

    expect(item.office).toMatchObject({
      correspondent: 'Stadtwerke Ulm',
      documentDate: '2026-03-12',
      asn: 4711,
      referenceNumber: '2026-0042',
      // Money is an integer plus a currency code, never a float.
      amountMinor: 8420,
      amountCurrency: 'EUR',
    });

    const fetched = body<{ office: { asn: number } }>(
      await h.app.inject({ method: 'GET', url: `/api/v1/items/${item.id}` }),
    );
    expect(fetched.office.asn).toBe(4711);
  });

  it('refuses an amount with no currency', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/v1/items',
      payload: invoice({
        office: { correspondent: 'Stadtwerke Ulm', amountMinor: 8420 },
      }),
    });
    expect(response.statusCode).toBe(422);
  });

  it('finds an item by its archive serial number', async () => {
    const id = body<{ id: string }>(
      await h.app.inject({ method: 'POST', url: '/api/v1/items', payload: invoice() }),
    ).id;

    const found = await h.app.inject({ method: 'GET', url: '/api/v1/items/by-asn/4711' });
    expect(found.statusCode).toBe(200);
    expect(body<{ id: string }>(found).id).toBe(id);

    expect((await h.app.inject({ method: 'GET', url: '/api/v1/items/by-asn/9999' })).statusCode).toBe(404);
  });

  it('refuses a duplicate ASN on create, naming the item that holds it', async () => {
    const first = body<{ id: string }>(
      await h.app.inject({ method: 'POST', url: '/api/v1/items', payload: invoice() }),
    );

    const clash = await h.app.inject({
      method: 'POST',
      url: '/api/v1/items',
      payload: invoice({ title: 'A different bill' }),
    });

    expect(clash.statusCode).toBe(409);
    expect(clash.headers['content-type']).toMatch(/application\/problem\+json/u);

    const problem = body<{ type: string; title: string; detail: string }>(clash);
    expect(problem.title).toBe('Conflict');
    expect(problem.detail).toContain('4711');
    expect(problem.detail).toContain(first.id);

    // And nothing was created: the refusal is a refusal, not a partial write.
    const items = h.recueil.connection.prepare('select count(*) as n from items').get() as { n: number };
    expect(items.n).toBe(1);
  });

  it('refuses a duplicate ASN on a whole-item update', async () => {
    await h.app.inject({ method: 'POST', url: '/api/v1/items', payload: invoice() });
    const other = body<{ id: string }>(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/items',
        payload: invoice({ title: 'April', office: { correspondent: 'Stadtwerke Ulm', asn: 4712 } }),
      }),
    );

    const clash = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/items/${other.id}`,
      payload: { office: { asn: 4711 } },
    });
    expect(clash.statusCode).toBe(409);

    // The item kept its own number.
    const unchanged = body<{ office: { asn: number } }>(
      await h.app.inject({ method: 'GET', url: `/api/v1/items/${other.id}` }),
    );
    expect(unchanged.office.asn).toBe(4712);
  });

  it('refuses a duplicate ASN on a facet write', async () => {
    await h.app.inject({ method: 'POST', url: '/api/v1/items', payload: invoice() });
    const other = body<{ id: string }>(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/items',
        payload: invoice({ title: 'April', office: { correspondent: 'Stadtwerke Ulm', asn: 4712 } }),
      }),
    );

    const clash = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/items/${other.id}/office`,
      payload: { values: { asn: 4711 }, provenance: { source: 'manual' } },
    });
    expect(clash.statusCode).toBe(409);
    expect(body<{ detail: string }>(clash).detail).toContain('4711');
  });

  it('lets an item keep the number it already has', async () => {
    const id = body<{ id: string }>(
      await h.app.inject({ method: 'POST', url: '/api/v1/items', payload: invoice() }),
    ).id;

    // Re-saving the same number on the same item is not a conflict with itself.
    const again = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/items/${id}/office`,
      payload: { values: { asn: 4711, referenceNumber: '2026-0042-a' } },
    });
    expect(again.statusCode).toBe(200);
  });

  it('frees the number when the item is trashed, and refuses the restore that would clash', async () => {
    const first = body<{ id: string }>(
      await h.app.inject({ method: 'POST', url: '/api/v1/items', payload: invoice() }),
    );

    expect(
      (await h.app.inject({ method: 'POST', url: `/api/v1/items/${first.id}/trash` })).statusCode,
    ).toBe(200);

    // The constraint is over *live* items, so the number is available again (P5, §3.7).
    const reused = await h.app.inject({
      method: 'POST',
      url: '/api/v1/items',
      payload: invoice({ title: 'The paper was refiled' }),
    });
    expect(reused.statusCode).toBe(201);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/items/by-asn/4711' })).statusCode).toBe(200);
    expect(body<{ id: string }>(await h.app.inject({ method: 'GET', url: '/api/v1/items/by-asn/4711' })).id)
      .toBe(body<{ id: string }>(reused).id);

    // Restoring the trashed one would put two live items on one number. The index refuses it, and
    // the refusal is a 409 rather than a 500 — which is the whole point of translating it.
    const restored = await h.app.inject({ method: 'POST', url: `/api/v1/items/${first.id}/restore` });
    expect(restored.statusCode).toBe(409);
  });
});
