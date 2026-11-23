/**
 * `@recueil/plugin-dedup-core` — the record-layer rules of CONCEPT §5.6.
 *
 * **identifier** widens Argus One's rule (spec/parity-zotero-plugins.md §3.2–3.3), which matched
 * on the exact normalised DOI only, to every identifier the facet carries. Two items that share an
 * identifier are a `duplicate` at score 1 — the only verdict the engine merges without review —
 * unless they carry *different* values of the same scheme, which makes them `distinct`: two DOIs
 * that disagree are two works, whatever else they share.
 *
 * **fuzzy** is what Argus One deliberately did not do ("No fuzzy matching of parent records"):
 * a near-identical title (token Jaccard ≥ 0.9, the bar Metadata Mender used for its title search),
 * the same year ± 1 and the same first author. Its score never reaches 1, so it only ever proposes.
 *
 * Both rules are pure and symmetric, as spec/hooks.md §6.3 requires.
 */
import { nameKey, titleSimilarity, titleTokens } from '@recueil/plugin-sdk';
import type { DedupRule, DedupSubject, DedupVerdict } from '@recueil/plugin-sdk';

type RecordSubject = Extract<DedupSubject, { layer: 'record' }>;

const record = (subject: DedupSubject): RecordSubject => {
  if (subject.layer !== 'record') throw new Error('a record-layer rule was given a file subject');
  return subject;
};

const byScheme = (subject: RecordSubject): Map<string, Set<string>> => {
  const out = new Map<string, Set<string>>();
  for (const id of subject.identifiers) {
    const values = out.get(id.scheme) ?? new Set<string>();
    values.add(id.value);
    out.set(id.scheme, values);
  }
  return out;
};

/** Schemes that identify one work. An ISSN or a URL is shared by many and is not one of them. */
const WORK_SCHEMES = new Set(['doi', 'pmid', 'pmcid', 'arxiv', 'isbn']);

export const identifierRule: DedupRule = {
  id: 'identifier',
  layer: 'record',
  title: 'Same identifier',

  async blockingKeys(subject) {
    return record(subject)
      .identifiers.filter((id) => WORK_SCHEMES.has(id.scheme))
      .map((id) => `${id.scheme}:${id.value}`);
  },

  async compare(left, right): Promise<DedupVerdict> {
    const a = byScheme(record(left));
    const b = byScheme(record(right));
    const shared: string[] = [];
    for (const [scheme, values] of [...a].sort(([x], [y]) => (x < y ? -1 : 1))) {
      if (!WORK_SCHEMES.has(scheme)) continue;
      const other = b.get(scheme);
      if (other === undefined) continue;
      const common = [...values].filter((value) => other.has(value));
      if (common.length > 0) shared.push(...common.map((value) => `${scheme} ${value}`));
      else {
        // Sorted, so compare(a, b) and compare(b, a) say exactly the same thing (§6.3 symmetry).
        const sides = [[...values].sort().join(', '), [...other].sort().join(', ')].sort();
        return {
          ruleId: 'identifier',
          score: 1,
          action: 'distinct',
          reason: `different ${scheme.toUpperCase()}s: ${sides[0]} and ${sides[1]}`,
        };
      }
    }
    if (shared.length === 0) return { ruleId: 'identifier', score: 0, action: 'undecided', reason: 'no identifier in common' };
    return { ruleId: 'identifier', score: 1, action: 'duplicate', reason: `the same ${shared.sort().join(' and ')}`, evidence: { shared } };
  },

  async mergePreference() {
    return 'undecided';
  },
};

const firstAuthor = (subject: RecordSubject): string | null => {
  const value = subject.snapshot['firstAuthor'];
  return typeof value === 'string' && value.trim() !== '' ? nameKey(value) : null;
};

const title = (subject: RecordSubject): string => {
  const value = subject.snapshot['title'];
  return typeof value === 'string' ? value : subject.normalisedTitle;
};

export const FUZZY_TITLE_THRESHOLD = 0.9;

export const fuzzyRule: DedupRule = {
  id: 'fuzzy',
  layer: 'record',
  title: 'Same title, year and first author',

  async blockingKeys(subject) {
    // The two longest title tokens, which survive a changed subtitle or a dropped article.
    const tokens = [...titleTokens(title(record(subject)))].sort((x, y) => y.length - x.length || (x < y ? -1 : 1));
    if (tokens.length < 2) return [];
    return [`t:${[tokens[0], tokens[1]].sort().join('|')}`];
  },

  async compare(left, right): Promise<DedupVerdict> {
    const a = record(left);
    const b = record(right);
    const similarity = titleSimilarity(title(a), title(b));
    const reasonTitle = `titles ${similarity.toFixed(2)} alike`;
    if (similarity < FUZZY_TITLE_THRESHOLD) {
      return { ruleId: 'fuzzy', score: similarity, action: 'undecided', reason: reasonTitle };
    }
    if (a.issuedYear !== undefined && b.issuedYear !== undefined && Math.abs(a.issuedYear - b.issuedYear) > 1) {
      return { ruleId: 'fuzzy', score: similarity, action: 'distinct', reason: `${reasonTitle}, but published ${a.issuedYear} and ${b.issuedYear}` };
    }
    const authorA = firstAuthor(a);
    const authorB = firstAuthor(b);
    if (authorA !== null && authorB !== null && authorA !== authorB) {
      return { ruleId: 'fuzzy', score: similarity, action: 'undecided', reason: `${reasonTitle}, but different first authors` };
    }
    // Capped below 1: a fuzzy match is never enough to merge without a person.
    const score = Math.min(0.95, similarity * (authorA !== null && authorA === authorB ? 1 : 0.9));
    return {
      ruleId: 'fuzzy',
      score,
      action: 'duplicate',
      reason: `${reasonTitle}${a.issuedYear === undefined ? '' : `, ${a.issuedYear}`}${authorA === null ? '' : ', same first author'}`,
      evidence: { similarity },
    };
  },
};

export default {};
