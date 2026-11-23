/**
 * Markdown to the HTML Zotero stores for a note.
 *
 * Only needed when a note was written or edited in Recueil: a note that came from Zotero and has
 * not been edited goes back as the HTML Zotero sent (`notes.content_original`). The converter is
 * deliberately small — paragraphs, headings, lists, block quotes, code, emphasis, links — and
 * escapes everything else, because the output is rendered by Zotero's note editor on every device
 * the owner has, and an unescaped `<` there is an injection.
 */

const escapeHtml = (text: string): string =>
  text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');

const safeUrl = (url: string): string | null => {
  const trimmed = url.trim();
  return /^(https?:|mailto:|zotero:)/iu.test(trimmed) ? trimmed : null;
};

const inline = (text: string): string => {
  const codeSpans: string[] = [];
  let out = text.replace(/`([^`]+)`/gu, (_match, code: string) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `\uE000${codeSpans.length - 1}\uE001`;
  });
  out = escapeHtml(out);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/gu, (match, label: string, url: string) => {
    const safe = safeUrl(url.replace(/&amp;/gu, '&'));
    return safe === null ? match : `<a href="${escapeHtml(safe)}">${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/gu, '$1<em>$2</em>');
  out = out.replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/gu, '$1<em>$2</em>');
  // Private-use characters mark the code spans; they cannot occur in a note's text by accident.
  return out.replace(/\uE000(\d+)\uE001/gu, (_match, index: string) => codeSpans[Number(index)] ?? '');
};

export const markdownToNoteHtml = (markdown: string): string => {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] = [];
  let code: string[] | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) blocks.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (list !== null) {
      const tag = list.ordered ? 'ol' : 'ul';
      blocks.push(`<${tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${tag}>`);
    }
    list = null;
  };
  const flushQuote = (): void => {
    if (quote.length > 0) blocks.push(`<blockquote><p>${quote.map(inline).join('<br>')}</p></blockquote>`);
    quote = [];
  };
  const flushAll = (): void => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    if (code !== null) {
      if (/^```/u.test(line)) {
        blocks.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`);
        code = null;
      } else code.push(line);
      continue;
    }
    if (/^```/u.test(line)) {
      flushAll();
      code = [];
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (heading !== null) {
      flushAll();
      const level = (heading[1] ?? '#').length;
      blocks.push(`<h${level}>${inline(heading[2] ?? '')}</h${level}>`);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/u.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/u.exec(line);
    if (bullet !== null || numbered !== null) {
      flushParagraph();
      flushQuote();
      const ordered = numbered !== null;
      if (list === null || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? numbered)?.[1] ?? '');
      continue;
    }
    const quoted = /^>\s?(.*)$/u.exec(line);
    if (quoted !== null) {
      flushParagraph();
      flushList();
      quote.push(quoted[1] ?? '');
      continue;
    }
    if (line.trim() === '') {
      flushAll();
      continue;
    }
    flushList();
    flushQuote();
    paragraph.push(line.trim());
  }
  if (code !== null) blocks.push(`<pre>${escapeHtml((code as string[]).join('\n'))}</pre>`);
  flushAll();

  return `<div data-schema-version="9">${blocks.join('')}</div>`;
};
