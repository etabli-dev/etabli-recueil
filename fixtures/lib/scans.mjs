/*
 * Recueil — fixtures
 * Copyright (C) 2026 the Recueil authors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * `fixtures/scans/` — the corpus for CONCEPT §5.3 stages 4 and 5, "type detection" and "OCR when no
 * text layer".
 *
 * The single question these files exist to answer is: **does the pipeline know when it must OCR?**
 * So the corpus is built around the ways that question is got wrong.
 *
 *   - A page whose words are only pixels must be OCRed. Six pages, across four documents.
 *   - A page whose words are in a text object must not be. OCRing it a second time is how a library
 *     acquires two overlapping text layers and a search index full of duplicates.
 *   - A *document* is not uniformly one or the other. `mixed-text-and-scan.pdf` is a born-digital
 *     letter with a scanned appendix; a per-document flag gets it wrong whichever way it is set.
 *   - A scanner's stamp is not a text layer. `sparse-text-layer.pdf` carries sixteen characters
 *     over a full page of raster. Any test of the form "has a text layer → skip" silently drops the
 *     whole page. This is the case OCRmyPDF's own `--skip-text` / `--redo-ocr` split exists for.
 *   - A page fed in sideways carries `/Rotate`. Rasterising without honouring it OCRs a rotated
 *     image, which returns nothing, which looks exactly like a blank page.
 *   - A page off the feeder by three degrees needs deskewing, so the skew is in the pixels, not in
 *     a placement matrix that a renderer would quietly undo.
 *
 * Nothing here is downloaded. The pages are drawn from the 5 × 7 bitmap font in `font-5x7.mjs`
 * onto a greyscale canvas, so the corpus is redistributable and rebuildable with nothing installed.
 */
import { buildPdf } from './pdf.mjs';
import { INK, canvas, drawText, fillRect, quarterTurn, speckle } from './raster.mjs';

/** About 75 dpi over A4. Big enough to read, small enough that six PDFs stay under a megabyte. */
const RASTER_WIDTH = 620;
const RASTER_HEIGHT = 877;

/**
 * Draw a page of text as if it had been through a flatbed.
 *
 * @param {object} spec
 * @param {string[]} spec.lines
 * @param {number} spec.seed          the speckle seed; different per page, fixed per fixture
 * @param {number} [spec.skew]        radians
 * @param {number} [spec.scale]
 * @param {number} [spec.top]
 * @param {Array<{ y: number, height?: number }>} [spec.rules]  horizontal rules, in raster pixels
 * @returns {{ width: number, height: number, pixels: Uint8Array }}
 */
function scannedPage({ lines, seed, skew = 0, scale = 2, top = 90, rules = [] }) {
  const page = canvas(RASTER_WIDTH, RASTER_HEIGHT);
  const rotate = skew ? { angle: skew, ox: RASTER_WIDTH / 2, oy: RASTER_HEIGHT / 2 } : undefined;

  for (const rule of rules) {
    fillRect(page, {
      x: 64,
      y: rule.y,
      width: RASTER_WIDTH - 128,
      height: rule.height ?? 2,
      ink: INK,
      rotate,
    });
  }

  lines.forEach((line, index) => {
    if (!line) return;
    drawText(page, { text: line, x: 64, y: top + index * (7 * scale + 6), scale, rotate });
  });

  speckle(page, { seed, density: 0.0018 });
  return page;
}

/** The invoice the Office facet, the rule corpus and the Paperless dump all describe. */
const INVOICE_LINES = [
  'Stadtwerke Ulm GmbH',
  'Karlstraße 1, 89073 Ulm',
  '',
  'RECHNUNG',
  '',
  'Rechnungsnummer: 2023-004417',
  'Kundennummer:    88-201934',
  'Rechnungsdatum:  14.03.2023',
  'Fällig am:       28.03.2023',
  '',
  'Position                        Betrag',
  '',
  'Grundpreis Strom                 12,90 €',
  'Arbeitspreis 1420 kWh           383,40 €',
  'Umsatzsteuer 19 %                75,20 €',
  '',
  'Gesamtbetrag                    471,50 €',
  '',
  'Zahlbar ohne Abzug innerhalb von 14 Tagen.',
  'IBAN DE02 1203 0000 0000 2020 51',
  '',
  'Dies ist ein erzeugtes Beispieldokument der',
  'Recueil-Testdaten. Kein echtes Dokument.',
];

