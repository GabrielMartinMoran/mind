@web @product/sidebar-emphasis
Feature: Sidebar Emphasis

  The sidebar uses the refined Memory Atlas emphasis system: no neon glow, no ambient pulse.

  @integration
  Scenario: Logo uses a quiet accent
    Given the sidebar is visible
    Then the logo has no neon glow or pulse animation

  @integration
  Scenario: Space item hover uses surface emphasis
    Given the sidebar shows a list of spaces
    When the user hovers over a space item
    Then the item background changes to the raised surface
    And no glow is applied

  @integration
  Scenario: Active space uses an accent bar
    Given a space is currently selected
    When the sidebar renders the active space item
    Then the item is marked aria-current="page"
    And it has a 2px accent edge
    And focus is visible

  @integration
  Scenario: Search input focus uses a visible ring
    Given the space search input is visible
    When the user focuses it
    Then a 2px accent focus ring is visible
    And no pulse animation plays

  @integration
  Scenario: Count badges use text and a subtle surface
    Given a space item is displayed with a count badge
    Then the count is shown as text
    And its background uses the raised surface
    And it has no glow
