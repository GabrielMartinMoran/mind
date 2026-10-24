@web @product/unified-search
Feature: In-Space Unified Search

  Search lives inside the open space, uses the same pipeline/ranking as MCP, and exposes filters in the URL.

  Background:
    Given the web application is loaded
    And a space "test" is open

  Rule: Query and filters

    @integration
    Scenario: Space search calls the unified endpoint
      When the user searches for "mcp" in the space header
      Then the app requests /api/search with q=mcp and space=test
      And results show name, snippet, tier, confidence and methods
      And the search view is rendered inside the space

    @integration
    Scenario: Filters combine
      Given the user selects tier T2 and tag cat:decision
      When searching for "auth"
      Then the request includes q=auth, space=test, tier=2 and tag=cat:decision

    @integration
    Scenario: Confidence filter is applied
      Given the user selects confidence high
      When searching
      Then only high-confidence results are shown
      And the total reflects the filtered set

    @unit
    Scenario: Invalid filter values are ignored
      Given a URL with tier=9
      Then the tier filter is omitted
      And the URL is canonicalized

    @integration
    Scenario: Clearing the query restores the memory list
      Given the query is "auth" and tier T2 is active
      When the user activates the in-field clear button
      Then the query is empty
      And the memory list is shown again
      And the tier filter remains active

    @integration
    Scenario: Clear filters resets query and filters
      Given the query and filters are active
      When the user activates "Clear filters"
      Then the query and filters are reset

  Rule: In-space URL state

    @contract
    Scenario: Search state survives reload
      Given the URL is /spaces/test?q=auth&tier=2
      When the page reloads
      Then the query is "auth"
      And the T2 filter is active
      And the search view is inside the space

    @integration
    Scenario: Back restores previous search
      Given the user searches for "auth" then "graph"
      When the user presses Back
      Then the results for "auth" are restored

    @integration
    Scenario: Global search route is gone
      When navigating to "/search?q=auth"
      Then the URL is canonicalized to "/" or the current space
      And no global search page is shown

  Rule: Result cards

    @integration
    Scenario: Whole card is a link
      Given a result for memory "mcp-agent-identity"
      Then the card is an anchor to the memory URL
      And pressing Enter opens the memory panel
      And the space query is preserved in the URL

    @integration
    Scenario: Result cards have no nested tag action
      Given a search result card
      Then the card remains a single link
      And tag filtering is controlled by the shared Tag select

    @integration
    Scenario: Result shows why it matched
      Given a search result with confidence and methods
      Then the card shows the confidence label
      And the card shows human-readable methods
      And the card shows the score without implying cross-query calibration

  Rule: Async states

    @integration
    Scenario: Stale responses are discarded
      Given a slow request for "auth"
      When the user types "graph" before it resolves
      Then the "auth" response is ignored
      And the "graph" results are shown

    @integration
    Scenario: Loading state preserves layout
      Given a search request is in flight
      Then skeletons match the result card geometry
      And the results region is aria-busy

    @integration
    Scenario: Long results scroll inside the space view
      Given a search returns more results than fit in the available space
      Then the results list scrolls vertically inside its region
      And the shared filter bar remains visible
      And the page does not clip the remaining results

    @integration
    Scenario: Empty search shows guidance
      Given no results match
      Then an empty state explains how to broaden the search
      And the result count is announced

    @integration
    Scenario: Search failure can be retried
      Given the search request fails
      Then an error message explains the failure
      And a retry action is available

  Rule: Pagination

    @integration
    Scenario: Load more appends results
      Given the first page returned 30 results and more exist
      When the user activates "Load more"
      Then the next page is requested with offset 30
      And the new results are appended

    @contract
    Scenario: Total count is exposed
      Given a search response
      Then X-Total-Count and X-Has-More headers are present
      And the UI uses them to show the result range

  Rule: MCP parity and embeddings

    @contract
    Scenario: Web ranking matches MCP
      Given the same corpus and query
      When the web searches with semantic=on and MCP memory_query searches
      Then both return the same order, score, confidence and methods

    @integration
    Scenario: Embeddings are off by default
      Given the search filters are shown
      Then "Use embeddings" is off
      And the request includes semantic=off

    @integration
    Scenario: Enabling embeddings uses the semantic channel
      Given the server has RAG enabled
      When the user turns on "Use embeddings"
      Then the request includes semantic=on
      And semantic-only matches can appear

    @integration
    Scenario: Embeddings toggle is disabled without RAG
      Given the server reports rag_enabled=false
      Then "Use embeddings" is disabled
      And an explanation is shown

  Rule: Context and keyboard

    @integration
    Scenario: Search stays in the open space
      Given the user is viewing space "test"
      When the user types a query
      Then the space header and view toggle remain visible
      And the results are inside the space

    @integration
    Scenario: Map search keeps the map visible
      Given the user is viewing the neural map for space "test"
      When the user types a query
      Then the map stays visible
      And matching nodes are highlighted

    @integration
    Scenario: One clear button sits inside the search field
      Given the space search is shown
      Then the custom clear button is always visible inside the input's right edge
      And the native search clear control is not shown
      When the user activates it with a query
      Then it clears the query and restores the memory list

    @integration
    Scenario: Slash focuses the space search
      Given the user is viewing a space and focus is not in a text field
      When the user presses "/"
      Then the space search input receives focus

    @integration
    Scenario: Arrow keys move through results
      Given the search results are displayed
      When the user presses ArrowDown
      Then focus moves to the next result
      And Enter opens it

    @manual
    Scenario: Screen reader announces result count
      Given a screen reader is active
      When results update
      Then the count is announced politely
      And focus is not moved
