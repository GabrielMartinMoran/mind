@web @product/memory-panel-motion
Feature: Memory Panel Motion

  The memory panel is a modal dialog with a short state transition and reduced-motion support.

  @integration
  Scenario: Panel opens as a dialog
    When a memory is selected
    Then the panel opens with showModal
    And focus moves inside
    And the transition uses the base motion token

  @integration
  Scenario: Panel closes and returns focus
    Given the memory panel is open
    When the user closes it
    Then it closes
    And focus returns to the card that opened it

  @integration
  Scenario: Reduced motion
    Given prefers-reduced-motion is reduce
    When the panel opens or closes
    Then no animation plays
    And the panel appears or disappears immediately

  @integration
  Scenario: No neon border
    Given the panel is visible
    Then the panel has no neon glow or pulsing border
    And its boundary uses the strong line token
