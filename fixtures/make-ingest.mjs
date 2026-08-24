#!/usr/bin/env node
/*
 * Recueil — fixtures
 * Copyright (C) 2026 the Recueil authors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Generate the Phase 2 ingestion corpora.
 *
 *   node fixtures/make-ingest.mjs
 *   node fixtures/make-ingest.mjs --check
 *
 * Writes, into `--out` (default `fixtures/`):
 *
 *   scans/       PDFs with and without a text layer, for the OCR stage
 *   mail/        .eml files, for the IMAP source
 *   archives/    zips, one of which must be refused
 *   paperless/   a Paperless-ngx API dump with a route table and the originals
 *   rules/       rule files and the case table they are asserted against
 *
 * and folds the counts into `fixtures/expected-counts.json` under the key `ingest`, leaving every
 * other key in that file alone. The Zotero generator owns `zotero` and `formats` and leaves `ingest`
 * alone in the same way, so the two can be run in either order — but `expected-counts.json` has to
 * exist first, which means `fixtures/zotero/make-fixture.mjs` runs at least once before this does.
 *
 * Nothing here is downloaded. Every PDF, PNG, message and archive is drawn, assembled or encoded by
 * this repository's own code, so the corpus is redistributable and rebuildable with nothing
 * installed beyond the workspace.
 *
 * The generator is deterministic: no clock, no `Math.random()`, pinned deflate levels. Running it
 * twice produces byte-identical files.
 *
 * Options
 * -------
 *   --out=DIR      where to write (default: the directory this script lives in)
 *   --no-counts    build but do not touch `expected-counts.json`
 *   --no-oracle    do not read the corpora back with the independent parsers; the manifest then
 *                  records which oracles did not run, and the counts they would have checked are
 *                  not checked. Use it to build on a machine without python3, never in CI.
 *   --check        write nothing; rebuild into a temporary directory and report whether what is
 *                  committed still matches. Exits 1 if it does not.
 *   --quiet        print nothing on success
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  contractPdf as buildContractPdf,
  labSheetPdf as buildLabSheetPdf,
  logoPng as buildLogoPng,
  minutesPdf as buildMinutesPdf,
  receiptPng as buildReceiptPng,
} from './lib/assets.mjs';
import { buildArchives } from './lib/archives.mjs';
import { measureIngestFixtures } from './lib/ingest-fixtures.mjs';
import { buildMail } from './lib/mail.mjs';
import { buildPaperless } from './lib/paperless.mjs';
import { buildPdf } from './lib/pdf.mjs';
import { buildRules } from './lib/rules.mjs';
import { buildScans } from './lib/scans.mjs';
import { emlOracle, pdfOracle, yamlOracle, zipOracle } from './lib/oracles.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COUNTS_FILE = path.join(HERE, 'expected-counts.json');
/** The directories this generator owns, and clears before writing. */
const CORPORA = ['scans', 'mail', 'archives', 'paperless', 'rules'];

const options = parseArgs(process.argv.slice(2));

if (options.check) {
  await check();
  process.exit(0);
}

const outDir = options.out ? path.resolve(options.out) : HERE;
const isDefaultOut = path.resolve(outDir) === path.resolve(HERE);

const files = buildCorpora();
write(outDir, files);

const oracles = await readBack(outDir, files);
const manifest = measureIngestFixtures({
  fixturesDir: outDir,
  files: files.files,
  paperlessSummary: files.paperlessSummary,
  oracles,
});

if (options.counts && isDefaultOut) {
  mergeIntoCounts(manifest);
}

if (!options.quiet) report(manifest);

/* ------------------------------------------------------------------------------------------------ */

/**
 * Build every corpus.
 *
 * The shared documents are built once and passed around by reference, because the exact-duplicate
 * check at CONCEPT §5.3 stage 2 is only fixtured if the bytes really are the same bytes.
 */
