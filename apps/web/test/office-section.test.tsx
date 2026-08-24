/**
 * The office section of the item pane.
 *
 * The interesting assertions are the two that keep the facet honest on the wire: a patch carries
 * only the field that changed, because a manual write locks every field it mentions (P4-1), and the
 * amount is written as one fact, because `ck_item_office_amount` refuses a value without a currency
 * and a currency without a value.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Item, OfficeFacet } from '@recueil/schemas';

import { OfficeSection } from '../src/item-pane/sections/office.js';
import { createFakeServer } from './fake-server.js';
import type { FakeServer } from './fake-server.js';
import { expandedItem, ITEM_ID } from './fixtures.js';
import { renderWithApi } from './helpers.js';

const NOW = '2026-08-22T09:15:00.000Z';

const officeFacet = (overrides: Partial<OfficeFacet> = {}): OfficeFacet => ({
  correspondent: 'Acme GmbH',
  officeDocumentType: 'invoice',
  documentDate: '2026-07-02',
  asn: 1042,
  referenceNumber: 'RE-2026-114',
  amountMinor: 129_900,
  amountCurrency: 'EUR',
  correspondentNormalised: 'acme gmbh',
  createdAt: NOW,
  updatedAt: NOW,
  lockedFields: ['asn'],
  provenance: {
    correspondent: { source: 'ingest.rules', confidence: 0.6, fetchedAt: NOW, appliedAt: NOW, locked: false },
    asn: { source: 'manual', fetchedAt: NOW, appliedAt: NOW, locked: true, lockedAt: NOW },
  },
  ...overrides,
});

const invoice = (facet: OfficeFacet | null = officeFacet()): Item =>
  expandedItem({ itemType: 'invoice', bibliographic: null, office: facet, title: 'Invoice RE-2026-114' });

const renderSection = (item: Item, routes = {}): { server: FakeServer } => {
  const server = createFakeServer({
    [`PATCH /api/v1/items/${ITEM_ID}`]: (request) => ({
      ...item,
      version: item.version + 1,
      office: { ...(item.office ?? officeFacet()), ...(request.body as { office: object }).office },
    }),
    ...routes,
  });
  renderWithApi(<OfficeSection item={item} />, server);
  return { server };
};

describe('the office section', () => {
  it('shows the five fields CONCEPT.md §5.2 names for the facet', () => {
    renderSection(invoice());
    expect(screen.getByLabelText('Correspondent')).toHaveValue('Acme GmbH');
    expect(screen.getByLabelText('Document date')).toHaveValue('2026-07-02');
    expect(screen.getByLabelText('ASN')).toHaveValue('1042');
    expect(screen.getByLabelText('Reference number')).toHaveValue('RE-2026-114');
    expect(screen.getByLabelText('Amount')).toHaveValue('1299.00');
    expect(screen.getByLabelText('Currency')).toHaveValue('EUR');
  });

  it('shows where a value came from, and how sure the extractor was', () => {
    renderSection(invoice());
    const row = screen.getByTestId('field-correspondent');
    expect(within(row).getByText(/from ingest.rules/u)).toBeInTheDocument();
    expect(within(row).getByText(/confidence 0.60/u)).toBeInTheDocument();
  });

  it('marks a locked field and offers to release it against the office facet', async () => {
    const user = userEvent.setup();
    const { server } = renderSection(invoice(), {
      [`DELETE /api/v1/items/${ITEM_ID}/locks/asn`]: () => undefined,
      [`GET /api/v1/items/${ITEM_ID}`]: () => invoice(),
    });

    expect(screen.getByTestId('lock-asn')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Unlock ASN' }));

    await waitFor(() => {
      expect(server.requestsTo('DELETE', `/api/v1/items/${ITEM_ID}/locks/asn`)).toHaveLength(1);
    });
    // The facet must be named: the server defaults to bibliographic, where there is no `asn`.
    expect(server.requestsTo('DELETE', `/api/v1/items/${ITEM_ID}/locks/asn`)[0]?.query.get('facet')).toBe('office');
  });

  it('sends a patch carrying only the field that changed', async () => {
    const user = userEvent.setup();
    const { server } = renderSection(invoice());

    const field = screen.getByLabelText('Reference number');
    await user.clear(field);
    await user.type(field, 'RE-2026-115');
    await user.tab();

    await waitFor(() => {
      expect(server.requestsTo('PATCH', `/api/v1/items/${ITEM_ID}`)).toHaveLength(1);
    });
    const request = server.requestsTo('PATCH', `/api/v1/items/${ITEM_ID}`)[0];
    expect(request?.body).toEqual({ office: { referenceNumber: 'RE-2026-115' } });
    expect(request?.headers['if-match']).toBe('"7"');
  });

  it('writes an emptied field as null rather than an empty string', async () => {
    const user = userEvent.setup();
    const { server } = renderSection(invoice());

    await user.clear(screen.getByLabelText('Reference number'));
    await user.tab();

    await waitFor(() => {
      expect(server.requestsTo('PATCH', `/api/v1/items/${ITEM_ID}`)[0]?.body).toEqual({
        office: { referenceNumber: null },
      });
    });
  });

  it('writes the amount and its currency in one patch', async () => {
    const user = userEvent.setup();
    const { server } = renderSection(invoice());

    const amount = screen.getByLabelText('Amount');
    await user.clear(amount);
    await user.type(amount, '1450.50');
    await user.tab();

    await waitFor(() => {
      expect(server.requestsTo('PATCH', `/api/v1/items/${ITEM_ID}`)).toHaveLength(1);
    });
    expect(server.requestsTo('PATCH', `/api/v1/items/${ITEM_ID}`)[0]?.body).toEqual({
      office: { amountMinor: 145_050, amountCurrency: 'EUR' },
    });
  });

  it('refuses an amount with no currency locally, rather than sending a body the server must reject', async () => {
    const user = userEvent.setup();
    const { server } = renderSection(invoice(officeFacet({ amountMinor: null, amountCurrency: null })));

    const amount = screen.getByLabelText('Amount');
    await user.clear(amount);
    await user.type(amount, '99.00');
    await user.tab();

    expect(await screen.findByRole('alert')).toHaveTextContent('three-letter currency code');
    expect(server.requestsTo('PATCH', `/api/v1/items/${ITEM_ID}`)).toHaveLength(0);
  });

  it('clears both halves of the amount together', async () => {
    const user = userEvent.setup();
    const { server } = renderSection(invoice());

    await user.clear(screen.getByLabelText('Amount'));
    await user.clear(screen.getByLabelText('Currency'));
    await user.tab();

    await waitFor(() => {
      expect(server.requestsTo('PATCH', `/api/v1/items/${ITEM_ID}`)[0]?.body).toEqual({
        office: { amountMinor: null, amountCurrency: null },
      });
    });
  });

  it('says so when the item has no office facet', () => {
    renderSection(invoice(null));
    expect(screen.getByText('This item has no office facet.')).toBeInTheDocument();
  });
});

describe('the office section as a registered item-pane section', () => {
  it('applies to an item with the facet and declines one without it (I1)', async () => {
    const { itemPaneSections } = await import('../src/item-pane/registry.js');
    const { registerCoreSections } = await import('../src/item-pane/sections/index.js');
    registerCoreSections();

    const section = itemPaneSections.all().find((candidate) => candidate.id === 'core.office');
    expect(section).toBeDefined();
    expect(section?.isVisible?.(invoice())).toBe(true);
    expect(section?.isVisible?.(expandedItem())).toBe(false);
  });
});
