/**
 * The Pike VM: a breadth-first simulation of the compiled program.
 *
 * Every thread advances one input code point per outer iteration, and a program counter is added to
 * a thread list at most once per position. That pair of facts is the whole safety argument: the
 * work is bounded by `input length × program length`, whatever the pattern, so the classic
 * exponential cases — `(a+)+$`, `(a|a)*b`, `(x+x+)+y` — cost the same as any other pattern of their
 * size. Thread priority is preserved (preferred branch first, lower-priority threads cut when a
 * higher-priority thread reaches `match`), which gives the leftmost-first submatch semantics a rule
 * author expects from a greedy or lazy quantifier.
 *
 * The step budget and the wall-clock allowance on top are not a substitute for that argument. They
 * are there because "linear" still multiplies: a 200 MB extracted text against a 5 000-instruction
 * program is a real cost even without backtracking, and a rule engine that can be made to spend
 * five minutes on one document is still a denial of service.
 */
import { RegexBudgetError, RegexTimeoutError } from './errors.js';
import type { Inst, Program } from './compile.js';
import type { Assertion, CodeRange } from './parse.js';

export interface VmOptions {
  readonly ignoreCase: boolean;
  readonly multiline: boolean;
  /** Hard ceiling on simulation steps for one match attempt. */
  readonly maxSteps: number;
  /** Wall-clock ceiling in milliseconds, or `undefined` for none. */
  readonly timeoutMs: number | undefined;
  /** For the error messages. */
  readonly pattern: string;
}

export interface VmMatch {
  /** Code-point index of the first character of the match. */
  readonly start: number;
  /** Code-point index one past the last character of the match. */
  readonly end: number;
  readonly text: string;
  /** Group 1..n, `undefined` where the group did not take part in the match. Group 0 is `text`. */
  readonly captures: readonly (string | undefined)[];
  readonly groups: Readonly<Record<string, string>>;
  /** Steps the simulation actually took. Reported so a dry run can show what a rule set costs. */
  readonly steps: number;
}

/** How often the clock is consulted, in steps. Often enough to be prompt, rarely enough to be free. */
const CLOCK_INTERVAL = 4096;

const foldCache = new Map<number, readonly number[]>();

/**
 * The other cases of a code point, for case-insensitive matching.
 *
 * This is simple folding: one code point in, at most two out. It is not the full Unicode default
 * case-folding table (ß → ss has no single-code-point answer), and a rule that depends on that
 * should write the alternatives out.
 */
const foldVariants = (codePoint: number): readonly number[] => {
  const cached = foldCache.get(codePoint);
  if (cached !== undefined) return cached;
  const char = String.fromCodePoint(codePoint);
  const variants: number[] = [];
  for (const other of [char.toLowerCase(), char.toUpperCase()]) {
    if (Array.from(other).length !== 1) continue;
    const cp = other.codePointAt(0)!;
    if (cp !== codePoint && !variants.includes(cp)) variants.push(cp);
  }
  const frozen: readonly number[] = Object.freeze(variants);
  if (foldCache.size < 4096) foldCache.set(codePoint, frozen);
  return frozen;
};

const inRanges = (ranges: readonly CodeRange[], codePoint: number): boolean => {
  for (const range of ranges) {
    if (codePoint >= range.lo && codePoint <= range.hi) return true;
  }
  return false;
};

const isWordChar = (codePoint: number | undefined): boolean =>
  codePoint !== undefined &&
  ((codePoint >= 0x30 && codePoint <= 0x39) ||
    (codePoint >= 0x41 && codePoint <= 0x5a) ||
    (codePoint >= 0x61 && codePoint <= 0x7a) ||
    codePoint === 0x5f);

const isNewline = (codePoint: number | undefined): boolean =>
  codePoint === 0x0a || codePoint === 0x0d || codePoint === 0x2028 || codePoint === 0x2029;

interface Thread {
  readonly pc: number;
  readonly slots: Int32Array;
}

/**
 * Run `program` over `input`, returning the leftmost match or `undefined`.
 *
 * `input` is taken as an array of code points so that positions, and therefore reported spans, are
 * code points rather than UTF-16 units — an astral character is one character to a rule author.
 */
