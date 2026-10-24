@web @product/view-toggle
Feature: View Toggle

  The list/map toggle exposes its state and changes immediately or with a short transition.

  @integration
  Scenario: Toggle exposes the active view
    Given the space view is displayed
    Then the list and map buttons expose aria-pressed
    And the active view is announced

  @integration
  Scenario: Arrow keys switch views
    Given the list view button has focus
    When the user presses ArrowRight
    Then the map view is activated
    And focus remains on the toggle

  @integration
  Scenario: Reduced motion
    Given prefers-reduced-motion is reduce
    When the user switches views
    Then the state changes immediately
    And no sliding indicator animation plays

  @integration
  Scenario: No obsolete track element
    Then the toggle does not depend on a view-toggle-track element
