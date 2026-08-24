/**
 * The repository's own Paperless-ngx corpus, as a `FakeLibrary`.
 *
 * `fixtures/paperless/` holds an API dump, a route table and eleven originals, and
 * `fixtures/expected-counts.json` states every count in it — written by hand before the generator
 * ran, and read back by a parser that had no part in writing it. `fixtures/README.md` describes it
 * as the corpus a Paperless import is asserted against. Until this loader existed, nothing read it:
 * the importer's own tests ran against `fixtures.ts`, a ten-document library written by the same
 * hand as the importer, which can only prove that the importer agrees with itself.
 *
 * So this turns the committed dump into the same `FakeLibrary` the fake server already serves.
 * Nothing is transformed on the way in beyond the shape the fake needs — the JSON *is* the
 * Paperless serialiser output, and if a field of it is one the importer cannot read, that has to
 * show up as a failure rather than be smoothed over here.
 *
 * **It is still not a compatibility claim.** The dump was written from the documented API of the
 * release named in its own manifest, not captured from a running server, and that release
 * (`paperlessVersion` below) is older than the one `client/types.ts` was transcribed from. What
 * this proves is that the importer reads the corpus the project committed as its Paperless
 * reference; `README.md` § "What is unproven" still says what would make it a compatibility claim.
 */
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  PaperlessCorrespondent,
  PaperlessCustomField,
  PaperlessDocument,
  PaperlessDocumentType,
  PaperlessStoragePath,
  PaperlessTag,
} from '../client/types.js';
import type { FakeFault, FakeLibrary, FakeOriginal } from './fake-server.js';

/** One entry of `fixtures/paperless/index.json`. */
interface FixtureRoute {
  method: string;
  path: string;
  query: Record<string, string>;
  status: number;
  contentType: string;
  file: string;
  contentDisposition?: string;
}

interface FixtureManifest {
  baseUrl: string;
  paperlessVersion: string;
  apiVersion: number;
  pageSize: number;
  routes: FixtureRoute[];
}

/** The `ingest.paperless` section of `fixtures/expected-counts.json`, as far as this loader reads it. */
export interface PaperlessFixtureExpectations {
  paperlessVersion: string;
  apiVersion: number;
  pageSize: number;
  documents: {
    live: number;
    trashed: number;
    pages: number;
    withAsn: number;
    withoutCorrespondent: number;
    withoutDocumentType: number;
    withEmptyContent: number;
    withNotes: number;
    longestTitle: number;
    unfetchable: Array<{ id: number; title: string; reason: string }>;
    hostileFilenames: Array<{ id: number; originalFileName: string }>;
  };
  tags: { total: number; inbox: number };
  correspondents: { total: number };
  documentTypes: { total: number };
  storagePaths: { total: number };
  customFields: { total: number; byDataType: Record<string, number> };
  originals: {
    files: number;
    contents: Array<{ path: string; bytes: number; sha256: string }>;
    distinctHashes: number;
  };
  routes: number;
  apiFiles: number;
}

export interface PaperlessFixtureCorpus {
  library: FakeLibrary;
  /** The faults that reproduce the route table's non-200 answers, for `FakeServerOptions.faults`. */
  faults: FakeFault[];
  /** What `fixtures/expected-counts.json` says this corpus contains. */
  expected: PaperlessFixtureExpectations;
  manifest: FixtureManifest;
  /** The one document the route table refuses to serve, with the status it refuses with. */
  unfetchable: Array<{ id: number; status: number }>;
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

const results = <T>(path: string): T[] => readJson<{ results: T[] }>(path).results;

/**
 * Build the corpus.
 *
 * @param fixturesDirectory the repository's `fixtures/` directory.
 */
export const paperlessFixtureCorpus = (fixturesDirectory: string): PaperlessFixtureCorpus => {
  const root = join(fixturesDirectory, 'paperless');
  const api = (name: string): string => join(root, 'api', name);

  const manifest = readJson<FixtureManifest>(join(root, 'index.json'));
  const expected = readJson<{ ingest: { paperless: PaperlessFixtureExpectations } }>(
    join(fixturesDirectory, 'expected-counts.json'),
  ).ingest.paperless;

  const documents: PaperlessDocument[] = [
    ...results<PaperlessDocument>(api('documents-page-1.json')),
    ...results<PaperlessDocument>(api('documents-page-2.json')),
  ];

  /* The originals, keyed by the document id the route table downloads them for. A route that does
     not answer 200 contributes a fault instead, so the importer meets the same refusal it would
     meet on the day: `1007` is a document whose file is missing from the media volume. */
  const originals = new Map<number, FakeOriginal>();
  const faults: FakeFault[] = [];
  const unfetchable: Array<{ id: number; status: number }> = [];

  for (const route of manifest.routes) {
    const download = /^\/api\/documents\/(\d+)\/download\/$/u.exec(route.path);
    if (download === null) continue;
    const id = Number(download[1]);

    if (route.status !== 200) {
      faults.push({
        path: route.path,
        times: Number.MAX_SAFE_INTEGER,
        status: route.status,
        body: readFileSync(join(root, route.file), 'utf8'),
        headers: { 'content-type': route.contentType },
      });
      unfetchable.push({ id, status: route.status });
      continue;
    }

    const filename = /filename="([^"]*)"/u.exec(route.contentDisposition ?? '')?.[1];
    originals.set(id, {
      bytes: Buffer.from(readFileSync(join(root, route.file))),
      contentType: route.contentType,
      ...(filename === undefined ? {} : { filename }),
    });
  }

  const library: FakeLibrary = {
    correspondents: results<PaperlessCorrespondent>(api('correspondents.json')),
    documentTypes: results<PaperlessDocumentType>(api('document_types.json')),
    tags: results<PaperlessTag>(api('tags.json')),
    storagePaths: results<PaperlessStoragePath>(api('storage_paths.json')),
    customFields: results<PaperlessCustomField>(api('custom_fields.json')),
    documents,
    originals,
  };

  return { library, faults, expected, manifest, unfetchable };
};