export const runProgram = (program: Program, input: readonly number[], options: VmOptions): VmMatch | undefined => {
  const { insts } = program;
  const length = input.length;
  const visited = new Int32Array(insts.length).fill(-1);
  const started = options.timeoutMs === undefined ? 0 : Date.now();
  let steps = 0;
  let generation = 0;

  const spend = (): void => {
    steps += 1;
    if (steps > options.maxSteps) throw new RegexBudgetError(options.pattern, options.maxSteps);
    if (options.timeoutMs !== undefined && steps % CLOCK_INTERVAL === 0 && Date.now() - started > options.timeoutMs) {
      throw new RegexTimeoutError(options.pattern, options.timeoutMs);
    }
  };

  const holds = (assertion: Assertion, position: number): boolean => {
    switch (assertion) {
      case 'start':
        return position === 0 || (options.multiline && isNewline(input[position - 1]));
      case 'end':
        return position === length || (options.multiline && isNewline(input[position]));
      case 'word-boundary':
        return isWordChar(input[position - 1]) !== isWordChar(input[position]);
      case 'not-word-boundary':
        return isWordChar(input[position - 1]) === isWordChar(input[position]);
    }
  };

  /** Follow every zero-width instruction reachable from `pc`, in priority order, into `list`. */
  const addThread = (list: Thread[], pc: number, position: number, slots: Int32Array): void => {
    const stack: Thread[] = [{ pc, slots }];
    while (stack.length > 0) {
      const thread = stack.pop()!;
      if (visited[thread.pc] === generation) continue;
      visited[thread.pc] = generation;
      spend();
      const inst = insts[thread.pc] as Inst;
      switch (inst.op) {
        case 'jmp':
          stack.push({ pc: inst.x, slots: thread.slots });
          break;
        case 'split':
          // Pushed in reverse so that the preferred branch is popped, and explored, first.
          stack.push({ pc: inst.y, slots: thread.slots });
          stack.push({ pc: inst.x, slots: thread.slots });
          break;
        case 'save': {
          const next = Int32Array.from(thread.slots);
          next[inst.slot] = position;
          stack.push({ pc: thread.pc + 1, slots: next });
          break;
        }
        case 'assert':
          if (holds(inst.assertion, position)) stack.push({ pc: thread.pc + 1, slots: thread.slots });
          break;
        default:
          list.push(thread);
      }
    }
  };

  const consumes = (inst: Extract<Inst, { op: 'class' }>, codePoint: number): boolean => {
    let hit = inRanges(inst.ranges, codePoint);
    if (!hit && options.ignoreCase) {
      for (const variant of foldVariants(codePoint)) {
        if (inRanges(inst.ranges, variant)) {
          hit = true;
          break;
        }
      }
    }
    return inst.negated ? !hit : hit;
  };

  // `^` pins the search to position 0 — unless `m` is set, where it also matches after a newline
  // and the search must go on sliding.
  const canSlide = !program.anchoredStart || options.multiline;
  const empty = new Int32Array(program.slotCount).fill(-1);
  let matched: Int32Array | undefined;
  let clist: Thread[] = [];
  generation += 1;
  addThread(clist, 0, 0, empty);

  for (let position = 0; position <= length; position += 1) {
    generation += 1;
    const nlist: Thread[] = [];
    for (const thread of clist) {
      spend();
      const inst = insts[thread.pc] as Inst;
      if (inst.op === 'class') {
        const codePoint = input[position];
        if (codePoint !== undefined && consumes(inst, codePoint)) {
          addThread(nlist, thread.pc + 1, position + 1, thread.slots);
        }
      } else if (inst.op === 'match') {
        matched = thread.slots;
        // Everything after this thread in the list is lower priority, so it cannot win.
        break;
      }
    }
    if (matched === undefined && canSlide && position + 1 <= length) {
      addThread(nlist, 0, position + 1, empty);
    }
    clist = nlist;
    // An empty list is not the end of the search: a start thread that died on an anchor at this
    // position says nothing about the next one. Stop only when no new start thread can be added.
    if (clist.length === 0 && (matched !== undefined || !canSlide)) break;
  }

  if (matched === undefined) return undefined;

  const start = matched[0]!;
  const end = matched[1]!;
  const slice = (from: number, to: number): string => input.slice(from, to).map((cp) => String.fromCodePoint(cp)).join('');
  const captures: (string | undefined)[] = [];
  for (let group = 1; group <= program.groupCount; group += 1) {
    const from = matched[group * 2]!;
    const to = matched[group * 2 + 1]!;
    captures.push(from >= 0 && to >= from ? slice(from, to) : undefined);
  }
  const groups: Record<string, string> = {};
  for (const [name, index] of program.groupNames) {
    const value = captures[index - 1];
    if (value !== undefined) groups[name] = value;
  }

  return { start, end, text: slice(start, end), captures, groups, steps };
};
