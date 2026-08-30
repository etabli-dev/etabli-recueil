/**
 * The Recueil search query language, and its translation to FTS5.
 *
 * ADR-0011 puts FTS5 underneath and Meilisearch beside it, "behind one search interface so the
 * backend is swappable", and it says in as many words: *the interface must not expose
 * backend-specific query syntax*. So user input is never handed to FTS5. It is tokenised here,
 * parsed into a small tree, and rendered back out as a `MATCH` expression that is well-formed by
 * construction. A Meilisearch backend renders the same tree into its own filter language, and a
 * saved search stored under `collections.query` keeps meaning when the backend changes.
 *
 * ## The syntax
 *
 * | Form | Meaning |
 * |---|---|
 * | `machine learning` | both words, anywhere (terms are ANDed) |
 * | `"machine learning"` | the exact phrase |
 * | `learn*` | prefix: `learn`, `learning`, `learned` |
 * | `-draft` | excludes documents containing `draft` |
 * | `sepsis OR septicaemia` | either |
 * | `(sepsis OR septicaemia) mortality` | grouping |
 * | `title:sepsis` | restricted to one field |
 * | `creator:"van Dijk"` | a phrase, restricted to one field |
 *
 * Field names are Recueil's, not the index's: `title`, `creator`, `container`, `id`, `tag`, `note`,
 * `text`. An unknown field name is a `ValidationError` rather than a silent search for the literal
 * string `foo:bar`, because a query that quietly means something else is worse than one that fails.
 *
 * Everything else — the characters FTS5 treats as operators, unbalanced quotes, a stray `^` — is
 * data. Terms are emitted as FTS5 string literals with `"` doubled, which is FTS5's own escape and
 * the reason no input can break out of a term.
 *
 * ## What is deliberately absent
 *
 * `NEAR`, column weighting and ranking hints. They are FTS5 features with no Meilisearch
 * counterpart, and exposing them would make the query language the index's rather than Recueil's.
 * Facet filtering — item type, year, collection, tag — is done with SQL predicates alongside the
 * `MATCH`, not inside the query string (`spec/data-model.md` §9).
 */
import { ResourceBudgetError, ValidationError } from '../errors.js';

/** The fields a query may name, and the FTS5 column each maps to. */
export const SEARCH_FIELDS = {
  title: 'title',
  creator: 'creators',
  container: 'container',
  id: 'identifiers',
  tag: 'tags',
  note: 'body',
  text: 'text',
} as const;

export type SearchField = keyof typeof SEARCH_FIELDS;

export const SEARCH_FIELD_NAMES = Object.keys(SEARCH_FIELDS) as SearchField[];

/** One word or phrase, optionally restricted to a field and optionally a prefix match. */
export interface TermNode {
  kind: 'term';
  /** The words of the term. More than one means a phrase. */
  words: string[];
  field: SearchField | null;
  prefix: boolean;
}

export interface NotNode {
  kind: 'not';
  operand: QueryNode;
}

export interface BooleanNode {
  kind: 'and' | 'or';
  operands: QueryNode[];
}

export type QueryNode = TermNode | NotNode | BooleanNode;

/* -------------------------------------------------------------------------------------------- */
/* Tokenising                                                                                      */
/* -------------------------------------------------------------------------------------------- */

interface Token {
  type: 'word' | 'phrase' | 'or' | 'not' | 'lparen' | 'rparen';
  value: string;
  field: SearchField | null;
  prefix: boolean;
}

const FIELD_PREFIX = /^([a-z]+):/u;

/**
 * Split the input into tokens.
 *
 * Written by hand rather than with a regular expression because a field prefix may be followed by
 * either a bare word or a quoted phrase, and because an unterminated quote has to run to the end of
 * the input rather than throwing: a user typing into a search box is unterminated most of the time.
 */