const REPORT_PAGE_1 = [
  'Landesanstalt für Umwelt Baden-Württemberg',
  '',
  'Jahresbericht Gewässergüte 2022',
  '',
  '1  Einleitung',
  '',
  'Der vorliegende Bericht fasst die Messreihen',
  'der 41 Pegel im Einzugsgebiet der oberen Donau',
  'für das Berichtsjahr 2022 zusammen. Die Daten',
  'wurden im Rahmen des landesweiten Messnetzes',
  'erhoben und nach DIN 38402 aufbereitet.',
  '',
  '2  Methodik',
  '',
  'Die Probenahme erfolgte monatlich an allen',
  'Messstellen. Abweichungen von diesem Rhythmus',
  'sind in Anhang B einzeln vermerkt.',
];

const REPORT_PAGE_2 = [
  '3  Ergebnisse',
  '',
  'Pegel            Mittel   Maximum   n',
  '',
  'Ulm Bad Held      2,4      11,8    12',
  'Riedlingen        3,1       9,4    12',
  'Sigmaringen       2,8      14,2    11',
  'Tuttlingen        1,9       6,7    12',
  '',
  'Die Überschreitung in Sigmaringen im Juli 2022',
  'fällt mit dem Niedrigwasserereignis zusammen',
  'und ist in Abschnitt 3.4 gesondert behandelt.',
  '',
  'Für den Parameter Nitrat liegen die Jahresmittel',
  'aller Messstellen unterhalb des Schwellenwertes.',
];

const REPORT_PAGE_3 = [
  'Anhang B  Abweichungen vom Messrhythmus',
  '',
  'Sigmaringen  2022-11  Hochwasser, kein Zugang',
  'Riedlingen   2022-02  Gerätedefekt',
  '',
  'Diese Seite wurde quer eingezogen und trägt',
  'deshalb /Rotate 270. Wer die Seitendrehung',
  'ignoriert, schickt ein um 90 Grad gedrehtes',
  'Bild an die Texterkennung und bekommt nichts',
  'zurück — was von einer leeren Seite nicht zu',
  'unterscheiden ist.',
];

const LETTER_LINES = [
  'Universität Ulm',
  'Institut für Geowissenschaften',
  '',
  'Ulm, 4. September 2023',
  '',
  'Sehr geehrte Frau Kollegin Müller,',
  '',
  'anbei übersende ich Ihnen den Prüfbericht zu',
  'den Bohrkernproben aus dem Einzugsgebiet der',
  'oberen Donau. Der eingescannte Laborbefund im',
  'Anhang stammt aus dem Archiv und liegt uns',
  'nur als Papier vor.',
  '',
  'Mit freundlichen Grüßen',
  'Prof. Dr. H. Okonkwo',
];

const LAB_SHEET_LINES = [
  'LABORBEFUND  Nr. L-2019-0884',
  '',
  'Probe          Tiefe   pH    Leitf.',
  '',
  'BK-11/1        1,2 m   7,4   612',
  'BK-11/2        3,8 m   7,1   688',
  'BK-11/3        6,0 m   6,9   704',
  '',
  'Geprüft: 12.06.2019',
  'Unterschrift unleserlich',
];

/**
 * Build the corpus.
 *
 * @returns {Array<{ path: string, bytes: Buffer, note: string }>}
 */
