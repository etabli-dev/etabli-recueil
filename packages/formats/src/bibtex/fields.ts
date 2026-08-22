/**
 * The canonical field order, and the `file` field's own little grammar.
 *
 * Field order is fixed rather than alphabetical or insertion-ordered because a `.bib` file lives in
 * a Git repository next to the manuscript it feeds. An export that reorders fields between runs
 * produces a diff on every regeneration and nobody reads those diffs twice. Fields not in the list
 * are emitted after it, alphabetically, so an unknown field is stable too.
 */

/** Emission order. Not every entry uses every field; the order is what is stable. */
export const BIBTEX_FIELD_ORDER: readonly string[] = [
  'author',
  'editor',
  'translator',
  'title',
  'subtitle',
  'shorttitle',
  'booktitle',
  'journal',
  'journaltitle',
  'shortjournal',
  'series',
  'volume',
  'number',
  'issue',
  'pages',
  'pagetotal',
  'edition',
  'version',
  'publisher',
  'institution',
  'school',
  'organization',
  'address',
  'location',
  'howpublished',
  'type',
  'year',
  'month',
  'date',
  'urldate',
  'doi',
  'isbn',
  'issn',
  'eprint',
  'eprinttype',
  'eprintclass',
  'archiveprefix',
  'primaryclass',
  'pmid',
  'pmcid',
  'url',
  'abstract',
  'keywords',
  'language',
  'langid',
  'note',
  'annotation',
  'file',
  'crossref',
];

const ORDER_INDEX: ReadonlyMap<string, number> = new Map(
  BIBTEX_FIELD_ORDER.map((name, index) => [name, index]),
);

/** Sort field names into emission order: known fields by the table, the rest alphabetically after. */
export const orderFields = (names: readonly string[]): string[] =>
  [...names].sort((left, right) => {
    const leftIndex = ORDER_INDEX.get(left);
    const rightIndex = ORDER_INDEX.get(right);
    if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex;
    if (leftIndex !== undefined) return -1;
    if (rightIndex !== undefined) return 1;
    return left < right ? -1 : left > right ? 1 : 0;
  });

/** One entry in a `file` field. */
export interface FileFieldEntry {
  readonly title?: string | undefined;
  readonly path: string;
  readonly mimeType?: string | undefined;
}

const escapeFilePart = (value: string): string => value.replace(/([\\:;])/gu, '\\$1');

/**
 * Render the JabRef/Zotero `file` field: `title:path:type`, entries separated by `;`.
 *
 * Colons and semicolons inside a part are backslash-escaped, which is what makes a Windows path
 * (`C:\lib\x.pdf`) survive a format whose separator is the colon.
 */
export const formatFileField = (entries: readonly FileFieldEntry[]): string =>
  entries
    .map((entry) =>
      [escapeFilePart(entry.title ?? ''), escapeFilePart(entry.path), escapeFilePart(entry.mimeType ?? '')].join(':'),
    )
    .join(';');

/**
 * Split on an unescaped separator.
 *
 * `unescape` matters: the entry separator `;` has to be split *without* consuming the backslashes,
 * because the escapes that survive belong to the `:` pass that follows. Unescaping too early is how
 * a Windows path `C:\lib\x.pdf` turns into three fields.
 */
const splitEscaped = (value: string, separator: string, unescape: boolean): string[] => {
  const parts: string[] = [];
  let current = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string;
    if (character === '\\' && index + 1 < value.length) {
      current += unescape ? (value[index + 1] as string) : character + (value[index + 1] as string);
      index += 1;
      continue;
    }
    if (character === separator) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
};

/**
 * Parse a `file` field.
 *
 * Both spellings in the wild are accepted: the three-part `title:path:type` that JabRef and Zotero
 * write, and the two-part `path:type` that older Mendeley exports use. A single part is a bare
 * path.
 */
export const parseFileField = (value: string): FileFieldEntry[] => {
  const entries: FileFieldEntry[] = [];
  for (const chunk of splitEscaped(value, ';', false)) {
    if (chunk.trim().length === 0) continue;
    const parts = splitEscaped(chunk, ':', true).map((part) => part.trim());
    if (parts.length === 1) {
      entries.push({ path: parts[0] as string });
      continue;
    }
    if (parts.length === 2) {
      const [first, second] = parts as [string, string];
      entries.push({ path: first, mimeType: second.length > 0 ? second : undefined });
      continue;
    }
    const [title, path, mimeType] = parts as [string, string, string];
    entries.push({
      title: title.length > 0 ? title : undefined,
      path,
      mimeType: mimeType.length > 0 ? mimeType : undefined,
    });
  }
  return entries;
};
