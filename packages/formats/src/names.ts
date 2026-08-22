/**
 * Personal names, in and out of the three name grammars.
 *
 * BibTeX's is the demanding one. `von Last, Jr, First` is a real grammar with brace-aware
 * tokenisation and a case rule for the particle, and getting it wrong is how "Ludwig van Beethoven"
 * becomes an author called Ludwig with the surname "van Beethoven" in one library and "Beethoven"
 * in the next. RIS and CSL are simpler, but they disagree with each other about particles, so the
 * conversions live together rather than being inlined into three exporters.
 *
 * A corporate author is braced on the way out and recognised on the way in: `{World Health
 * Organization}` is one name, not a Mr Organization with two forenames.
 */
import { collapseWhitespace, escapeLatex, unescapeLatex } from './text/latex.js';
import type { EscapeOptions } from './text/latex.js';
import { isOrganisation, trimmed } from './record.js';
import type { FormatCreator } from './record.js';

/** The parts of a name, independent of any format's spelling of them. */
export interface NameParts {
  readonly familyName?: string | undefined;
  readonly givenName?: string | undefined;
  readonly namePrefix?: string | undefined;
  readonly nameSuffix?: string | undefined;
  readonly literalName?: string | undefined;
  readonly kind: 'person' | 'organisation';
}

/* -------------------------------------------------------------------------------------------- */
/* Brace-aware tokenisation                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** Split on a separator that appears at brace depth zero. */
const splitAtDepthZero = (value: string, separator: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && value.startsWith(separator, index)) {
      parts.push(value.slice(start, index));
      index += separator.length - 1;
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
};

/** Split a name list on the ` and ` that BibTeX uses, ignoring any inside braces. */
export const splitBibtexNameList = (value: string): string[] =>
  splitAtDepthZero(value, ' and ')
    .map((name) => collapseWhitespace(name))
    .filter((name) => name.length > 0);

