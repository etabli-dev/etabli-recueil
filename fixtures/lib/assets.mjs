/*
 * Recueil — fixtures
 * Copyright (C) 2026 the Recueil authors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The handful of documents that appear in more than one corpus.
 *
 * They are shared on purpose. CONCEPT §5.3 stage 2 is an exact-duplicate check against document
 * hashes, and stage 3 sends the contents of archives and mail back round to stage 1 — so the corpus
 * has to contain the same bytes arriving by several routes. The invoice is on disk under `scans/`,
 * attached to a message under `mail/`, inside two archives under `archives/`, and downloadable from
 * the Paperless dump. One Document, five arrivals, four Items: that is the assertion, and it is only
 * possible if the bytes really are identical.
 */
import { buildPdf } from './pdf.mjs';
import { INK, PAPER, canvas, drawText, encodePng, fillRect, speckle } from './raster.mjs';

/**
 * A small greyscale PNG of a till receipt — the "photograph from a phone" arrival path, and the one
 * non-PDF binary the corpus carries around.
 *
 * @returns {Buffer}
 */
export function receiptPng() {
  const page = canvas(420, 300);
  fillRect(page, { x: 0, y: 0, width: 420, height: 4, ink: 0x88 });
  const lines = [
    'BUCHHANDLUNG JASTRAM',
    'Hirschstraße 12, 89073 Ulm',
    '',
    '1x Lehrbuch der Hydrologie   48,00',
    '1x Versand                    3,90',
    '',
    'SUMME                        51,90',
    'MwSt 7 %                      3,40',
    '',
    'Beleg 2023/0912   12.09.2023',
  ];
  lines.forEach((line, index) => {
    if (!line) return;
    drawText(page, { text: line, x: 18, y: 24 + index * 26, scale: 2 });
  });
  fillRect(page, { x: 18, y: 214, width: 384, height: 2, ink: INK });
  speckle(page, { seed: 0xbe11, density: 0.004 });
  return encodePng(page);
}

/**
 * A 160 × 40 wordmark, used as the inline `cid:` image in the mail corpus. Small enough that the
 * base64 of it stays readable in the `.eml`.
 *
 * @returns {Buffer}
 */
export function logoPng() {
  const mark = canvas(160, 40, PAPER);
  fillRect(mark, { x: 0, y: 0, width: 160, height: 40, ink: 0xe0 });
  drawText(mark, { text: 'RECUEIL', x: 12, y: 10, scale: 3, ink: 0x30 });
  return encodePng(mark);
}

/**
 * A born-digital minutes document: a real text layer, two pages, no raster. The counterpart to the
 * scans, so that a mail with two attachments has one of each.
 *
 * @returns {Buffer}
 */
export function minutesPdf() {
  return buildPdf({
    title: 'Protokoll der Sitzung vom 13. März 2023',
    creator: 'LibreOffice 7.6',
    pages: [
      {
        text: [
          'Arbeitskreis Gewässergüte — Protokoll',
          '',
          'Sitzung vom 13. März 2023, 14:00–16:30 Uhr, Ulm',
          '',
          'Anwesend: A. Weiß (Vorsitz), H. Okonkwo, C. Müller, J. Bianchi',
          '',
          'TOP 1  Genehmigung des Protokolls vom 12. Dezember 2022',
          'TOP 2  Bericht zur Messreihe Sigmaringen',
          'TOP 3  Beschaffung eines zweiten Trübungssensors',
          'TOP 4  Verschiedenes',
          '',
          'Zu TOP 2 wurde die Überschreitung vom Juli 2022 erörtert. Die',
          'Messstelle wird bis zum Herbst zusätzlich beprobt.',
        ],
      },
      {
        text: [
          'Zu TOP 3',
          '',
          'Zwei Angebote liegen vor. Die Beschaffung wird zurückgestellt,',
          'bis die Haushaltsmittel für 2024 feststehen.',
          '',
          'Nächste Sitzung: 19. Juni 2023',
        ],
      },
    ],
  });
}

/**
 * A one-page laboratory result with a real text layer — the born-digital twin of the sheet that is
 * scanned in `scans/skewed-page.pdf`. Both are in the corpus so that "the same document, once as a
 * scan and once as a file" is a near-duplicate rather than an exact one: the hashes differ, the
 * extracted text does not, and only the simhash layer of CONCEPT §5.6 can see the relationship.
 *
 * @returns {Buffer}
 */
export function labSheetPdf() {
  return buildPdf({
    title: 'Laborbefund L-2019-0884',
    creator: 'LabWare 7',
    pages: [
      {
        text: [
          'LABORBEFUND  Nr. L-2019-0884',
          '',
          'Probe          Tiefe   pH    Leitfähigkeit',
          '',
          'BK-11/1        1,2 m   7,4   612 uS/cm',
          'BK-11/2        3,8 m   7,1   688 uS/cm',
          'BK-11/3        6,0 m   6,9   704 uS/cm',
          '',
          'Geprüft: 12.06.2019',
        ],
      },
    ],
  });
}

/**
 * A one-page contract, used where the corpus needs a third distinct PDF.
 *
 * @returns {Buffer}
 */
export function contractPdf() {
  return buildPdf({
    title: 'Mietvertrag Lagerraum 2021',
    creator: 'LibreOffice 7.6',
    pages: [
      {
        text: [
          'Mietvertrag über einen Lagerraum',
          '',
          'zwischen Hausverwaltung Kessler GmbH (Vermieter)',
          'und R. Heller (Mieter)',
          '',
          '§ 1  Mietsache: Lagerraum Nr. 14, Souterrain, ca. 11 m²',
          '§ 2  Mietzins: 62,00 € monatlich, fällig zum Dritten',
          '§ 3  Laufzeit: ab 1. Oktober 2021, unbefristet',
          '§ 4  Kündigungsfrist: drei Monate zum Quartalsende',
          '',
          'Ulm, 21. September 2021',
        ],
      },
    ],
  });
}
