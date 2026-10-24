import { describe, expect, test } from 'bun:test';

import { buildAppUrl, parseAppRoute } from '../src/features/routing/routing.js';

const NO_FILTERS = {
  q: '',
  spaceFilter: null,
  tag: '',
  tiers: [],
  tier: null,
  confidence: null,
  semantic: false,
};

describe('SPA routing contract', () => {
  test('parses home route', () => {
    expect(parseAppRoute('/', '')).toEqual({
      spaceName: null,
      view: 'list',
      memoryName: null,
      ...NO_FILTERS,
    });
  });

  test('parses encoded space, view, and memory from URL', () => {
    expect(parseAppRoute('/spaces/Project%20Alpha', '?view=map&memory=Task%20A')).toEqual({
      spaceName: 'Project Alpha',
      view: 'map',
      memoryName: 'Task A',
      ...NO_FILTERS,
    });
  });

  test('falls back safely for invalid view', () => {
    expect(parseAppRoute('/spaces/demo', '?view=grid')).toEqual({
      spaceName: 'demo',
      view: 'list',
      memoryName: null,
      ...NO_FILTERS,
    });
  });

  test('falls back safely for malformed path or bad encoding', () => {
    expect(parseAppRoute('/spaces', '?view=map')).toEqual({
      spaceName: null,
      view: 'list',
      memoryName: null,
      ...NO_FILTERS,
    });

    expect(parseAppRoute('/spaces/%E0%A4%A', '?memory=abc')).toEqual({
      spaceName: null,
      view: 'list',
      memoryName: null,
      ...NO_FILTERS,
    });
  });

  test('builds canonical home and space URLs', () => {
    expect(buildAppUrl({ spaceName: null, view: 'map', memoryName: 'ignored' })).toBe('/');
    expect(buildAppUrl({ spaceName: 'Project Alpha', view: 'list', memoryName: null })).toBe(
      '/spaces/Project%20Alpha'
    );
    expect(buildAppUrl({ spaceName: 'Project Alpha', view: 'map', memoryName: 'Task A' })).toBe(
      '/spaces/Project%20Alpha?view=map&memory=Task%20A'
    );
  });

  test('targets the canonical home route for All spaces navigation', () => {
    expect(buildAppUrl({ spaceName: null, view: 'list' })).toBe('/');
    expect(parseAppRoute('/', '')).toMatchObject({ spaceName: null, view: 'list' });
  });

  test('preserves memory names with literal percent signs', () => {
    const url = buildAppUrl({
      spaceName: 'Project Alpha',
      view: 'map',
      memoryName: 'Release 100% done',
    });
    expect(url).toBe('/spaces/Project%20Alpha?view=map&memory=Release%20100%25%20done');

    expect(
      parseAppRoute('/spaces/Project%20Alpha', '?view=map&memory=Release%20100%25%20done')
    ).toEqual({
      spaceName: 'Project Alpha',
      view: 'map',
      memoryName: 'Release 100% done',
      ...NO_FILTERS,
    });
  });
});

describe('SPA routing search and filters', () => {
  test('treats /search as an unknown route that canonicalizes to home', () => {
    expect(parseAppRoute('/search', '?q=auth')).toEqual({
      spaceName: null,
      view: 'list',
      memoryName: null,
      ...NO_FILTERS,
    });
    expect(parseAppRoute('/search', '?q=auth&space=projects%2Fmind')).toEqual({
      spaceName: null,
      view: 'list',
      memoryName: null,
      ...NO_FILTERS,
    });
  });

  test('parses filters on a space route', () => {
    expect(
      parseAppRoute(
        '/spaces/projects%2Fmind',
        '?view=map&q=auth&tag=a&tier=3&confidence=low&semantic=on'
      )
    ).toEqual({
      spaceName: 'projects/mind',
      view: 'map',
      memoryName: null,
      q: 'auth',
      spaceFilter: null,
      tag: 'a',
      tiers: [3],
      tier: 3,
      confidence: 'low',
      semantic: true,
    });
  });

  test('drops invalid filter values from space URLs', () => {
    expect(
      parseAppRoute('/spaces/demo', '?tier=9&confidence=extreme&semantic=off&unknown=1')
    ).toEqual({
      spaceName: 'demo',
      view: 'list',
      memoryName: null,
      ...NO_FILTERS,
    });
  });

  test('builds canonical space URLs with filters and omits default list view', () => {
    expect(
      buildAppUrl({
        spaceName: 'Project Alpha',
        view: 'list',
        q: 'auth',
        tag: 'a',
        tier: 1,
        confidence: 'medium',
        semantic: true,
      })
    ).toBe('/spaces/Project%20Alpha?q=auth&tag=a&tier=1&confidence=medium&semantic=on');
  });

  test('drops invalid filter values when building URLs', () => {
    expect(buildAppUrl({ spaceName: 'demo', tier: 9, confidence: 'extreme' })).toBe('/spaces/demo');
    expect(buildAppUrl({ spaceName: 'demo', q: '', spaceFilter: '*' })).toBe('/spaces/demo');
  });

  test('round-trips space search filters through parse and build', () => {
    const url = buildAppUrl({
      spaceName: 'projects/mind',
      q: 'auth flow',
      tag: 'cat:decision',
      tier: 2,
      confidence: 'high',
      semantic: true,
    });
    const [pathname, search] = url.split('?');
    const parsed = parseAppRoute(pathname!, `?${search ?? ''}`);
    expect(parsed).toEqual({
      spaceName: 'projects/mind',
      view: 'list',
      memoryName: null,
      q: 'auth flow',
      spaceFilter: null,
      tag: 'cat:decision',
      tiers: [2],
      tier: 2,
      confidence: 'high',
      semantic: true,
    });
  });

  test('preserves existing logs and encoded deep-link routes', () => {
    expect(parseAppRoute('/logs', '')).toEqual({
      spaceName: null,
      view: 'list',
      memoryName: null,
      isLogsPage: true,
      ...NO_FILTERS,
    });
    expect(parseAppRoute('/spaces/projects%2Ftest', '?memory=my-memory%20name')).toEqual({
      spaceName: 'projects/test',
      view: 'list',
      memoryName: 'my-memory name',
      ...NO_FILTERS,
    });
  });
});

