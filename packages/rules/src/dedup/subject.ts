/**
 * What a dedup rule can see: a candidate and the record it might duplicate.
 *
 * The pair is ordered, and the order carries meaning. `left` is the candidate — the thing that has
 * just arrived, or the row being considered — and `right` is the record already in the library.
 * CONCEPT.md §5.6's winner rules ("newest `dateAdded`, most complete, manual") need that
 * distinction, and so does a reader of a dry-run report.
 *
 * `fieldCount` and `dateAdded` are here only because the `most-complete` and `newest` winner rules
 * read them. The engine does not interpret them further: it names a winner and Phase 3 executes it.
 */

export interface DedupSide {
  readonly id: string;
  readonly itemType?: string;
  readonly title?: string;
  /** Publication year. The `year-within` condition compares these. */
  readonly year?: number;
  /** Creator names in any consistent form; compared after normalisation, not parsed. */
  readonly creators?: readonly string[];
  readonly venue?: string;
  /** The office facet's correspondent, for the private-document half of the library. */
  readonly correspondent?: string;
  /** Book, proceedings or series title — whatever holds the item. */
  readonly container?: string;
  /**
   * Identifiers by scheme: `doi`, `pmid`, `pmcid`, `arxiv`, `isbn`, … Stored normalised, per
   * invariant B1, and compared here with `=`.
   */
  readonly identifiers?: Readonly<Record<string, string>>;
  /** SHA-256 of every document attached to this side, for the file layer of §5.6. */
  readonly hashes?: readonly string[];
  /** Which importer or source this side came from. PRISMA needs per-source duplicate counts. */
  readonly source?: string;
  /** ISO-8601. Read by the `newest` and `oldest` winner rules. */
  readonly dateAdded?: string;
  /** How many fields are populated. Read by the `most-complete` winner rule. */
  readonly fieldCount?: number;
  readonly hasAnnotations?: boolean;
  readonly hasNotes?: boolean;
}

export interface DedupPair {
  /** Identifies the pair in the trace and in the dry-run report. */
  readonly id: string;
  /** The candidate. */
  readonly left: DedupSide;
  /** The record already in the library. */
  readonly right: DedupSide;
}

export type DedupField = 'source' | 'item-type' | 'title' | 'venue' | 'correspondent' | 'container';
