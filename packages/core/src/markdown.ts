/**
 * The narrow HTML-to-Markdown conversion invariant N1 needs.
 *
 * `spec/data-model.md` §4.8: `notes.content_markdown` is always populated, **including for HTML
 * imports**, so that the search index and the export path read one column. The original HTML is
 * kept verbatim in `content_original`, so a Zotero note still round-trips losslessly (P10) — which
 * is what makes it acceptable for this converter to be small.
 *
 * And it is deliberately small. It handles the tag vocabulary Zotero's note editor actually emits —
 * headings, paragraphs, breaks, lists, blockquotes, emphasis, code, links — and drops the rest to
 * text. It is not an HTML parser and does not pretend to be one; a note whose HTML this mangles
 * still has its exact source one column away. Reaching for a full parser here would add a
 * dependency to the one package every other package builds on, for a fidelity that
 * `content_original` already guarantees.
 */

const BLOCK_CLOSERS = /<\/(p|div|h[1-6]|li|ul|ol|blockquote|pre|tr|table)\s*>/giu;

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
};

const decodeEntities = (value: string): string =>
  value
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#39);/giu, (match) => ENTITIES[match.toLowerCase()] ?? match)
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)));

/** Convert a fragment of HTML to Markdown. See the module note on what this deliberately is not. */
export const htmlToMarkdown = (html: string): string => {
  let text = html;

  text = text.replace(/<!--[\s\S]*?-->/gu, '');
  text = text.replace(/<(script|style)[\s\S]*?<\/\1>/giu, '');

  // Inline marks, innermost meaning first so a `<strong><em>` nest survives.
  text = text.replace(/<a\b[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/giu, '[$2]($1)');
  text = text.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/giu, '**$2**');
  text = text.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/giu, '*$2*');
  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/giu, '`$1`');

  // Block structure.
  text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/giu, (_match, level: string, body: string) =>
    `\n${'#'.repeat(Number.parseInt(level, 10))} ${body.trim()}\n`,
  );
  text = text.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/giu, (_match, body: string) =>
    `\n${body
      .trim()
      .split(/\n+/u)
      .map((line) => `> ${line.trim()}`)
      .join('\n')}\n`,
  );
  text = text.replace(/<li\b[^>]*>/giu, '\n- ');
  text = text.replace(/<br\s*\/?>/giu, '\n');
  text = text.replace(BLOCK_CLOSERS, '\n');
  text = text.replace(/<[^>]+>/gu, '');

  text = decodeEntities(text);

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
};

/**
 * The title a note gets when the caller supplies none: the first heading, or the first line.
 *
 * Stored rather than derived on read, so that a note list needs no Markdown parsing (§4.8).
 */
export const deriveNoteTitle = (markdown: string, maxLength = 120): string | null => {
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const heading = /^#{1,6}\s+(.*)$/u.exec(line);
    const candidate = (heading?.[1] ?? line)
      .replace(/^[>*\-+\s]+/u, '')
      .replace(/[*_`]/gu, '')
      .trim();
    if (candidate === '') continue;
    return candidate.length > maxLength ? `${candidate.slice(0, maxLength - 1)}…` : candidate;
  }
  return null;
};
