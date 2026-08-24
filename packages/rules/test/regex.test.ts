import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_STEPS,
  RegexBudgetError,
  RegexSyntaxError,
  RegexTimeoutError,
  SafeRegex,
} from '../src/regex/index.js';

describe('the linear engine agrees with RegExp on patterns both can run', () => {
  const cases: readonly (readonly [string, string, string])[] = [
    ['abc', 'xxabcxx', ''],
    ['^abc$', 'abc', ''],
    ['a+b', 'aaab', ''],
    ['a*?b', 'aaab', ''],
    ['(a|b)+c', 'ababc', ''],
    ['[a-c]{2,4}', 'zzabcabcz', ''],
    ['\\d{4}-\\d{2}-\\d{2}', 'on 2026-08-22 ok', ''],
    ['(?<ref>[A-Z]{2}\\d{5})', 'ref XY12345 end', ''],
    ['colou?r', 'COLOR', 'i'],
    ['^b', 'a\nb', 'm'],
    ['a.b', 'a\nb', 's'],
    ['a.b', 'a\nb', ''],
    ['\\bword\\b', 'a word here', ''],
    ['\\bword\\b', 'awordhere', ''],
    ['[^/]*\\.pdf', 'dir/file.pdf', ''],
    ['(foo|foobar)baz', 'foobarbaz', ''],
    ['x{0,3}y', 'xxxy', ''],
    ['(a)(b)?(c)', 'ac', ''],
    ['[\\s\\S]+', 'a\nb', ''],
    ['[\\w.-]+@[\\w.-]+', 'mail a.b-c@ex.example now', ''],
    ['Rechnung\\s+Nr\\.?\\s*(\\d+)', 'Rechnung Nr. 40231', 'i'],
    ['ä+', 'xxäääy', ''],
    ['(ab)*', 'ababab', ''],
    ['^$', '', ''],
  ];

  for (const [pattern, input, flags] of cases) {
    it(`/${pattern}/${flags} against ${JSON.stringify(input)}`, () => {
      const mine = SafeRegex.compile(pattern, { flags }).exec(input);
      const native = new RegExp(pattern, flags).exec(input);
      if (native === null) {
        expect(mine).toBeUndefined();
        return;
      }
      expect(mine).toBeDefined();
      expect(mine!.start).toBe(native.index);
      expect(mine!.text).toBe(native[0]);
      expect(mine!.captures).toEqual(native.slice(1).map((value) => value ?? undefined));
    });
  }
});

describe('unsupported constructs are refused at compile time', () => {
  const refused: readonly (readonly [string, string])[] = [
    ['(?=x)y', 'lookahead'],
    ['(?!x)y', 'negative lookahead'],
    ['(?<=x)y', 'lookbehind'],
    ['(a)\\1', 'backreferences'],
    ['\\k<a>', 'named backreferences'],
    ['\\p{L}+', 'Unicode property escapes'],
    ['a{1001}', 'repetition count'],
    ['a++', 'nothing for'],
    ['(a', 'unterminated group'],
    ['[a', 'unterminated character class'],
    ['*a', 'nothing for'],
  ];

  for (const [pattern, fragment] of refused) {
    it(`refuses /${pattern}/`, () => {
      expect(() => SafeRegex.compile(pattern)).toThrowError(RegexSyntaxError);
      try {
        SafeRegex.compile(pattern);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain(fragment);
      }
    });
  }

  it('refuses a flag it does not have', () => {
    expect(() => SafeRegex.compile('a', { flags: 'g' })).toThrowError(/unsupported flag "g"/u);
  });
});

describe('catastrophic backtracking', () => {
  const evil = '^(a+)+$';
  const hostile = `${'a'.repeat(100)}b`;

  it('would hang a backtracking engine — proved by running one', () => {
    // The child is a plain `node -e` running the same pattern on the same input through the
    // platform's own RegExp. It is killed after three seconds; the assertion is that it had to be.
    // Any machine that finished 2^100 backtracks in three seconds would be news.
    const child = spawnSync(process.execPath, ['-e', `/${evil}/.test(${JSON.stringify(hostile)})`], {
      timeout: 3000,
      killSignal: 'SIGKILL',
    });
    expect(child.signal).toBe('SIGKILL');
    expect(child.status).toBeNull();
  }, 15_000);

  it('is a non-event for the linear engine', () => {
    const compiled = SafeRegex.compile(evil);
    const started = process.hrtime.bigint();
    const matched = compiled.test(hostile);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(matched).toBe(false);
    expect(elapsedMs).toBeLessThan(250);
  });

  it('answers the same for the accepting input', () => {
    expect(SafeRegex.compile(evil).test('a'.repeat(100))).toBe(true);
  });

  it('handles the other classic shapes as cheaply', () => {
    for (const pattern of ['(a|a)*$', '(x+x+)+y', '(a*)*b', '([a-z]+)+#']) {
      const compiled = SafeRegex.compile(pattern);
      const started = process.hrtime.bigint();
      compiled.test('a'.repeat(80));
      compiled.test('x'.repeat(80));
      expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(250);
    }
  });
});

describe('the budget and the clock', () => {
  it('the step budget fires, and names itself', () => {
    const compiled = SafeRegex.compile('(?:a|b)*c', { maxSteps: 500 });
    expect(() => compiled.test('ab'.repeat(5000))).toThrowError(RegexBudgetError);
    try {
      compiled.test('ab'.repeat(5000));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RegexBudgetError);
      expect((error as RegexBudgetError).steps).toBe(500);
      expect((error as Error).message).toContain('exceeded its budget of 500 steps');
    }
  });

  it('the wall-clock allowance fires on work that outlasts it', () => {
    // Linear does not mean instant: a few million code points against a pattern that keeps a dozen
    // threads alive is real work, and one millisecond is not enough of it.
    const compiled = SafeRegex.compile('(?:[a-z]|[0-9])*!', { timeoutMs: 1, maxSteps: DEFAULT_MAX_STEPS * 20 });
    expect(() => compiled.test('a1b2c3'.repeat(400_000))).toThrowError(RegexTimeoutError);
    try {
      compiled.test('a1b2c3'.repeat(400_000));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RegexTimeoutError);
      expect((error as RegexTimeoutError).timeoutMs).toBe(1);
    }
  }, 20_000);

  it('a generous budget completes the same work', () => {
    const compiled = SafeRegex.compile('(?:[a-z]|[0-9])*!', { timeoutMs: 30_000, maxSteps: 50_000_000 });
    expect(compiled.test('a1b2c3'.repeat(10_000))).toBe(false);
  }, 20_000);
});

describe('captures', () => {
  it('names the groups a rule can interpolate', () => {
    const compiled = SafeRegex.compile('^(?<year>\\d{4})-(?<month>\\d{2})');
    const found = compiled.exec('2026-08-22');
    expect(found?.groups).toEqual({ year: '2026', month: '08' });
    expect(compiled.groupNames).toEqual(['year', 'month']);
  });

  it('leaves a group that took no part undefined rather than empty', () => {
    const found = SafeRegex.compile('a(b)?(c)').exec('ac');
    expect(found?.captures).toEqual([undefined, 'c']);
  });

  it('counts positions in code points, not UTF-16 units', () => {
    const found = SafeRegex.compile('b').exec('𝄞b');
    expect(found?.start).toBe(1);
  });
});
