/**
 * The Zotero Connector endpoints (ADR-0006).
 *
 * These tests assert what this implementation *does*, against payloads shaped like the ones the
 * extension sends: that a translator's output becomes a correct library record, and that the
 * handshake answers in the shape `routes/connector.ts` documents. On their own they are Recueil
 * agreeing with Recueil, so the compatibility half lives next door in `connector-upstream.test.ts`,
 * which runs verbatim upstream code over these same responses.
 *
 * The payloads below are the ones a real translator emits: the field names, the two creator forms
 * (`firstName`/`lastName` and single-field `name`), and the tag and note shapes.
 */
import { describe, expect, it } from 'vitest';

import { parseZoteroDate } from '../src/routes/connector.js';
import { body, harness } from './helpers.js';

const JOURNAL_ARTICLE = {
  itemType: 'journalArticle',
  title: 'The PRISMA 2020 statement: an updated guideline for reporting systematic reviews',
  creators: [
    { firstName: 'Matthew J', lastName: 'Page', creatorType: 'author' },
    { firstName: 'Joanne E', lastName: 'McKenzie', creatorType: 'author' },
    { name: 'The PRISMA Group', creatorType: 'contributor' },
  ],
  publicationTitle: 'BMJ',
  volume: '372',
  pages: 'n71',
  date: 'March 29, 2021',
  DOI: 'https://doi.org/10.1136/BMJ.N71',
  ISSN: '1756-1833',
  abstractNote: 'The PRISMA statement was published in 2009.',
  url: 'https://www.bmj.com/content/372/bmj.n71',
  language: 'en',
  libraryCatalog: 'www.bmj.com',
  accessDate: '2026-08-22T09:00:00Z',
  tags: [{ tag: 'systematic review', type: 1 }, { tag: 'reporting' }],
  notes: [{ note: '<p>Read the checklist.</p>' }],
  attachments: [{ title: 'Full Text PDF', mimeType: 'application/pdf', url: 'https://example.org/n71.pdf' }],
  extra: 'PMID: 33782057',
};

describe('parseZoteroDate', () => {
  it('keeps an unambiguous EDTF date and extracts a year from prose', () => {
    expect(parseZoteroDate('2021-03-29')).toEqual({ issuedDate: '2021-03-29', issuedYear: 2021 });
    expect(parseZoteroDate('2021')).toEqual({ issuedDate: '2021', issuedYear: 2021 });
    expect(parseZoteroDate('March 29, 2021')).toEqual({ issuedDate: '2021', issuedYear: 2021 });
    expect(parseZoteroDate('n.d.')).toEqual({});
    expect(parseZoteroDate(undefined)).toEqual({});
  });
});

describe('/connector/ping', () => {
  it('answers the handshake on both verbs and announces a client version', async () => {
    const h = await harness();
    try {
      for (const method of ['GET', 'POST'] as const) {
        const response = await h.app.inject({ method, url: '/connector/ping', payload: method === 'POST' ? {} : undefined });
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toMatch(/application\/json/u);
        expect(response.headers['x-zotero-version']).toBeTypeOf('string');

        const prefs = body(response).prefs as Record<string, unknown>;
        expect(prefs.automaticSnapshots).toBe(true);
        // Answered with what this server can actually do rather than with what would light up the
        // most buttons in the extension.
        expect(prefs.googleDocsAddNoteEnabled).toBe(false);
        expect(prefs.supportsAttachmentUpload).toBe(false);
      }
    } finally {
      await h.close();
    }
  });

  it('needs no credential even when the rest of the API does', async () => {
    const h = await harness({ env: { RECUEIL_REQUIRE_AUTH: 'true' } });
    try {
      expect((await h.app.inject({ method: 'POST', url: '/connector/ping', payload: {} })).statusCode).toBe(200);
    } finally {
      await h.close();
    }
  });
});

describe('/connector/getSelectedCollection', () => {
  it('answers with the library root', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({
        method: 'POST',
        url: '/connector/getSelectedCollection',
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const target = body(response);
      expect(target.id).toBeNull();
      expect(target.editable).toBe(true);
      expect(target.libraryEditable).toBe(true);
      expect(target.name).toBeTypeOf('string');
      // `targets` is not optional — see `connector-upstream.test.ts` and the captured fixture.
      expect(target.targets).toEqual([
        { id: 'L1', name: target.name, filesEditable: true, level: 0 },
      ]);
      expect(target.tags).toEqual({ L1: [] });
    } finally {
      await h.close();
    }
  });
});

