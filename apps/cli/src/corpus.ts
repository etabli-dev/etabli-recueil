/**
 * The corpus a rule set is dry-run against.
 *
 * CONCEPT.md §5.6 asks for "a dry-run report before execution", and the question that report answers
 * is "what would these rules do to *these* documents". So a corpus has to be able to be the real
 * documents — a consume directory, a folder of scans — and not only a hand-written fixture, because
 * a rule that matches a text regex is only tested by text a real extractor produced.
 *
 * Two shapes are accepted, and they are different tools:
 *
 * - **A directory.** Every file under it becomes one subject: its path, its filename, the media type
 *   sniffed from its bytes, and — for a PDF or a text file — the text a rule's `text` condition will
 *   actually see. This is the honest one, and it is the one to reach for before running a rule set
 *   over four thousand documents.
 * - **A JSON or YAML file** holding an array of subjects, or `{ "subjects": [...] }`. This is for a
 *   case a directory cannot express: a mail sender, a resolver outcome, a tag that an earlier stage
 *   set. `fixtures/rules/cases.json`'s `{ "cases": [{ "id", "input" }] }` shape is read too, so the
 *   repository's own rule corpus can be pointed at directly.
 *
 * Path safety is the same rule as everywhere else: a directory entry is resolved with `realpath`
 * and refused when it lands outside the root, because a corpus is a directory somebody else may
 * have filled.
 */
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

import { sniffMimeType } from '@recueil/core';
import { extractPdfText, isInside } from '@recueil/ingest';
import type { IngestionSubject } from '@recueil/rules';
import { parse as parseYaml } from 'yaml';

export interface CorpusLoad {
  subjects: IngestionSubject[];
  /** Entries the loader saw and did not offer, with the reason. Reported, never silent. */
  skipped: Array<{ path: string; reason: string }>;
  /** `directory` or the file the subjects were read from. */
  origin: string;
}

/** How much text a subject carries. A rule's own `limits.maxTextLength` truncates again below this. */
const MAX_TEXT_BYTES = 512 * 1024;

export const loadCorpus = async (path: string, options: { recursive?: boolean } = {}): Promise<CorpusLoad> => {
  const root = resolve(path);
  const info = await stat(root);
  return info.isDirectory() ? loadDirectory(root, options) : loadFile(root);
};

/* ------------------------------------------------------------------------------------------- */

const loadDirectory = async (root: string, options: { recursive?: boolean }): Promise<CorpusLoad> => {
  const realRoot = await realpath(root);
  const subjects: IngestionSubject[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = join(directory, entry.name);
      if (entry.name.startsWith('.')) {
        skipped.push({ path: child, reason: 'the name begins with a dot' });
        continue;
      }

      let real: string;
      try {
        real = await realpath(child);
      } catch (error) {
        skipped.push({ path: child, reason: `it could not be resolved: ${String(error)}` });
        continue;
      }
      if (!isInside(realRoot, real)) {
        skipped.push({ path: child, reason: `it resolves to '${real}', outside the corpus` });
        continue;
      }

      const info = await stat(real);
      if (info.isDirectory()) {
        if (options.recursive === false) {
          skipped.push({ path: child, reason: 'it is a directory and the scan is not recursive' });
          continue;
        }
        await walk(real);
        continue;
      }
      if (!info.isFile()) {
        skipped.push({ path: child, reason: 'it is not a regular file' });
        continue;
      }

      subjects.push(await subjectForFile(real, relative(realRoot, real)));
    }
  };

  await walk(realRoot);
  return { subjects, skipped, origin: realRoot };
};

const subjectForFile = async (absolute: string, relativePath: string): Promise<IngestionSubject> => {
  const bytes = await readFile(absolute);
  const sniffed = sniffMimeType(bytes, { filename: basename(absolute) });
  const text = textOf(bytes, sniffed.mimeType);

  return {
    id: relativePath,
    source: 'folder',
    path: relativePath,
    filename: basename(absolute),
    mime: sniffed.mimeType,
    ...(text === null ? {} : { text }),
    tags: [],
  };
};

