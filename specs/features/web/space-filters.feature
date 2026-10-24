@web @product/space-filters
Feature: Space Filters

  One filter bar in the open-space context drives list, map and in-space search.
  Tier chips are inclusive: every active tier is shown; all three active means
  all tiers.

  Background:
    Given a space "test" is open

  Rule: One filter bar

    @integration
    Scenario: List and map share the same filters
      When the user switches between list and neural map
      Then the search, tag and tier filters keep their state
      And the filter bar stays in the same place

    @integration
    Scenario: Search input is part of the filter bar
      Then the space search input is in the filter bar
      And typing filters the current view

    @integration
    Scenario: Controls share one row and center line at 1280
      Given a search query is active at 1280px
      Then search, tag, tier chips, confidence, embeddings and Clear filters share one row
      And their vertical centers align
      And no visible field label pushes a control below the row

    @integration
    Scenario: Compact search leaves room for filters
      Given a search query is active at 1280px
      Then the search field is at most 320px wide
      And the filter bar stays one row

    @manual
    Scenario: Wide viewports give search and filters more room
      Given the space view is open at 1680px wide
      Then the search field uses a 340px basis
      And the primary filter controls have 12px gaps
      And the filter bar stays on one row

    @integration
    Scenario: Contextual controls do not change the row rhythm
      Given the list or map view is active
      Then confidence and embeddings are not shown
      And the visible filter controls keep the same height and alignment

    @integration
    Scenario: Tier filters are colored chips
      Then the tier filter shows T1, T2 and T3 chips
      And each chip uses its tier color and text
      And each chip exposes aria-pressed
      And multiple chips can be active at once
      And all three active means all tiers

    @integration
    Scenario: Selecting multiple tiers filters list and search
      Given T1 and T3 are active
      When the user views the list or searches
      Then only T1 and T3 memories are eligible
      And the request includes tiers=1,3
      And the URL includes tiers=1,3

    @integration
    Scenario: Selecting one tier keeps the single-tier URL
      Given only T2 is active
      Then the request includes tier=2
      And the URL includes tier=2

    @integration
    Scenario: Tag filter is shared
      When the user sets a tag filter
      Then the memory list and search results use that tag
      And the map keeps the tag filter state

    @integration
    Scenario: Tag filter is a select populated by the current space
      Given the current space has memory tags
      Then the Tag control is a native select
      And it contains "All tags" and each distinct memory tag
      And arbitrary free-text tag values cannot be entered
      When the user selects a tag
      Then list and search use the selected tag
      And the map keeps the selected tag in shared filter state

    @integration
    Scenario: Only matches is map-only
      Given the list view is active
      Then the "Only matches" toggle is not shown
      When the user switches to the map
      Then "Only matches" is shown in the same filter bar

    @integration
    Scenario: Search-specific filters use the same style
      Given a search query is active
      Then confidence and embeddings controls use the shared filter styles
      And they live in the same filter bar

  Rule: One clear action

    @integration
    Scenario: Clear filters is the only reset action
      Given a query, tag, multiple tiers, confidence and embeddings are active
      When the user activates "Clear filters"
      Then the query, tag, tiers, confidence, embeddings and only-matches are reset
      And all three tier chips are active again
      And no second clear action is shown in the empty state

    @integration
    Scenario: The in-field X clears only the query
      Given a query and tier filters are active
      When the user activates the in-field clear button
      Then the query is empty
      And the tier filters remain active

    @integration
    Scenario: Empty state does not duplicate reset actions
      Given no memories match the filters
      Then the empty state explains how to broaden the search
      And it does not show its own clear button

    @integration
    Scenario: Reset zoom is not a filter reset
      Given the map view is active
      Then "Reset zoom" only resets pan and zoom
      And it does not change the shared filters

  Rule: Responsive

    @integration
    Scenario: Filter bar wraps without overflow
      Given the viewport is 320px wide
      Then the filter bar wraps into rows
      And the page has no horizontal scroll

    @manual
    Scenario: Compact space controls preserve results at 320x700
      Given the viewport is 320x700
      When the map and shared filter bar are visible
      Then Delete space keeps an accessible name and visible label
      And the results body is at least 120px tall
      And the page has no horizontal scroll
