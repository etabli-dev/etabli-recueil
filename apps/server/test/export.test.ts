/**
 * Export, and the `.bib` feed Overleaf and Quarto fetch (CONCEPT.md §5.11).
 *
 * "It returns some text" is not the test. What matters is that the text is a *parseable*
 * bibliography — asserted by feeding it back through `@recueil/formats`' own importer, which is the
 * same parser the round-trip tests in that package use — that the media type is one a build tool
 * recognises, and that the ETag is stable enough for a build that refetches on every run to get a
 * 304.
 */
import { importBibtex, importCslJson, importRis } from '@recueil/formats';
import { describe, expect, it } from 'vitest';

import { body, createItem, harness } from './helpers.js';

const seed = async (h: Awaited<ReturnType<typeof harness>>): Promise<{ collectionId: string; itemIds: string[] }> => {
  const collection = body(
    await h.app.inject({ method: 'POST', url: '/api/v1/collections', payload: { name: 'Reading list' } }),
  );

  const author = body(
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/creators',
      payload: { kind: 'person', familyName: 'Ravaud', givenName: 'Philippe' },
    }),
  );

  const itemIds: string[] = [];
  for (const title of ['A randomised trial', 'A second trial']) {
    const item = await createItem(h, {
      title,
      collectionIds: [collection.id],
      bibliographic: {
        title,
        containerTitle: 'The Lancet',
        issuedDate: '2019',
        issuedYear: 2019,
        volume: '393',
        pages: '1-10',
      },
    });
    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/items/${item.id as string}/creators`,
      payload: { creators: [{ creatorId: author.id, role: 'author' }] },
    });
    itemIds.push(item.id as string);
  }

  return { collectionId: collection.id as string, itemIds };
};

describe('GET /api/v1/export/{format}', () => {
  it('serves parseable BibTeX for an explicit selection', async () => {
    const h = await harness();
    try {
      const { itemIds } = await seed(h);
      const response = await h.app.inject({
        method: 'GET',
        url: `/api/v1/export/bibtex?ids=${itemIds.join(',')}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('application/x-bibtex; charset=utf-8');
      expect(response.headers['x-recueil-record-count']).toBe('2');

      const parsed = importBibtex(response.payload);
      expect(parsed.records.length).toBe(2);
      expect(parsed.records.map((record) => record.bibliographic?.title).sort()).toEqual([
        'A randomised trial',
        'A second trial',
      ]);
      expect(parsed.records[0]?.creators?.[0]?.familyName).toBe('Ravaud');
    } finally {
      await h.close();
    }
  });

  it('serves parseable RIS and CSL-JSON with the right media types', async () => {
    const h = await harness();
    try {
      const { collectionId } = await seed(h);

      const ris = await h.app.inject({
        method: 'GET',
        url: `/api/v1/export/ris?collectionId=${collectionId}`,
      });
      expect(ris.headers['content-type']).toBe('application/x-research-info-systems; charset=utf-8');
      expect(importRis(ris.payload).records.length).toBe(2);

      const csl = await h.app.inject({
        method: 'GET',
        url: `/api/v1/export/csl-json?collectionId=${collectionId}`,
      });
      expect(csl.headers['content-type']).toBe('application/vnd.citationstyles.csl+json; charset=utf-8');
      expect(importCslJson(csl.payload).records.length).toBe(2);
      expect(JSON.parse(csl.payload)).toHaveLength(2);
    } finally {
      await h.close();
    }
  });

  it('reports what the format could not carry when asked (P10)', async () => {
    const h = await harness();
    try {
      const item = await createItem(h, {
        bibliographic: {
          title: 'With an OpenAlex id',
          openalexId: 'W2741809807',
          issuedYear: 2020,
        },
      });

      const response = await h.app.inject({
        method: 'GET',
        url: `/api/v1/export/bibtex?ids=${item.id as string}&report=true`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/u);
      const report = body(response);
      expect(report.format).toBe('bibtex');
      expect(report.recordCount).toBe(1);
      expect(report.losses).toContainEqual(expect.objectContaining({ field: 'openalexId' }));
    } finally {
      await h.close();
    }
  });

  it('refuses an export with no selection', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({ method: 'GET', url: '/api/v1/export/bibtex' });
      expect(response.statusCode).toBe(422);
      expect(body(response).detail).toContain('selection');
    } finally {
      await h.close();
    }
  });

  it('refuses an unknown format with a pointer at the path', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({ method: 'GET', url: '/api/v1/export/endnote' });
      expect(response.statusCode).toBe(422);
      expect(body(response).errors).toContainEqual(expect.objectContaining({ path: 'path.format' }));
    } finally {
      await h.close();
    }
  });
});

