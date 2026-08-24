/*
 * Recueil — fixtures
 * Copyright (C) 2026 the Recueil authors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Independent readers for the files the generator writes.
 *
 * A generator that checked its own output with its own code would prove nothing: the same
 * misunderstanding produces the file and passes the check. So each corpus is read back by something
 * that had no part in writing it —
 *
 *   | corpus     | oracle                                            |
 *   |------------|---------------------------------------------------|
 *   | `scans/`   | **pdf.js** (Mozilla), resolved out of the workspace |
 *   | `mail/`    | **Python's `email`** package, from the standard library |
 *   | `archives/`| **Python's `zipfile`**, including its CRC check     |
 *
 * The findings are not just "it parsed". They are the properties the corpus *claims*: how many
 * pages, which of them carry a text layer, which carry a raster, what a page's `/Rotate` is; what a
 * message's Subject decodes to and which parts are attachments; what a zip's entry names are, byte
 * for byte, and whether the CRCs hold. `ingest-fixtures.mjs` asserts those against the numbers
 * written by hand, so the oracle is what closes the loop rather than another opinion of the
 * generator's.
 *
 * If an oracle is missing the build **fails**, unless `--no-oracle` is passed — and the manifest
 * records which oracles ran, so a receipt that was produced without them says so.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

/* ------------------------------------------------------------------------------------------------
 * PDF — pdf.js
 * --------------------------------------------------------------------------------------------- */

/**
 * pdf.js is a workspace dependency of `apps/web`, so it is present after a `pnpm install` at the
 * root and absent otherwise. It is looked for where pnpm puts it, and then by plain resolution, so
 * that moving the dependency does not break the fixture build silently.
 */
const PDFJS_CANDIDATES = [
  'apps/web/node_modules/pdfjs-dist/legacy/build/pdf.mjs',
  'node_modules/pdfjs-dist/legacy/build/pdf.mjs',
];

async function loadPdfjs() {
  for (const candidate of PDFJS_CANDIDATES) {
    const file = path.join(REPO, candidate);
    if (fs.existsSync(file)) return { module: await import(file), from: candidate };
  }
  try {
    return { module: await import('pdfjs-dist/legacy/build/pdf.mjs'), from: 'pdfjs-dist' };
  } catch {
    return null;
  }
}

/**
 * Read every PDF with pdf.js and report what is actually in it.
 *
 * @param {Array<{ path: string, bytes: Buffer }>} files
 * @returns {Promise<{ available: boolean, reader?: string, version?: string, byFile?: object }>}
 */
export async function pdfOracle(files) {
  const loaded = await loadPdfjs();
  if (!loaded) return { available: false };
  const pdfjs = loaded.module;

  /** @type {Record<string, object>} */
  const byFile = {};
  for (const file of files) {
    if (!file.path.endsWith('.pdf')) continue;
    const document = await pdfjs.getDocument({
      data: new Uint8Array(file.bytes),
      /* No worker, no fonts fetched over the network, no console noise about either. */
      useWorkerFetch: false,
      isEvalSupported: false,
      disableFontFace: true,
      verbosity: 0,
    }).promise;

    const pages = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const text = await page.getTextContent();
      const characters = text.items.reduce((sum, item) => sum + (item.str?.length ?? 0), 0);
      const operators = await page.getOperatorList();
      const images = operators.fnArray.filter(
        (fn) =>
          fn === pdfjs.OPS.paintImageXObject ||
          fn === pdfjs.OPS.paintInlineImageXObject ||
          fn === pdfjs.OPS.paintImageMaskXObject,
      ).length;
      pages.push({
        page: number,
        rotate: page.rotate,
        textItems: text.items.length,
        textCharacters: characters,
        images,
      });
    }

    const info = await document.getMetadata();
    byFile[file.path] = {
      pages: document.numPages,
      pagesWithTextLayer: pages.filter((p) => p.textCharacters > 0).length,
      pagesWithImage: pages.filter((p) => p.images > 0).length,
      textCharacters: pages.reduce((sum, p) => sum + p.textCharacters, 0),
      rotations: pages.map((p) => p.rotate),
      title: info.info?.Title ?? null,
      byPage: pages,
    };
    await document.cleanup();
  }

  return {
    available: true,
    reader: `pdf.js ${pdfjs.version} (${loaded.from})`,
    version: pdfjs.version,
    byFile,
  };
}

/* ------------------------------------------------------------------------------------------------
 * MIME and zip — Python's standard library
 * --------------------------------------------------------------------------------------------- */

