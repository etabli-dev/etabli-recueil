/*
 * Recueil — fixtures
 * Copyright (C) 2026 the Recueil authors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The promise the Phase 2 corpora make, and the code that refuses to publish a receipt unless the
 * corpora keep it.
 *
 * `EXPECTED` below is written by hand from the corpus designs in `scans.mjs`, `mail.mjs`,
 * `archives.mjs`, `paperless.mjs` and `rules.mjs`. Everything else here reads what was built — most
 * of it through the independent readers in `oracles.mjs` — and compares. A mismatch is a build
 * failure, not a diff to be accepted. This is the same arrangement as `zotero/lib/counts.mjs`, and
 * for the same reason: `expected-counts.json` must be a receipt for a promise, not a record of
 * whatever the generator happened to emit.
 *
 * The properties asserted are the ones a test will assert on. For a scan that is "how many pages,
 * how many of them have a text layer, how many have a raster, what are the rotations" — because
 * those four numbers are precisely what decides whether the OCR stage runs. For a message it is the
 * part structure, the attachment names and the decoded Subject. For an archive it is the entry
 * names byte for byte, the CRCs, and which entries are hostile.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The corpora, and the numbers promised for each file in them. */
export const EXPECTED = {
  /**
   * `pages` / `textLayerPages` / `imagePages` / `rotations` are read back with pdf.js.
   * `textCharacters` is the total across pages; for the image-only documents it must be exactly
   * zero, which is the assertion the whole OCR stage rests on.
   */
  scans: {
    'invoice-image-only.pdf': {
      pages: 1,
      textLayerPages: 0,
      imagePages: 1,
      textCharacters: 0,
      rotations: [0],
    },
    'report-multi-page.pdf': {
      pages: 3,
      textLayerPages: 0,
      imagePages: 3,
      textCharacters: 0,
      rotations: [0, 0, 270],
    },
    'skewed-page.pdf': {
      pages: 1,
      textLayerPages: 0,
      imagePages: 1,
      textCharacters: 0,
      rotations: [0],
    },
    'born-digital.pdf': {
      pages: 2,
      textLayerPages: 2,
      imagePages: 0,
      rotations: [0, 0],
    },
    'mixed-text-and-scan.pdf': {
      pages: 2,
      textLayerPages: 1,
      imagePages: 1,
      rotations: [0, 0],
    },
    'sparse-text-layer.pdf': {
      pages: 1,
      textLayerPages: 1,
      imagePages: 1,
      /* Sixteen characters of scanner stamp over a full page of raster. A pipeline that skips OCR
         on "has a text layer" loses the page; one that skips on "has enough text" keeps it. */
      textCharacters: 16,
      rotations: [0],
    },
  },

  /** Read back with Python's `email` package. `defects` is its own vocabulary of defect classes. */
  mail: {
    'plain-text.eml': {
      contentType: 'text/plain',
      isMultipart: false,
      parts: 1,
      attachments: 0,
      inlineWithContentId: 0,
      nestedMessages: 0,
      utf8Valid: true,
      defects: 0,
      subject: 'Kurze Rückmeldung zur Messreihe Sigmaringen',
    },
    'html-multipart.eml': {
      contentType: 'multipart/alternative',
      isMultipart: true,
      parts: 3,
      attachments: 0,
      inlineWithContentId: 0,
      nestedMessages: 0,
      utf8Valid: true,
      defects: 0,
      subject: 'Ausgabe 6/2023: Niedrigwasser und Grundwasserneubildung',
    },
    'two-attachments.eml': {
      contentType: 'multipart/mixed',
      isMultipart: true,
      parts: 4,
      attachments: 2,
      inlineWithContentId: 0,
      nestedMessages: 0,
      utf8Valid: true,
      defects: 0,
      subject: 'Ihre Rechnung 2023-004417 und das Sitzungsprotokoll',
    },
    'inline-image.eml': {
      contentType: 'multipart/related',
      isMultipart: true,
      parts: 4,
      /* The wordmark is inline and is not one of these. */
      attachments: 1,
      inlineWithContentId: 1,
      nestedMessages: 0,
      utf8Valid: true,
      defects: 0,
      subject: 'Ihre Bestellung 2023/0912',
    },
    'forwarded-nested.eml': {
      contentType: 'multipart/mixed',
      isMultipart: true,
      /* outer, text, message/rfc822, the inner message, its text, its PDF. */
      parts: 6,
      attachments: 2,
      inlineWithContentId: 0,
      nestedMessages: 1,
      utf8Valid: true,
      defects: 0,
      subject: 'Fwd: Mietvertrag Lagerraum Nr. 14',
    },
    'subject-non-utf8.eml': {
      contentType: 'text/plain',
      isMultipart: false,
      parts: 1,
      attachments: 0,
      inlineWithContentId: 0,
      nestedMessages: 0,
      /* The whole point. Reading this file as UTF-8 destroys it. */
      utf8Valid: false,
      defects: 0,
      subject: 'Zahlungserinnerung: 471,50 € offen (Kundennr. 88-201934)',
    },
    'malformed-boundary.eml': {
      contentType: 'multipart/mixed',
      isMultipart: true,
      /* The outer message and the one part that could be recovered. The second part's delimiter is
         two hyphens short, so it reads as a continuation of the first part's body rather than as a
         part of its own — which is exactly the recovery a pipeline must make and then report. */
      parts: 2,
      attachments: 0,
      inlineWithContentId: 0,
      nestedMessages: 0,
      utf8Valid: true,
      /* Python records a defect rather than raising. That it records one is the assertion; which
         one it is, is in the manifest. */
      defects: 1,
      subject: 'Befund vom 26.10.2023',
    },
    'attachment-name-traversal.eml': {
      contentType: 'multipart/mixed',
      isMultipart: true,
      parts: 7,
      attachments: 5,
      inlineWithContentId: 0,
      nestedMessages: 0,
      utf8Valid: true,
      defects: 0,
      subject: 'Invoice 88201934 attached',
    },
  },

  /** Read back with Python's `zipfile`, `testzip()` included. */
  archives: {
    'mixed.zip': {
      entries: 9,
      directories: 2,
      /* One name is CP437 without general-purpose bit 11, one is UTF-8 with it. */
      utf8FlagEntries: 1,
      nonAsciiNames: 2,
      emptyEntries: 1,
      symlinks: 0,
      hostileNames: 0,
      crcFailures: 0,
    },
    'nested.zip': {
      entries: 4,
      directories: 1,
      utf8FlagEntries: 0,
      nonAsciiNames: 0,
      emptyEntries: 0,
      symlinks: 0,
      hostileNames: 0,
      crcFailures: 0,
      /* nested.zip → tiefer/noch-tiefer.zip → innerste.zip. An extractor needs a cap. */
      innerArchives: 2,
      maxArchiveDepth: 3,
    },
    'path-traversal.zip': {
      entries: 7,
      directories: 0,
      utf8FlagEntries: 0,
      nonAsciiNames: 0,
      emptyEntries: 0,
      symlinks: 1,
      /* Five hostile by name; the sixth is hostile by mode — a symbolic link whose own name is
         perfectly ordinary. `harmlos.txt` is the seventh, and it is what makes "reject the
         archive" and "reject the entries" distinguishable. */
      hostileNames: 5,
      crcFailures: 0,
    },
  },

  /** The Paperless dump. Counted from the JSON the generator wrote, not from the definitions. */
  paperless: {
    apiFiles: 10,
    originals: 11,
    /* 1001 and 1009 are the same bytes. */
    distinctOriginalHashes: 10,
    documentsLive: 11,
    documentsTrashed: 1,
    documentPages: 2,
    pageSize: 8,
    withAsn: 7,
    withoutCorrespondent: 1,
    withoutDocumentType: 2,
    withEmptyContent: 2,
    withNotes: 1,
    longestTitle: 303,
    unfetchable: 1,
    hostileFilenames: 1,
    tags: 9,
    inboxTags: 1,
    correspondents: 6,
    documentTypes: 5,
    storagePaths: 2,
    customFields: 6,
    routes: 21,
  },

  /**
   * The same bytes, arriving by more than one route.
   *
   * CONCEPT §5.3 stage 2 is an exact-duplicate check against Document hashes, and stage 3 sends the
   * contents of archives and messages back round to stage 1. Neither is fixtured unless the corpus
   * really does contain the same bytes several times over — on disk, inside a zip, inside a zip
   * inside a zip, and base64-encoded in a message. Each key below is the file on disk that holds
   * those bytes; the number is how many places the oracles find them, counting that one.
   *
   * The invoice's six: `scans/invoice-image-only.pdf`, two Paperless originals (1001 and 1009 are a
   * document filed twice), an entry in `mixed.zip`, an entry in `nested.zip`'s inner archive, and an
   * attachment on `two-attachments.eml`.
   */
  arrivals: {
    'scans/invoice-image-only.pdf': 6,
    'paperless/originals/1003.png': 4,
    'paperless/originals/1002.pdf': 3,
    'paperless/originals/1004.pdf': 3,
  },

  /** The rule corpus. */
  rules: {
    files: 7,
    rulesByFile: {
      'precedence.yaml': 6,
      'precedence.json': 6,
      'negation.yaml': 5,
      'hostile-regex.yaml': 7,
      'malformed.yaml': 6,
    },
    cases: 11,
    /* `malformed.yaml` is valid YAML and an invalid rule set; everything else is both. */
    yamlParses: 4,
  },
};

