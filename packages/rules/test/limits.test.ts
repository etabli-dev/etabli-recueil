import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { applyMatcher } from '../src/match.js';
import { globToPattern } from '../src/glob.js';
import { prepareInput } from '../src/regex/input.js';
import { DEFAULT_LIMITS, MAX_CONDITION_DEPTH } from '../src/engine.js';
import { evaluateDedup, evaluateIngestion } from '../src/evaluate.js';
import { nameOverlap, similarity } from '../src/dedup/similarity.js';
import { MAX_DOCUMENT_DEPTH, MAX_RULE_SET_CHARS, loadRuleSet, parseRuleSet } from '../src/parse.js';
import { MAX_INTERPOLATED, interpolate } from '../src/interpolate.js';
import { MAX_PROGRAM } from '../src/regex/compile.js';
import {
  DEFAULT_MAX_INPUT_LENGTH,
  DEFAULT_MAX_STEPS,
  DEFAULT_TIMEOUT_MS,
  MAX_COMPILE_STEPS,
  MAX_DEPTH,
  MAX_PATTERN_LENGTH,
  MAX_REPEAT,
  RegexBudgetError,
  RegexInputTooLongError,
  RegexSyntaxError,
  RegexTimeoutError,
  SafeRegex,
  isRegexLimitError,
  safeMatch,
  safeTest,
} from '../src/regex/index.js';

/**
 * The limits, and the evidence that each one bounds the thing it claims to bound.
 *
 * Every case here was a measured defect before it was a test. The numbers in the comments are what
 * the code did on the machine the hardening round ran on, and the assertions are written with a
 * wide enough margin that a slower machine still separates "bounded" from "not bounded" — the
 * failing numbers are one to four orders of magnitude away from the passing ones, not a few
 * per cent.
 */

const elapsed = (fn: () => void): number => {
  const started = process.hrtime.bigint();
  try {
    fn();
  } catch {
    /* the refusal is the point; the time it took is what is asserted */
  }
  return Number(process.hrtime.bigint() - started) / 1e6;
};

describe('maxInputLength bounds the haystack before anything is allocated', () => {
  it('refuses an over-long input by name, and says which limit it hit', () => {
    const compiled = SafeRegex.compile('Rechnung', { flags: 'i' });
    let thrown: unknown;
    try {
      compiled.test('x'.repeat(4 * 1024 * 1024));
      expect.unreachable('should have refused');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RegexInputTooLongError);
    const refusal = thrown as RegexInputTooLongError;
    expect(refusal.maxInputLength).toBe(DEFAULT_MAX_INPUT_LENGTH);
    expect(refusal.length).toBe(4 * 1024 * 1024);
    expect(refusal.message).toContain('maxInputLength');
    expect(refusal.message).toContain(String(DEFAULT_MAX_INPUT_LENGTH));
  });

  it('refuses in constant time, so the refusal costs nothing proportional to the input', () => {
    const compiled = SafeRegex.compile('Rechnung', { flags: 'i' });
    // Before the fix this call built a boxed code-point array first: 3.9 s and +407 MB of resident
    // memory at 64 MB. The check is now against `String.prototype.length`, so it is free.
    const small = elapsed(() => compiled.test('x'.repeat(1024 * 1024)));
    const huge = elapsed(() => compiled.test('x'.repeat(64 * 1024 * 1024)));
    expect(huge).toBeLessThan(50);
    expect(small).toBeLessThan(50);
  });

  it('accepts an input at exactly the limit', () => {
    const compiled = SafeRegex.compile('needle', { maxInputLength: 4096, timeoutMs: 10_000 });
    const exact = `${'x'.repeat(4090)}needle`;
    expect(exact.length).toBe(4096);
    expect(compiled.test(exact)).toBe(true);
    expect(() => compiled.test('x'.repeat(4097))).toThrowError(RegexInputTooLongError);
  });

  it('is one of the runtime refusals, not a syntax error', () => {
    const error = new RegexInputTooLongError('a', 10, 5);
    expect(isRegexLimitError(error)).toBe(true);
    expect(isRegexLimitError(new RegexSyntaxError('nope', 'a', 0))).toBe(false);
  });
});

