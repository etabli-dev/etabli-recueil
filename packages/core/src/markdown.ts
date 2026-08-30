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
 * text. It is not a conforming HTML parser and does not pretend to be one; a note whose HTML this
 * mangles still has its exact source one column away. Reaching for a full parser here would add a
 * dependency to the one package every other package builds on, for a fidelity that
 * `content_original` already guarantees.
 *
 * ## Why this is a scanner and not a chain of `String.replace` calls (ADR-0022)
 *
 * It used to be six chained replacements over lazy `([\s\S]*?)` patterns bounded by a closing tag,
 * two of them carrying a backreference. That shape is quadratic in the input whenever the closing
 * tag is absent: every unmatched opener costs a scan to the end of the note. Measured against the
 * shipped build, 500 unclosed `<strong>` in 260 KB cost 0.04 s, 2 000 in 1 MB cost 0.67 s and
 * 4 000 in 2 MB cost 2.58 s — clean quadratic growth, reaching minutes inside the server's own
 * 16 MiB body limit. Note bodies are not ours: they arrive from `POST /api/v1/notes`, from the
 * Zotero connector route and from imported libraries, and the conversion runs synchronously on the
 * request thread, so the whole process stops with it.
 *
 * A budget cannot be enforced inside `String.replace`, so the chain is gone. What replaces it is a
 * single left-to-right pass: the cursor only ever moves forward, each frame on the element stack is
 * pushed once and popped once, and a closing tag with no opener is rejected in constant time
 * against a per-name counter rather than by searching the stack. The work is therefore linear in
 * the length of the input with no pathological case to find, which is a stronger guarantee than any
 * ceiling this module could have been given — and it is the same tag vocabulary as before, so the
 * fidelity ceiling recorded above is unchanged.
 */

/** Closing tags that end a block, and so become a line break when nothing else claims them. */
const BLOCK_CLOSERS: ReadonlySet<string> = new Set([
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'ul',
  'ol',
  'blockquote',
  'pre',
  'tr',
  'table',
]);

/** Inline elements that become a Markdown marker around their body. */
const INLINE_MARKS: ReadonlyMap<string, string> = new Map([
  ['strong', '**'],
  ['b', '**'],
  ['em', '*'],
  ['i', '*'],
  ['code', '`'],
]);

/** Elements whose body is transformed rather than merely wrapped, and so needs collecting. */
const COLLECTING = new Set([...INLINE_MARKS.keys(), 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote']);

/** Elements whose content is markup for the browser, not text for the reader. */
const DROPPED: ReadonlySet<string> = new Set(['script', 'style']);

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
};

/** The last code point Unicode has. A numeric reference beyond it is data, not a character. */
const MAX_CODE_POINT = 0x10_ff_ff;

/**
 * Decode the handful of entities this vocabulary needs.
 *
 * Both patterns are anchored on `&`, have no nested quantifier and no alternation under one, and
 * are applied to a single text run: linear, and safe to leave as a regular expression (ADR-0022
 * §4). The numeric branch clamps rather than trusting the number — `String.fromCodePoint` throws a
 * `RangeError` above the last code point, and `&#99999999;` in a note body is a stranger's choice.
 */
const decodeEntities = (value: string): string =>
  value
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#39);/giu, (match) => ENTITIES[match.toLowerCase()] ?? match)
    .replace(/&#(\d{1,8});/gu, (match, code: string) => {
      const point = Number.parseInt(code, 10);
      return point >= 0 && point <= MAX_CODE_POINT ? String.fromCodePoint(point) : match;
    });

/** One open element whose body is being collected. */
interface Frame {
  readonly tag: string;
  /** `href` for an `a`, otherwise null. */
  readonly href: string | null;
  readonly out: string[];
}

interface Tag {
  readonly name: string;
  readonly closing: boolean;
  readonly href: string | null;
  /** Index just past the `>`, or the end of the input when there is no `>`. */
  readonly end: number;
}