const tokenise = (value: string): string[] => {
  const tokens: string[] = [];
  let depth = 0;
  let current = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string;
    if (character === '\\') {
      current += character + (value[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') depth = Math.max(0, depth - 1);
    if (depth === 0 && /\s/u.test(character)) {
      if (current.length > 0) tokens.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
};

/**
 * Is this token a particle?
 *
 * BibTeX's rule is the case of the first letter *at brace level zero*: `van` is a particle,
 * `{Van}` is not, and `Van` is not. The brace is how an author who spells it "Van Dijk" says so.
 */
const isParticleToken = (token: string): boolean => {
  for (const character of token) {
    if (character === '{' || character === '}' || character === '\\') return false;
    if (/\p{L}/u.test(character)) {
      return character === character.toLowerCase() && character !== character.toUpperCase();
    }
  }
  return false;
};

const stripOuterBraces = (value: string): string => {
  const text = value.trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return text;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0 && index !== text.length - 1) return text;
    }
  }
  return text.slice(1, -1);
};

const isFullyBraced = (value: string): boolean => {
  const text = value.trim();
  return text.startsWith('{') && text.endsWith('}') && stripOuterBraces(text) !== text;
};

const decode = (value: string): string | undefined => trimmed(collapseWhitespace(unescapeLatex(value)));

/** Parse one BibTeX name into its parts. */
export const parseBibtexName = (value: string): NameParts => {
  const raw = collapseWhitespace(value);

  if (isFullyBraced(raw)) {
    return { literalName: decode(stripOuterBraces(raw)), kind: 'organisation' };
  }

  const commaParts = splitAtDepthZero(raw, ',').map((part) => part.trim());

  if (commaParts.length >= 2) {
    const vonLast = tokenise(commaParts[0] as string);
    const suffix = commaParts.length >= 3 ? (commaParts[1] as string) : undefined;
    const given = commaParts.length >= 3 ? (commaParts[2] as string) : (commaParts[1] as string);
    const { particle, family } = splitVonLast(vonLast);
    return {
      familyName: decode(family),
      givenName: given === undefined ? undefined : decode(given),
      namePrefix: particle === undefined ? undefined : decode(particle),
      nameSuffix: suffix === undefined ? undefined : decode(suffix),
      kind: 'person',
    };
  }

  /* `First von Last`. Everything up to the first particle is the forename; if there is no
     particle, the last token is the family name and the rest is the forename. */
  const tokens = tokenise(raw);
  if (tokens.length === 0) return { kind: 'person' };
  if (tokens.length === 1) return { familyName: decode(tokens[0] as string), kind: 'person' };

  let particleStart = -1;
  for (let index = 1; index < tokens.length - 1; index += 1) {
    if (isParticleToken(tokens[index] as string)) {
      particleStart = index;
      break;
    }
  }

  if (particleStart === -1) {
    return {
      givenName: decode(tokens.slice(0, -1).join(' ')),
      familyName: decode(tokens[tokens.length - 1] as string),
      kind: 'person',
    };
  }

  let particleEnd = particleStart;
  while (particleEnd + 1 < tokens.length - 1 && isParticleToken(tokens[particleEnd + 1] as string)) {
    particleEnd += 1;
  }

  return {
    givenName: decode(tokens.slice(0, particleStart).join(' ')),
    namePrefix: decode(tokens.slice(particleStart, particleEnd + 1).join(' ')),
    familyName: decode(tokens.slice(particleEnd + 1).join(' ')),
    kind: 'person',
  };
};

const splitVonLast = (tokens: readonly string[]): { particle?: string; family: string } => {
  let index = 0;
  while (index < tokens.length - 1 && isParticleToken(tokens[index] as string)) index += 1;
  if (index === 0) return { family: tokens.join(' ') };
  return { particle: tokens.slice(0, index).join(' '), family: tokens.slice(index).join(' ') };
};

/** Render one creator as a BibTeX name. Corporate names are braced so the grammar leaves them be. */
export const formatBibtexName = (creator: FormatCreator, options: EscapeOptions): string => {
  const escape = (value: string): string => escapeLatex(value, options);

  if (isOrganisation(creator)) {
    const literal = trimmed(creator.literalName) ?? trimmed(creator.familyName) ?? '';
    return `{${escape(literal)}}`;
  }

  const prefix = trimmed(creator.namePrefix);
  const family = trimmed(creator.familyName) ?? trimmed(creator.literalName) ?? '';
  const given = trimmed(creator.givenName);
  const suffix = trimmed(creator.nameSuffix);

  const vonLast = escape(prefix === undefined ? family : `${prefix} ${family}`);
  if (suffix !== undefined) return `${vonLast}, ${escape(suffix)}, ${given === undefined ? '' : escape(given)}`;
  if (given === undefined) return vonLast;
  return `${vonLast}, ${escape(given)}`;
};

/** Render a creator for RIS, which wants `Family, Given, Suffix` and has no particle field. */
export const formatRisName = (creator: FormatCreator): string => {
  /* A trailing comma is RIS's own way of saying "this whole string is the name": it is what Zotero,
     EndNote and Reference Manager all write for a corporate author, and it is the only signal the
     format has. */
  if (isOrganisation(creator)) return `${trimmed(creator.literalName) ?? trimmed(creator.familyName) ?? ''},`;
  const prefix = trimmed(creator.namePrefix);
  const family = trimmed(creator.familyName) ?? trimmed(creator.literalName) ?? '';
  const full = prefix === undefined ? family : `${prefix} ${family}`;
  const given = trimmed(creator.givenName);
  const suffix = trimmed(creator.nameSuffix);
  const parts = [full];
  if (given !== undefined) parts.push(given);
  if (suffix !== undefined) parts.push(suffix);
  return parts.join(', ');
};

/**
 * Parse a RIS name.
 *
 * A trailing comma marks a corporate body — `World Health Organization,` — which is the convention
 * every RIS writer uses and the only one the format offers. A value with no comma at all is read as
 * a family name, because that is what it is far more often, and because the alternative silently
 * turns half the world's single-word surnames into organisations.
 */
export const parseRisName = (value: string): NameParts => {
  const whole = value.trim();
  if (whole.endsWith(',')) {
    const literal = whole.slice(0, -1).trim();
    return literal.length === 0 ? { kind: 'person' } : { literalName: literal, kind: 'organisation' };
  }
  const parts = whole.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) return { kind: 'person' };
  if (parts.length === 1) return { familyName: parts[0], kind: 'person' };
  return {
    familyName: parts[0],
    givenName: parts[1],
    nameSuffix: parts[2],
    kind: 'person',
  };
};

/** A CSL-JSON name object. `literal` and the structured fields are mutually exclusive in practice. */
export interface CslName {
  family?: string;
  given?: string;
  'non-dropping-particle'?: string;
  suffix?: string;
  literal?: string;
}

export const formatCslName = (creator: FormatCreator): CslName => {
  if (isOrganisation(creator)) {
    return { literal: trimmed(creator.literalName) ?? trimmed(creator.familyName) ?? '' };
  }
  const name: CslName = {};
  const family = trimmed(creator.familyName) ?? trimmed(creator.literalName);
  if (family !== undefined) name.family = family;
  const given = trimmed(creator.givenName);
  if (given !== undefined) name.given = given;
  const prefix = trimmed(creator.namePrefix);
  if (prefix !== undefined) name['non-dropping-particle'] = prefix;
  const suffix = trimmed(creator.nameSuffix);
  if (suffix !== undefined) name.suffix = suffix;
  return name;
};

export const parseCslName = (name: CslName): NameParts => {
  const literal = trimmed(name.literal);
  if (literal !== undefined) return { literalName: literal, kind: 'organisation' };
  return {
    familyName: trimmed(name.family),
    givenName: trimmed(name.given),
    namePrefix: trimmed(name['non-dropping-particle']),
    nameSuffix: trimmed(name.suffix),
    kind: 'person',
  };
};

/** Turn parsed name parts into a creator with a role. The one place importers build creators. */
export const creatorFromNameParts = (
  parts: NameParts,
  role: FormatCreator['role'],
): FormatCreator | undefined => {
  if (parts.familyName === undefined && parts.literalName === undefined) return undefined;
  return {
    role,
    kind: parts.kind,
    familyName: parts.familyName,
    givenName: parts.givenName,
    namePrefix: parts.namePrefix,
    nameSuffix: parts.nameSuffix,
    literalName: parts.literalName,
  };
};
