@web @product/search-results
Feature: Search Results

  In-space search results display with ranking context and navigation.

  Background:
    Given the web application is loaded
    And a space "projects/test" is open

  Rule: Result layout

    @integration
    Scenario: Results are a single flat list
      When searching for "test" in the space
      Then results are shown in one list
      And no global space grouping is shown
      And the space context remains visible

    @integration
    Scenario: Result shows memory name and tier
      Given a search result for "my-memory" in tier 2
      When the result displays
      Then it shows the memory name "my-memory"
      And a T2 badge is shown

    @integration
    Scenario: Result shows content preview
      Given a search result with matching content
      When the result displays
      Then a content preview is shown with matched terms

    @integration
    Scenario: Highlight matched terms in preview
      When displaying search results
      Then matched terms are highlighted
      And the highlight is implemented without injecting unescaped HTML

    @integration
    Scenario: Result shows confidence and methods
      Given a search result with confidence "high" and methods "trigram, token_set"
      When the result displays
      Then a "High confidence" label is shown
      And the methods are shown as human-readable labels

    @integration
    Scenario: Result shows score as query-relative
      Given a search result with score 0.82
      When the result displays
      Then the score is shown as query-relative
      And the copy does not imply cross-query calibration

  Rule: Navigation

    @integration
    Scenario: Click navigates to the memory and keeps the query
      Given a search result for "my-memory"
      When clicking the result
      Then the memory panel opens
      And the URL keeps the space query

    @integration
    Scenario: Middle click opens the memory URL
      Given a search result card
      When the user middle-clicks the card
      Then the browser opens the memory URL

    @integration
    Scenario: Clear search returns to the list
      Given a search is active
      When the user clears the query
      Then the memory list is shown
      And the search results view is hidden
