import { describe, expect, it } from 'vitest';

import type { PageMetadata } from '../src/extract.js';
import { SaveError, itemBody, saveToRecueil } from '../src/save.js';
import { checkServerUrl } from '../src/url.js';
import { originPattern } from '../src/browser.js';

const meta = (overrides: Partial<PageMetadata> = {}): PageMetadata => ({
  url: 'https://journal.example/a',
  itemType: 'article',
  title: 'Tranexamic acid',
  authors: [{ family: 'Lovelace', given: 'Ada' }, { literal: 'Trial Group' }],
  date: '2019/03/15',
  year: 2019,
  containerTitle: 'Injury',
  volume: '50',
  issue: '3',
  firstPage: '101',
  lastPage: '109',
  doi: '10.1000/txa',
  pmid: null,
  isbn: null,
  issn: null,
  publisher: null,
  abstract: null,
  language: 'en',
  pdfUrl: null,
  source: 'highwire',
  ...overrides,
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the item a page becomes', () => {
  it('carries what the page said, with inline creators the server resolves', () => {
    expect(itemBody(meta())).toEqual({
      itemType: 'article',
      title: 'Tranexamic acid',
      bibliographic: { url: 'https://journal.example/a', title: 'Tranexamic acid', containerTitle: 'Injury', volume: '50', issue: '3', pages: '101-109', pageFirst: 101, pageLast: 109, doi: '10.1000/txa', issuedYear: 2019, issuedDate: '2019-03-15', languageCode: 'en' },
      creators: [
        { role: 'author', creator: { kind: 'person', familyName: 'Lovelace', givenName: 'Ada' } },
        { role: 'author', creator: { kind: 'organisation', literalName: 'Trial Group' } },
      ],
    });
  });
});

describe('saving', () => {
  const settings = { baseUrl: 'https://recueil.example/', token: 'rc_t' };

  it('creates the item with the token, and attaches the PDF in the upload', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const outcome = await saveToRecueil(settings, meta({ pdfUrl: 'https://journal.example/a.pdf' }), {
      fetch: async (url, init) => {
        calls.push({ url, ...(init === undefined ? {} : { init }) });
        return url.endsWith('/items') ? json(201, { id: 'ITEM1' }) : json(201, { id: 'DOC1' });
      },
      fetchPdf: async () => new Blob(['%PDF-1.7'], { type: 'application/pdf' }),
    });
    expect(outcome).toEqual({ itemId: 'ITEM1', pdf: 'attached' });
    expect(calls.map((call) => call.url)).toEqual(['https://recueil.example/api/v1/items', 'https://recueil.example/api/v1/documents']);
    expect((calls[0]!.init!.headers as Record<string, string>)['authorization']).toBe('Bearer rc_t');
    const form = calls[1]!.init!.body as FormData;
    expect(form.get('itemId')).toBe('ITEM1');
    expect(form.get('role')).toBe('primary');
  });

  it('keeps the item when the PDF link is a login page', async () => {
    const outcome = await saveToRecueil(settings, meta({ pdfUrl: 'https://journal.example/a.pdf' }), {
      fetch: async () => json(201, { id: 'ITEM1' }),
      fetchPdf: async () => new Blob(['<html>'], { type: 'text/html' }),
    });
    expect(outcome.itemId).toBe('ITEM1');
    expect(outcome.pdf).toEqual({ failed: expect.stringContaining('not a PDF') });
  });

  it('reports the server’s refusal with its status', async () => {
    const error = await saveToRecueil(settings, meta(), { fetch: async () => json(403, { title: 'Forbidden', detail: 'The token lacks items:write.' }) }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SaveError);
    expect(error).toMatchObject({ status: 403, message: 'The token lacks items:write.' });
  });
});

describe('the server address', () => {
  it('takes HTTPS, HTTP only on this computer, and asks for exactly that origin', () => {
    expect(checkServerUrl('https://recueil.example/app/')).toEqual({ ok: true, url: 'https://recueil.example/app' });
    expect(checkServerUrl('http://localhost:3000')).toEqual({ ok: true, url: 'http://localhost:3000' });
    expect(checkServerUrl('http://recueil.example')).toMatchObject({ ok: false });
    expect(originPattern('https://recueil.example/app')).toBe('https://recueil.example/*');
  });
});
