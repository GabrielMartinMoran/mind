@web @product/neural-map-filtering
Feature: Neural Map Filtering

  Background:
    Given the web application is loaded
    And a space with memories is open in map view

  Rule: Search highlight

    @integration
    Scenario: Search highlights matches
      Given a search for "auth" returned 3 matches in this space
      When the map renders
      Then the 3 matching nodes are highlighted
      And other nodes are dimmed

    @integration
    Scenario: Match count is announced
      Given the map is filtered
      Then the match count is visible
      And it is announced politely

    @integration
    Scenario: Clearing search restores the map
      Given the map is filtered
      When the search is cleared
      Then all nodes return to the default emphasis

  Rule: Only matches

    @integration
    Scenario: Only matches hides the rest
      Given the "Only matches" toggle is on
      Then only matching nodes and their edges are shown
      And the match count is announced

    @integration
    Scenario: Only matches preserves context edges
      Given two matching nodes are connected
      When "Only matches" is on
      Then the edge between them is visible
      And edges to hidden nodes are hidden

  Rule: Tier filters

    @integration
    Scenario: Tier chips filter nodes
      When the user toggles T3 off
      Then T3 nodes are hidden
      And the chip state is exposed with aria-pressed

    @integration
    Scenario: Tier filters combine with search
      Given T3 is off and a search is active
      Then only matching T1 and T2 nodes are highlighted
      And T3 nodes remain hidden

  Rule: All available nodes

    @integration
    Scenario: Map requests all available nodes
      When the neural map opens
      Then the graph API is called with limit 1000
      And there is no 300-node cap
      And no "Load full graph" action is shown

    @integration
    Scenario: Truncated graph explains missing matches quietly
      Given the backend capped the graph to 1000 of 1200 nodes
      And search matches exist outside the returned set
      Then a quiet notice says how many matches are outside the graph
      And no "Load full graph" button is shown

  Rule: Accessible fallback

    @integration
    Scenario: Memory list mirrors the graph
      Given the map is displayed
      Then a "Memory list" table lists every rendered node
      And each row links to the memory

    @integration
    Scenario: Keyboard navigates nodes
      Given a node has focus
      When the user presses ArrowRight
      Then focus moves to the nearest node to the right
      And Enter opens the memory

    @integration
    Scenario: Graph is a group, not an image
      Given the neural map renders
      Then the SVG has role group and an aria-label
      And nodes are exposed as buttons

    @manual
    Scenario: Screen reader reads the map summary
      Given a screen reader is active
      When the map renders
      Then the graph summary and match count are announced
      And the memory list is reachable by keyboard