/**
 * The text a rule's `text` condition will see.
 *
 * The PDF's own layer, or the bytes of a text file. **Not** OCR output: no OCR engine runs here, so
 * a scan with no text layer arrives with no text, and a rule that matches on text will not match
 * it. That is the true answer for a dry run without an OCR pass, and it is better than a corpus
 * that silently pretends the recogniser had already run.
 */
const textOf = (bytes: Buffer, mediaType: string): string | null => {
  if (mediaType === 'application/pdf') {
    try {
      const extracted = extractPdfText(bytes);
      return extracted.text.length === 0 ? null : extracted.text.slice(0, MAX_TEXT_BYTES);
    } catch {
      return null;
    }
  }
  if (mediaType.startsWith('text/') || mediaType === 'message/rfc822' || mediaType === 'application/json') {
    return bytes.subarray(0, MAX_TEXT_BYTES).toString('utf8');
  }
  return null;
};

/* ------------------------------------------------------------------------------------------- */

interface CaseFile {
  cases?: Array<{ id?: unknown; input?: unknown }>;
  subjects?: unknown;
}

const loadFile = async (file: string): Promise<CorpusLoad> => {
  const raw = await readFile(file, 'utf8');
  const parsed: unknown = file.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw);

  const subjects: IngestionSubject[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  const push = (value: unknown, fallbackId: string): void => {
    const subject = toSubject(value, fallbackId);
    if (subject === null) skipped.push({ path: fallbackId, reason: 'it is not an object with a usable shape' });
    else subjects.push(subject);
  };

  if (Array.isArray(parsed)) {
    parsed.forEach((entry, index) => {
      push(entry, `${basename(file)}#${String(index)}`);
    });
  } else if (parsed !== null && typeof parsed === 'object') {
    const document = parsed as CaseFile;
    if (Array.isArray(document.subjects)) {
      document.subjects.forEach((entry, index) => {
        push(entry, `${basename(file)}#${String(index)}`);
      });
    } else if (Array.isArray(document.cases)) {
      // `fixtures/rules/cases.json`: each case names its input and its own id. A case with no
      // inline input (it points at an input file instead) is reported rather than invented.
      for (const entry of document.cases) {
        const id = typeof entry.id === 'string' ? entry.id : `${basename(file)}#case`;
        if (entry.input === undefined) {
          skipped.push({ path: id, reason: 'the case carries no inline input' });
          continue;
        }
        push({ id, ...(entry.input as object) }, id);
      }
    } else {
      push(parsed, basename(file));
    }
  }

  return { subjects, skipped, origin: file };
};

/** One subject from a plain object, tolerating `null` where the fixtures write it for "absent". */
const toSubject = (value: unknown, fallbackId: string): IngestionSubject | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;

  const text = readString(source['text']);
  const path = readString(source['path']);
  const filename = readString(source['filename']) ?? (path === undefined ? undefined : basename(path));

  return {
    id: readString(source['id']) ?? fallbackId,
    ...(readString(source['source']) === undefined ? {} : { source: readString(source['source'])! }),
    ...(readString(source['sender']) === undefined ? {} : { sender: readString(source['sender'])! }),
    ...(readStrings(source['recipients']) === undefined ? {} : { recipients: readStrings(source['recipients'])! }),
    ...(readString(source['subject']) === undefined ? {} : { subject: readString(source['subject'])! }),
    ...(path === undefined ? {} : { path }),
    ...(filename === undefined ? {} : { filename }),
    ...(readString(source['mime']) === undefined ? {} : { mime: readString(source['mime'])! }),
    ...(text === undefined ? {} : { text }),
    ...(readString(source['itemType']) === undefined ? {} : { itemType: readString(source['itemType'])! }),
    tags: readStrings(source['tags']) ?? [],
    ...(Array.isArray(source['resolvers'])
      ? { resolvers: source['resolvers'] as IngestionSubject['resolvers'] }
      : {}),
  };
};

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const readStrings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : undefined;
