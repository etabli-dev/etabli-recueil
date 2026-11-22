import { describe, expect, it } from 'vitest';

import { extractPageMetadata } from '../src/extract.js';

const page = (head: string, body = '', url = 'https://journal.example/article/1') => {
  const doc = new DOMParser().parseFromString(`<!doctype html><html lang="en"><head><title>Page title</title>${head}</head><body>${body}</body></html>`, 'text/html');
  return extractPageMetadata(doc, url);
};

describe('reading a scholarly page', () => {
  it('reads Highwire citation tags, the way Google Scholar does', () => {
    const meta = page(`
      <meta name="citation_title" content="Tranexamic acid in hip fracture surgery">
      <meta name="citation_author" content="Lovelace, Ada">
      <meta name="citation_author" content="Charles Babbage">
      <meta name="citation_publication_date" content="2019/03/15">
      <meta name="citation_journal_title" content="Injury">
      <meta name="citation_volume" content="50"><meta name="citation_issue" content="3">
      <meta name="citation_firstpage" content="101"><meta name="citation_lastpage" content="109">
      <meta name="citation_doi" content="https://doi.org/10.1000/TXA.2019">
      <meta name="citation_pmid" content="31000001">
      <meta name="citation_pdf_url" content="/article/1.pdf">`);
    expect(meta).toMatchObject({
      itemType: 'article',
      source: 'highwire',
      title: 'Tranexamic acid in hip fracture surgery',
      authors: [{ family: 'Lovelace', given: 'Ada' }, { family: 'Babbage', given: 'Charles' }],
      year: 2019,
      containerTitle: 'Injury',
      volume: '50',
      issue: '3',
      firstPage: '101',
      lastPage: '109',
      doi: '10.1000/txa.2019',
      pmid: '31000001',
      pdfUrl: 'https://journal.example/article/1.pdf',
      language: 'en',
    });
  });

  it('falls back to JSON-LD, then to a DOI in the address', () => {
    const ld = page(
      `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebSite' }, { '@type': 'ScholarlyArticle', headline: 'A JSON-LD article', author: [{ '@type': 'Person', givenName: 'Grace', familyName: 'Hopper' }, { '@type': 'Organization', name: 'The Trial Group' }], datePublished: '2021-05-02', isPartOf: { name: 'Bone' } }] })}</script>`,
    );
    expect(ld).toMatchObject({ source: 'json-ld', title: 'A JSON-LD article', authors: [{ family: 'Hopper', given: 'Grace' }, { literal: 'The Trial Group' }], year: 2021, containerTitle: 'Bone', itemType: 'article' });
    const bare = page('', '<p>Nothing scholarly here.</p>', 'https://doi.org/10.5555/abc-123');
    expect(bare).toMatchObject({ doi: '10.5555/abc-123', title: 'Page title', source: 'document', itemType: 'article' });
  });

  it('tells conference papers, books and preprints from articles', () => {
    expect(page('<meta name="citation_title" content="T"><meta name="citation_conference_title" content="ICSE">').itemType).toBe('conference_paper');
    expect(page('<meta name="citation_title" content="T"><meta name="citation_isbn" content="9783161484100">').itemType).toBe('book');
    expect(page('<meta name="citation_title" content="T">', '', 'https://arxiv.org/abs/2101.00001').itemType).toBe('preprint');
    expect(page('<meta property="og:title" content="A blog post">').itemType).toBe('webpage');
  });

  it('survives broken JSON-LD and keeps the meta tags', () => {
    expect(page('<script type="application/ld+json">{not json</script><meta name="dc.title" content="Dublin Core title">')).toMatchObject({ title: 'Dublin Core title', source: 'dublin-core' });
  });

  it('is self-contained, as executeScript requires', () => {
    // The function is serialised and run in the page: it may not refer to anything outside itself.
    const source = extractPageMetadata.toString();
    const rebuilt = new Function(`return (${source});`)() as typeof extractPageMetadata;
    const doc = new DOMParser().parseFromString('<meta name="citation_title" content="Isolated">', 'text/html');
    expect(rebuilt(doc, 'https://x.example/').title).toBe('Isolated');
  });
});
