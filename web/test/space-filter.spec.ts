import { describe, expect, test } from 'bun:test';

import {
  filterVisibleSpaces,
  matchesSpaceQuery,
  normalizeSearchText,
} from '../src/domain/space-filter.js';

const MIND = {
  name: 'projects/mind',
  description: 'Long-term memory engine',
  tags: ['type:project', 'cat:decision'],
};

const DESIGN = {
  name: 'projects/atelier',
  description: 'Design system and tokens',
  tags: ['type:design', 'cat:style'],
};

const HIDDEN = {
  name: 'sessions/mind',
  description: 'Session checkpoints',
  tags: ['type:session'],
  hidden: true,
};

describe('normalizeSearchText', () => {
  test('lowercases and removes diacritics', () => {
    expect(normalizeSearchText('Café Déjà')).toBe('cafe deja');
    expect(normalizeSearchText('MEMÓRIA')).toBe('memoria');
  });

  test('treats missing or nullish input as an empty string', () => {
    expect(normalizeSearchText(undefined)).toBe('');
    expect(normalizeSearchText(null)).toBe('');
  });
});

describe('matchesSpaceQuery', () => {
  test('an empty or whitespace-only query matches every space', () => {
    expect(matchesSpaceQuery(MIND, '')).toBe(true);
    expect(matchesSpaceQuery(MIND, '   ')).toBe(true);
  });

  test('matches by name, description and tags, ignoring case', () => {
    expect(matchesSpaceQuery(MIND, 'MIND')).toBe(true);
    expect(matchesSpaceQuery(MIND, 'memory')).toBe(true);
    expect(matchesSpaceQuery(MIND, 'CAT:DECISION')).toBe(true);
  });

  test('matches accents in either direction', () => {
    const accented = {
      name: 'proyectos/café',
      description: 'Diseño de memoria',
      tags: ['tipo:proyecto'],
    };

    expect(matchesSpaceQuery(accented, 'cafe')).toBe(true);
    expect(matchesSpaceQuery(accented, 'diseno')).toBe(true);
    expect(matchesSpaceQuery({ name: 'memoria' }, 'memória')).toBe(true);
  });

  test('requires every whitespace token to match somewhere across the fields', () => {
    expect(matchesSpaceQuery(MIND, 'mind memory')).toBe(true);
    expect(matchesSpaceQuery(MIND, 'project decision')).toBe(true);
    expect(matchesSpaceQuery(MIND, 'mind missing')).toBe(false);
  });

  test('tokens may match different fields', () => {
    expect(matchesSpaceQuery(MIND, 'mind engine')).toBe(true);
    expect(matchesSpaceQuery(MIND, 'engine decision')).toBe(true);
  });

  test('reports no match when no field contains the token', () => {
    expect(matchesSpaceQuery(MIND, 'embeddings')).toBe(false);
  });
});

describe('filterVisibleSpaces', () => {
  test('excludes hidden spaces and applies the query', () => {
    const spaces = [MIND, DESIGN, HIDDEN];

    expect(filterVisibleSpaces(spaces, '').map(space => space.name)).toEqual([
      'projects/mind',
      'projects/atelier',
    ]);
    expect(filterVisibleSpaces(spaces, 'atelier').map(space => space.name)).toEqual([
      'projects/atelier',
    ]);
    expect(filterVisibleSpaces(spaces, 'session')).toEqual([]);
  });

  test('handles a missing spaces array', () => {
    expect(filterVisibleSpaces(undefined, 'mind')).toEqual([]);
  });
});