describe('the wall clock covers the whole call, allocation included', () => {
  it('fires on a large input without first paying for a copy of it', () => {
    // The defect: `Array.from(input, …)` ran before the step loop, so a 16 MB input cost 848 ms in
    // allocation alone under a 1 ms allowance. The clock now starts in `exec` and the input reader
    // consults it per chunk, so the whole call is bounded by the deadline plus one chunk.
    const compiled = SafeRegex.compile('(?:[a-z]|[0-9])*!', {
      timeoutMs: 1,
      maxSteps: 1_000_000_000,
      maxInputLength: 32 * 1024 * 1024,
    });
    const input = 'a1b2c3'.repeat(16 * 1024 * 1024 / 6);
    let thrown: unknown;
    const took = elapsed(() => {
      try {
        compiled.test(input);
      } catch (error) {
        thrown = error;
        throw error;
      }
    });
    expect(thrown).toBeInstanceOf(RegexTimeoutError);
    expect(took).toBeLessThan(400);
  }, 30_000);

  it('fires while indexing a string that carries astral characters', () => {
    // The other input path: a string with a surrogate in it does need an index, and that build is
    // chunked against the same deadline rather than run to completion first.
    const compiled = SafeRegex.compile('zzz', {
      timeoutMs: 1,
      maxSteps: 1_000_000_000,
      maxInputLength: 32 * 1024 * 1024,
    });
    const input = '𝄞abcd'.repeat(2 * 1024 * 1024);
    let thrown: unknown;
    const took = elapsed(() => {
      try {
        compiled.test(input);
      } catch (error) {
        thrown = error;
        throw error;
      }
    });
    expect(thrown).toBeInstanceOf(RegexTimeoutError);
    expect(took).toBeLessThan(400);
  }, 30_000);
});

describe('the input reader is inside the clock, not before it', () => {
  const options = (deadline: number) => ({ deadline, timeoutMs: 1, pattern: 'x' });

  it('abandons the surrogate scan when the deadline has passed', () => {
    // The scan is the only work a plain string costs, and it is chunked so that a caller which has
    // already spent its allowance elsewhere does not pay for a whole pass regardless.
    expect(() => prepareInput('a'.repeat(4 * 1024 * 1024), options(Date.now() - 1))).toThrowError(RegexTimeoutError);
  });

  it('abandons the code-point index of an astral string when the deadline has passed', () => {
    expect(() => prepareInput('𝄞abc'.repeat(1024 * 1024), options(Date.now() - 1))).toThrowError(RegexTimeoutError);
  });

  it('agrees with the string iterator on every case the indexed path handles', () => {
    // The zero-copy path and the indexed path have to answer identically, and only strings with a
    // surrogate in them take the second. `[...text]` is the reference for what a code point is.
    for (const text of ['plain', 'Ä Ö ü', 'a𝄞b', '𝄞𝄞𝄞', 'a\ud800b', 'a\udfffb', '𝄞', 'x\ud83d\ude00y']) {
      const prepared = prepareInput(text, { deadline: undefined, timeoutMs: undefined, pattern: 'x' });
      const points = [...text];
      expect(prepared.length).toBe(points.length);
      for (let index = 0; index < points.length; index += 1) {
        expect(prepared.at(index)).toBe(points[index]!.codePointAt(0));
      }
      expect(prepared.at(-1)).toBeUndefined();
      expect(prepared.at(points.length)).toBeUndefined();
      expect(prepared.slice(0, points.length)).toBe(text);
      expect(prepared.slice(1, points.length)).toBe(points.slice(1).join(''));
    }
  });

  it('matches across an astral character the same way either path does', () => {
    expect(SafeRegex.compile('(?<g>.)b').exec('a𝄞b')?.groups).toEqual({ g: '𝄞' });
    expect(SafeRegex.compile('b').exec('𝄞b')?.start).toBe(1);
    expect(SafeRegex.compile('^𝄞+$').test('𝄞𝄞𝄞')).toBe(true);
    expect(SafeRegex.compile('a.c', { flags: 's' }).exec('a𝄞c')?.text).toBe('a𝄞c');
  });

  it('reads an ordinary string with no deadline at all', () => {
    const plain = prepareInput('Rechnung', { deadline: undefined, timeoutMs: undefined, pattern: 'x' });
    expect(plain.length).toBe(8);
    expect(plain.slice(0, 3)).toBe('Rec');
    const astral = prepareInput('a𝄞b', { deadline: undefined, timeoutMs: undefined, pattern: 'x' });
    expect(astral.length).toBe(3);
    expect(astral.at(1)).toBe(0x1d11e);
    expect(astral.slice(1, 3)).toBe('𝄞b');
    // A lone surrogate is one code point of its own, as the string iterator treats it.
    const lone = prepareInput('a\ud800b', { deadline: undefined, timeoutMs: undefined, pattern: 'x' });
    expect(lone.length).toBe(3);
    expect(lone.at(1)).toBe(0xd800);
  });
});

