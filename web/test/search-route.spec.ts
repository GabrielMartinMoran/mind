import { describe, expect, test } from 'bun:test';

import { buildResultUrl, hasSearchCriteria, resolveSearchView } from '../src/app/search-route.js';
import { parseAppRoute } from '../src/features/routing/routing.js';

const NO_FILTERS = {
  q: '',
  spaceFilter: null,
  tag: '',
  tier: null,
  confidence: null,
  semantic: false,
};

interface ResultFixture {
  id: string;
  space_name: string;
  name: string;
  tier?: number;
}

function result(overrides: Partial<ResultFixture> = {}): ResultFixture {
  return {
    id: 'id-1',
    space_name: 'projects/mind',
    name: 'mcp-agent-identity',
    tier: 2,
    ...overrides,
  };
}

function searchState(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    query: '',
    filters: { space: '*', tag: null, tier: null, confidence: null },
    semantic: false,
    spaceMode: false,
    currentSpace: null,
    ...overrides,
  };
}

describe('resolveSearchView', () => {
  test('never treats /search as a search surface', () => {
    expect(resolveSearchView(parseAppRoute('/search', '?q=auth'))).toEqual({
      showSearch: false,
      spaceMode: false,
      currentSpace: null,
    });
  });

  test('opens the search view in space mode when a space route carries a query or confidence', () => {
    for (const search of ['?q=auth', '?confidence=high']) {
      expect(resolveSearchView(parseAppRoute('/spaces/projects%2Fmind', search))).toEqual({
        showSearch: true,
        spaceMode: true,
        currentSpace: { name: 'projects/mind' },
      });
    }
  });

  test('keeps tier/tag-only space routes on the list view', () => {
    for (const search of ['?tier=2', '?tag=cat%3Adecision', '?tier=1&tag=cat%3Adecision']) {
      expect(resolveSearchView(parseAppRoute('/spaces/projects%2Fmind', search))).toEqual({
        showSearch: false,
        spaceMode: false,
        currentSpace: null,
      });
    }
  });

  test('keeps the space detail view when a space route has no search filters', () => {
    expect(resolveSearchView(parseAppRoute('/spaces/projects%2Fmind', '?view=map'))).toEqual({
      showSearch: false,
      spaceMode: false,
      currentSpace: null,
    });

    // `semantic` alone is not a search criterion.
    expect(resolveSearchView(parseAppRoute('/spaces/projects%2Fmind', '?semantic=on'))).toEqual({
      showSearch: false,
      spaceMode: false,
      currentSpace: null,
    });
  });

  test('never opens the search view for home or logs', () => {
    for (const [pathname, search] of [
      ['/', ''],
      ['/', '?q=auth'],
      ['/logs', ''],
      ['/logs', '?q=auth'],
    ]) {
      expect(resolveSearchView(parseAppRoute(pathname, search))).toEqual({
        showSearch: false,
        spaceMode: false,
        currentSpace: null,
      });
    }
  });
});

describe('hasSearchCriteria', () => {
  test('accepts q and confidence only; tier/tag are list filters', () => {
    expect(hasSearchCriteria({ ...NO_FILTERS, q: 'auth' })).toBe(true);
    expect(hasSearchCriteria({ ...NO_FILTERS, q: '   ' })).toBe(false);
    expect(hasSearchCriteria({ ...NO_FILTERS, tag: 'cat:decision' })).toBe(false);
    expect(hasSearchCriteria({ ...NO_FILTERS, tier: 2 })).toBe(false);
    expect(hasSearchCriteria({ ...NO_FILTERS, confidence: 'high' })).toBe(true);
  });

  test('ignores semantic, space filters and invalid values', () => {
    expect(hasSearchCriteria({ ...NO_FILTERS, semantic: true })).toBe(false);
    expect(hasSearchCriteria({ ...NO_FILTERS, spaceFilter: 'projects/mind' } as any)).toBe(false);
    expect(hasSearchCriteria({ ...NO_FILTERS, tier: 9 })).toBe(false);
    expect(hasSearchCriteria({ ...NO_FILTERS, confidence: 'extreme' })).toBe(false);
    expect(hasSearchCriteria(undefined)).toBe(false);
  });
});

describe('buildResultUrl', () => {
  test('builds the memory URL with encoded space and name', () => {
    expect(
      buildResultUrl(
        result({ space_name: 'projects/arcana web', name: 'Release 100% done' }),
        searchState()
      )
    ).toBe('/spaces/projects%2Farcana%20web?memory=Release%20100%25%20done');
  });

  test('preserves the active query, filters and semantic flag', () => {
    const url = buildResultUrl(
      result(),
      searchState({
        query: 'auth flow',
        filters: {
          space: '*',
          tag: 'cat:decision',
          tier: 2,
          confidence: 'high',
        },
        semantic: true,
      })
    );

    expect(url).toBe(
      '/spaces/projects%2Fmind?memory=mcp-agent-identity&q=auth%20flow&tag=cat%3Adecision&tier=2&confidence=high&semantic=on'
    );
  });

  test('omits empty and default values', () => {
    expect(
      buildResultUrl(
        result(),
        searchState({
          query: '   ',
          filters: { space: 'projects/mind', tag: '', tier: null, confidence: null },
          semantic: false,
        })
      )
    ).toBe('/spaces/projects%2Fmind?memory=mcp-agent-identity');

    expect(
      buildResultUrl(
        result(),
        searchState({
          filters: { space: '*', tag: null, tier: 9, confidence: 'unknown' },
        })
      )
    ).toBe('/spaces/projects%2Fmind?memory=mcp-agent-identity');
  });

  test('round-trips through the routing parser', () => {
    const url = buildResultUrl(
      result(),
      searchState({ query: 'auth', filters: { space: '*', tag: 'a', tier: 1, confidence: 'low' } })
    );
    const [, search] = url.split('?');

    expect(parseAppRoute('/spaces/projects%2Fmind', `?${search ?? ''}`)).toEqual({
      spaceName: 'projects/mind',
      view: 'list',
      memoryName: 'mcp-agent-identity',
      q: 'auth',
      spaceFilter: null,
      tag: 'a',
      tiers: [1],
      tier: 1,
      confidence: 'low',
      semantic: false,
    });
  });
});