/**
 * Parse every `.eml` with Python's `email` package and report its structure.
 *
 * `email` records *defects* rather than throwing, which is exactly the behaviour
 * `mail/malformed-boundary.eml` is a fixture for: the oracle's finding that the file carries a
 * `StartBoundaryNotFoundDefect` is what turns "this file is deliberately broken" from an assertion
 * in a README into something checked on every build.
 *
 * @param {Array<{ path: string, bytes: Buffer }>} files
 * @param {string} root  the directory the paths are relative to
 * @returns {{ available: boolean, reader?: string, byFile?: object }}
 */
export function emlOracle(files, root) {
  const paths = files.filter((file) => file.path.endsWith('.eml')).map((file) => file.path);
  if (!paths.length) return { available: true, reader: 'python3 email (no files)', byFile: {} };
  return runPython(EML_SCRIPT, paths, root, 'email');
}

/**
 * Read every zip with Python's `zipfile`, including `testzip()`, which walks every entry and checks
 * its CRC. Entry names are reported as raw bytes so that the CP437 name in `mixed.zip` can be
 * compared without going through anyone's idea of the right decoding.
 *
 * @param {Array<{ path: string, bytes: Buffer }>} files
 * @param {string} root
 * @returns {{ available: boolean, reader?: string, byFile?: object }}
 */
export function zipOracle(files, root) {
  const paths = files.filter((file) => file.path.endsWith('.zip')).map((file) => file.path);
  if (!paths.length) return { available: true, reader: 'python3 zipfile (no files)', byFile: {} };
  return runPython(ZIP_SCRIPT, paths, root, 'zipfile');
}