/**
 * Measure the built corpora and assert them against `EXPECTED`.
 *
 * @param {object} spec
 * @param {string} spec.fixturesDir  the `fixtures/` directory
 * @param {Array<{ path: string, bytes: Buffer, note: string }>} spec.files  what was written
 * @param {object} spec.paperlessSummary  the summary `buildPaperless()` returned
 * @param {object} spec.oracles  `{ pdf, mail, archives, yaml }`, each `{ available, ... }`
 * @returns {object} the `ingest` block of `expected-counts.json`
 */
export function measureIngestFixtures({ fixturesDir, files, paperlessSummary, oracles }) {
  /** @type {string[]} */
  const problems = [];
  const check = (label, actual, expected) => {
    const same = JSON.stringify(actual) === JSON.stringify(expected);
    if (!same) {
      problems.push(`${label}: expected ${JSON.stringify(expected)}, built ${JSON.stringify(actual)}`);
    }
    return actual;
  };

  /* -- what is on disk ---------------------------------------------------------------------- */

  const onDisk = files.map((file) => {
    const absolute = path.join(fixturesDir, file.path);
    const bytes = fs.readFileSync(absolute);
    if (!bytes.equals(file.bytes)) {
      problems.push(`${file.path} on disk differs from what the generator produced`);
    }
    return {
      path: file.path,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      note: file.note,
    };
  });
  const byPath = new Map(onDisk.map((file) => [file.path, file]));

  /* -- scans -------------------------------------------------------------------------------- */

  const scans = measureCorpus('scans', EXPECTED.scans, (name, expected) => {
    const key = `scans/${name}`;
    const found = oracles.pdf.available ? oracles.pdf.byFile[key] : null;
    if (!found) return { ...byPathEntry(key), oracle: null };
    check(`scans/${name}.pages`, found.pages, expected.pages);
    check(`scans/${name}.textLayerPages`, found.pagesWithTextLayer, expected.textLayerPages);
    check(`scans/${name}.imagePages`, found.pagesWithImage, expected.imagePages);
    check(`scans/${name}.rotations`, found.rotations, expected.rotations);
    if (expected.textCharacters !== undefined) {
      check(`scans/${name}.textCharacters`, found.textCharacters, expected.textCharacters);
    }
    return {
      ...byPathEntry(key),
      pages: found.pages,
      textLayerPages: found.pagesWithTextLayer,
      imagePages: found.pagesWithImage,
      textCharacters: found.textCharacters,
      rotations: found.rotations,
      title: found.title,
    };
  });

  /* -- mail --------------------------------------------------------------------------------- */

  const mail = measureCorpus('mail', EXPECTED.mail, (name, expected) => {
    const key = `mail/${name}`;
    const found = oracles.mail.available ? oracles.mail.byFile[key] : null;
    if (!found) return { ...byPathEntry(key), oracle: null };
    check(`mail/${name}.contentType`, found.contentType, expected.contentType);
    check(`mail/${name}.isMultipart`, found.isMultipart, expected.isMultipart);
    check(`mail/${name}.parts`, found.parts, expected.parts);
    check(`mail/${name}.attachments`, found.attachmentCount, expected.attachments);
    check(`mail/${name}.inlineWithContentId`, found.inlineWithContentId, expected.inlineWithContentId);
    check(`mail/${name}.nestedMessages`, found.nestedMessages, expected.nestedMessages);
    check(`mail/${name}.utf8Valid`, found.utf8Valid, expected.utf8Valid);
    check(`mail/${name}.defects`, found.defects.length, expected.defects);
    check(`mail/${name}.subject`, found.subject, expected.subject);
    return {
      ...byPathEntry(key),
      contentType: found.contentType,
      parts: found.parts,
      attachments: found.attachments,
      inlineWithContentId: found.inlineWithContentId,
      nestedMessages: found.nestedMessages,
      utf8Valid: found.utf8Valid,
      defects: found.defects,
      subject: found.subject,
      from: found.from,
    };
  });

  /* -- archives ----------------------------------------------------------------------------- */

  const archives = measureCorpus('archives', EXPECTED.archives, (name, expected) => {
    const key = `archives/${name}`;
    const found = oracles.archives.available ? oracles.archives.byFile[key] : null;
    if (!found) return { ...byPathEntry(key), oracle: null };
    const hostile = found.byEntry.filter((entry) => isHostile(entry.rawName));
    const actual = {
      entries: found.entries,
      directories: found.byEntry.filter((entry) => entry.directory).length,
      utf8FlagEntries: found.byEntry.filter((entry) => entry.utf8Flag).length,
      nonAsciiNames: found.byEntry.filter((entry) => !/^[\x20-\x7e]*$/.test(entry.rawName)).length,
      emptyEntries: found.byEntry.filter((entry) => !entry.directory && entry.size === 0).length,
      symlinks: found.byEntry.filter((entry) => entry.symlink).length,
      hostileNames: hostile.length,
      crcFailures: found.crcFailures.length,
    };
    for (const [property, want] of Object.entries(expected)) {
      if (property in actual) check(`archives/${name}.${property}`, actual[property], want);
    }
    return {
      ...byPathEntry(key),
      ...actual,
      ...(expected.innerArchives === undefined
        ? {}
        : {
            innerArchives: check(
              `archives/${name}.innerArchives`,
              found.byEntry.filter((entry) => entry.rawName.endsWith('.zip')).length,
              expected.innerArchives,
            ),
            maxArchiveDepth: expected.maxArchiveDepth,
          }),
      hostileEntryNames: hostile.map((entry) => entry.rawName),
      byEntry: found.byEntry.map((entry) => ({
        name: entry.rawName,
        utf8Flag: entry.utf8Flag,
        directory: entry.directory,
        symlink: entry.symlink,
        size: entry.size,
        crc: entry.crc,
        hostile: isHostile(entry.rawName),
      })),
    };
  });

  /* -- paperless ---------------------------------------------------------------------------- */

  const originals = onDisk.filter((file) => file.path.startsWith('paperless/originals/'));
  const paperless = {
    ...paperlessSummary,
    apiFiles: onDisk.filter((file) => file.path.startsWith('paperless/api/')).length,
    originals: {
      ...paperlessSummary.originals,
      distinctHashes: new Set(originals.map((file) => file.sha256)).size,
      contents: originals.map((file) => ({
        path: file.path,
        bytes: file.bytes,
        sha256: file.sha256,
      })),
    },
  };
  check('paperless.apiFiles', paperless.apiFiles, EXPECTED.paperless.apiFiles);
  check('paperless.originals', originals.length, EXPECTED.paperless.originals);
  check(
    'paperless.distinctOriginalHashes',
    paperless.originals.distinctHashes,
    EXPECTED.paperless.distinctOriginalHashes,
  );
  check('paperless.documentsLive', paperlessSummary.documents.live, EXPECTED.paperless.documentsLive);
  check(
    'paperless.documentsTrashed',
    paperlessSummary.documents.trashed,
    EXPECTED.paperless.documentsTrashed,
  );
  check('paperless.documentPages', paperlessSummary.documents.pages, EXPECTED.paperless.documentPages);
  check('paperless.pageSize', paperlessSummary.pageSize, EXPECTED.paperless.pageSize);
  check('paperless.withAsn', paperlessSummary.documents.withAsn, EXPECTED.paperless.withAsn);
  check(
    'paperless.withoutCorrespondent',
    paperlessSummary.documents.withoutCorrespondent,
    EXPECTED.paperless.withoutCorrespondent,
  );
  check(
    'paperless.withoutDocumentType',
    paperlessSummary.documents.withoutDocumentType,
    EXPECTED.paperless.withoutDocumentType,
  );
  check(
    'paperless.withEmptyContent',
    paperlessSummary.documents.withEmptyContent,
    EXPECTED.paperless.withEmptyContent,
  );
  check('paperless.withNotes', paperlessSummary.documents.withNotes, EXPECTED.paperless.withNotes);
  check(
    'paperless.longestTitle',
    paperlessSummary.documents.longestTitle,
    EXPECTED.paperless.longestTitle,
  );
  check(
    'paperless.unfetchable',
    paperlessSummary.documents.unfetchable.length,
    EXPECTED.paperless.unfetchable,
  );
  check(
    'paperless.hostileFilenames',
    paperlessSummary.documents.hostileFilenames.length,
    EXPECTED.paperless.hostileFilenames,
  );
  check('paperless.tags', paperlessSummary.tags.total, EXPECTED.paperless.tags);
  check('paperless.inboxTags', paperlessSummary.tags.inbox, EXPECTED.paperless.inboxTags);
  check(
    'paperless.correspondents',
    paperlessSummary.correspondents.total,
    EXPECTED.paperless.correspondents,
  );
  check(
    'paperless.documentTypes',
    paperlessSummary.documentTypes.total,
    EXPECTED.paperless.documentTypes,
  );
  check(
    'paperless.storagePaths',
    paperlessSummary.storagePaths.total,
    EXPECTED.paperless.storagePaths,
  );
  check('paperless.customFields', paperlessSummary.customFields.total, EXPECTED.paperless.customFields);
  check('paperless.routes', paperlessSummary.routes, EXPECTED.paperless.routes);

  /* -- rules -------------------------------------------------------------------------------- */

  const ruleFiles = onDisk.filter((file) => file.path.startsWith('rules/'));
  check('rules.files', ruleFiles.length, EXPECTED.rules.files);
  const cases = JSON.parse(
    fs.readFileSync(path.join(fixturesDir, 'rules', 'cases.json'), 'utf8'),
  );
  check('rules.cases', cases.cases.length, EXPECTED.rules.cases);
  const yamlParses = oracles.yaml.available
    ? Object.values(oracles.yaml.byFile).filter((result) => result.parses).length
    : null;
  if (yamlParses !== null) check('rules.yamlParses', yamlParses, EXPECTED.rules.yamlParses);

  const rules = {
    files: ruleFiles.length,
    rulesByFile: EXPECTED.rules.rulesByFile,
    cases: cases.cases.length,
    caseIds: cases.cases.map((one) => one.id),
    yaml: oracles.yaml.available ? oracles.yaml.byFile : null,
    contents: ruleFiles.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      note: file.note,
    })),
  };

  /* -- the documents that arrive by more than one route ------------------------------------- */

  /*
   * Built from three sources, none of them the generator's own bookkeeping: the files on disk, the
   * zip entries the Python reader extracted and hashed (recursively, so an entry inside an inner
   * archive counts), and the decoded MIME payloads. A claim that the same document arrives four ways
   * is only worth making if something other than the code that put it there has found it four times.
   */
  /** @type {Map<string, Array<{ at: string, bytes: number }>>} */
  const byHash = new Map();
  const arrival = (sha256, at, bytes) => {
    if (!byHash.has(sha256)) byHash.set(sha256, []);
    byHash.get(sha256).push({ at, bytes });
  };
  for (const file of onDisk) arrival(file.sha256, file.path, file.bytes);
  if (oracles.archives.available) {
    for (const [archivePath, found] of Object.entries(oracles.archives.byFile)) {
      for (const entry of found.allEntries) {
        if (entry.directory) continue;
        arrival(entry.sha256, `${archivePath}!${entry.qualifiedName}`, entry.size);
      }
    }
  }
  if (oracles.mail.available) {
    for (const [messagePath, found] of Object.entries(oracles.mail.byFile)) {
      for (const payload of found.payloads) {
        if (!payload.name) continue;
        arrival(payload.sha256, `${messagePath}!${payload.name}`, payload.bytes);
      }
    }
  }

  const sharedDocuments = [...byHash.entries()]
    .filter(([, places]) => places.length > 1)
    .map(([sha256, places]) => ({
      sha256,
      bytes: places[0].bytes,
      arrivals: places.length,
      appearsAs: places.map((place) => place.at).sort(),
    }))
    .sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1));

  if (oracles.archives.available && oracles.mail.available) {
    check('arrivals.sets', sharedDocuments.length, Object.keys(EXPECTED.arrivals).length);
    for (const [home, count] of Object.entries(EXPECTED.arrivals)) {
      const set = sharedDocuments.find((one) => one.appearsAs.includes(home));
      check(`arrivals[${home}]`, set ? set.arrivals : 0, count);
    }
  }

  if (problems.length) {
    throw new Error(
      `the built ingestion corpora do not match the stated counts:\n  - ${problems.join('\n  - ')}`,
    );
  }

  return {
    generatedBy: 'fixtures/make-ingest.mjs',
    description:
      'Counts for the Phase 2 ingestion corpora, asserted by the generator against the numbers ' +
      'stated in fixtures/lib/ingest-fixtures.mjs and read back with independent parsers. ' +
      'Ingestion tests should assert against these.',
    oracles: {
      pdf: oracles.pdf.available ? oracles.pdf.reader : null,
      mail: oracles.mail.available ? oracles.mail.reader : null,
      archives: oracles.archives.available ? oracles.archives.reader : null,
      yaml: oracles.yaml.available ? oracles.yaml.reader : null,
    },
    files: onDisk.length,
    totalBytes: onDisk.reduce((sum, file) => sum + file.bytes, 0),
    scans: { files: Object.keys(scans).length, byFile: scans },
    mail: { files: Object.keys(mail).length, byFile: mail },
    archives: { files: Object.keys(archives).length, byFile: archives },
    paperless,
    rules,
    sharedDocuments,
    contents: onDisk.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
    })),
  };

  function byPathEntry(key) {
    const file = byPath.get(key);
    if (!file) {
      problems.push(`${key} is promised but was not written`);
      return { bytes: 0, sha256: null };
    }
    return { bytes: file.bytes, sha256: file.sha256 };
  }

  function measureCorpus(dirName, expected, measureOne) {
    const stated = Object.keys(expected).sort();
    const present = onDisk
      .filter((file) => file.path.startsWith(`${dirName}/`))
      .map((file) => file.path.slice(dirName.length + 1))
      .sort();
    for (const name of present) {
      if (!expected[name]) problems.push(`${dirName}/${name} was written but is not stated`);
    }
    for (const name of stated) {
      if (!present.includes(name)) problems.push(`${dirName}/${name} is stated but not written`);
    }
    /** @type {Record<string, object>} */
    const result = {};
    for (const name of stated) {
      if (!present.includes(name)) continue;
      result[name] = measureOne(name, expected[name]);
    }
    return result;
  }
}

/**
 * Is this archive entry name an attempt to write outside the extraction root?
 *
 * Absolute, a drive letter, a `..` segment under either separator, or a name that normalises to one.
 * Deliberately written as a predicate over the *raw* name, because that is the string an extractor
 * receives and the only one it can be judged on.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isHostile(name) {
  if (name.startsWith('/') || name.startsWith('\\')) return true;
  if (/^[A-Za-z]:/.test(name)) return true;
  return name
    .split(/[\\/]/)
    .some((segment) => segment === '..');
}
