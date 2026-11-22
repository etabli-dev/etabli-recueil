/**
 * Web of Science plain text, the format bibliometrix and biblioshiny import unmodified
 * (`convert2df(file, dbsource = "wos", format = "plaintext")`; CONCEPT §7 Phase 5 exit).
 *
 * One record per item, the WoS field tags bibliometrix maps onto its `M` data frame: PT, AU, AF,
 * TI, SO, LA, DT, DE, ID, AB, C1, CR, NR, TC, PY, VL, IS, BP, EP, DI, UT. Continuation lines are
 * indented three spaces, records end with `ER`, the file with `EF`.
 *
 * `CR` carries the item's reference list from the graph in bibliometrix's own shape —
 * `AUTHOR I, YEAR, SOURCE, V1, P2, DOI 10.x` — which is what its co-citation and historiograph
 * analyses parse. `UT` is a stable Recueil identifier, since there is no WoS accession number.
 */
import type { Recueil } from '@recueil/core';
import { schema } from '@recueil/core';
import { and, eq, inArray } from 'drizzle-orm';

const DOC_TYPES: Record<string, [string, string]> = {
  article: ['J', 'Article'],
  preprint: ['J', 'Article'],
  conference_paper: ['C', 'Proceedings Paper'],
  chapter: ['B', 'Book Chapter'],
  book: ['B', 'Book'],
  report: ['J', 'Report'],
  thesis: ['B', 'Thesis'],
};

