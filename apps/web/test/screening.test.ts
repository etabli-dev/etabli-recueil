import { describe, expect, it } from 'vitest';

import { keyAction, reasonsFor } from '../src/routes/screening.js';

describe('screening keys', () => {
  it('maps the screening keys, and reason numbers only while choosing a reason', () => {
    expect(keyAction('i', 0)).toEqual({ kind: 'include' });
    expect(keyAction('e', 0)).toEqual({ kind: 'exclude' });
    expect(keyAction('m', 0)).toEqual({ kind: 'maybe' });
    expect(keyAction('u', 0)).toEqual({ kind: 'undo' });
    expect(keyAction('j', 0)).toEqual({ kind: 'next' });
    expect(keyAction('2', 0)).toBeNull();
    expect(keyAction('2', 3)).toEqual({ kind: 'reason', index: 1 });
    expect(keyAction('4', 3)).toBeNull();
    expect(keyAction('x', 3)).toBeNull();
  });

  it('offers the reasons of the stage and those for any stage', () => {
    const review = {
      id: 'r',
      title: 'R',
      question: null,
      status: 'screening',
      automationDisclosure: false,
      exclusionReasons: [
        { code: 'pop', label: 'Population', stage: 'any' as const },
        { code: 'design', label: 'Design', stage: 'full_text' as const },
        { code: 'lang', label: 'Language', stage: 'title_abstract' as const },
      ],
    };
    expect(reasonsFor(review, 'title_abstract').map((r) => r.code)).toEqual(['pop', 'lang']);
    expect(reasonsFor(review, 'full_text').map((r) => r.code)).toEqual(['pop', 'design']);
  });
});
