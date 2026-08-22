/**
 * Serialising a selection of the library (CONCEPT.md §5.11, ADR-0016).
 *
 * Two things happen here and they are worth separating in the reader's head: **choosing** which
 * items to export, and **rendering** them.
 *
 * *Choosing* is `resolveSelection`. A selection is a collection, a saved search, an explicit list of
 * ids, or a query — and a saved search is a smart collection, so "collection" and "saved search"
 * are one code path with two spellings of the same id (§4.1). Whatever the source, the answer is an
 * ordered list of item ids, and the order is deterministic, because a `.bib` file whose entries
 * reorder between fetches produces a diff on every Overleaf build.
 *
 * *Rendering* is `renderExport`, and its whole substance is the citation key. ADR-0016: "the value
 * of a key is that it is the same one as last year", because every `\cite{}` already written has to
 * keep resolving. So a stored key always wins, a pinned key is never recomputed, and only items
 * that have no key at all get a generated one — disambiguated against a ledger of the stored keys,
 * so a new item can never be handed a key a manuscript already points at.
 *
 * Losses are reported and never silent (P10). A `.bib` file cannot carry an OpenAlex id; the
 * endpoint says so in a header and, for the JSON variants of the export endpoint, in the body.
 */
import type { Recueil } from '@recueil/core';
import { ValidationError } from '@recueil/core';
import type { Item } from '@recueil/schemas';
import {
  disambiguate,
  exportBiblatex,
  exportBibtex,
  exportCslJson,
  exportRis,
  recordFromItem,
} from '@recueil/formats';
import type { ExportResult, FormatRecord, LossEntry } from '@recueil/formats';

import { loadItemView } from './item-view.js';

export const EXPORT_FORMATS = ['bibtex', 'biblatex', 'ris', 'csl-json'] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * The media type and file extension of each format.
 *
 * `application/x-bibtex` is what BibTeX tooling — including Overleaf's URL importer — expects; the
 * CSL type is the one the CSL project registered. Getting these right is the difference between a
 * browser rendering the file and a browser downloading it, and between Overleaf recognising a
 * bibliography and Overleaf saving an HTML page.
 */
export const FORMAT_MEDIA: Record<ExportFormat, { contentType: string; extension: string }> = {
  bibtex: { contentType: 'application/x-bibtex; charset=utf-8', extension: 'bib' },
  biblatex: { contentType: 'application/x-bibtex; charset=utf-8', extension: 'bib' },
  ris: { contentType: 'application/x-research-info-systems; charset=utf-8', extension: 'ris' },
  'csl-json': { contentType: 'application/vnd.citationstyles.csl+json; charset=utf-8', extension: 'json' },
};

export interface Selection {
  /** A collection, manual or smart. A smart one is a saved search (§4.1). */
  readonly collectionId?: string;
  /** An explicit list. Order is preserved, because a caller who sent an order meant it. */
  readonly ids?: readonly string[];
  /** A full-text query in Recueil's own syntax. */
  readonly q?: string;
  /** Cap the selection. Defaults to the export ceiling below. */
  readonly limit?: number;
}

/**
 * The largest export served in one request.
 *
 * Ten thousand entries is a `.bib` of a few megabytes and a second or two of work, which is a
 * reasonable ceiling for something a LaTeX build fetches synchronously. A library-sized export is
 * the analytics bundle's job (ADR-0008), not this endpoint's.
 */
export const MAX_EXPORT_ITEMS = 10_000;

/**
 * Resolve a selection to an ordered list of item ids.
 *
 * Exactly one source may be given, and giving none is an error rather than "the whole library":
 * an accidental `GET /export/bibtex` should not serialise fifty thousand records.
 */
export const resolveSelection = (recueil: Recueil, selection: Selection): string[] => {
  const limit = Math.min(selection.limit ?? MAX_EXPORT_ITEMS, MAX_EXPORT_ITEMS);
  const sources = [selection.collectionId, selection.ids, selection.q].filter(
    (value) => value !== undefined && (!Array.isArray(value) || value.length > 0),
  );

  if (sources.length === 0) {
    throw new ValidationError(
      'An export needs a selection: pass `collectionId`, `ids` or `q`. Exporting the whole library ' +
        'by accident is not something an endpoint should make easy.',
    );
  }
  if (sources.length > 1) {
    throw new ValidationError('Give one selection only: `collectionId`, `ids` or `q`.');
  }

  if (selection.ids !== undefined && selection.ids.length > 0) {
    return [...selection.ids].slice(0, limit);
  }

  if (selection.collectionId !== undefined) {
    const collection = recueil.collections.get(selection.collectionId);
    if (collection.kind === 'smart') return smartCollectionItems(recueil, collection, limit);

    // Paged out in full rather than in one query, because `listItems` is cursor-paged and the
    // cursor is the only ordering guarantee it offers.
    const ids: string[] = [];
    let cursor: string | undefined;
    while (ids.length < limit) {
      const page: { data: { id: string }[]; page: { nextCursor: string | null } } =
        recueil.collections.listItems(selection.collectionId, {
          limit: Math.min(200, limit - ids.length),
          order: 'asc',
          ...(cursor === undefined ? {} : { cursor }),
        });
      ids.push(...page.data.map((row) => row.id));
      if (page.page.nextCursor === null) break;
      cursor = page.page.nextCursor;
    }
    return ids;
  }

  return recueil.search.available ? recueil.search.itemIdsMatching(selection.q as string, limit) : [];
};