describe('GET /api/v1/collections/{id}/bibliography.bib', () => {
  it('serves BibTeX Overleaf can parse, with a stable ETag', async () => {
    const h = await harness();
    try {
      const { collectionId } = await seed(h);
      const url = `/api/v1/collections/${collectionId}/bibliography.bib`;

      const first = await h.app.inject({ method: 'GET', url });
      expect(first.statusCode).toBe(200);
      expect(first.headers['content-type']).toBe('application/x-bibtex; charset=utf-8');
      expect(first.headers['content-disposition']).toContain('.bib');
      expect(first.headers.etag).toMatch(/^"[A-Za-z0-9_-]+"$/u);

      const parsed = importBibtex(first.payload);
      expect(parsed.records.length).toBe(2);
      // A key on every entry: a `.bib` without keys cannot be cited.
      expect(first.payload).toMatch(/@article\{[^,]+,/u);

      // The same request twice gives the same tag, which is what makes a build's refetch cheap.
      const second = await h.app.inject({ method: 'GET', url });
      expect(second.headers.etag).toBe(first.headers.etag);

      const conditional = await h.app.inject({
        method: 'GET',
        url,
        headers: { 'if-none-match': first.headers.etag as string },
      });
      expect(conditional.statusCode).toBe(304);
      expect(conditional.payload).toBe('');
    } finally {
      await h.close();
    }
  });

  it('changes the ETag when the bibliography changes', async () => {
    const h = await harness();
    try {
      const { collectionId } = await seed(h);
      const url = `/api/v1/collections/${collectionId}/bibliography.bib`;
      const before = await h.app.inject({ method: 'GET', url });

      await createItem(h, {
        title: 'A third trial',
        collectionIds: [collectionId],
        bibliographic: { title: 'A third trial', issuedYear: 2021 },
      });

      const after = await h.app.inject({ method: 'GET', url });
      expect(after.headers.etag).not.toBe(before.headers.etag);
      expect(importBibtex(after.payload).records.length).toBe(3);
    } finally {
      await h.close();
    }
  });

  it('honours a scoped token in the URL, and refuses a bad one', async () => {
    const h = await harness({ env: { RECUEIL_REQUIRE_AUTH: 'true' } });
    try {
      // With authentication required, the fixtures are built through the services rather than
      // through the API: this test is about the credential, not about seeding.
      const token = h.app.recueil.tokens.create(
        { name: 'Overleaf', client: 'bib_feed', scopes: ['export:read', 'collections:read'] },
        h.recueil.actor,
      );

      const collection = h.recueil.collections.create({ name: 'Feed' }, h.recueil.actor);
      const item = h.recueil.library.createItem(
        { itemType: 'article', title: 'Tokened', bibliographic: { title: 'Tokened', issuedYear: 2020 } },
        h.recueil.actor,
      );
      h.recueil.collections.addItems(collection.id, [item.item.id], h.recueil.actor);

      const url = `/api/v1/collections/${collection.id}/bibliography.bib`;

      const anonymous = await h.app.inject({ method: 'GET', url });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.headers['www-authenticate']).toContain('Bearer');

      const tokened = await h.app.inject({ method: 'GET', url: `${url}?token=${token.secret}` });
      expect(tokened.statusCode).toBe(200);
      expect(importBibtex(tokened.payload).records.length).toBe(1);

      const wrong = await h.app.inject({ method: 'GET', url: `${url}?token=rcu_nonsense` });
      expect(wrong.statusCode).toBe(401);
    } finally {
      await h.close();
    }
  });
});

describe('GET /api/v1/saved-searches/{id}/bibliography.bib', () => {
  it('serves a saved search, and points a manual collection at the right URL', async () => {
    const h = await harness();
    try {
      const { collectionId } = await seed(h);

      const manual = await h.app.inject({
        method: 'GET',
        url: `/api/v1/saved-searches/${collectionId}/bibliography.bib`,
      });
      expect(manual.statusCode).toBe(404);
      expect(body(manual).detail).toContain('/collections/');

      const saved = body(
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/collections',
          payload: { name: 'Trials', kind: 'smart', query: { text: 'randomised' } },
        }),
      );

      const response = await h.app.inject({
        method: 'GET',
        url: `/api/v1/saved-searches/${saved.id as string}/bibliography.bib`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('application/x-bibtex; charset=utf-8');
      // The FTS index finds the one item whose title carries the word.
      const parsed = importBibtex(response.payload);
      expect(parsed.records.map((record) => record.bibliographic?.title)).toEqual(['A randomised trial']);
    } finally {
      await h.close();
    }
  });

  it('refuses a saved search whose query it cannot understand', async () => {
    const h = await harness();
    try {
      const saved = h.recueil.collections.create(
        { name: 'Structured', kind: 'smart', query: { and: [{ field: 'itemType', eq: 'article' }] } },
        h.recueil.actor,
      );

      const response = await h.app.inject({
        method: 'GET',
        url: `/api/v1/saved-searches/${saved.id}/bibliography.bib`,
      });
      expect(response.statusCode).toBe(422);
      expect(body(response).detail).toContain('text');
    } finally {
      await h.close();
    }
  });
});
