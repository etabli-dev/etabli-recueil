#!/usr/bin/env node
/*
 * Recueil — fixtures
 * Copyright (C) 2026 the Recueil authors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Generate the synthetic Zotero library.
 *
 *   node fixtures/zotero/make-fixture.mjs
 *   node fixtures/zotero/make-fixture.mjs --id-layout=fresh --out=/tmp/zotero-fresh
 *
 * Writes, into `--out` (default `fixtures/zotero/`):
 *
 *   zotero.sqlite         a real Zotero database, built from Zotero's own schema files
 *   better-bibtex.sqlite  Better BibTeX's citation-key store, built from its own DDL
 *   storage/<KEY>/…       the files the stored attachments point at
 *   linked-attachments/…  the one linked file that does resolve
 *
 * and, when writing to the default location, `fixtures/expected-counts.json` — which also carries
 * the counts of the hand-written `fixtures/bibtex/`, `fixtures/ris/` and `fixtures/csl-json/`
 * files, checked on every run against the numbers stated in `fixtures/lib/text-fixtures.mjs`.
 *
 * The generator is deterministic: same inputs, same bytes, same hashes, same object keys. Running
 * it twice produces no diff, so a spurious change in `expected-counts.json` always means something
 * real moved.
 *
 * Options
 * -------
 *   --out=DIR           where to write (default: the directory this script lives in)
 *   --id-layout=LAYOUT  `legacy` (default) or `fresh`; see fixtures/README.md
 *   --no-counts         build the database but do not touch `expected-counts.json`
 *   --check             write nothing; rebuild into a temporary directory and report whether the
 *                       committed fixture still matches it. Exits 1 if it does not.
 *   --quiet             print nothing on success
 *
 * The environment variable `RECUEIL_FIXTURE_SQLITE` pins the driver to `better-sqlite3` or
 * `node:sqlite`; both produce identical content and, across SQLite versions, different bytes.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from './lib/build.mjs';
import { logicalDigest, measure, writeManifest } from './lib/counts.mjs';
import { open } from './lib/sqlite.mjs';
import { measureTextFixtures } from '../lib/text-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '..');
const SCHEMA_DIR = path.join(HERE, 'schema');

const options = parseArgs(process.argv.slice(2));

if (options.check) {
  check();
  process.exit(0);
}

const outDir = options.out ? path.resolve(options.out) : HERE;
const isDefaultOut = path.resolve(outDir) === path.resolve(HERE);

const built = build({ outDir, schemaDir: SCHEMA_DIR, idLayout: options.idLayout });

// Prove the claim in the task rather than assume it: reopen the file as a database, from a fresh
// connection, and read something out of it that only a well-formed database can answer.
const verification = verify(built.dbPath, built.bbtPath);

const manifest = measure(built, {
  upstream: readSources(SCHEMA_DIR),
  verification,
});
manifest.formats = measureTextFixtures(FIXTURES);

if (options.counts && isDefaultOut) {
  writeManifest(path.join(FIXTURES, 'expected-counts.json'), manifest);
}

if (!options.quiet) {
  const z = manifest.zotero;
  process.stdout.write(
    [
      `driver              ${verification.driver} (SQLite ${verification.sqliteVersion})`,
      `identifier layout   ${z.identifierLayout}`,
      `zotero.sqlite       ${rel(built.dbPath)} (${kb(built.dbPath)})`,
      `better-bibtex       ${rel(built.bbtPath)} (${kb(built.bbtPath)})`,
      `items               ${z.items.allRows} rows; ` +
        `${z.items.regularLive} live regular, ${z.items.regularTrashed} trashed`,
      `                    ${Object.entries(z.liveByType)
        .map(([type, n]) => `${type} ${n}`)
        .join(', ')}`,
      `notes               ${z.notes.total} (${z.notes.child} child, ${z.notes.standalone} standalone)`,
      `attachments         ${z.attachments.total}; ${z.attachments.filesPresent} files present, ` +
        `${z.attachments.filesMissing} deliberately missing`,
      `annotations         ${z.annotations.total}`,
      `collections         ${z.collections.total} (${z.collections.trashed} trashed, ` +
        `depth ${z.collections.maxDepth})`,
      `tags / creators     ${z.tags.total} / ${z.creators.total}`,
      `relations           ${z.relations.total}`,
      `citation keys       ${z.citationKeys.nativeField} native, ${z.citationKeys.extraLine} in Extra, ` +
        `${z.citationKeys.betterBibtexRows} in Better BibTeX (${z.citationKeys.betterBibtexPinned} pinned)`,
      `storage             ${z.storage.files} files in ${z.storage.directories} directories, ` +
        `${z.storage.totalBytes} bytes`,
      `format fixtures     ${manifest.formats.bibtex.files} BibTeX, ${manifest.formats.ris.files} RIS, ` +
        `${manifest.formats.cslJson.files} CSL-JSON`,
      options.counts && isDefaultOut
        ? `counts              ${rel(path.join(FIXTURES, 'expected-counts.json'))}`
        : 'counts              not written',
      '',
    ].join('\n'),
  );
}

/* ------------------------------------------------------------------------------------------------ */