describe('a hostile pattern is refused at compile time, not at match time', () => {
  it('refuses a counted repetition of an empty body', () => {
    // Thirty characters, a three-instruction program, and 15.8 seconds to compile: the empty body
    // emitted nothing, so `MAX_PROGRAM` — which counts what was emitted — was never consulted while
    // the copying loops ran a billion times. A fourth level of nesting is four hours.
    let thrown: unknown;
    const took = elapsed(() => {
      try {
        SafeRegex.compile('(?:(?:(?:){1000}){1000}){1000}');
      } catch (error) {
        thrown = error;
        throw error;
      }
    });
    expect(thrown).toBeInstanceOf(RegexSyntaxError);
    expect((thrown as Error).message).toContain(String(MAX_COMPILE_STEPS));
    expect(took).toBeLessThan(1000);
  }, 30_000);

  it('refuses it through the rule schema too, which is what the API validates with', () => {
    const took = elapsed(() => {
      parseRuleSet(
        JSON.stringify({
          version: 1,
          kind: 'ingestion',
          rules: [{ id: 'r', when: { type: 'filename', match: { matches: '(?:(?:(?:){1000}){1000}){1000}' } }, then: [{ type: 'stop' }] }],
        }),
      );
    });
    const result = parseRuleSet(
      JSON.stringify({
        version: 1,
        kind: 'ingestion',
        rules: [{ id: 'r', when: { type: 'filename', match: { matches: '(?:(?:(?:){1000}){1000}){1000}' } }, then: [{ type: 'stop' }] }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(took).toBeLessThan(1000);
  }, 30_000);

  it('refuses a pattern nested deeper than the stack can take, as a syntax error', () => {
    // `'('.repeat(3000)` used to throw a bare `RangeError: Maximum call stack size exceeded` out of
    // `SafeRegex.compile` — not a `RegexSyntaxError`, so nothing downstream could report it as the
    // rule author's mistake.
    let thrown: unknown;
    try {
      SafeRegex.compile(`${'('.repeat(3000)}a${')'.repeat(3000)}`);
      expect.unreachable('should have refused');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RegexSyntaxError);
    expect((thrown as Error).message).toContain(String(MAX_DEPTH));
    expect(SafeRegex.compile(`${'('.repeat(MAX_DEPTH)}a${')'.repeat(MAX_DEPTH)}`).programSize).toBeGreaterThan(0);
  });

  it('parses a long pattern in linear time', () => {
    // The rejected-construct probes and the `{n,m}` reader each built a fresh copy of the rest of
    // the pattern, once per atom: a 40 000-character run of literals cost 60.7 seconds before the
    // instruction cap could refuse it.
    const took = elapsed(() => SafeRegex.compile('a'.repeat(40_000)));
    expect(took).toBeLessThan(1000);
    expect(() => SafeRegex.compile('a'.repeat(40_000))).toThrowError(RegexSyntaxError);
  }, 30_000);

  it('refuses a pattern longer than MAX_PATTERN_LENGTH without reading it', () => {
    let thrown: unknown;
    try {
      SafeRegex.compile('a'.repeat(MAX_PATTERN_LENGTH + 1));
      expect.unreachable('should have refused');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RegexSyntaxError);
    expect((thrown as Error).message).toContain('MAX_PATTERN_LENGTH');
  });

  it('still compiles the patterns a rule author actually writes', () => {
    for (const pattern of [
      '^(?<year>\\d{4})-\\d{2}-\\d{2}_(?<who>[A-Z]+)_RE-(?<ref>\\d+)\\.pdf$',
      'Rechnung\\s+Nr\\.?\\s*(\\d+)',
      '(?:a|b|c){1,1000}',
      '[\\s\\S]{0,1000}x',
    ]) {
      expect(SafeRegex.compile(pattern).programSize).toBeGreaterThan(0);
    }
  });
});

describe('safeMatch is the bounded drop-in for a caller outside this package', () => {
  it('reports a match, with the span and the captures', () => {
    const result = safeMatch('Rechnung\\s+(\\d+)', 'Rechnung 40231', { flags: 'i' });
    expect(result.ok).toBe(true);
    expect(result.ok && result.matched && result.match.captures).toEqual(['40231']);
  });

  it('reports a non-match as a decided answer', () => {
    expect(safeMatch('Rechnung', 'Lieferschein')).toEqual({ ok: true, matched: false });
  });

  it('reports a refusal separately from a non-match, naming the limit', () => {
    const long = safeMatch('Rechnung', 'x'.repeat(2_000_000));
    expect(long.ok).toBe(false);
    expect(!long.ok && long.limit).toBe('input-length');
    expect(!long.ok && long.refusal).toContain('maxInputLength');

    const steps = safeMatch('(?:a|b)*c', 'ab'.repeat(5000), { maxSteps: 500 });
    expect(steps.ok).toBe(false);
    expect(!steps.ok && steps.limit).toBe('steps');
    expect(!steps.ok && steps.error).toBeInstanceOf(RegexBudgetError);
  });

  it('throws on a pattern that cannot be compiled, because that is not the input’s fault', () => {
    expect(() => safeMatch('(?=x)y', 'anything')).toThrowError(RegexSyntaxError);
  });

  it('safeTest keeps the three states three', () => {
    expect(safeTest('a', 'banana')).toBe(true);
    expect(safeTest('z', 'banana')).toBe(false);
    expect(safeTest('a', 'x'.repeat(2_000_000))).toBeUndefined();
  });
});

describe('every matcher is bounded, not only the two that compile a pattern', () => {
  it('refuses an over-long value to `contains` rather than folding a copy of it', () => {
    const result = applyMatcher({ contains: 'needle' }, 'x'.repeat(2_000_000));
    expect(result.matched).toBe(false);
    expect(result.error).toContain('maxInputLength');
  });

  it('an over-long value is an undecidable condition, so the rule errors instead of not matching', () => {
    const ruleSet = {
      kind: 'ingestion' as const,
      rules: [{ id: 'r', when: { type: 'filename' as const, match: { contains: 'invoice' } }, then: [{ type: 'stop' as const }] }],
    };
    const { trace } = evaluateIngestion(ruleSet, { id: 's', filename: 'x'.repeat(2_000_000) });
    expect(trace.rules[0]!.outcome).toBe('error');
  });

  it('leaves an ordinary value alone', () => {
    expect(applyMatcher({ contains: 'needle' }, 'a needle here').matched).toBe(true);
  });
});

describe('a value is refused before the facet rewrites it, not after', () => {
  it('refuses an over-long path before normalising it three times over', () => {
    // `normalisePath` is linear but it is a replace, a split and a join — three copies — and it
    // used to run before `applyMatcher` had any chance to refuse the value.
    const ruleSet = {
      kind: 'ingestion' as const,
      rules: [{ id: 'r', when: { type: 'path' as const, match: { glob: 'scans/**' } }, then: [{ type: 'stop' as const }] }],
    };
    const path = `scans/${'a/'.repeat(1_000_000)}x.pdf`;
    const took = elapsed(() => {
      const { trace } = evaluateIngestion(ruleSet, { id: 's', path });
      expect(trace.rules[0]!.outcome).toBe('error');
    });
    expect(took).toBeLessThan(50);
  });

  it('refuses it on the filename condition too, which derives the name from the same path', () => {
    const ruleSet = {
      kind: 'ingestion' as const,
      rules: [{ id: 'r', when: { type: 'filename' as const, match: { endsWith: '.pdf' } }, then: [{ type: 'stop' as const }] }],
    };
    const path = `scans/${'a/'.repeat(1_000_000)}x.pdf`;
    expect(evaluateIngestion(ruleSet, { id: 's', path }).trace.rules[0]!.outcome).toBe('error');
  });

  it('still matches an ordinary path', () => {
    const ruleSet = {
      kind: 'ingestion' as const,
      rules: [{ id: 'r', when: { type: 'path' as const, match: { glob: 'scans/**' } }, then: [{ type: 'stop' as const }] }],
    };
    expect(evaluateIngestion(ruleSet, { id: 's', path: 'scans/2026/x.pdf' }).trace.rules[0]!.outcome).toBe('matched');
  });

  it('refuses an over-long glob before expanding it', () => {
    // Translation is an expansion: `**` becomes eleven characters, so the pattern is refused only
    // after the expanded string exists unless the glob itself is bounded first.
    const took = elapsed(() => {
      expect(() => globToPattern('*'.repeat(MAX_PATTERN_LENGTH + 1))).toThrowError(RegexSyntaxError);
    });
    expect(took).toBeLessThan(50);
    expect(globToPattern('scans/**/*.pdf')).toContain('[^/]');
  });
});

describe('a `text` condition truncates rather than being refused', () => {
  it('takes the smaller of maxTextLength and maxInputLength, and says which bit', () => {
    // Without this the two defaults contradict each other: a rule set asking for 16 MB of text
    // would hand the matcher sixty times what it is allowed to read, and every rule on every long
    // document would come back undecidable — a review entry for a reason that is not true of it.
    expect(DEFAULT_LIMITS.maxInputLength).toBeLessThan(DEFAULT_LIMITS.maxTextLength);
    const ruleSet = {
      kind: 'ingestion' as const,
      rules: [{ id: 'r', when: { type: 'text' as const, match: { contains: 'beginning' } }, then: [{ type: 'stop' as const }] }],
    };
    const text = `beginning${'x'.repeat(2 * 1024 * 1024)}`;
    const { trace } = evaluateIngestion(ruleSet, { id: 's', text });
    expect(trace.rules[0]!.outcome).toBe('matched');
    expect(trace.warnings.join('\n')).toContain('maxInputLength');
    expect(trace.warnings.join('\n')).toContain(`text truncated to ${DEFAULT_LIMITS.maxInputLength}`);
  });
});

describe('the similarity measures are bounded before they normalise', () => {
  // NFKC is an expansion, so the bound has to be checked on the raw value: U+FDFA is one code point
  // that normalises to eighteen. 800 000 of them — a 1.6 MB title field a hostile PDF can set —
  // became 14.4 million characters and cost 3.0 s and half a gigabyte through `evaluateDedup`,
  // with no budget of any kind in the way.
  const bomb = '\ufdfa'.repeat(400_000);

  it('refuses to measure an over-long title, in constant time', () => {
    expect(bomb.normalize('NFKC').length).toBeGreaterThan(bomb.length * 10);
    const took = elapsed(() => {
      expect(similarity(bomb, `${bomb}x`)).toBeUndefined();
    });
    expect(took).toBeLessThan(50);
  }, 30_000);

  it('refuses a creator list whose total length is over the limit', () => {
    expect(nameOverlap([bomb], [bomb])).toBeUndefined();
    expect(nameOverlap(Array.from({ length: 2000 }, () => 'x'.repeat(1000)), ['a'])).toBeUndefined();
  });

  it('an unmeasurable title is undecidable, not a score of zero', () => {
    const ruleSet = {
      kind: 'dedup' as const,
      rules: [
        {
          id: 't',
          when: { type: 'title-similarity' as const, atLeast: 0.9 },
          then: [{ type: 'flag' as const, reasonCode: 'possible_duplicate', explanation: 'looks like a duplicate' }],
        },
      ],
    };
    const took = elapsed(() => {
      const { trace } = evaluateDedup(ruleSet, { id: 'p', left: { id: 'a', title: bomb }, right: { id: 'b', title: `${bomb}x` } });
      expect(trace.rules[0]!.outcome).toBe('error');
    });
    expect(took).toBeLessThan(100);
  }, 30_000);

  it('still measures the titles a library actually holds', () => {
    expect(similarity('Der Steuerbescheid 2026', 'Der Steuerbescheid 2026')).toBe(1);
    expect(similarity('', '')).toBe(0);
    expect(nameOverlap(['Ada Lovelace'], ['Ada Lovelace', 'Charles Babbage'])).toBe(1);
  });
});

describe('interpolation is bounded by what it produces, not by the template', () => {
  it('refuses a substitution that would expand past the limit', () => {
    // A 1 KB template the schema accepts, holding two hundred placeholders, against a capture as
    // long as the matched value: sixty megabytes of string for one tag name.
    const captures = new Map([['big', 'x'.repeat(200_000)]]);
    const result = interpolate('${big}${big}${big}${big}${big}', captures);
    expect(result.ok).toBe(false);
    expect(!result.ok && 'tooLong' in result && result.limit).toBe(MAX_INTERPOLATED);
  });

  it('the action is skipped and the trace says why, rather than the value being written', () => {
    const ruleSet = {
      kind: 'ingestion' as const,
      rules: [
        {
          id: 'r',
          when: { type: 'filename' as const, match: { matches: '(?<all>[\\s\\S]+)' } },
          then: [{ type: 'add-tags' as const, tags: ['${all}${all}${all}'] }],
        },
      ],
    };
    // The clock is opened up on purpose: the match itself must finish, or the rule errors for a
    // different reason and this stops testing interpolation at all.
    const { outcome, trace } = evaluateIngestion(
      ruleSet,
      { id: 's', filename: 'y'.repeat(30_000) },
      { limits: { timeoutMs: 30_000, maxSteps: 100_000_000 } },
    );
    expect(outcome.tags).toEqual([]);
    expect(trace.rules[0]!.actions[0]!.outcome).toBe('skipped');
    expect(trace.rules[0]!.actions[0]!.detail).toContain(String(MAX_INTERPOLATED));
  });

  it('still substitutes an ordinary capture', () => {
    expect(interpolate('Office/Invoices/${year}', new Map([['year', '2026']]))).toEqual({
      ok: true,
      value: 'Office/Invoices/2026',
      used: ['year'],
    });
  });
});

describe('the rule-set document is bounded before it is parsed', () => {
  it('refuses a document longer than maxLength, naming it', () => {
    const result = parseRuleSet(`# ${'x'.repeat(MAX_RULE_SET_CHARS)}`);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues[0]!.message).toContain('maxLength');
  });

  it('still reads an ordinary document', () => {
    const result = parseRuleSet('version: 1\nkind: ingestion\nrules:\n  - id: r\n    when: { type: always }\n    then: [{ type: stop }]\n');
    expect(result.ok).toBe(true);
  });

  it('refuses a document nested deeper than the schema can validate without overflowing', () => {
    // A condition is recursive, so `{"not":{"not":…}}` three thousand deep is a 24 KB document —
    // inside `maxLength`, inside every schema cap — that made `RuleSetSchema.safeParse` throw a
    // bare `RangeError: Maximum call stack size exceeded` out of a function contracted to return
    // its issues rather than throw.
    const nest = (n: number): string =>
      `{"version":1,"kind":"ingestion","rules":[{"id":"r","when":${'{"not":'.repeat(n)}{"type":"always"}${'}'.repeat(n)},"then":[{"type":"stop"}]}]}`;
    for (const depth of [MAX_DOCUMENT_DEPTH + 1, 3000, 50_000]) {
      const result = parseRuleSet(nest(depth));
      expect(result.ok).toBe(false);
      expect(!result.ok && result.issues[0]!.message).toContain('MAX_DOCUMENT_DEPTH');
    }
    // `loadRuleSet` is the other front door — a row read back out of the database — and carries the
    // same check, because it is the one that hands the value to Zod.
    const deep = JSON.parse(nest(3000)) as unknown;
    expect(loadRuleSet(deep).ok).toBe(false);
  });

  it('still reads a document nested as deeply as a person plausibly would', () => {
    const nest = (n: number): string =>
      `{"version":1,"kind":"ingestion","rules":[{"id":"r","when":${'{"not":'.repeat(n)}{"type":"always"}${'}'.repeat(n)},"then":[{"type":"stop"}]}]}`;
    expect(parseRuleSet(nest(8)).ok).toBe(true);
  });
});

describe('the evaluator does not overflow on a rule set it was handed directly', () => {
  it('treats an over-deep condition as undecidable rather than throwing', () => {
    // `evaluateRules` takes a plain `RuleSetLike`, which another package may build without going
    // through the parser — the ingest pipeline's rule adapter does exactly that.
    let when: Record<string, unknown> = { type: 'always' };
    for (let index = 0; index < MAX_CONDITION_DEPTH + 5; index += 1) when = { not: when };
    const ruleSet = { kind: 'ingestion' as const, rules: [{ id: 'r', when: when as never, then: [{ type: 'stop' as const }] }] };
    const { trace } = evaluateIngestion(ruleSet, { id: 's' });
    expect(trace.rules[0]!.outcome).toBe('error');

    // And at a depth that would actually exhaust the stack, which is the case that matters: the
    // guard has to fire before the recursion does, not merely somewhere below it.
    let deep: Record<string, unknown> = { type: 'always' };
    for (let index = 0; index < 20_000; index += 1) deep = { not: deep };
    const deepSet = { kind: 'ingestion' as const, rules: [{ id: 'r', when: deep as never, then: [{ type: 'stop' as const }] }] };
    expect(evaluateIngestion(deepSet, { id: 's' }).trace.rules[0]!.outcome).toBe('error');
  });

  it('evaluates an ordinary nested condition', () => {
    const ruleSet = {
      kind: 'ingestion' as const,
      rules: [
        {
          id: 'r',
          when: { all: [{ not: { any: [{ type: 'filename' as const, match: { contains: 'zzz' } }] } }] } as never,
          then: [{ type: 'stop' as const }],
        },
      ],
    };
    const { trace } = evaluateIngestion(ruleSet, { id: 's', filename: 'invoice.pdf' });
    expect(trace.rules[0]!.outcome).toBe('matched');
  });
});

describe('the README states the limits this code actually enforces', () => {
  // A README is read as a contract, and a table of numbers is the part of one that rots first.
  const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
  const group = (value: number): string => value.toLocaleString('en-GB').replaceAll(',', ' ');

  for (const [name, value] of [
    ['maxInputLength', DEFAULT_MAX_INPUT_LENGTH],
    ['timeoutMs', DEFAULT_TIMEOUT_MS],
    ['maxSteps', DEFAULT_MAX_STEPS],
    ['MAX_PATTERN_LENGTH', MAX_PATTERN_LENGTH],
    ['MAX_DEPTH', MAX_DEPTH],
    ['MAX_REPEAT', MAX_REPEAT],
    ['MAX_PROGRAM', MAX_PROGRAM],
    ['MAX_COMPILE_STEPS', MAX_COMPILE_STEPS],
    ['MAX_DOCUMENT_DEPTH', MAX_DOCUMENT_DEPTH],
    ['MAX_CONDITION_DEPTH', MAX_CONDITION_DEPTH],
  ] as const) {
    it(`quotes ${name} as ${group(value)}`, () => {
      expect(readme).toContain(name);
      expect(readme).toContain(group(value));
    });
  }

  it('quotes MAX_RULE_SET_CHARS and MAX_INTERPOLATED in the units the table uses', () => {
    expect(MAX_RULE_SET_CHARS).toBe(1024 * 1024);
    expect(MAX_INTERPOLATED).toBe(64 * 1024);
    expect(readme).toContain('`maxLength` (1 MiB)');
    expect(readme).toContain('`MAX_INTERPOLATED`, 64 KiB');
  });
});