export function buildScans() {
  /** @type {Array<{ path: string, bytes: Buffer, note: string }>} */
  const files = [];
  const add = (path, bytes, note) => files.push({ path, bytes, note });

  add(
    'scans/invoice-image-only.pdf',
    buildPdf({
      title: 'Rechnung 2023-004417',
      creator: 'Brother ADS-4700W',
      pages: [
        {
          image: scannedPage({
            lines: INVOICE_LINES,
            seed: 0x5ca11,
            rules: [{ y: 176 }, { y: 404, height: 3 }],
          }),
        },
      ],
    }),
    'one page, no text layer at all: the plain OCR case',
  );

  add(
    'scans/report-multi-page.pdf',
    buildPdf({
      title: 'Jahresbericht Gewässergüte 2022',
      creator: 'Brother ADS-4700W',
      pages: [
        { image: scannedPage({ lines: REPORT_PAGE_1, seed: 0x11a1 }) },
        { image: scannedPage({ lines: REPORT_PAGE_2, seed: 0x11a2 }) },
        {
          /* Captured sideways, then corrected by the page dictionary — which is what a sheet fed
             into the ADF the wrong way round produces. Both halves are needed: a `/Rotate` over an
             upright raster would render crooked and OCR perfectly, which is the opposite of the
             case being fixtured. */
          image: quarterTurn(scannedPage({ lines: REPORT_PAGE_3, seed: 0x11a3 })),
          width: 842,
          height: 595,
          rotate: 270,
        },
      ],
    }),
    'three pages, no text layer, the third carrying /Rotate 270',
  );

  add(
    'scans/skewed-page.pdf',
    buildPdf({
      title: 'Laborbefund L-2019-0884 (schief eingezogen)',
      creator: 'Brother ADS-4700W',
      pages: [
        {
          image: scannedPage({
            lines: LAB_SHEET_LINES,
            seed: 0x5c3e,
            skew: 0.055,
            rules: [{ y: 150 }],
          }),
        },
      ],
    }),
    'one page, no text layer, rotated 0.055 rad (3.15°) in the raster itself',
  );

  add(
    'scans/born-digital.pdf',
    buildPdf({
      title: 'Prüfbericht zu den Bohrkernproben BK-11',
      creator: 'LibreOffice 7.6',
      pages: [
        {
          text: [
            'Universität Ulm — Institut für Geowissenschaften',
            '',
            'Prüfbericht zu den Bohrkernproben BK-11',
            '',
            'Dieses Dokument hat eine echte Textebene. Die Pipeline muss die',
            'Texterkennung überspringen: ein zweiter Durchlauf legte eine zweite,',
            'leicht verschobene Textebene darüber und verdoppelte jeden Treffer',
            'im Suchindex.',
            '',
            'Seite 1 von 2',
          ],
        },
        {
          text: [
            'Anhang A — Messwerte',
            '',
            'Probe BK-11/1   1,2 m   pH 7,4',
            'Probe BK-11/2   3,8 m   pH 7,1',
            'Probe BK-11/3   6,0 m   pH 6,9',
            '',
            'Seite 2 von 2',
          ],
        },
      ],
    }),
    'two pages, both with a real text layer: OCR must be skipped',
  );

  add(
    'scans/mixed-text-and-scan.pdf',
    buildPdf({
      title: 'Anschreiben mit eingescanntem Anhang',
      creator: 'LibreOffice 7.6 + Brother ADS-4700W',
      pages: [
        {
          text: [
            'Universität Ulm — Institut für Geowissenschaften',
            '',
            'Ulm, 4. September 2023',
            '',
            'Sehr geehrte Frau Kollegin Müller,',
            '',
            'anbei übersende ich Ihnen den Prüfbericht zu den Bohrkernproben.',
            'Der eingescannte Laborbefund auf Seite 2 stammt aus dem Archiv und',
            'liegt uns nur als Papier vor.',
            '',
            'Mit freundlichen Grüßen',
            'Prof. Dr. H. Okonkwo',
          ],
        },
        { image: scannedPage({ lines: LAB_SHEET_LINES, seed: 0x5c4f, rules: [{ y: 150 }] }) },
      ],
    }),
    'page 1 has a text layer, page 2 does not: the flag is per page, not per document',
  );

  add(
    'scans/sparse-text-layer.pdf',
    buildPdf({
      title: 'Anschreiben mit Scannerstempel',
      creator: 'Brother ADS-4700W',
      pages: [
        {
          image: scannedPage({ lines: LETTER_LINES, seed: 0x57a3 }),
          text: ['ADS-4700W 000412'],
          textSize: 7,
          textTop: 28,
        },
      ],
    }),
    'a full page of raster under a 16-character scanner stamp: "has text" is not "has a text layer"',
  );

  return files;
}