const isNameStart = (character: string | undefined): boolean =>
  character !== undefined && ((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z'));

const isNameChar = (character: string | undefined): boolean =>
  character !== undefined &&
  ((character >= 'a' && character <= 'z') ||
    (character >= 'A' && character <= 'Z') ||
    (character >= '0' && character <= '9') ||
    character === '-' ||
    character === ':' ||
    character === '_');

const isSpace = (character: string | undefined): boolean =>
  character === ' ' || character === '\t' || character === '\n' || character === '\r' || character === '\f';

/**
 * Read one tag starting at `at`, where `html[at]` is `<`.
 *
 * Null means "this `<` does not begin a tag", which is how a bare `<` in prose survives. The scan
 * is strictly forward and reads each character at most once, attribute values included; quoted
 * values are honoured, so a `>` inside `title="a > b"` no longer ends the tag early.
 */
const readTag = (html: string, at: number): Tag | null => {
  let index = at + 1;
  const closing = html[index] === '/';
  if (closing) index += 1;
  if (!isNameStart(html[index])) return null;

  const nameStart = index;
  while (isNameChar(html[index])) index += 1;
  const name = html.slice(nameStart, index).toLowerCase();

  let href: string | null = null;

  for (;;) {
    while (isSpace(html[index])) index += 1;
    const character = html[index];
    if (character === undefined) return { name, closing, href, end: html.length };
    if (character === '>') return { name, closing, href, end: index + 1 };
    if (character === '/' && html[index + 1] === '>') return { name, closing, href, end: index + 2 };

    if (!isNameStart(character) && character !== '_' && character !== ':') {
      // Junk between attributes: skip it rather than restarting, so the cursor keeps moving.
      index += 1;
      continue;
    }

    const attributeStart = index;
    while (isNameChar(html[index])) index += 1;
    const attribute = html.slice(attributeStart, index).toLowerCase();

    while (isSpace(html[index])) index += 1;
    if (html[index] !== '=') continue;
    index += 1;
    while (isSpace(html[index])) index += 1;

    const quote = html[index];
    let value: string;
    if (quote === '"' || quote === "'") {
      index += 1;
      const valueStart = index;
      while (index < html.length && html[index] !== quote) index += 1;
      value = html.slice(valueStart, index);
      if (index < html.length) index += 1;
    } else {
      const valueStart = index;
      while (index < html.length && !isSpace(html[index]) && html[index] !== '>') index += 1;
      value = html.slice(valueStart, index);
    }

    if (attribute === 'href' && href === null) href = decodeEntities(value);
  }
};

/** The Markdown a finished element contributes to its parent. */
const renderFrame = (frame: Frame): string => {
  const body = frame.out.join('');

  const mark = INLINE_MARKS.get(frame.tag);
  if (mark !== undefined) return `${mark}${body}${mark}`;

  if (frame.tag === 'a') return frame.href === null ? body : `[${body}](${frame.href})`;

  if (frame.tag === 'blockquote') {
    return `\n${body
      .trim()
      .split(/\n+/u)
      .map((line) => `> ${line.trim()}`)
      .join('\n')}\n`;
  }

  // h1…h6.
  const level = Number.parseInt(frame.tag.slice(1), 10);
  return `\n${'#'.repeat(level)} ${body.trim()}\n`;
};

/**
 * Strip trailing spaces and tabs from one line.
 *
 * Written by hand, and not as `line.replace(/[ \t]+$/u, '')`, because that regular expression is
 * quadratic in a line holding an interior run of whitespace: `[ \t]+` is anchored only at the end,
 * so the engine starts at each position of the run, consumes to the end of it, fails `$` and
 * backtracks through every length. Measured on the shipped build, one line carrying 50 000
 * interior spaces cost 9.1 s and 100 000 cost 17.8 s — from `<p>a<spaces>b</p>`, which is a note
 * body a stranger can post. Walking back from the end reads each character once.
 */
const trimLineEnd = (line: string): string => {
  let end = line.length;
  while (end > 0) {
    const character = line[end - 1];
    if (character !== ' ' && character !== '\t') break;
    end -= 1;
  }
  return end === line.length ? line : line.slice(0, end);
};

/** Convert a fragment of HTML to Markdown. See the module note on what this deliberately is not. */
export const htmlToMarkdown = (html: string): string => {
  const root: string[] = [];
  const stack: Frame[] = [];
  /** How many frames are open per tag name, so an orphan closing tag costs one lookup. */
  const openCounts = new Map<string, number>();

  const top = (): string[] => (stack.length === 0 ? root : (stack[stack.length - 1] as Frame).out);
  const emit = (text: string): void => {
    if (text !== '') top().push(text);
  };

  const push = (tag: string, href: string | null): void => {
    stack.push({ tag, href, out: [] });
    openCounts.set(tag, (openCounts.get(tag) ?? 0) + 1);
  };

  /** Pop one frame and fold it into its parent, rendered or — when unclosed — raw. */
  const pop = (rendered: boolean): void => {
    const frame = stack.pop() as Frame;
    openCounts.set(frame.tag, (openCounts.get(frame.tag) ?? 1) - 1);
    const text = rendered ? renderFrame(frame) : frame.out.join('');
    if (text !== '') top().push(text);
  };

  /**
   * Close the nearest open frame with this name, if there is one.
   *
   * The counter makes the "there is none" answer constant-time, which is what stops a note full of
   * `</i>` with no `<i>` from turning the stack search into a second quadratic. Frames skipped on
   * the way down are folded in raw, exactly as the old backreferenced patterns left a mis-nested
   * `<strong>x</b>` un-marked, and each of them is popped once across the whole conversion.
   */
  const closeFrame = (name: string): boolean => {
    if ((openCounts.get(name) ?? 0) === 0) return false;
    for (;;) {
      const frame = stack[stack.length - 1] as Frame;
      const matched = frame.tag === name;
      pop(matched);
      if (matched) return true;
    }
  };

  let index = 0;
  while (index < html.length) {
    const lt = html.indexOf('<', index);
    if (lt === -1) {
      emit(decodeEntities(html.slice(index)));
      break;
    }
    if (lt > index) emit(decodeEntities(html.slice(index, lt)));

    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);
      index = close === -1 ? html.length : close + 3;
      continue;
    }

    const tag = readTag(html, lt);
    if (tag === null) {
      emit('<');
      index = lt + 1;
      continue;
    }
    index = tag.end;

    if (tag.closing) {
      if (COLLECTING.has(tag.name) && closeFrame(tag.name)) continue;
      // No opener claimed it. A block's closing tag still ends the line; anything else is dropped,
      // which is what stripping the tag used to do.
      if (BLOCK_CLOSERS.has(tag.name)) emit('\n');
      continue;
    }

    if (DROPPED.has(tag.name)) {
      // Skip the element's content outright. An unclosed `<script>` runs to the end of the note
      // rather than spilling its body into the reader's text.
      const close = html.toLowerCase().indexOf(`</${tag.name}`, index);
      if (close === -1) {
        index = html.length;
      } else {
        const closeTag = readTag(html, close);
        index = closeTag === null ? close + 2 : closeTag.end;
      }
      continue;
    }

    if (tag.name === 'br') {
      emit('\n');
      continue;
    }
    if (tag.name === 'li') {
      emit('\n- ');
      continue;
    }
    if (COLLECTING.has(tag.name)) {
      push(tag.name, tag.href);
      continue;
    }
    // Every other opening tag is dropped, leaving its content as text.
  }

  // Whatever the note left open is folded in as plain text, never as a half-written marker.
  while (stack.length > 0) pop(false);

  return root
    .join('')
    .split('\n')
    .map(trimLineEnd)
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