/**
 * The membership of a saved search.
 *
 * A smart collection's `query` is the structured saved search. The structured query language of
 * §4.1 is not built yet, so the one form understood here is `{ "text": "…" }` — the same syntax the
 * search endpoint takes — and anything else is refused rather than quietly returning nothing. A
 * saved search that silently exports an empty bibliography is a broken manuscript nobody notices.
 */
const smartCollectionItems = (
  recueil: Recueil,
  collection: { id: string; query: string | null },
  limit: number,
): string[] => {
  const raw = collection.query;
  if (raw === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError(
      `The saved search on collection '${collection.id}' is not valid JSON.`,
      { collectionId: collection.id },
    );
  }

  const text =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { text?: unknown; q?: unknown }).text ?? (parsed as { q?: unknown }).q
      : undefined;

  if (typeof text !== 'string' || text.trim() === '') {
    throw new ValidationError(
      `The saved search on collection '${collection.id}' has no \`text\` query. Phase 1 understands ` +
        'saved searches of the form `{"text": "<query>"}`; the structured query language arrives ' +
        'with the search phase.',
      { collectionId: collection.id, query: parsed },
    );
  }

  if (!recueil.search.available) return [];
  return recueil.search.itemIdsMatching(text, limit);
};

export interface RenderedExport {
  readonly format: ExportFormat;
  readonly text: string;
  readonly contentType: string;
  readonly extension: string;
  readonly recordCount: number;
  readonly losses: readonly LossEntry[];
}

/**
 * Serialise the items behind a list of ids.
 *
 * Ids that no longer resolve are skipped rather than failing the export: a `.bib` endpoint an
 * Overleaf build depends on should not start returning 404 because one item was trashed this
 * morning. What was skipped is reported as a loss entry, so it is visible rather than silent.
 */
export const renderExport = (
  recueil: Recueil,
  format: ExportFormat,
  itemIds: readonly string[],
): RenderedExport => {
  const records: FormatRecord[] = [];
  const missing: LossEntry[] = [];

  let index = 0;
  for (const id of itemIds) {
    let view: Item;
    try {
      view = loadItemView(recueil, id);
    } catch {
      missing.push({
        direction: 'export',
        format,
        recordIndex: index,
        recordKey: id,
        field: 'item',
        reason: 'the item is no longer in the library, or is in the trash',
      });
      index += 1;
      continue;
    }
    records.push(recordFromItem(view));
    index += 1;
  }

  const keys = citationKeys(records);
  const result = serialise(format, records, keys);

  return {
    format,
    text: result.text,
    contentType: FORMAT_MEDIA[format].contentType,
    extension: FORMAT_MEDIA[format].extension,
    recordCount: records.length,
    losses: [...missing, ...result.losses],
  };
};

/**
 * The key each record is exported under (ADR-0016).
 *
 * A stored key wins outright — it is unique among live items by database constraint, and it is what
 * every existing `\cite{}` points at. Records with no key are generated one, disambiguated against
 * a ledger of every stored key in the batch, so a new item can never be handed a key that is
 * already in use.
 */
export const citationKeys = (records: readonly FormatRecord[]): Map<string, string> => {
  const stored = new Map<string, string>();
  const ledger = new Set<string>();

  for (const record of records) {
    const key = record.bibliographic?.citationKey;
    if (record.id !== undefined && typeof key === 'string' && key.trim() !== '') {
      stored.set(record.id, key.trim());
      ledger.add(key.trim());
    }
  }

  const needKeys = records.filter((record) => record.id === undefined || !stored.has(record.id));
  for (const assignment of disambiguate(needKeys, { ledger })) {
    stored.set(assignment.id, assignment.key);
  }

  return stored;
};

const serialise = (
  format: ExportFormat,
  records: readonly FormatRecord[],
  keys: ReadonlyMap<string, string>,
): ExportResult => {
  switch (format) {
    case 'bibtex':
      return exportBibtex(records, { keys });
    case 'biblatex':
      return exportBiblatex(records, { keys });
    case 'ris':
      return exportRis(records, { keys });
    case 'csl-json':
      return exportCslJson(records, { keys });
  }
};