function buildCorpora() {
  const scans = buildScans();
  const invoicePdf = requireFile(scans, 'scans/invoice-image-only.pdf');
  const shared = {
    invoicePdf,
    minutesPdf: buildMinutesPdf(),
    contractPdf: buildContractPdf(),
    labSheetPdf: buildLabSheetPdf(),
    receiptPng: buildReceiptPng(),
    logoPng: buildLogoPng(),
  };

  const paperless = buildPaperless(shared, (spec) =>
    buildPdf({
      title: spec.title,
      creator: 'Paperless-ngx fixture',
      pages: Array.from({ length: spec.pages }, (_, index) => ({
        text: index === 0 ? spec.lines : [`${spec.title} — Seite ${index + 1}`],
      })),
    }),
  );

  return {
    files: [
      ...scans,
      ...buildMail(shared),
      ...buildArchives(shared),
      ...paperless.files,
      ...buildRules(),
    ],
    paperlessSummary: paperless.summary,
  };
}

/** Clear the five directories and write the corpus. */
function write(root, { files }) {
  for (const corpus of CORPORA) {
    fs.rmSync(path.join(root, corpus), { recursive: true, force: true });
  }
  for (const file of files) {
    const absolute = resolveInside(root, file.path);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, file.bytes);
  }
}

/**
 * Resolve a corpus-relative path inside the output root, and refuse anything that escapes it.
 *
 * The generator writes filenames that are themselves attacks — a Paperless document whose
 * `original_file_name` is `../../../../etc/paperless-pwn.pdf`, zip entries that climb out of their
 * root. None of those strings ever reaches this function, by construction; this is here so that the
 * day one of them does, the build stops instead of writing outside the repository.
 */
function resolveInside(root, relative) {
  const absolute = path.resolve(root, relative);
  const prefix = path.resolve(root) + path.sep;
  if (!absolute.startsWith(prefix)) {
    throw new Error(`refusing to write ${relative}: it resolves outside ${root}`);
  }
  return absolute;
}

/** Read the corpora back with parsers that had no part in writing them. */
async function readBack(root, { files }) {
  const oracles = {
    pdf: options.oracle ? await pdfOracle(files) : { available: false },
    mail: options.oracle ? emlOracle(files, root) : { available: false },
    archives: options.oracle ? zipOracle(files, root) : { available: false },
    yaml: options.oracle ? await yamlOracle(files) : { available: false },
  };
  if (options.oracle) {
    const missing = Object.entries(oracles)
      .filter(([, result]) => !result.available)
      .map(([name]) => name);
    if (missing.length) {
      throw new Error(
        `the ${missing.join(', ')} oracle${missing.length > 1 ? 's are' : ' is'} not available on ` +
          'this machine, so the corpus cannot be verified. Install the workspace ' +
          '(`pnpm install` at the repository root) for pdf.js and yaml, and python3 for the mail ' +
          'and archive readers — or pass --no-oracle and accept an unverified receipt.',
      );
    }
  }
  return oracles;
}

/**
 * Replace the `ingest` key of `expected-counts.json` and leave every other key untouched.
 *
 * Two generators write this file. Rewriting it wholesale from either one would delete the other's
 * work, so each reads, replaces its own key, and writes back.
 */
function mergeIntoCounts(ingest) {
  if (!fs.existsSync(COUNTS_FILE)) {
    throw new Error(
      'fixtures/expected-counts.json does not exist yet. Run ' +
        '`node fixtures/zotero/make-fixture.mjs` first: it creates the file, and this generator ' +
        'only replaces the `ingest` key in it.',
    );
  }
  const counts = JSON.parse(fs.readFileSync(COUNTS_FILE, 'utf8'));
  counts.ingest = ingest;
  fs.writeFileSync(COUNTS_FILE, `${JSON.stringify(counts, null, 2)}\n`, 'utf8');
}

/**
 * Rebuild into a temporary directory and compare against what is committed, touching nothing under
 * `fixtures/`.
 */
