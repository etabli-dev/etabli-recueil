/**
 * The 64-bit simhash of a document's extracted text.
 *
 * `documents.simhash` is the near-duplicate blocking key of CONCEPT §5.6, and the dedup engine of
 * Phase 3 is what will use it. The pipeline computes it because this is the only moment the text is
 * in memory anyway; leaving the column null would mean a second full pass over the library later.
 *
 * Charikar's construction, over shingles rather than words: three-word windows, so that a re-scan
 * with a handful of OCR errors still lands close to the original, while two unrelated papers that
 * share a vocabulary do not. The digest is sixteen lowercase hex characters, which is what the
 * column expects.
 */
import { createHash } from 'node:crypto';

import { DEFAULT_SIMHASH_MAX_CHARS } from '../budgets.js';

const SHINGLE = 3;
const BITS = 64;

/**
 * Sixteen hex characters, or null when there is not enough text to say anything.
 *
 * `maxChars` bounds the work (ADR-0022 §5: nothing unbounded runs synchronously). Text past it is
 * not read: see `DEFAULT_SIMHASH_MAX_CHARS` for why a prefix is the right answer here and a refusal
 * is not.
 */
export const simhash = (text: string, maxChars: number = DEFAULT_SIMHASH_MAX_CHARS): string | null => {
  const tokens = tokenise(text.length > maxChars ? text.slice(0, maxChars) : text);
  if (tokens.length === 0) return null;

  const shingles = new Map<string, number>();
  const windows = Math.max(1, tokens.length - SHINGLE + 1);
  for (let index = 0; index < windows; index += 1) {
    const shingle = tokens.slice(index, index + SHINGLE).join(' ');
    shingles.set(shingle, (shingles.get(shingle) ?? 0) + 1);
  }

  const weights = new Array<number>(BITS).fill(0);
  for (const [shingle, count] of shingles) {
    const digest = createHash('sha1').update(shingle).digest();
    for (let bit = 0; bit < BITS; bit += 1) {
      const byte = digest[bit >> 3] as number;
      const set = (byte >> (7 - (bit & 7))) & 1;
      weights[bit] = (weights[bit] as number) + (set === 1 ? count : -count);
    }
  }

  let out = '';
  for (let nibble = 0; nibble < BITS / 4; nibble += 1) {
    let value = 0;
    for (let bit = 0; bit < 4; bit += 1) {
      value = (value << 1) | ((weights[nibble * 4 + bit] as number) > 0 ? 1 : 0);
    }
    out += value.toString(16);
  }
  return out;
};

/** The Hamming distance between two simhashes. Null when either is absent or malformed. */
export const simhashDistance = (a: string | null, b: string | null): number | null => {
  if (a === null || b === null || a.length !== 16 || b.length !== 16) return null;
  let distance = 0;
  for (let index = 0; index < 16; index += 1) {
    const left = Number.parseInt(a[index] as string, 16);
    const right = Number.parseInt(b[index] as string, 16);
    if (Number.isNaN(left) || Number.isNaN(right)) return null;
    let xor = left ^ right;
    while (xor !== 0) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
};

const tokenise = (text: string): string[] =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 1);
