/**
 * Stages 4, 6 and 7 on their own: type detection, the office heuristics, and identifier finding.
 *
 * These are pure functions over text, so they are tested as such — every claim about a heuristic is
 * a claim about a specific input, and a heuristic that is only tested through the pipeline is a
 * heuristic nobody can tune.
 */
import { describe, expect, it } from 'vitest';

import { detectType } from '../src/detect/type.js';
import { parseTeiHeader } from '../src/metadata/grobid.js';
import {
  OfficeHeuristicExtractor,
  pickDocumentDate,
  readAmount,
  readDates,
  readLetterhead,
  readReference,
  toMinorUnits,
} from '../src/metadata/office.js';
import { extractIdentifiers, normaliseDoi, normaliseIsbn, normaliseIssn } from '../src/resolve/identifiers.js';
import { extractPdfText } from '../src/text/pdf-text.js';
import { simhash, simhashDistance } from '../src/text/simhash.js';
import { invoiceLines, makePdf, scholarlyLines } from './helpers.js';

/* ------------------------------------------------------------------------------------------ */

describe('reading a PDF text layer', () => {
  it('recovers the text of a PDF that has one', () => {
    const pdf = makePdf({ lines: ['Hello world', 'Second line'] });
    const result = extractPdfText(pdf);
    expect(result.text).toContain('Hello world');
    expect(result.text).toContain('Second line');
    expect(result.pageCount).toBe(1);
  });

  it('returns nothing for a page that is a picture', () => {
    const result = extractPdfText(makePdf({ salt: 'picture' }));
    expect(result.text).toBe('');
  });

  it('handles escaped parentheses in a string literal', () => {
    const result = extractPdfText(makePdf({ lines: ['A (nested) parenthesis'] }));
    expect(result.text).toContain('A (nested) parenthesis');
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('type detection', () => {
  const base = { byteSize: 1000, pageCount: 1, fromArchive: false };

  it('calls a PDF with no text layer a scan', () => {
    const result = detectType({
      ...base,
      mediaType: 'application/pdf',
      text: null,
      hasTextLayer: false,
    });
    expect(result.type).toBe('scan');
  });

  it('calls a PDF with an abstract, a DOI and a reference list a scholarly PDF', () => {
    const result = detectType({
      ...base,
      mediaType: 'application/pdf',
      hasTextLayer: true,
      text: scholarlyLines({ title: 'A paper', doi: '10.1234/x' }).join('\n'),
    });
    expect(result.type).toBe('scholarly_pdf');
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.signals.join(' ')).toContain('DOI');
  });

  it('calls an invoice an office document', () => {
    const result = detectType({
      ...base,
      mediaType: 'application/pdf',
      hasTextLayer: true,
      text: invoiceLines({ correspondent: 'Stadtwerke Ulm', reference: 'SW-1' }).join('\n'),
    });
    expect(result.type).toBe('office_document');
  });

  it('gives a tie a low score rather than breaking it silently', () => {
    // One scholarly signal of weight 2 against one office signal of weight 2.
    const result = detectType({
      ...base,
      mediaType: 'application/pdf',
      hasTextLayer: true,
      text: 'Abstract\nThis is a contract.',
    });
    expect(result.confidence).toBeLessThan(0.3);
    expect(result.signals.join(' ')).toContain('level at');
  });

  it('types images and archives from the media type', () => {
    expect(detectType({ ...base, mediaType: 'image/jpeg', text: null, hasTextLayer: null }).type).toBe(
      'image',
    );
    expect(
      detectType({ ...base, mediaType: 'application/zip', text: null, hasTextLayer: null }).type,
    ).toBe('archive');
    expect(
      detectType({ ...base, mediaType: 'message/rfc822', text: null, hasTextLayer: null }).type,
    ).toBe('email');
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('finding identifiers', () => {
  it('finds and normalises a DOI however it is written', () => {
    const identifiers = extractIdentifiers(
      'See https://doi.org/10.1093/IJE/dyw341 and doi: 10.1000/Xyz.',
    );
    expect(identifiers.filter((entry) => entry.scheme === 'doi').map((entry) => entry.value)).toEqual([
      '10.1093/ije/dyw341',
      '10.1000/xyz',
    ]);
  });

  it('does not swallow the full stop at the end of a sentence', () => {
    expect(normaliseDoi('10.1000/xyz.')).toBe('10.1000/xyz');
    expect(normaliseDoi('10.1000/xyz(2)')).toBe('10.1000/xyz(2)');
    expect(normaliseDoi('(10.1000/xyz)')).toBe(null);
  });

  it('verifies an ISBN check digit rather than accepting any thirteen digits', () => {
    expect(normaliseIsbn('978-0-306-40615-7')).toBe('9780306406157');
    expect(normaliseIsbn('978-0-306-40615-8')).toBe(null);
    expect(normaliseIsbn('0-306-40615-2')).toBe('0306406152');
  });

  it('verifies an ISSN check digit', () => {
    expect(normaliseIssn('0378-5955')).toBe('0378-5955');
    expect(normaliseIssn('0378-5956')).toBe(null);
  });

  it('refuses a PMID that is really a page number', () => {
    const identifiers = extractIdentifiers('PMID: 12\nPMID: 39381234');
    expect(identifiers.filter((entry) => entry.scheme === 'pmid').map((entry) => entry.value)).toEqual([
      '39381234',
    ]);
  });

  it('refuses an arXiv id whose month is impossible', () => {
    expect(extractIdentifiers('arXiv:2699.01234')).toEqual([]);
    expect(extractIdentifiers('arXiv:2601.01234')).toEqual([{ scheme: 'arxiv', value: '2601.01234' }]);
  });

  it('honours the scan limit, so a reference list is not mined for the document own DOI', () => {
    const text = `${'x'.repeat(500)}doi:10.1/late`;
    expect(extractIdentifiers(text, { limit: 100 })).toEqual([]);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('the office heuristics', () => {
  it('reads a labelled document date in preference to any other date on the page', () => {
    const text = 'Due 30.04.2026\nInvoice date: 14.03.2026\nPrinted 01.01.2020';
    const picked = pickDocumentDate(readDates(text), new Date('2026-08-22T00:00:00Z'));
    expect(picked?.iso).toBe('2026-03-14');
    expect(picked?.explicit).toBe(true);
  });

  it('never picks a date in the future', () => {
    const picked = pickDocumentDate(readDates('Valid until 2030-01-01'), new Date('2026-08-22T00:00:00Z'));
    expect(picked).toBe(null);
  });

  it('reads both British and German date forms', () => {
    expect(readDates('12 March 2026').map((date) => date.iso)).toContain('2026-03-12');
    expect(readDates('12. März 2026').map((date) => date.iso)).toContain('2026-03-12');
    expect(readDates('March 12, 2026').map((date) => date.iso)).toContain('2026-03-12');
    expect(readDates('12.03.2026').map((date) => date.iso)).toContain('2026-03-12');
  });

  it('refuses an impossible date', () => {
    expect(readDates('31.02.2026')).toEqual([]);
  });

  it('reads an amount in either decimal convention, into minor units', () => {
    expect(toMinorUnits('1.234,56')).toBe(123456);
    expect(toMinorUnits('1,234.56')).toBe(123456);
    expect(toMinorUnits('1234')).toBe(123400);
    expect(readAmount('Total due £1,234.56')).toEqual({ minor: 123456, currency: 'GBP' });
    expect(readAmount('Gesamtbetrag 1.234,56 EUR')).toEqual({ minor: 123456, currency: 'EUR' });
  });

  it('reads a reference number', () => {
    expect(readReference('Invoice number: SW-2026-0042')).toBe('SW-2026-0042');
    expect(readReference('Kundennummer: KD-99213')).toBe('KD-99213');
    expect(readReference('nothing here')).toBe(null);
  });

  it('reads a letterhead but refuses an address line or a page number', () => {
    expect(readLetterhead('Stadtwerke Ulm GmbH\nMagirusstr. 44\n89077 Ulm')).toBe('Stadtwerke Ulm GmbH');
    expect(readLetterhead('89077 Ulm\ninfo@example.org')).toBe(null);
  });

  it('trusts the mail envelope over the letterhead, and says so in the confidence', async () => {
    const extractor = new OfficeHeuristicExtractor({ now: () => new Date('2026-08-22T00:00:00Z') });

    const fromLetterhead = await extractor.extract({
      bytes: Buffer.alloc(0),
      mediaType: 'application/pdf',
      sha256: 'a'.repeat(64),
      detectedType: 'office_document',
      text: invoiceLines({ correspondent: 'Stadtwerke Ulm GmbH', reference: 'SW-1' }).join('\n'),
    });

    const fromEnvelope = await extractor.extract({
      bytes: Buffer.alloc(0),
      mediaType: 'application/pdf',
      sha256: 'b'.repeat(64),
      detectedType: 'office_document',
      text: invoiceLines({ correspondent: 'Stadtwerke Ulm GmbH', reference: 'SW-1' }).join('\n'),
      sourceMetadata: { from: 'Stadtwerke Ulm <billing@swu.example>' },
    });

    expect(fromLetterhead.fields['office.correspondent']?.value).toBe('Stadtwerke Ulm GmbH');
    expect(fromEnvelope.fields['office.correspondent']?.value).toBe('Stadtwerke Ulm');
    expect(fromEnvelope.fields['office.correspondent']!.provenance.confidence).toBeGreaterThan(
      fromLetterhead.fields['office.correspondent']!.provenance.confidence,
    );
  });

  it('reads the date, reference and amount off an invoice', async () => {
    const extractor = new OfficeHeuristicExtractor({ now: () => new Date('2026-08-22T00:00:00Z') });
    const result = await extractor.extract({
      bytes: Buffer.alloc(0),
      mediaType: 'application/pdf',
      sha256: 'c'.repeat(64),
      detectedType: 'office_document',
      text: invoiceLines({ correspondent: 'Acme Ltd', reference: 'INV-2026-7' }).join('\n'),
    });

    expect(result.fields['office.documentDate']?.value).toBe('2026-03-14');
    expect(result.fields['office.referenceNumber']?.value).toBe('INV-2026-7');
    expect(result.fields['office.amountMinor']?.value).toBe(123456);
    expect(result.fields['office.amountCurrency']?.value).toBe('EUR');
    expect(result.fields['office.officeDocumentType']?.value).toBe('invoice');
    expect(result.itemType).toBe('invoice');
  });

  it('says what it could not read instead of guessing', async () => {
    const extractor = new OfficeHeuristicExtractor();
    const result = await extractor.extract({
      bytes: Buffer.alloc(0),
      mediaType: 'application/pdf',
      sha256: 'd'.repeat(64),
      detectedType: 'office_document',
      text: '',
    });
    expect(result.confidence).toBe(0);
    expect(result.warnings?.join(' ')).toContain('no correspondent');
    expect(result.warnings?.join(' ')).toContain('no document date');
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('the GROBID TEI reader', () => {
  // The transport needs a container and is therefore not tested here; the parser does not, and is.
  // This TEI is hand-written to the documented shape, not captured from a live GROBID, so it proves
  // the parser reads what it claims to read and says nothing about GROBID's real output.
  const tei = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt><title level="a" type="main">Deep Learning for Ingestion Pipelines</title></titleStmt>
      <sourceDesc>
        <biblStruct>
          <analytic>
            <title level="a" type="main">Deep Learning for Ingestion Pipelines</title>
            <author>
              <persName><forename type="first">Ada</forename><surname>Lovelace</surname></persName>
              <idno type="ORCID">0000-0002-1825-0097</idno>
              <affiliation><orgName type="institution">Analytical Engine Institute</orgName></affiliation>
            </author>
            <author>
              <persName><forename type="first">Grace</forename><surname>Hopper</surname></persName>
            </author>
            <idno type="DOI">10.1234/ingest.2026</idno>
          </analytic>
          <monogr>
            <title level="j">Journal of Reproducible Findings</title>
            <imprint>
              <biblScope unit="volume">12</biblScope>
              <biblScope unit="issue">3</biblScope>
              <date type="published" when="2026-03-14" />
            </imprint>
          </monogr>
        </biblStruct>
      </sourceDesc>
    </fileDesc>
    <profileDesc><abstract><p>We describe a pipeline that flags rather than guesses.</p></abstract></profileDesc>
  </teiHeader>
  <text><back><div type="references"><listBibl>
    <biblStruct><analytic><title level="a">On compilers</title></analytic><monogr><imprint><date when="1952" /></imprint></monogr></biblStruct>
  </listBibl></div></back></text>
</TEI>`;

  it('reads the header into a proposal with provenance on every field', () => {
    const result = parseTeiHeader(tei, {
      extractor: 'grobid',
      confidence: 0.7,
      fetchedAt: '2026-08-22T09:14:00.000Z',
    });

    expect(result.fields['bibliographic.title']?.value).toBe('Deep Learning for Ingestion Pipelines');
    expect(result.fields['bibliographic.doi']?.value).toBe('10.1234/ingest.2026');
    expect(result.fields['bibliographic.containerTitle']?.value).toBe('Journal of Reproducible Findings');
    expect(result.fields['bibliographic.issuedYear']?.value).toBe(2026);
    expect(result.fields['bibliographic.volume']?.value).toBe('12');
    expect(result.fields['bibliographic.abstract']?.value).toContain('flags rather than guesses');

    for (const field of Object.values(result.fields)) {
      expect(field.provenance.source).toBe('grobid');
      expect(field.provenance.fetchedAt).toBe('2026-08-22T09:14:00.000Z');
      expect(field.provenance.confidence).toBeGreaterThan(0);
      expect(field.provenance.confidence).toBeLessThan(1);
    }

    expect(result.creators.map((creator) => creator.family)).toEqual(['Lovelace', 'Hopper']);
    expect(result.creators[0]!.orcid).toBe('0000-0002-1825-0097');
    expect(result.creators[0]!.affiliation).toBe('Analytical Engine Institute');
    expect(result.identifiers).toContainEqual({ scheme: 'doi', value: '10.1234/ingest.2026' });
    expect(result.references).toHaveLength(1);
    expect(result.references[0]!.title).toBe('On compilers');
  });

  it('reports a header with nothing in it as zero confidence rather than inventing a record', () => {
    const result = parseTeiHeader('<TEI><teiHeader></teiHeader></TEI>', {
      extractor: 'grobid',
      confidence: 0.7,
    });
    expect(result.confidence).toBe(0);
    expect(result.warnings).toContain('GROBID returned no title');
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('simhash', () => {
  it('is stable and sixteen hex characters', () => {
    const text = 'the quick brown fox jumps over the lazy dog and then does it again';
    expect(simhash(text)).toMatch(/^[0-9a-f]{16}$/u);
    expect(simhash(text)).toBe(simhash(text));
  });

  it('puts a re-scan with a few OCR errors closer than an unrelated document', () => {
    const original =
      'Recueil gathers documents from anywhere, keeps a content addressed library with a ' +
      'bibliographic facet, and verifies references against the open scholarly graph.';
    const rescanned = original.replace('gathers', 'gathefs').replace('facet', 'facel');
    const unrelated =
      'The mitochondrion is a double membrane bound organelle found in most eukaryotic organisms ' +
      'and generates most of the chemical energy needed to power biochemical reactions.';

    const near = simhashDistance(simhash(original), simhash(rescanned));
    const far = simhashDistance(simhash(original), simhash(unrelated));
    expect(near).not.toBeNull();
    expect(far).not.toBeNull();
    expect(near as number).toBeLessThan(far as number);
  });

  it('returns null for text with nothing in it', () => {
    expect(simhash('')).toBe(null);
  });
});
