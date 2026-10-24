@web @product/space-overview
Feature: All Spaces Overview

  The All spaces page presents each space with enough signal to choose where to
  go: total memories, tier distribution, description and tags.

  Background:
    Given the web application is loaded
    And spaces with memories exist

  Rule: Space card data

    @contract
    Scenario: Spaces API includes tier counts
      When requesting /api/spaces
      Then each space includes memory_count
      And each space includes tier_counts with t1, t2 and t3
      And the three counts add up to memory_count

    @integration
    Scenario: Card shows the tier spectrum
      Given a space with T1, T2 and T3 memories
      Then the card shows the total memory count
      And the card shows a segmented bar with T1, T2 and T3 colors
      And the card shows the count for each tier
      And the segment widths follow the counts

    @integration
    Scenario: Empty space remains useful
      Given a space with zero memories
      Then the card shows an empty state instead of a colored bar
      And the total is zero

    @integration
    Scenario: Long descriptions and tags do not break the grid
      Given a space with a long description and many tags
      Then the description is clamped
      And tags truncate with a +N count
      And the grid keeps consistent card heights

    @integration
    Scenario: Card links to the space
      When the user activates a space card
      Then the SPA navigates to that space
      And the page does not reload

  Rule: Tier chips

    @integration
    Scenario: Tier counts are passive chips
      Given a space with memories
      Then each tier count is grouped in a non-interactive chip
      And each chip uses its tier color with an emphasized number
      And zero counts are muted
      And the tier label and number remain visually distinct

  Rule: Search spaces locally

    @unit
    Scenario: Search matches across space fields
      Given visible spaces with names, descriptions and tags
      When a query contains multiple words
      Then each word must match somewhere across those fields
      And matching ignores case and accents

    @integration
    Scenario: Search updates the grid without replacing the input
      When the user types in the All spaces search
      Then matching visible spaces and a result count are shown
      And the input keeps its focus, value and caret when spaces refresh
      And neither the URL nor memory search is changed

    @integration
    Scenario: Search query remains when returning from a space
      Given an active All spaces query
      When the user opens a space and returns to All spaces
      Then the query and filtered spaces are restored

    @integration
    Scenario: Query clear restores all visible spaces
      Given an active All spaces query
      When the user activates the in-field clear control
      Then all visible spaces return
      And focus stays in the search input
      And no additional clear button appears in the no-results state

    @integration
    Scenario: All spaces has no scoped storage summary
      Given the user has visited a space
      When the user returns to All spaces
      Then no space-count memory-count embeddings summary appears above the grid
      And the sidebar storage status uses global rather than scoped data

  Rule: Responsive

    @integration
    Scenario: Cards remain readable at 320px
      Given the viewport is 320px wide
      Then the tier spectrum and counts remain visible
      And the page has no horizontal scroll

    @manual
    Scenario: Wide cards use four columns and adapt below desktop width
      Given the viewport is 1680px wide
      Then the All spaces grid has four equal columns
      And card titles have more room to remain readable
      When the viewport narrows below 1360px
      Then the grid adapts its column count to the available width
      And a 320px viewport still shows one column