async function check() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recueil-ingest-'));
  try {
    const fresh = buildCorpora();
    write(tmp, fresh);
    const oracles = await readBack(tmp, fresh);
    const freshManifest = measureIngestFixtures({
      fixturesDir: tmp,
      files: fresh.files,
      paperlessSummary: fresh.paperlessSummary,
      oracles,
    });

    /** @type {string[]} */
    const problems = [];

    for (const file of fresh.files) {
      const committed = path.join(HERE, file.path);
      if (!fs.existsSync(committed)) {
        problems.push(`${file.path} is missing`);
        continue;
      }
      if (!fs.readFileSync(committed).equals(file.bytes)) problems.push(`${file.path} has changed`);
    }

    for (const corpus of CORPORA) {
      const dir = path.join(HERE, corpus);
      if (!fs.existsSync(dir)) continue;
      const expected = new Set(
        fresh.files.filter((f) => f.path.startsWith(`${corpus}/`)).map((f) => f.path),
      );
      for (const found of walk(dir, corpus)) {
        if (!expected.has(found)) problems.push(`${found} is committed but is not generated`);
      }
    }

    if (!fs.existsSync(COUNTS_FILE)) {
      problems.push('fixtures/expected-counts.json is missing');
    } else {
      const committed = JSON.parse(fs.readFileSync(COUNTS_FILE, 'utf8')).ingest;
      if (JSON.stringify(committed) !== JSON.stringify(freshManifest)) {
        problems.push('expected-counts.json ingest differs from a fresh build');
      }
    }

    if (problems.length) {
      process.stderr.write(
        `the committed ingestion corpora are out of date:\n  - ${problems.join('\n  - ')}\n` +
          'Run `node fixtures/make-ingest.mjs` and commit the result.\n',
      );
      process.exit(1);
    }
    if (!options.quiet) process.stdout.write('ingestion fixtures are up to date\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function* walk(dir, prefix) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) yield* walk(path.join(dir, entry.name), relative);
    else yield relative;
  }
}

function requireFile(files, wanted) {
  const found = files.find((file) => file.path === wanted);
  if (!found) throw new Error(`${wanted} was not built`);
  return found.bytes;
}

function report(manifest) {
  const kb = (bytes) => `${Math.round(bytes / 1024)} kB`;
  // Every per-file property below comes from an oracle, so each is summed defensively: with
  // --no-oracle the manifest legitimately has none of them and the report must still print.
  const sum = (byFile, pick) => Object.values(byFile).reduce((total, one) => total + pick(one), 0);
  const scans = manifest.scans.byFile;
  const archives = manifest.archives.byFile;

  process.stdout.write(
    [
      `scans               ${manifest.scans.files} PDFs, ${sum(scans, (f) => f.pages ?? 0)} pages; ` +
        `${sum(scans, (f) => f.textLayerPages ?? 0)} with a text layer, ` +
        `${sum(scans, (f) => f.imagePages ?? 0)} rasterised`,
      `mail                ${manifest.mail.files} messages, ` +
        `${sum(manifest.mail.byFile, (f) => f.attachments?.length ?? 0)} attachments`,
      `archives            ${manifest.archives.files} zips, ` +
        `${sum(archives, (f) => f.entries ?? 0)} entries, ` +
        `${sum(archives, (f) => (f.hostileNames ?? 0) + (f.symlinks ?? 0))} hostile`,
      `paperless           ${manifest.paperless.documents.live} live documents ` +
        `(+${manifest.paperless.documents.trashed} trashed), ` +
        `${manifest.paperless.originals.files} originals, ` +
        `${manifest.paperless.routes} routes`,
      `rules               ${manifest.rules.files} files, ${manifest.rules.cases} cases`,
      `shared documents    ${manifest.sharedDocuments.length} sets of identical bytes, arriving ` +
        `${manifest.sharedDocuments.reduce((total, one) => total + one.arrivals, 0)} ways in all`,
      `total               ${manifest.files} files, ${kb(manifest.totalBytes)}`,
      `oracles             pdf: ${manifest.oracles.pdf ?? 'NOT RUN'}`,
      `                    mail: ${manifest.oracles.mail ?? 'NOT RUN'}`,
      `                    archives: ${manifest.oracles.archives ?? 'NOT RUN'}`,
      `                    yaml: ${manifest.oracles.yaml ?? 'NOT RUN'}`,
      options.counts && isDefaultOut
        ? `counts              ${path.relative(path.resolve(HERE, '..'), COUNTS_FILE)} (ingest)`
        : 'counts              not written',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const parsed = { out: null, counts: true, oracle: true, quiet: false, check: false };
  for (const arg of argv) {
    if (arg.startsWith('--out=')) parsed.out = arg.slice('--out='.length);
    else if (arg === '--no-counts') parsed.counts = false;
    else if (arg === '--no-oracle') parsed.oracle = false;
    else if (arg === '--check') parsed.check = true;
    else if (arg === '--quiet') parsed.quiet = true;
    else throw new Error(`unknown option ${arg}`);
  }
  return parsed;
}
