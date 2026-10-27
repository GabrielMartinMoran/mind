@web @product/search-focus
Feature: Search Focus Emphasis

  Search controls use a visible focus ring and no ambient pulse.

  @integration
  Scenario: Search input focus ring
    Given the space search input is visible
    When it receives keyboard focus
    Then a 2px accent focus ring is visible
    And no box-shadow pulse runs

  @integration
  Scenario: Result card focus
    Given a search result card has focus
    Then the focus ring is visible
    And the card is not highlighted only by color

  @integration
  Scenario: Reduced motion
    Given prefers-reduced-motion is reduce
    When the search UI updates
    Then no transition or pulse plays