describe('SPA routing multi-tier filters', () => {
  test('exposes the normalized tier list for multi-tier URLs', () => {
    const route = parseAppRoute('/spaces/test', '?tiers=1,3');
    expect(route.tiers).toEqual([1, 3]);
    expect(route.tier).toBeNull();
  });

  test('maps a single tier param to a one-element list', () => {
    const route = parseAppRoute('/spaces/test', '?tier=2');
    expect(route.tiers).toEqual([2]);
    expect(route.tier).toBe(2);
  });

  test('exposes an empty list when no tier filter is present', () => {
    const route = parseAppRoute('/spaces/test', '');
    expect(route.tiers).toEqual([]);
    expect(route.tier).toBeNull();
  });

  test('canonicalizes invalid and duplicate tier values', () => {
    expect(parseAppRoute('/spaces/test', '?tiers=1,9,3').tiers).toEqual([1, 3]);
    expect(parseAppRoute('/spaces/test', '?tiers=3,1,1,3').tiers).toEqual([1, 3]);
    expect(parseAppRoute('/spaces/test', '?tiers=1,2,3').tiers).toEqual([]);
  });

  test('falls back to tier when tiers has no valid value', () => {
    expect(parseAppRoute('/spaces/test', '?tiers=9&tier=2').tiers).toEqual([2]);
  });

  test('builds tier= for one tier and tiers= for two, omitting all', () => {
    expect(buildAppUrl({ spaceName: 'test', tiers: [2] })).toBe('/spaces/test?tier=2');
    expect(buildAppUrl({ spaceName: 'test', tiers: [1, 3] })).toBe('/spaces/test?tiers=1,3');
    expect(buildAppUrl({ spaceName: 'test', tiers: [] })).toBe('/spaces/test');
    expect(buildAppUrl({ spaceName: 'test', tiers: [1, 2, 3] })).toBe('/spaces/test');
  });

  test('round-trips multi-tier filters while keeping the other fields', () => {
    const url = buildAppUrl({
      spaceName: 'test',
      view: 'map',
      memoryName: 'm1',
      q: 'auth',
      tag: 'cat:decision',
      tiers: [1, 3],
      confidence: 'high',
      semantic: true,
    });
    expect(url).toBe(
      '/spaces/test?view=map&memory=m1&q=auth&tag=cat%3Adecision&tiers=1,3&confidence=high&semantic=on'
    );

    const [pathname, search] = url.split('?');
    expect(parseAppRoute(pathname!, `?${search ?? ''}`)).toEqual({
      spaceName: 'test',
      view: 'map',
      memoryName: 'm1',
      q: 'auth',
      spaceFilter: null,
      tag: 'cat:decision',
      tiers: [1, 3],
      tier: null,
      confidence: 'high',
      semantic: true,
    });
  });

  test('canonicalizes invalid tier values when building URLs', () => {
    expect(buildAppUrl({ spaceName: 'test', tiers: [1, 9, 3] })).toBe('/spaces/test?tiers=1,3');
    expect(buildAppUrl({ spaceName: 'test', tiers: [9] })).toBe('/spaces/test');
  });
});
