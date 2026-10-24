@web @product/neural-map-emphasis
Feature: Neural Map Selection Emphasis

  Graph selection and filtering use static emphasis, not glow or pulse.

  @integration
  Scenario: Selected node is static
    Given a graph node is selected
    Then it has a visible selected ring
    And no pulse or glow animation plays

  @integration
  Scenario: Search matches are highlighted
    Given a search query matches nodes
    Then matching nodes are highlighted
    And non-matching nodes are dimmed
    And the emphasis is static

  @integration
  Scenario: Dimmed nodes stay legible
    Given a node is dimmed
    Then it remains visible at the design-system dim level
    And it can be restored by clearing the search
