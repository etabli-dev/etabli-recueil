/**
 * Annotate → note → cite (CONCEPT §7 Phase 4 exit).
 *
 * A note made from an annotation quotes the passage, carries the comment, and ends with a citation
 * in Pandoc syntax — `[@key, p. 12]` — which Quarto, R Markdown and the Overleaf `.bib` workflow
 * all read. The note keeps `parent_annotation_id`, so it can always be traced back to the place in
 * the document it came from.
 *
 * The page in the citation is the printed page label when the annotation has one, because that is
 * the page a reader will look for; the physical page otherwise.
 */
import type { Actor } from './actor.js';
import type { AnnotationService } from './annotations.js';
import type { LibraryService } from './library.js';
import type { NoteService } from './notes.js';
import type { NoteRow } from '../db/schema.js';
import { ValidationError } from '../errors.js';

export interface CitationParts {
  citationKey: string | null;
  /** Shown when there is no key: "Lovelace 2020". */
  fallback: string;
  page: string | null;
}

export const pandocCitation = (parts: CitationParts): string => {
  const locator = parts.page === null ? '' : `, p. ${parts.page}`;
  if (parts.citationKey !== null && /^[A-Za-z0-9_:.\-+/]+$/u.test(parts.citationKey)) return `[@${parts.citationKey}${locator}]`;
  return `(${parts.fallback}${locator})`;
};

const quoteBlock = (text: string): string =>
  text
    .trim()
    .split(/\r?\n/u)
    .map((line) => `> ${line}`)
    .join('\n');

export const noteFromAnnotation = (
  services: { annotations: AnnotationService; notes: NoteService; library: LibraryService },
  annotationId: string,
  actor: Actor,
  options: { itemId?: string } = {},
): NoteRow => {
  const annotation = services.annotations.get(annotationId);
  const itemId = options.itemId ?? annotation.itemId;
  if (itemId === null) throw new ValidationError('Name the item the note belongs to: this annotation was made outside any item.');
  const record = services.library.getItem(itemId);
  const year = record.bibliographic?.issuedYear ?? null;
  const citation = pandocCitation({
    citationKey: record.bibliographic?.citationKey ?? null,
    fallback: [record.item.title ?? 'Untitled', year].filter((part) => part !== null).join(' '),
    page: annotation.pageLabel ?? (annotation.pageIndex === null ? null : String(annotation.pageIndex + 1)),
  });

  const parts: string[] = [];
  if (annotation.quotedText !== null && annotation.quotedText.trim() !== '') parts.push(quoteBlock(annotation.quotedText));
  if (annotation.bodyText !== null && annotation.bodyText.trim() !== '') parts.push(annotation.bodyText.trim());
  parts.push(citation);

  return services.notes.create(
    {
      itemId,
      contentMarkdown: parts.join('\n\n'),
      noteKind: annotation.quotedText === null ? 'thought' : 'quote',
      parentAnnotationId: annotation.id,
    },
    actor,
  );
};