const tokenise = (input: string): Token[] => {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const character = input[index] as string;

    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }

    if (character === '(') {
      tokens.push({ type: 'lparen', value: '(', field: null, prefix: false });
      index += 1;
      continue;
    }
    if (character === ')') {
      tokens.push({ type: 'rparen', value: ')', field: null, prefix: false });
      index += 1;
      continue;
    }

    // A leading `-` on a term is exclusion; a `-` inside a word is part of the word.
    if (character === '-' && index + 1 < input.length && !/[\s)]/u.test(input[index + 1] as string)) {
      tokens.push({ type: 'not', value: '-', field: null, prefix: false });
      index += 1;
      continue;
    }

    // A field prefix binds to whatever term follows it.
    let field: SearchField | null = null;
    const rest = input.slice(index);
    const fieldMatch = FIELD_PREFIX.exec(rest);
    if (fieldMatch !== null) {
      const name = fieldMatch[1] as string;
      if (!Object.prototype.hasOwnProperty.call(SEARCH_FIELDS, name)) {
        throw new ValidationError(
          `Unknown search field '${name}'. Known fields: ${SEARCH_FIELD_NAMES.join(', ')}.`,
          { field: name, known: SEARCH_FIELD_NAMES },
        );
      }
      field = name as SearchField;
      index += fieldMatch[0].length;
      if (index >= input.length) break;
    }

    if (input[index] === '"') {
      const close = input.indexOf('"', index + 1);
      const end = close === -1 ? input.length : close;
      tokens.push({
        type: 'phrase',
        value: input.slice(index + 1, end),
        field,
        prefix: false,
      });
      index = close === -1 ? input.length : close + 1;
      continue;
    }

    let end = index;
    while (end < input.length && !/[\s()"]/u.test(input[end] as string)) end += 1;
    let word = input.slice(index, end);
    index = end;

    const prefix = word.endsWith('*');
    if (prefix) word = word.slice(0, -1);

    if (field === null && (word === 'OR' || word === 'or')) {
      tokens.push({ type: 'or', value: 'OR', field: null, prefix: false });
      continue;
    }
    if (field === null && (word === 'NOT' || word === 'not')) {
      tokens.push({ type: 'not', value: 'NOT', field: null, prefix: false });
      continue;
    }
    if (field === null && (word === 'AND' || word === 'and')) {
      // Implicit already; accepting the word is politeness, not a feature.
      continue;
    }

    if (word === '') continue;
    tokens.push({ type: 'word', value: word, field, prefix });
  }

  return tokens;
};

/* -------------------------------------------------------------------------------------------- */
/* Parsing                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/**
 * The longest query this compiler will read (ADR-0022 §2).
 *
 * The tokeniser is linear in the input, but `parseOr`/`parseAnd`/`parsePrimary` recurse once per
 * open bracket, so a query that is nothing but `(` overflows the stack — a `RangeError` out of a
 * search box rather than a refusal naming a limit. The bound is here rather than in the route
 * because a saved search, the CLI and `LibraryService.listItems({ text })` all reach this function
 * without passing through the server's own 2 048-character schema, and ADR-0022 puts the budget on
 * the call. Generous next to any query a person types: it is half a page of prose.
 */
export const MAX_QUERY_LENGTH = 4_096;

/**
 * How deeply a query may nest before it is refused (ADR-0022 §2, §5).
 *
 * `parsePrimary` recurses once per `(` and `parseUnary` once per leading `-`, so nesting is
 * recursion and recursion is the JavaScript stack. Measured against the shipped build, 5 000 open
 * brackets threw `RangeError: Maximum call stack size exceeded` out of `parseSearchQuery` — not a
 * refusal a caller can render, and not a limit anybody named. The length bound above is not enough
 * on its own: it leaves 4 096 possible frames, which is the same order as the overflow. This one
 * bounds the recursion itself, and sixty-four is far past any query a person writes.
 */
export const MAX_QUERY_DEPTH = 64;

/**
 * Parse a query into a tree. `null` for an empty query — the caller decides whether that means
 * "everything" or "nothing"; here it just means the user typed no terms.
 */
