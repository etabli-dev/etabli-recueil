/**
 * Creators and their appearances on items (§5.1, §5.2).
 *
 * CR2 is the assertion this file exists for: two creators with different non-null ORCIDs are never
 * merged. Getting that wrong silently fuses two researchers into one, and every co-authorship map
 * built afterwards is wrong in a way nobody notices. IC1's dense ordinals and IC2's role rule are
 * the other two.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ConflictError,
  InvariantError,
  NotFoundError,
  renderInitials,
  renderSortName,
} from '../src/index.js';
import { makeLibrary } from './helpers.js';
import type { TestLibrary } from './helpers.js';

let library: TestLibrary;

beforeEach(() => {
  library = makeLibrary();
});

afterEach(() => {
  library.dispose();
});

const makeItem = (title: string): string =>
  library.library.createItem({ itemType: 'article', bibliographic: { title } }, library.actor).item
    .id;

describe('CreatorService — names and identity', () => {
  it('renders the display name, sort name and initials once, on write', () => {
    const creator = library.creators.create(
      { familyName: 'van Dijk', givenName: 'Anna Maria', namePrefix: null },
      library.actor,
    );
    expect(creator.displayName).toBe('Anna Maria van Dijk');
    expect(creator.sortName).toBe('van dijk, anna maria');
    expect(creator.initials).toBe('A.M.');

    expect(renderSortName({ literalName: 'World Health Organization' })).toBe(
      'world health organization',
    );
    expect(renderInitials('Jean-Pierre')).toBe('J.P.');
  });

  it('requires a literal name for an organisation, and some name for anyone', () => {
    expect(() => library.creators.create({ kind: 'organisation' }, library.actor)).toThrow(
      /literal name/iu,
    );
    expect(() => library.creators.create({ givenName: 'Only given' }, library.actor)).toThrow(
      /family name or a literal name/iu,
    );
  });

  it('normalises an ORCID and refuses a second creator claiming it', () => {
    const creator = library.creators.create(
      { familyName: 'Curie', givenName: 'Marie', orcid: 'https://orcid.org/0000000218250097' },
      library.actor,
    );
    expect(creator.orcid).toBe('0000-0002-1825-0097');
    expect(library.creators.findByOrcid('0000-0002-1825-0097')?.id).toBe(creator.id);

    expect(() =>
      library.creators.create(
        { familyName: 'Curie', givenName: 'M.', orcid: '0000-0002-1825-0097' },
        library.actor,
      ),
    ).toThrow(ConflictError);
  });

  it('finds by the normalised sort name — the deduplicator\'s blocking key', () => {
    const creator = library.creators.create({ familyName: 'Müller', givenName: 'Anna' }, library.actor);
    expect(library.creators.findBySortName('Müller, Anna').map((row) => row.id)).toEqual([creator.id]);
    expect(library.creators.list({ prefix: 'mül' })).toHaveLength(1);
  });
});

describe('CreatorService — appearances on items', () => {
  it('writes a dense author list from zero and rewrites it wholesale on reorder (IC1)', () => {
    const item = makeItem('A paper');
    const first = library.creators.create({ familyName: 'Alpha' }, library.actor);
    const second = library.creators.create({ familyName: 'Beta' }, library.actor);
    const third = library.creators.create({ familyName: 'Gamma' }, library.actor);

    library.creators.setItemCreators(
      item,
      [{ creatorId: first.id }, { creatorId: second.id }, { creatorId: third.id }],
      library.actor,
    );
    expect(library.creators.forItem(item).map((row) => row.appearance.ordinal)).toEqual([0, 1, 2]);

    library.creators.setItemCreators(
      item,
      [{ creatorId: third.id }, { creatorId: first.id }],
      library.actor,
    );
    const after = library.creators.forItem(item);
    expect(after.map((row) => row.appearance.ordinal)).toEqual([0, 1]);
    expect(after.map((row) => row.creator.familyName)).toEqual(['Gamma', 'Alpha']);
  });

  it('allows one creator in two roles but not the same role twice (IC2)', () => {
    const item = makeItem('A collection');
    const person = library.creators.create({ familyName: 'Doe', givenName: 'Jane' }, library.actor);

    expect(() =>
      library.creators.setItemCreators(
        item,
        [
          { creatorId: person.id, role: 'author' },
          { creatorId: person.id, role: 'editor' },
        ],
        library.actor,
      ),
    ).not.toThrow();

    expect(() =>
      library.creators.setItemCreators(
        item,
        [
          { creatorId: person.id, role: 'author' },
          { creatorId: person.id, role: 'author' },
        ],
        library.actor,
      ),
    ).toThrow(InvariantError);
  });

  it('keeps the affiliation on the appearance, not on the person (bibliometrix C1)', () => {
    const item = makeItem('A paper');
    const person = library.creators.create({ familyName: 'Rossi', givenName: 'Luca' }, library.actor);

    library.creators.setItemCreators(
      item,
      [
        {
          creatorId: person.id,
          rawName: 'L. Rossi',
          affiliationRaw: 'Università di Bologna',
          countryCode: 'IT',
          isCorresponding: true,
        },
      ],
      library.actor,
    );

    const [appearance] = library.creators.forItem(item);
    expect(appearance?.appearance.affiliationRaw).toBe('Università di Bologna');
    expect(appearance?.appearance.countryCode).toBe('IT');
    expect(appearance?.appearance.isCorresponding).toBe(true);
    // The person carries no affiliation of their own.
    expect(Object.keys(appearance?.creator ?? {})).not.toContain('affiliationRaw');
  });

  it('lists everything by an author, excluding trashed items, paged by cursor', () => {
    const person = library.creators.create({ familyName: 'Prolific' }, library.actor);
    const ids = Array.from({ length: 4 }, (_value, index) => makeItem(`Paper ${index}`));
    for (const id of ids) library.creators.setItemCreators(id, [{ creatorId: person.id }], library.actor);

    expect(library.creators.listWorks(person.id).data).toHaveLength(4);

    library.library.trashItem(ids[0] as string, library.actor);
    expect(library.creators.listWorks(person.id).data).toHaveLength(3);

    const first = library.creators.listWorks(person.id, { limit: 2 });
    const second = library.creators.listWorks(person.id, {
      limit: 2,
      cursor: first.page.nextCursor as string,
    });
    expect(new Set([...first.data, ...second.data].map((row) => row.id)).size).toBe(3);
  });
});

describe('CreatorService — merge (CR1, CR2)', () => {
  it('refuses to merge two creators with different ORCIDs, and says why (CR2)', () => {
    const first = library.creators.create(
      { familyName: 'Smith', givenName: 'John', orcid: '0000-0002-1825-0097' },
      library.actor,
    );
    const second = library.creators.create(
      { familyName: 'Smith', givenName: 'J.', orcid: '0000-0001-5109-3700' },
      library.actor,
    );

    try {
      library.creators.merge(first.id, second.id, library.actor);
      throw new Error('the merge should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(InvariantError);
      const problem = error as InvariantError;
      expect(problem.detail?.['invariant']).toBe('CR2');
      expect(problem.message).toMatch(/review queue/u);
    }

    // Neither record moved.
    expect(library.creators.get(first.id).trashedAt).toBeNull();
    expect(library.creators.get(second.id).disambiguationStatus).toBe('unreviewed');
  });

  it('merges when only one side has an ORCID, moving appearances and folding name forms', () => {
    const item = makeItem('A paper');
    const other = makeItem('Another paper');
    const winner = library.creators.create(
      { familyName: 'Nakamura', givenName: 'Hiroshi', orcid: '0000-0002-1825-0097' },
      library.actor,
    );
    const loser = library.creators.create({ familyName: 'Nakamura', givenName: 'H.' }, library.actor);

    library.creators.setItemCreators(item, [{ creatorId: loser.id }], library.actor);
    library.creators.setItemCreators(other, [{ creatorId: loser.id }], library.actor);

    const outcome = library.creators.merge(loser.id, winner.id, library.actor);
    expect(outcome.movedAppearances).toBe(2);

    // CR1: merged, pointing at the winner, and trashed.
    const merged = library.creators.get(loser.id, { includeTrashed: true });
    expect(merged.disambiguationStatus).toBe('merged');
    expect(merged.mergedIntoCreatorId).toBe(winner.id);
    expect(merged.trashedAt).not.toBeNull();
    expect(() => library.creators.get(loser.id)).toThrow(NotFoundError);

    // The appearances are the winner's now, and the old spelling stays findable.
    expect(library.creators.listWorks(winner.id).data).toHaveLength(2);
    expect(library.creators.listWorks(loser.id).data).toHaveLength(0);
    expect(outcome.winner.nameVariants).toContain('H. Nakamura');
  });

  it('drops rather than duplicates an appearance the winner already had, and re-densifies (IC1)', () => {
    const item = makeItem('Shared');
    const winner = library.creators.create({ familyName: 'Winner' }, library.actor);
    const loser = library.creators.create({ familyName: 'Loser' }, library.actor);
    const third = library.creators.create({ familyName: 'Third' }, library.actor);

    library.creators.setItemCreators(
      item,
      [{ creatorId: winner.id }, { creatorId: loser.id }, { creatorId: third.id }],
      library.actor,
    );

    library.creators.merge(loser.id, winner.id, library.actor);

    const after = library.creators.forItem(item);
    expect(after.map((row) => row.creator.familyName)).toEqual(['Winner', 'Third']);
    expect(after.map((row) => row.appearance.ordinal)).toEqual([0, 1]);
  });

  it('reverses a merge: restoring the loser puts its appearances back', () => {
    const item = makeItem('A paper');
    const winner = library.creators.create({ familyName: 'Winner' }, library.actor);
    const loser = library.creators.create({ familyName: 'Loser' }, library.actor);
    library.creators.setItemCreators(item, [{ creatorId: loser.id }], library.actor);

    library.creators.merge(loser.id, winner.id, library.actor);
    expect(library.creators.forItem(item).map((row) => row.creator.id)).toEqual([winner.id]);

    library.creators.restore(loser.id, library.actor);
    const restored = library.creators.get(loser.id);
    expect(restored.trashedAt).toBeNull();
    expect(restored.mergedIntoCreatorId).toBeNull();
    expect(restored.disambiguationStatus).toBe('unreviewed');
    expect(library.creators.forItem(item).map((row) => row.creator.id)).toEqual([loser.id]);
  });
});

describe('CreatorService — trash', () => {
  it('refuses to trash a creator who still appears on a live item', () => {
    const item = makeItem('A paper');
    const person = library.creators.create({ familyName: 'Busy' }, library.actor);
    library.creators.setItemCreators(item, [{ creatorId: person.id }], library.actor);

    expect(() => library.creators.trash(person.id, library.actor)).toThrow(ConflictError);
    expect(() => library.creators.trash(person.id, library.actor)).toThrow(/still appears on/u);

    library.creators.setItemCreators(item, [], library.actor);
    expect(() => library.creators.trash(person.id, library.actor)).not.toThrow();
    expect(() => library.creators.get(person.id)).toThrow(NotFoundError);

    library.creators.restore(person.id, library.actor);
    expect(library.creators.get(person.id).trashedAt).toBeNull();
  });
});