describe('/connector/saveItems', () => {
  it('turns a translator’s item into a library record', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({
        method: 'POST',
        url: '/connector/saveItems',
        payload: {
          items: [JOURNAL_ARTICLE],
          uri: 'https://www.bmj.com/content/372/bmj.n71',
          sessionID: 'a1b2c3d4-0000-0000-0000-000000000001',
        },
      });

      expect(response.statusCode).toBe(201);
      const saved = (body(response).items as { id: string; title: string }[])[0] as {
        id: string;
        title: string;
      };
      expect(saved.title).toContain('PRISMA 2020');

      const item = body(await h.app.inject({ method: 'GET', url: `/api/v1/items/${saved.id}` }));
      expect(item.itemType).toBe('article');
      expect(item.sourceSystem).toBe('connector');

      const facet = item.bibliographic as Record<string, unknown>;
      expect(facet.containerTitle).toBe('BMJ');
      expect(facet.volume).toBe('372');
      expect(facet.issuedYear).toBe(2021);
      // The DOI is normalised on the way in (B1), prefix stripped and lower-cased.
      expect(facet.doi).toBe('10.1136/bmj.n71');
      expect(facet.abstract).toContain('PRISMA statement');

      // A capture is not a hand edit: the values are stamped `connector` and left unlocked, so a
      // resolver may improve them later (P4-1).
      const provenance = facet.provenance as Record<string, { source: string; locked: boolean }>;
      expect(provenance.doi?.source).toBe('connector');
      expect(provenance.doi?.locked).toBe(false);

      const creators = item.creators as { role: string; creator: { displayName: string } }[];
      expect(creators.map((entry) => entry.creator.displayName)).toEqual([
        'Matthew J Page',
        'Joanne E McKenzie',
        'The PRISMA Group',
      ]);
      expect(creators[2]?.role).toBe('contributor');

      expect((item.tags as { name: string }[]).map((tag) => tag.name).sort()).toEqual([
        'reporting',
        'systematic review',
      ]);
      expect((item.noteIds as unknown[]).length).toBe(1);

      // Zotero's own Extra is preserved verbatim, and the catalogue is appended (P10).
      expect(item.extra).toContain('PMID: 33782057');
      expect(item.extra).toContain('Library catalog: www.bmj.com');
    } finally {
      await h.close();
    }
  });

  it('maps an unknown item type to webpage and records the original (P10)', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({
        method: 'POST',
        url: '/connector/saveItems',
        payload: { items: [{ itemType: 'artwork', title: 'A painting' }], sessionID: 's' },
      });

      const saved = (body(response).items as { id: string }[])[0] as { id: string };
      const item = body(await h.app.inject({ method: 'GET', url: `/api/v1/items/${saved.id}` }));
      expect(item.itemType).toBe('webpage');
      expect(item.extra).toContain('Zotero item type: artwork');
    } finally {
      await h.close();
    }
  });

  it('does not create a second creator for the same person on a second save', async () => {
    const h = await harness();
    try {
      for (let run = 0; run < 2; run += 1) {
        await h.app.inject({
          method: 'POST',
          url: '/connector/saveItems',
          payload: { items: [JOURNAL_ARTICLE], sessionID: `run-${run}` },
        });
      }

      const creators = body(await h.app.inject({ method: 'GET', url: '/api/v1/creators' }));
      expect((creators.data as unknown[]).length).toBe(3);
    } finally {
      await h.close();
    }
  });

  it('refuses a body with no items', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({
        method: 'POST',
        url: '/connector/saveItems',
        payload: { items: [] },
      });
      expect(response.statusCode).toBe(422);
    } finally {
      await h.close();
    }
  });
});

describe('/connector/saveSnapshot', () => {
  it('creates the webpage item and says the bytes were not stored', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({
        method: 'POST',
        url: '/connector/saveSnapshot',
        payload: {
          url: 'https://example.org/a-page',
          title: 'A page',
          sessionID: 'snap-1',
          singleFile: true,
        },
      });

      expect(response.statusCode).toBe(201);
      const item = body(
        await h.app.inject({ method: 'GET', url: `/api/v1/items/${body(response).id as string}` }),
      );
      expect(item.itemType).toBe('webpage');
      expect((item.bibliographic as Record<string, unknown>).url).toBe('https://example.org/a-page');
      expect(item.extra).toContain('the page bytes were not stored');
    } finally {
      await h.close();
    }
  });
});