function runPython(script, paths, root, label) {
  let output;
  try {
    output = execFileSync('python3', ['-c', script, root, ...paths], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    if (error.code === 'ENOENT') return { available: false };
    throw new Error(`the python3 ${label} oracle failed:\n${error.stderr || error.message}`);
  }
  const parsed = JSON.parse(output);
  return { available: true, reader: `python3 ${parsed.python} — ${label}`, byFile: parsed.files };
}

/* ------------------------------------------------------------------------------------------------
 * YAML — the `yaml` package
 * --------------------------------------------------------------------------------------------- */

/**
 * `yaml` is a dependency of `packages/rules` and of `packages/schemas`, so it is present after a
 * `pnpm install` at the root. It is the same loader the rule engine will use, which is the point:
 * the claim `malformed.yaml` makes is "valid YAML, invalid rule set", and only the real loader can
 * confirm the first half of that.
 *
 * @param {Array<{ path: string, bytes: Buffer }>} files
 * @returns {Promise<{ available: boolean, reader?: string, byFile?: object }>}
 */
export async function yamlOracle(files) {
  const candidates = [
    'packages/rules/node_modules/yaml/dist/index.js',
    'packages/schemas/node_modules/yaml/dist/index.js',
    'node_modules/yaml/dist/index.js',
  ];
  /** @type {{ parse: Function } | null} */
  let yaml = null;
  let from = null;
  for (const candidate of candidates) {
    const file = path.join(REPO, candidate);
    if (!fs.existsSync(file)) continue;
    yaml = (await import(file)).default ?? (await import(file));
    from = candidate;
    break;
  }
  if (!yaml) {
    try {
      yaml = await import('yaml');
      from = 'yaml';
    } catch {
      return { available: false };
    }
  }

  /** @type {Record<string, object>} */
  const byFile = {};
  for (const file of files) {
    if (!file.path.endsWith('.yaml')) continue;
    try {
      const document = yaml.parse(file.bytes.toString('utf8'));
      byFile[file.path] = {
        parses: true,
        topLevelKeys: Object.keys(document ?? {}).sort(),
        rules: Array.isArray(document?.rules) ? document.rules.length : null,
        /* A rule with no `id` is one of malformed.yaml's six faults, so this is counted rather than
           assumed. */
        rulesWithoutId: Array.isArray(document?.rules)
          ? document.rules.filter((rule) => rule?.id === undefined).length
          : null,
      };
    } catch (error) {
      byFile[file.path] = { parses: false, error: String(error.message ?? error) };
    }
  }

  return { available: true, reader: `yaml (${from})`, byFile };
}

const EML_SCRIPT = `
import email, email.policy, hashlib, json, os, sys
from email.header import decode_header, make_header

root, paths = sys.argv[1], sys.argv[2:]
out = {}
for rel in paths:
    with open(os.path.join(root, rel), 'rb') as handle:
        raw = handle.read()
    # compat32, not the modern policy: it is the lenient parser, it records defects instead of
    # raising, and a mail fixture is exactly where leniency is the property under test.
    msg = email.message_from_bytes(raw)

    parts, attachments, inline, nested, defects, payloads = 0, [], 0, 0, [], []
    for sub in msg.walk():
        parts += 1
        defects.extend(type(d).__name__ for d in sub.defects)
        if sub.get_content_type() == 'message/rfc822':
            nested += 1
        disposition = (sub.get('Content-Disposition') or '').split(';')[0].strip().lower()
        name = sub.get_filename()
        if disposition == 'attachment' or (name and disposition != 'inline'):
            attachments.append(name)
        elif disposition == 'inline' and sub.get('Content-ID'):
            inline += 1
        if not sub.is_multipart() and sub.get_content_type() != 'message/rfc822':
            body = sub.get_payload(decode=True)
            if body:
                # The hash of the decoded part, so that "the same bytes arrive by several routes"
                # is something the oracle confirms rather than something the generator asserts.
                payloads.append({
                    'name': name,
                    'contentType': sub.get_content_type(),
                    'bytes': len(body),
                    'sha256': hashlib.sha256(body).hexdigest(),
                })

    def decoded(name):
        # compat32 hands back a Header object rather than a str when a header carries raw 8-bit
        # bytes, which one of these messages does on purpose. str() on it is the decoded form.
        raw_value = msg.get(name)
        if raw_value is None:
            return None
        try:
            return str(make_header(decode_header(raw_value)))
        except Exception as exc:                                # noqa: BLE001
            return 'UNDECODABLE: %s' % exc

    subject = decoded('Subject') or ''

    try:
        raw.decode('utf-8')
        utf8 = True
    except UnicodeDecodeError:
        utf8 = False

    out[rel] = {
        'contentType': msg.get_content_type(),
        'isMultipart': msg.is_multipart(),
        'parts': parts,
        'attachments': attachments,
        'attachmentCount': len(attachments),
        'inlineWithContentId': inline,
        'nestedMessages': nested,
        'subject': subject,
        'from': decoded('From'),
        'defects': sorted(set(defects)),
        'payloads': payloads,
        'crlfOnly': b'\\r\\n' in raw and raw.replace(b'\\r\\n', b'') .count(b'\\n') == 0,
        'utf8Valid': utf8,
    }

print(json.dumps({'python': sys.version.split()[0], 'files': out}))
`;

const ZIP_SCRIPT = `
import hashlib, io, json, os, stat, sys, zipfile

MAX_DEPTH = 4

def read_archive(data, prefix, depth, entries):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        bad = archive.testzip()
        comment = archive.comment.decode('utf-8', 'replace')
        for info in archive.infolist():
            mode = info.external_attr >> 16
            payload = b'' if info.is_dir() else archive.read(info)
            entry = {
                'name': info.filename,
                # orig_filename is what the header holds; filename is zipfile's decoding of it. The
                # two differ exactly where general-purpose bit 11 is not set and the name is not
                # ASCII.
                'rawName': info.orig_filename,
                'qualifiedName': prefix + info.orig_filename,
                'nameBytes': info.orig_filename.encode('utf-8', 'surrogateescape').hex(),
                'utf8Flag': bool(info.flag_bits & 0x800),
                'directory': info.is_dir(),
                'depth': depth,
                'method': info.compress_type,
                'size': info.file_size,
                'compressed': info.compress_size,
                'crc': info.CRC,
                'sha256': hashlib.sha256(payload).hexdigest(),
                'symlink': stat.S_ISLNK(mode),
                'unixMode': oct(mode),
            }
            entries.append(entry)
            # Recurse into members that are themselves archives, bounded, so that the nesting claim
            # is checked by the oracle rather than asserted in a README.
            if payload[:4] == b'PK\\x03\\x04' and depth < MAX_DEPTH:
                read_archive(payload, prefix + info.orig_filename + '!', depth + 1, entries)
        return bad, comment

root, paths = sys.argv[1], sys.argv[2:]
out = {}
for rel in paths:
    with open(os.path.join(root, rel), 'rb') as handle:
        data = handle.read()
    entries = []
    bad, comment = read_archive(data, '', 1, entries)
    top = [e for e in entries if e['depth'] == 1]
    out[rel] = {
        'entries': len(top),
        'entriesIncludingNested': len(entries),
        'maxDepth': max(e['depth'] for e in entries) if entries else 0,
        'crcFailures': [] if bad is None else [bad],
        'comment': comment,
        'byEntry': top,
        'allEntries': entries,
    }

print(json.dumps({'python': sys.version.split()[0], 'files': out}))
`;
