/*
 * Recueil — fixtures
 * Copyright (C) 2026 the Recueil authors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Count the hand-written BibTeX, RIS and CSL-JSON fixtures, and assert the counts against the
 * numbers stated here.
 *
 * The counting is deliberately naive — a block-level regex for BibTeX, a tag count for RIS,
 * `JSON.parse().length` for CSL-JSON. It is not a parser and must not become one: its job is to
 * notice that a file changed shape, so that `expected-counts.json` cannot quietly drift away from
 * what the README says is in these files. The real parsing is `@recueil/formats`' job, and these
 * numbers are what its tests assert against.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * What each file is expected to hold. `entries` for BibTeX counts `@` blocks that are not
 * `@string`, `@preamble` or `@comment`; those three are counted separately.
 */
export const EXPECTED = {
  bibtex: {
    'awkward.bib': { entries: 12, strings: 9, preambles: 1, comments: 1 },
    'crossref.bib': { entries: 6, strings: 0, preambles: 0, comments: 0 },
    'files.bib': { entries: 5, strings: 0, preambles: 0, comments: 0 },
    'macros.bib': { entries: 0, strings: 6, preambles: 0, comments: 0 },
    'uses-macros.bib': { entries: 4, strings: 0, preambles: 0, comments: 0 },
    'malformed.bib': { entries: 5, strings: 0, preambles: 0, comments: 0 },
  },
  ris: {
    'awkward.ris': { typeTags: 10, endTags: 10, lineEnding: 'CRLF', bom: false },
    'endnote.ris': { typeTags: 3, endTags: 3, lineEnding: 'LF', bom: true },
    'malformed.ris': { typeTags: 3, endTags: 3, lineEnding: 'LF', bom: false },
  },
  cslJson: {
    'awkward.json': { entries: 8 },
    'dates.json': { entries: 12 },
    'names.json': { entries: 12 },
  },
};

/**
 * Measure the three directories.
 *
 * @param {string} fixturesDir  the `fixtures/` directory
 * @returns {object}
 */
export function measureTextFixtures(fixturesDir) {
  /** @type {string[]} */
  const problems = [];

  const bibtex = measureDir(fixturesDir, 'bibtex', EXPECTED.bibtex, measureBibtex, problems);
  const ris = measureDir(fixturesDir, 'ris', EXPECTED.ris, measureRis, problems);
  const cslJson = measureDir(fixturesDir, 'csl-json', EXPECTED.cslJson, measureCslJson, problems);

  if (problems.length) {
    throw new Error(
      `the text fixtures do not match the stated counts:\n  - ${problems.join('\n  - ')}`,
    );
  }

  return {
    bibtex: { files: Object.keys(bibtex).length, byFile: bibtex },
    ris: { files: Object.keys(ris).length, byFile: ris },
    cslJson: { files: Object.keys(cslJson).length, byFile: cslJson },
  };
}

function measureDir(fixturesDir, dirName, expected, measureOne, problems) {
  const dir = path.join(fixturesDir, dirName);
  const onDisk = fs
    .readdirSync(dir)
    .filter((name) => !name.startsWith('.'))
    .sort();
  const stated = Object.keys(expected).sort();

  for (const name of onDisk) {
    if (!expected[name]) problems.push(`${dirName}/${name} is on disk but not stated`);
  }
  for (const name of stated) {
    if (!onDisk.includes(name)) problems.push(`${dirName}/${name} is stated but not on disk`);
  }

  /** @type {Record<string, object>} */
  const result = {};
  for (const name of onDisk) {
    if (!expected[name]) continue;
    const actual = measureOne(fs.readFileSync(path.join(dir, name)));
    for (const [key, want] of Object.entries(expected[name])) {
      if (actual[key] !== want) {
        problems.push(`${dirName}/${name} ${key}: expected ${want}, found ${actual[key]}`);
      }
    }
    result[name] = { ...actual, bytes: fs.statSync(path.join(dir, name)).size };
  }
  return result;
}

/** @param {Buffer} buffer */
function measureBibtex(buffer) {
  const text = buffer.toString('utf8');
  const blocks = [...text.matchAll(/^@(\w+)\s*[{(]/gm)].map((m) => m[1].toLowerCase());
  return {
    entries: blocks.filter((kind) => !['string', 'preamble', 'comment'].includes(kind)).length,
    strings: blocks.filter((kind) => kind === 'string').length,
    preambles: blocks.filter((kind) => kind === 'preamble').length,
    comments: blocks.filter((kind) => kind === 'comment').length,
  };
}

/** @param {Buffer} buffer */
function measureRis(buffer) {
  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  return {
    typeTags: (text.match(/^TY {2}- /gm) ?? []).length,
    endTags: (text.match(/^ER {2}- ?/gm) ?? []).length,
    lineEnding: text.includes('\r\n') ? 'CRLF' : 'LF',
    bom,
  };
}

/** @param {Buffer} buffer */
function measureCslJson(buffer) {
  const parsed = JSON.parse(buffer.toString('utf8'));
  if (!Array.isArray(parsed)) throw new Error('a CSL-JSON fixture must be a top-level array');
  return { entries: parsed.length };
}
