/**
 * Abstract syntax tree → Pike VM program.
 *
 * The instruction set is the classic Thompson one — consume, split, jump, save, assert, match —
 * because it is the set a simulation can run breadth-first without ever backtracking. Counted
 * repetition is the one construct with no instruction of its own: `a{3,5}` is compiled by emitting
 * the body five times, which is why `MAX_REPEAT` in the parser and `MAX_PROGRAM` here both exist. A
 * pattern that would need a program larger than the cap is refused at compile time; the alternative
 * is a rule set that quietly costs a gigabyte.
 */
import { RegexSyntaxError } from './errors.js';
import type { Assertion, CodeRange, ParsedPattern, RegexNode } from './parse.js';

export type Inst =
  | { readonly op: 'class'; readonly negated: boolean; readonly ranges: readonly CodeRange[] }
  | { readonly op: 'split'; readonly x: number; readonly y: number }
  | { readonly op: 'jmp'; readonly x: number }
  | { readonly op: 'save'; readonly slot: number }
  | { readonly op: 'assert'; readonly assertion: Assertion }
  | { readonly op: 'match' };

type MutableInst =
  | { op: 'class'; negated: boolean; ranges: readonly CodeRange[] }
  | { op: 'split'; x: number; y: number }
  | { op: 'jmp'; x: number }
  | { op: 'save'; slot: number }
  | { op: 'assert'; assertion: Assertion }
  | { op: 'match' };

export interface Program {
  readonly insts: readonly Inst[];
  /** Two slots per group, plus the two that hold the whole match. */
  readonly slotCount: number;
  readonly groupCount: number;
  readonly groupNames: ReadonlyMap<string, number>;
  /** True when every path through the program begins at `^`, so the search cannot slide rightwards. */
  readonly anchoredStart: boolean;
}

/** A program larger than this is refused rather than compiled. */
export const MAX_PROGRAM = 20_000;

/** Does every branch of this node start with `^`? Used to skip the sliding start of the search. */
const startsAnchored = (node: RegexNode): boolean => {
  switch (node.kind) {
    case 'assert':
      return node.assertion === 'start';
    case 'group':
      return startsAnchored(node.node);
    case 'concat':
      return node.nodes.length > 0 && startsAnchored(node.nodes[0]!);
    case 'alternate':
      return node.nodes.length > 0 && node.nodes.every(startsAnchored);
    case 'repeat':
      return node.min > 0 && startsAnchored(node.node);
    default:
      return false;
  }
};

export const compilePattern = (parsed: ParsedPattern, pattern: string): Program => {
  const insts: MutableInst[] = [];

  const emit = (inst: MutableInst): number => {
    if (insts.length >= MAX_PROGRAM) {
      throw new RegexSyntaxError(`pattern compiles to more than ${MAX_PROGRAM} instructions`, pattern, 0);
    }
    insts.push(inst);
    return insts.length - 1;
  };

  /** Fill in the forward targets of a `split` or a `jmp` once the code they jump over exists. */
  const patch = (index: number, x: number, y?: number): void => {
    const inst = insts[index]!;
    if (inst.op === 'split') {
      inst.x = x;
      inst.y = y ?? x;
    } else if (inst.op === 'jmp') {
      inst.x = x;
    }
  };

  const emitNode = (node: RegexNode): void => {
    switch (node.kind) {
      case 'empty':
        return;
      case 'class':
        emit({ op: 'class', negated: node.negated, ranges: node.ranges });
        return;
      case 'assert':
        emit({ op: 'assert', assertion: node.assertion });
        return;
      case 'concat':
        for (const child of node.nodes) emitNode(child);
        return;
      case 'alternate': {
        const jumps: number[] = [];
        for (let index = 0; index < node.nodes.length; index += 1) {
          if (index === node.nodes.length - 1) {
            emitNode(node.nodes[index]!);
            break;
          }
          const split = emit({ op: 'split', x: 0, y: 0 });
          emitNode(node.nodes[index]!);
          jumps.push(emit({ op: 'jmp', x: 0 }));
          patch(split, split + 1, insts.length);
        }
        for (const jump of jumps) patch(jump, insts.length);
        return;
      }
      case 'group': {
        if (node.index === undefined) {
          emitNode(node.node);
          return;
        }
        emit({ op: 'save', slot: node.index * 2 });
        emitNode(node.node);
        emit({ op: 'save', slot: node.index * 2 + 1 });
        return;
      }
      case 'repeat':
        emitRepeat(node.node, node.min, node.max, node.lazy);
        return;
    }
  };

  /** `x` is the preferred branch, so greedy points it at the body and lazy points it past. */
  const branch = (split: number, bodyStart: number, after: number, lazy: boolean): void => {
    patch(split, lazy ? after : bodyStart, lazy ? bodyStart : after);
  };

  const emitStar = (body: RegexNode, lazy: boolean): void => {
    const split = emit({ op: 'split', x: 0, y: 0 });
    emitNode(body);
    emit({ op: 'jmp', x: split });
    branch(split, split + 1, insts.length, lazy);
  };

  const emitPlus = (body: RegexNode, lazy: boolean): void => {
    const bodyStart = insts.length;
    emitNode(body);
    const split = emit({ op: 'split', x: 0, y: 0 });
    branch(split, bodyStart, insts.length, lazy);
  };

  const emitOptional = (body: RegexNode, lazy: boolean): void => {
    const split = emit({ op: 'split', x: 0, y: 0 });
    emitNode(body);
    branch(split, split + 1, insts.length, lazy);
  };

  const emitRepeat = (body: RegexNode, min: number, max: number, lazy: boolean): void => {
    if (!Number.isFinite(max)) {
      if (min === 0) {
        emitStar(body, lazy);
        return;
      }
      for (let index = 0; index < min - 1; index += 1) emitNode(body);
      emitPlus(body, lazy);
      return;
    }
    for (let index = 0; index < min; index += 1) emitNode(body);
    for (let index = min; index < max; index += 1) emitOptional(body, lazy);
  };

  emit({ op: 'save', slot: 0 });
  emitNode(parsed.node);
  emit({ op: 'save', slot: 1 });
  emit({ op: 'match' });

  return {
    insts,
    slotCount: (parsed.groupCount + 1) * 2,
    groupCount: parsed.groupCount,
    groupNames: parsed.groupNames,
    anchoredStart: startsAnchored(parsed.node),
  };
};
