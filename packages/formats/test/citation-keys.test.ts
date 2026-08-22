/**
 * ADR-0016, clause by clause.
 *
 * The worked example in the ADR — Ravaud, P. (2019), *The Effect of Preprints on Systematic Review
 * Timeliness* → `ravaudEffPreSys2019` — is the single most load-bearing assertion in this package:
 * it is the compatibility claim that lets an existing manuscript keep building after migration.
 */
import { describe, expect, it } from 'vitest';

import {
  ANONYMOUS_AUTH,
  DEFAULT_CITATION_KEY_FORMULA,
  base26Suffix,
  disambiguate,
  generateKey,
  isValidPattern,
  parsePattern,
  PatternError,
  transliterate,
} from '../src/index.js';
import type { FormatRecord } from '../src/index.js';
import { ravaud } from './fixtures.js';

const record = (over: Partial<FormatRecord> = {}): FormatRecord => ({
  id: 'x',
  itemType: 'article',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('the ADR-0016 worked example', () => {
  it('produces ravaudEffPreSys2019', () => {
    expect(generateKey(ravaud)).toBe('ravaudEffPreSys2019');
  });

  it('is what the default formula says it is', () => {
    expect(DEFAULT_CITATION_KEY_FORMULA).toBe('auth.lower + shorttitle(3,3) + year');
    expect(generateKey(ravaud, { formula: DEFAULT_CITATION_KEY_FORMULA })).toBe('ravaudEffPreSys2019');
  });
});

describe('the auth segment', () => {
  const cases: Array<[string, FormatRecord, string]> = [
    [
      'takes the first author',
      record({
        creators: [
          { role: 'author', familyName: 'Ravaud' },
          { role: 'author', familyName: 'Boutron' },
        ],
      }),
      'ravaud',
    ],
    [
      'falls back to the editor when there is no author',
      record({ creators: [{ role: 'editor', familyName: 'Nowak' }] }),
      'nowak',
    ],
    [
      'falls back to any other role when there is neither',
      record({ creators: [{ role: 'recipient', familyName: 'Kowalski' }] }),
      'kowalski',
    ],
    ['becomes anon with no creators at all', record({}), ANONYMOUS_AUTH],
    [
      'uses the whole string of a single-field name',
      record({ creators: [{ role: 'author', kind: 'organisation', literalName: 'World Health Organization' }] }),
      'worldhealthorganization',
    ],
    [
      'drops a particle stored in its own field',
      record({ creators: [{ role: 'author', familyName: 'Beethoven', namePrefix: 'van' }] }),
      'beethoven',
    ],
    [
      'keeps a particle embedded in the family string, as Better BibTeX does',
      record({ creators: [{ role: 'author', familyName: 'van Beethoven' }] }),
      'vanbeethoven',
    ],
    [
      'prefers a recorded Latin variant to romanisation',
      record({
        creators: [
          {
            role: 'author',
            familyName: 'Чайковский',
            nameVariants: [{ form: 'Tchaikovsky, Pyotr', source: 'openalex' }],
          },
        ],
      }),
      'tchaikovsky',
    ],
    [
      'romanises when no Latin variant is on the record',
      record({ creators: [{ role: 'author', familyName: 'Чайковский' }] }),
      'cajkovskij',
    ],
  ];

  it.each(cases)('%s', (_name, input, expected) => {
    expect(generateKey(input, { formula: 'auth.lower' })).toBe(expected);
  });
});

describe('transliteration', () => {
  const cases: Array<[string, string, string]> = [
    ['strips combining marks after NFKD', 'Ravaud é ü ā ć ş', 'Ravaudeuacs'],
    ['expands eszett', 'Straße', 'Strasse'],
    ['maps the ligatures and barred letters', 'æœøđðþłħıŋƒ', 'aeoeoddthlhingf'],
    ['romanises Cyrillic by ISO 9', 'Чайковский', 'Cajkovskij'],
    ['romanises Greek by ISO 843', 'Παπαδόπουλος', 'Papadopoylos'],
    ['drops everything else', 'Smith-Jones (2019)!', 'SmithJones2019'],
  ];

  it.each(cases)('%s', (_name, input, expected) => {
    expect(transliterate(input)).toBe(expected);
  });

  it('folds rather than expands the umlauts by default', () => {
    expect(transliterate('Müller')).toBe('Muller');
  });

  it('expands them when germanExpansion is on', () => {
    expect(transliterate('Müller', { germanExpansion: true })).toBe('Mueller');
    expect(generateKey(record({ creators: [{ role: 'author', familyName: 'Müller' }] }), { formula: 'auth.lower', germanExpansion: true })).toBe('mueller');
  });
});

describe('the shorttitle segment', () => {
  const short = (title: string): string => generateKey(record({ bibliographic: { title } }), { formula: 'shorttitle(3,3)' });

  it('drops skip words and truncates to three characters', () => {
    expect(short('The Effect of Preprints on Systematic Review Timeliness')).toBe('EffPreSys');
  });

  it('lets a subtitle after a colon participate', () => {
    expect(short('Power: A Note on Sample Size')).toBe('PowNotSam');
  });

  it('keeps digits', () => {
    expect(short('The 100 Year Study')).toBe('100YeaStu');
  });

  it('yields a shorter segment when fewer words survive', () => {
    expect(short('On the Method')).toBe('Met');
  });

  it('yields nothing at all for an empty title', () => {
    expect(generateKey(record({ bibliographic: { title: 'The and of' } }), { formula: 'shorttitle(3,3)' })).toBe(ANONYMOUS_AUTH);
  });

  it('honours a replacement skip-word list', () => {
    expect(
      generateKey(record({ bibliographic: { title: 'The Effect of Preprints' } }), {
        formula: 'shorttitle(3,3)',
        skipWords: [],
      }),
    ).toBe('TheEffOf');
  });
});

describe('the year segment', () => {
  it('takes the four-digit year of the issued date', () => {
    expect(generateKey(record({ bibliographic: { issuedDate: '2019-04-01' } }), { formula: 'year' })).toBe('2019');
  });

  it('is empty when there is no date, and disambiguation carries the load', () => {
    expect(generateKey(record({ creators: [{ role: 'author', familyName: 'Ravaud' }] }))).toBe('ravaud');
  });
});

describe('the pattern language', () => {
  const rich = record({
    creators: [
      { role: 'author', familyName: 'Ravaud', givenName: 'Philippe' },
      { role: 'author', familyName: 'Boutron', givenName: 'Isabelle' },
      { role: 'author', familyName: 'Créquit', givenName: 'Perrine' },
    ],
    bibliographic: {
      title: 'The Effect of Preprints on Systematic Review Timeliness',
      containerShort: 'J Clin Epidemiol',
      issuedDate: '2019',
      doi: '10.1136/bmj.n71',
    },
  });

  const cases: Array<[string, string]> = [
    ['auth', 'Ravaud'],
    ['auth.lower', 'ravaud'],
    ['auth.upper', 'RAVAUD'],
    ['authors(2)', 'RavaudBoutron'],
    ['authEtal.lower', 'ravaudetal'],
    ['authorLast.lower', 'crequit'],
    ['veryshorttitle', 'Eff'],
    ['title(2,4)', 'TheEffe'],
    ['shortyear', '19'],
    ['journal.abbr', 'JCE'],
    ['journal.lower.condense(-)', 'j-clin-epidemiol'],
    ['doi', '10.1136/bmj.n71'],
    ['shorttitle(3,3).select(1,2)', 'EffPre'],
    ['auth.lower + "x" + year', 'ravaudx2019'],
    ['auth.replace(a,4).lower', 'r4v4ud'],
    ['auth.capitalize', 'Ravaud'],
  ];

  it.each(cases)('%s', (formula, expected) => {
    expect(generateKey(rich, { formula })).toBe(expected);
  });

  it('rejects a function outside the subset, naming the token', () => {
    expect(() => parsePattern('auth.lower + zotero + year')).toThrow(PatternError);
    try {
      parsePattern('auth.lower + zotero + year');
      expect.unreachable('the pattern should have been rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(PatternError);
      expect((error as PatternError).token).toBe('zotero');
      expect((error as PatternError).message).toContain('zotero');
    }
  });

  it('rejects a modifier outside the subset, naming the token', () => {
    try {
      parsePattern('auth.postfix');
      expect.unreachable('the pattern should have been rejected');
    } catch (error) {
      expect((error as PatternError).token).toBe('postfix');
    }
  });

  it('rejects the wrong number of arguments', () => {
    expect(() => parsePattern('auth.replace(a)')).toThrow(PatternError);
    expect(() => parsePattern('year(4)')).toThrow(PatternError);
  });

  it('never silently accepts a pattern it did not understand', () => {
    expect(isValidPattern('auth.lower + shorttitle(3,3) + year')).toBe(true);
    expect(isValidPattern('auth.lower + shorttitle(3,3) +')).toBe(false);
    expect(isValidPattern('')).toBe(false);
  });
});

describe('bijective base 26', () => {
  const cases: Array<[number, string]> = [
    [1, 'a'],
    [2, 'b'],
    [26, 'z'],
    [27, 'aa'],
    [28, 'ab'],
    [52, 'az'],
    [53, 'ba'],
    [702, 'zz'],
    [703, 'aaa'],
  ];

  it.each(cases)('%i is %s', (ordinal, expected) => {
    expect(base26Suffix(ordinal)).toBe(expected);
  });

  it('starts at one', () => {
    expect(() => base26Suffix(0)).toThrow(RangeError);
  });
});

describe('disambiguation', () => {
  const colliding = (id: string, createdAt: string): FormatRecord => ({
    id,
    itemType: 'article',
    createdAt,
    creators: [{ role: 'author', familyName: 'Smith' }],
    bibliographic: { title: 'A Repeated Title', issuedDate: '2019' },
  });

  it('orders by created-at, then by id — never by array order', () => {
    const later = colliding('B', '2026-02-01T00:00:00.000Z');
    const earlier = colliding('A', '2026-01-01T00:00:00.000Z');
    const forwards = disambiguate([earlier, later]);
    const backwards = disambiguate([later, earlier]);
    expect(forwards.map((assignment) => [assignment.id, assignment.key])).toEqual([
      ['A', 'smithRepTit2019'],
      ['B', 'smithRepTit2019a'],
    ]);
    expect(backwards).toEqual(forwards);
  });

  it('breaks a timestamp tie on the id', () => {
    const same = '2026-01-01T00:00:00.000Z';
    const assignments = disambiguate([colliding('Z', same), colliding('A', same)]);
    expect(assignments.map((assignment) => assignment.id)).toEqual(['A', 'Z']);
    expect(assignments.map((assignment) => assignment.suffix)).toEqual(['', 'a']);
  });

  it('runs a, b, … z, aa for a large collision', () => {
    const many = Array.from({ length: 28 }, (_unused, index) =>
      colliding(String(index).padStart(3, '0'), `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`),
    );
    const suffixes = disambiguate(many).map((assignment) => assignment.suffix);
    expect(suffixes.slice(0, 3)).toEqual(['', 'a', 'b']);
    expect(suffixes[26]).toBe('z');
    expect(suffixes[27]).toBe('aa');
  });

  it('never reissues a key the ledger has already seen', () => {
    const assignments = disambiguate([colliding('A', '2026-01-01T00:00:00.000Z')], {
      ledger: ['smithRepTit2019', 'smithRepTit2019a'],
    });
    expect(assignments[0]?.key).toBe('smithRepTit2019b');
  });

  it('leaves a pinned key alone and lets nothing else take it', () => {
    const pinned: FormatRecord = {
      id: 'P',
      itemType: 'article',
      createdAt: '2026-03-01T00:00:00.000Z',
      creators: [{ role: 'author', familyName: 'Smith' }],
      bibliographic: {
        title: 'A Repeated Title',
        issuedDate: '2019',
        citationKey: 'smithRepTit2019',
        citationKeyLocked: true,
      },
    };
    const fresh = colliding('F', '2026-01-01T00:00:00.000Z');
    const assignments = disambiguate([fresh, pinned]);
    const byId = new Map(assignments.map((assignment) => [assignment.id, assignment]));
    expect(byId.get('P')?.key).toBe('smithRepTit2019');
    expect(byId.get('P')?.pinned).toBe(true);
    expect(byId.get('F')?.key).toBe('smithRepTit2019a');
  });

  it('reports drift against the key already on the record', () => {
    const drifted: FormatRecord = {
      id: 'D',
      itemType: 'article',
      createdAt: '2026-01-01T00:00:00.000Z',
      creators: [{ role: 'author', familyName: 'Smith' }],
      bibliographic: { title: 'A Repeated Title', issuedDate: '2019', citationKey: 'oldKey2018' },
    };
    const [assignment] = disambiguate([drifted]);
    expect(assignment?.existing).toBe('oldKey2018');
    expect(assignment?.key).toBe('smithRepTit2019');
    expect(assignment?.changed).toBe(true);
  });

  it('never recomputes a pinned key, even through generateKey', () => {
    const pinned: FormatRecord = {
      id: 'P',
      itemType: 'article',
      bibliographic: { title: 'Something Else Entirely', citationKey: 'legacy:key/1999', citationKeyLocked: true },
    };
    expect(generateKey(pinned)).toBe('legacy:key/1999');
    expect(generateKey(pinned, { respectPinned: false })).toBe('anonSomElsEnt');
  });
});