/**
 * Rebuild the fixture into a temporary directory and compare it with what is committed, without
 * touching anything under `fixtures/`.
 *
 * The comparison is by content, never by bytes: `logicalDigest()` hashes every row of every table,
 * so a different SQLite build laying the pages out differently is not a failure, and a changed
 * record is. The manifest, the storage files and their SHA-256 sums are compared too.
 */
function check() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recueil-fixture-'));
  try {
    const fresh = build({ outDir: tmp, schemaDir: SCHEMA_DIR, idLayout: 'legacy' });
    const freshManifest = measure(fresh, {});
    freshManifest.formats = measureTextFixtures(FIXTURES);

    const committedPath = path.join(FIXTURES, 'expected-counts.json');
    const problems = [];

    if (!fs.existsSync(committedPath)) {
      problems.push('fixtures/expected-counts.json is missing; run the generator');
    } else {
      const committed = JSON.parse(fs.readFileSync(committedPath, 'utf8'));
      for (const key of ['zotero', 'formats']) {
        const a = JSON.stringify(committed[key]);
        const b = JSON.stringify(freshManifest[key]);
        if (a !== b) problems.push(`expected-counts.json ${key} differs from a fresh build`);
      }
    }

    const committedDb = path.join(HERE, 'zotero.sqlite');
    if (!fs.existsSync(committedDb)) {
      problems.push('fixtures/zotero/zotero.sqlite is missing; run the generator');
    } else if (logicalDigest(committedDb) !== logicalDigest(fresh.dbPath)) {
      problems.push('zotero.sqlite content differs from a fresh build');
    }

    const committedBbt = path.join(HERE, 'better-bibtex.sqlite');
    if (!fs.existsSync(committedBbt)) {
      problems.push('fixtures/zotero/better-bibtex.sqlite is missing; run the generator');
    } else if (logicalDigest(committedBbt) !== logicalDigest(fresh.bbtPath)) {
      problems.push('better-bibtex.sqlite content differs from a fresh build');
    }

    for (const file of fresh.files) {
      const committedFile = path.join(HERE, file.path);
      if (!fs.existsSync(committedFile)) {
        problems.push(`${file.path} is missing`);
        continue;
      }
      const actual = createHash('sha256').update(fs.readFileSync(committedFile)).digest('hex');
      if (actual !== file.sha256) problems.push(`${file.path} has changed`);
    }

    if (problems.length) {
      process.stderr.write(
        `the committed fixture is out of date:\n  - ${problems.join('\n  - ')}\n` +
          'Run `node fixtures/zotero/make-fixture.mjs` and commit the result.\n',
      );
      process.exitCode = 1;
      process.exit(1);
    }
    if (!options.quiet) process.stdout.write('fixtures are up to date\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Reopen both databases and confirm they are readable SQLite files holding the tables the fixture
 * claims. `PRAGMA integrity_check` and `PRAGMA foreign_key_check` are the two questions worth
 * asking; a fixture that fails either is worse than no fixture.
 */
function verify(dbPath, bbtPath) {
  const db = open(dbPath);
  const integrity = String(db.value('PRAGMA integrity_check'));
  const foreignKeyViolations = db.all('PRAGMA foreign_key_check').length;
  const sqliteVersion = String(db.value('SELECT sqlite_version()'));
  const tables = db
    .all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map((row) => String(row.name));
  const driver = db.driver;
  const userdataVersion = Number(db.value("SELECT version FROM version WHERE schema = 'userdata'"));
  const globalSchemaVersion = Number(
    db.value("SELECT version FROM version WHERE schema = 'globalSchema'"),
  );
  db.close();

  const bbt = open(bbtPath);
  const bbtIntegrity = String(bbt.value('PRAGMA integrity_check'));
  const bbtTables = bbt
    .all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map((row) => String(row.name));
  bbt.close();

  const problems = [];
  if (integrity !== 'ok') problems.push(`zotero.sqlite integrity_check: ${integrity}`);
  if (bbtIntegrity !== 'ok') problems.push(`better-bibtex.sqlite integrity_check: ${bbtIntegrity}`);
  if (foreignKeyViolations) problems.push(`${foreignKeyViolations} foreign key violations`);
  for (const required of [
    'items',
    'itemTypes',
    'itemData',
    'itemDataValues',
    'fields',
    'itemTypeFields',
    'creators',
    'creatorTypes',
    'itemCreators',
    'collections',
    'collectionItems',
    'tags',
    'itemTags',
    'itemNotes',
    'itemAttachments',
    'itemAnnotations',
    'itemRelations',
    'deletedItems',
  ]) {
    if (!tables.includes(required)) problems.push(`zotero.sqlite is missing table ${required}`);
  }
  if (!bbtTables.includes('citationkey')) {
    problems.push('better-bibtex.sqlite is missing table citationkey');
  }
  if (problems.length) throw new Error(`verification failed:\n  - ${problems.join('\n  - ')}`);

  return {
    driver,
    sqliteVersion,
    integrityCheck: integrity,
    foreignKeyViolations,
    userdataVersion,
    globalSchemaVersion,
    zoteroTables: tables.length,
    betterBibtexTables: bbtTables,
  };
}

/** Lift the upstream provenance out of `schema/SOURCES.md` so the manifest cannot contradict it. */
function readSources(schemaDir) {
  const text = fs.readFileSync(path.join(schemaDir, 'SOURCES.md'), 'utf8');
  const grab = (re) => re.exec(text)?.[1] ?? null;
  return {
    zotero: {
      repository: 'https://github.com/zotero/zotero',
      tag: grab(/tag \*\*`([^`]+)`\*\*/),
      commit: grab(/commit `([0-9a-f]{40})`, dated/),
    },
    zoteroSchema: {
      repository: 'https://github.com/zotero/zotero-schema',
      commit: grab(/\*\*`([0-9a-f]{40})`\*\* \(\d{4}-\d{2}-\d{2}\), schema `version`/),
      version: Number(grab(/schema `version` \*\*(\d+)\*\*/)),
    },
    betterBibtex: {
      repository: 'https://github.com/retorquere/zotero-better-bibtex',
      tag: grab(/tag \*\*`(v[^`]+)`\*\*/),
    },
  };
}

function parseArgs(argv) {
  const options = { out: null, idLayout: 'legacy', counts: true, quiet: false, check: false };
  for (const arg of argv) {
    if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length);
    else if (arg.startsWith('--id-layout=')) options.idLayout = arg.slice('--id-layout='.length);
    else if (arg === '--no-counts') options.counts = false;
    else if (arg === '--check') options.check = true;
    else if (arg === '--quiet') options.quiet = true;
    else throw new Error(`unknown option ${arg}`);
  }
  if (!['legacy', 'fresh'].includes(options.idLayout)) {
    throw new Error(`--id-layout must be legacy or fresh, not ${options.idLayout}`);
  }
  return options;
}

function rel(file) {
  return path.relative(path.resolve(FIXTURES, '..'), file);
}

function kb(file) {
  return `${Math.round(fs.statSync(file).size / 1024)} kB`;
}