const LANGUAGES: Record<string, string> = { en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese', nl: 'Dutch', ru: 'Russian', zh: 'Chinese', ja: 'Japanese' };

const field = (tag: string, values: readonly string[]): string[] => {
  const cleaned = values.map((value) => value.replace(/\s+/gu, ' ').trim()).filter((value) => value !== '');
  if (cleaned.length === 0) return [];
  return cleaned.map((value, index) => `${index === 0 ? tag : '  '} ${value}`);
};

const initials = (given: string | null | undefined): string =>
  (given ?? '')
    .split(/[\s-]+/u)
    .filter((part) => part !== '')
    .map((part) => part[0]!.toUpperCase())
    .join('');

/** `LOVELACE A, 2020, INJURY, V12, P101, DOI 10.1234/x` from what is known about a cited work. */
export const citedReference = (work: {
  firstAuthor: string | null;
  firstAuthorGiven?: string | null;
  year: number | null;
  source: string | null;
  volume?: string | null;
  page?: string | null;
  doi: string | null;
  title?: string | null;
}): string => {
  const parts: string[] = [];
  const author = work.firstAuthor === null ? 'ANONYMOUS' : `${work.firstAuthor.toUpperCase()}${initials(work.firstAuthorGiven) === '' ? '' : ` ${initials(work.firstAuthorGiven)}`}`;
  parts.push(author);
  if (work.year !== null) parts.push(String(work.year));
  parts.push((work.source ?? work.title ?? 'UNKNOWN').toUpperCase());
  if (work.volume) parts.push(`V${work.volume}`);
  if (work.page) parts.push(`P${work.page}`);
  if (work.doi) parts.push(`DOI ${work.doi.toUpperCase()}`);
  return parts.join(', ');
};

export const toWosPlaintext = (recueil: Recueil, itemIds: readonly string[]): string => {
  const out = ['FN Clarivate Analytics Web of Science', 'VR 1.0'];
  const nodes = new Map(
    (itemIds.length === 0 ? [] : recueil.db.select().from(schema.graphNodes).where(inArray(schema.graphNodes.itemId, [...itemIds])).all()).map((n) => [n.itemId!, n]),
  );
  for (const itemId of itemIds) {
    const record = recueil.library.getItem(itemId);
    const bib = record.bibliographic;
    const [pt, dt] = DOC_TYPES[record.item.itemType] ?? ['J', 'Article'];
    const creators = recueil.creators.forItem(itemId).filter((entry) => entry.appearance.role === 'author');
    const tags = recueil.tags.forItem(itemId).map((tag) => tag.name);
    const cited = recueil.db
      .select({ value: schema.itemMetrics.metricValue })
      .from(schema.itemMetrics)
      .where(and(eq(schema.itemMetrics.itemId, itemId), eq(schema.itemMetrics.metric, 'cited_by_count')))
      .all();

    // The reference list, from the graph: one CR line per distinct cited node.
    const references: string[] = [];
    const node = nodes.get(itemId);
    if (node !== undefined) {
      const targets = [
        ...new Set(
          recueil.db
            .select({ target: schema.graphEdges.targetNodeId })
            .from(schema.graphEdges)
            .where(and(eq(schema.graphEdges.sourceNodeId, node.id), eq(schema.graphEdges.edgeType, 'cites')))
            .all()
            .map((row) => row.target),
        ),
      ];
      for (const targetId of targets) {
        const target = recueil.db.select().from(schema.graphNodes).where(eq(schema.graphNodes.id, targetId)).get();
        if (target === undefined) continue;
        if (target.itemId !== null) {
          const tb = recueil.library.getItem(target.itemId, { includeTrashed: true }).bibliographic;
          const tc = recueil.creators.forItem(target.itemId)[0]?.creator;
          references.push(
            citedReference({ firstAuthor: tc?.familyName ?? tc?.literalName ?? null, firstAuthorGiven: tc?.givenName ?? null, year: tb?.issuedYear ?? null, source: tb?.containerShort ?? tb?.containerTitle ?? null, volume: tb?.volume ?? null, page: tb?.pageFirst == null ? null : String(tb.pageFirst), doi: tb?.doi ?? null, title: tb?.title ?? null }),
          );
        } else if (target.shadowWorkId !== null) {
          const shadow = recueil.db.select().from(schema.shadowWorks).where(eq(schema.shadowWorks.id, target.shadowWorkId)).get();
          if (shadow === undefined) continue;
          const first = (JSON.parse(shadow.authors) as { family?: string; given?: string }[])[0];
          references.push(
            citedReference({ firstAuthor: shadow.firstAuthorFamily ?? first?.family ?? null, firstAuthorGiven: first?.given ?? null, year: shadow.issuedYear, source: shadow.containerTitle, doi: shadow.doi, title: shadow.title }),
          );
        }
      }
    }

    out.push(
      ...field('PT', [pt]),
      ...field('AU', creators.map(({ creator }) => (creator.literalName ?? `${creator.familyName ?? ''}, ${initials(creator.givenName)}`).replace(/, $/u, ''))),
      ...field('AF', creators.map(({ creator }) => creator.literalName ?? `${creator.familyName ?? ''}, ${creator.givenName ?? ''}`.replace(/, $/u, ''))),
      ...field('TI', [bib?.title ?? record.item.title ?? '']),
      ...field('SO', [(bib?.containerTitle ?? '').toUpperCase()]),
      ...field('LA', [bib?.languageCode ? (LANGUAGES[bib.languageCode.slice(0, 2)] ?? bib.languageCode) : '']),
      ...field('DT', [dt]),
      ...field('DE', [tags.join('; ')]),
      ...field('AB', [bib?.abstract ?? '']),
      // bibliometrix's convert2df assumes every record has C1; without one it fails outright.
      ...field('C1', (() => {
        const affiliations = creators
          .filter(({ appearance }) => appearance.affiliationRaw !== null && appearance.affiliationRaw.trim() !== '')
          .map(({ creator, appearance }) => `[${creator.literalName ?? `${creator.familyName ?? ''}, ${creator.givenName ?? ''}`.replace(/, $/u, '')}] ${appearance.affiliationRaw!.trim()}`);
        return affiliations.length > 0 ? affiliations : ['NA'];
      })()),
      ...field('CR', references),
      ...field('NR', [String(references.length)]),
      ...field('TC', [cited.length === 0 ? '0' : String(Math.max(...cited.map((row) => row.value)))]),
      ...field('PY', [bib?.issuedYear == null ? '' : String(bib.issuedYear)]),
      ...field('VL', [bib?.volume ?? '']),
      ...field('IS', [bib?.issue ?? '']),
      ...field('BP', [bib?.pageFirst == null ? '' : String(bib.pageFirst)]),
      ...field('EP', [bib?.pageLast == null ? '' : String(bib.pageLast)]),
      ...field('DI', [bib?.doi ?? '']),
      ...field('UT', [`RECUEIL:${record.item.publicId}`]),
      'ER',
      '',
    );
  }
  out.push('EF', '');
  return out.join('\n');
};
