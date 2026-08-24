/*
 * Recueil — fixtures
 * Copyright (C) 2026 the Recueil authors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * `fixtures/archives/` — the corpus for CONCEPT §5.3 stage 3, "archive extraction (zip, eml) to
 * scratch; inner files re-enter at stage 1".
 *
 * Three archives.
 *
 * **`mixed.zip`** is the ordinary case done awkwardly: PDFs and images in subdirectories, an
 * explicit directory entry, an empty file, a name in UTF-8 with general-purpose bit 11 set, and a
 * name with an `ß` in it written in CP437 *without* bit 11 — which is what Windows Explorer produced
 * for twenty years and what turns `Grundriß.png` into `Grundri.png` in a reader that assumes UTF-8.
 *
 * **`nested.zip`** contains zips. Two of its members are archives, one of them three levels deep, so
 * a pipeline that re-enters inner files at stage 1 has to decide where to stop. The depths are
 * stated in `expected-counts.json`; a test asserts that the cap fires with a reason, not that the
 * extractor recurses until it runs out of scratch.
 *
 * **`path-traversal.zip`** must be **rejected safely**, and the distinction matters: it holds one
 * legitimate entry alongside six hostile ones. Refusing the archive wholesale and refusing the six
 * are different behaviours, and a fixture with only hostile entries cannot tell them apart. The six
 * are the six shapes that get past a naive check — a relative climb, an absolute path, backslash
 * separators, a climb that only appears after the path is normalised, a climb spelled with `.`
 * segments, and a symbolic link whose *name* is perfectly ordinary and whose target is
 * `/etc/passwd`. Five are caught by looking at the name; the sixth is only caught by looking at the
 * mode.
 *
 * The hostile names are written by `zip.mjs` rather than by an archiving library, because every
 * archiving library worth using refuses to write at least three of them.
 */
import { MODE_SYMLINK, buildZip } from './zip.mjs';

/**
 * @param {object} shared
 * @param {Buffer} shared.invoicePdf
 * @param {Buffer} shared.minutesPdf
 * @param {Buffer} shared.contractPdf
 * @param {Buffer} shared.receiptPng
 * @param {Buffer} shared.labSheetPdf
 * @returns {Array<{ path: string, bytes: Buffer, note: string }>}
 */
export function buildArchives({ invoicePdf, minutesPdf, contractPdf, receiptPng, labSheetPdf }) {
  /** @type {Array<{ path: string, bytes: Buffer, note: string }>} */
  const files = [];
  const add = (path, bytes, note) => files.push({ path, bytes, note });

  /* -- mixed.zip ---------------------------------------------------------------------------- */

  add(
    'archives/mixed.zip',
    buildZip([
      {
        name: 'Ordnerübersicht.txt',
        /* Non-ASCII and bit 11 set: the correct modern encoding. */
        data: [
          'Inhalt dieses Archivs',
          '',
          'rechnungen/  Rechnungen 2023',
          'protokolle/  Sitzungsprotokolle',
          'unterordner/ Vertraege',
          '',
        ].join('\r\n'),
      },
      { name: 'rechnungen/', directory: true },
      { name: 'rechnungen/2023-03-14-stadtwerke.pdf', data: invoicePdf },
      { name: 'rechnungen/2023-09-12-jastram.png', data: receiptPng },
      { name: 'protokolle/Protokoll 2023-03-13.pdf', data: minutesPdf },
      {
        /* CP437 is a superset of ASCII in the range this name uses; Latin-1 stands in for it here
           because `ß` sits at 0xE1 in CP437 and 0xDF in Latin-1, and what matters to the fixture is
           that the bytes are *not* UTF-8 and bit 11 is *not* set. A reader that assumes UTF-8 gets
           an invalid sequence; one that assumes CP437 gets `Grundriß`; one that assumes Latin-1 gets
           something else again. All three are wrong to guess. */
        name: 'Grundriß.png',
        nameEncoding: 'latin1',
        utf8: false,
        data: receiptPng,
      },
      { name: 'leere-datei.txt', data: Buffer.alloc(0) },
      { name: 'unterordner/', directory: true },
      { name: 'unterordner/mietvertrag.pdf', data: contractPdf },
    ]),
    'PDFs and images in subdirectories, an empty file, a directory entry, and one filename in ' +
      'CP437 without the UTF-8 flag',
  );

  /* -- nested.zip --------------------------------------------------------------------------- */

  const innermost = buildZip([
    {
      name: 'ende.txt',
      data: 'Vier Ebenen tief. Ein Extraktor ohne Tiefenbegrenzung findet das hier.\r\n',
    },
  ]);
  const deeper = buildZip([
    { name: 'innerste.zip', data: innermost, store: true },
    { name: 'hinweis.txt', data: 'Die naechste Ebene liegt in innerste.zip.\r\n' },
  ]);
  const inner = buildZip([
    /* Byte-identical to `scans/invoice-image-only.pdf` and to the copy in `mixed.zip`: the same
       Document arriving for the fourth time, now two archive levels down. */
    { name: 'rechnungen/2023-03-14-stadtwerke.pdf', data: invoicePdf },
    { name: 'laborbefund.pdf', data: labSheetPdf },
  ]);

  add(
    'archives/nested.zip',
    buildZip([
      {
        name: 'readme.txt',
        data: [
          'Sicherung 2023.',
          '',
          'innen.zip           enthaelt Rechnungen und einen Laborbefund',
          'tiefer/noch-tiefer.zip enthaelt innerste.zip enthaelt ende.txt',
          '',
        ].join('\r\n'),
      },
      /* Zip members are stored, not deflated: a zip inside a zip does not compress and a reader
         that streams the outer entry sees the inner archive's signature immediately. */
      { name: 'innen.zip', data: inner, store: true },
      { name: 'tiefer/', directory: true },
      { name: 'tiefer/noch-tiefer.zip', data: deeper, store: true },
    ]),
    'archives inside the archive, reaching four levels down at the deepest',
  );

  /* -- path-traversal.zip ------------------------------------------------------------------- */

  add(
    'archives/path-traversal.zip',
    buildZip(
      [
        {
          name: 'harmlos.txt',
          data:
            'Dies ist der einzige zulaessige Eintrag in diesem Archiv.\r\n' +
            'Wer das ganze Archiv verwirft, verwirft auch diese Datei.\r\n',
        },
        {
          name: '../../../../tmp/recueil-pwned.txt',
          data: 'relative climb out of the extraction root\r\n',
        },
        {
          name: '/etc/recueil-pwned.txt',
          data: 'absolute path; path.join() with a root discards the root entirely\r\n',
        },
        {
          name: '..\\..\\recueil-pwned-win.txt',
          data: 'backslash separators; harmless on Linux, a climb on Windows\r\n',
        },
        {
          name: 'unterordner/../../escape.txt',
          data: 'only a climb after normalisation; a startsWith() on the raw name passes it\r\n',
        },
        {
          name: '.././.././recueil-pwned-dots.txt',
          data: 'the same climb spelled with single-dot segments\r\n',
        },
        {
          /* A zip may declare a member to be a symbolic link, in the high bits of the external
             attributes; the entry data is the link target. Extract it faithfully and the next write
             through that name lands in /etc/passwd. */
          name: 'link-nach-etc-passwd',
          data: '/etc/passwd',
          store: true,
          externalAttributes: MODE_SYMLINK,
        },
      ],
      { comment: 'Recueil fixture: every entry but harmlos.txt must be refused.' },
    ),
    'one legitimate entry and six hostile ones, including a symlink to /etc/passwd',
  );

  return files;
}