export const parseSearchQuery = (input: string): QueryNode | null => {
  if (input.length > MAX_QUERY_LENGTH) {
    throw new ResourceBudgetError(
      `That query is ${input.length} characters; the most this index will read is ` +
        `${MAX_QUERY_LENGTH}. Search for fewer words at a time.`,
      'MAX_QUERY_LENGTH',
      { length: input.length, limit: MAX_QUERY_LENGTH },
    );
  }

  const tokens = tokenise(input);
  let position = 0;
  let depth = 0;

  const peek = (): Token | undefined => tokens[position];

  /** Charged at each recursion, so the stack is bounded by a number rather than by the platform. */
  const descend = (): void => {
    depth += 1;
    if (depth > MAX_QUERY_DEPTH) {
      throw new ResourceBudgetError(
        `That query nests more than ${MAX_QUERY_DEPTH} levels deep. Use fewer brackets.`,
        'MAX_QUERY_DEPTH',
        { limit: MAX_QUERY_DEPTH },
      );
    }
  };

  /** `a OR b OR c` — the loosest binding. */
  const parseOr = (): QueryNode | null => {
    const operands: QueryNode[] = [];
    for (;;) {
      const operand = parseAnd();
      if (operand !== null) operands.push(operand);
      if (peek()?.type === 'or') {
        position += 1;
        continue;
      }
      break;
    }
    if (operands.length === 0) return null;
    if (operands.length === 1) return operands[0] as QueryNode;
    return { kind: 'or', operands };
  };

  /** Juxtaposition is AND. */
  const parseAnd = (): QueryNode | null => {
    const operands: QueryNode[] = [];
    for (;;) {
      const next = peek();
      if (next === undefined || next.type === 'or' || next.type === 'rparen') break;
      const operand = parseUnary();
      if (operand !== null) operands.push(operand);
    }
    if (operands.length === 0) return null;
    if (operands.length === 1) return operands[0] as QueryNode;
    return { kind: 'and', operands };
  };

  const parseUnary = (): QueryNode | null => {
    const next = peek();
    if (next === undefined) return null;
    if (next.type === 'not') {
      position += 1;
      descend();
      const operand = parseUnary();
      depth -= 1;
      if (operand === null) return null;
      return { kind: 'not', operand };
    }
    return parsePrimary();
  };

  const parsePrimary = (): QueryNode | null => {
    const next = peek();
    if (next === undefined) return null;

    if (next.type === 'lparen') {
      position += 1;
      descend();
      const inner = parseOr();
      depth -= 1;
      if (peek()?.type === 'rparen') position += 1;
      return inner;
    }
    if (next.type === 'rparen') {
      // An unbalanced closing bracket is data the user is still typing, not an error.
      position += 1;
      return null;
    }

    position += 1;
    const words =
      next.type === 'phrase'
        ? next.value.split(/\s+/u).filter((word) => word !== '')
        : [next.value];
    if (words.length === 0) return null;
    return { kind: 'term', words, field: next.field, prefix: next.prefix };
  };

  const tree = parseOr();
  return tree;
};

/* -------------------------------------------------------------------------------------------- */
/* Rendering to FTS5                                                                               */
/* -------------------------------------------------------------------------------------------- */

/** An FTS5 string literal. Doubling `"` is FTS5's own escape, and it is the only one needed. */
const literal = (word: string): string => `"${word.replaceAll('"', '""')}"`;

const renderTerm = (node: TermNode): string => {
  const phrase = node.words.map(literal).join(' ');
  const body = node.prefix ? `${phrase}*` : phrase;
  if (node.field === null) return `(${body})`;
  return `{${SEARCH_FIELDS[node.field]}} : (${body})`;
};

/**
 * Render a tree as an FTS5 `MATCH` expression.
 *
 * `NOT` is rendered as FTS5's binary `AND … NOT …`, because FTS5 has no unary negation: a query
 * that is nothing but exclusions has no positive side to subtract from, and the caller is told so
 * rather than being handed a syntax error from SQLite.
 */
export const renderFts5 = (node: QueryNode): string => {
  switch (node.kind) {
    case 'term':
      return renderTerm(node);
    case 'not':
      throw new ValidationError(
        'A search cannot consist only of exclusions. Give at least one term to exclude from.',
      );
    case 'or':
      return `(${node.operands.map((operand) => renderFts5(operand)).join(' OR ')})`;
    case 'and': {
      const positives = node.operands.filter((operand) => operand.kind !== 'not');
      const negatives = node.operands.filter(
        (operand): operand is NotNode => operand.kind === 'not',
      );
      if (positives.length === 0) {
        throw new ValidationError(
          'A search cannot consist only of exclusions. Give at least one term to exclude from.',
        );
      }
      const head = `(${positives.map((operand) => renderFts5(operand)).join(' AND ')})`;
      if (negatives.length === 0) return head;
      const tail = negatives.map((operand) => renderFts5(operand.operand)).join(' AND ');
      return `(${head} NOT (${tail}))`;
    }
  }
};

/** Parse and render in one step. `null` when the query has no terms at all. */
export const compileSearchQuery = (input: string): string | null => {
  const tree = parseSearchQuery(input);
  if (tree === null) return null;
  return renderFts5(tree);
};
