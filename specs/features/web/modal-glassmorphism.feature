@web @product/modal-surface
Feature: Modal Surface and Focus

  Modals use a solid token surface, a backdrop and visible focus; no glassmorphism.

  @integration
  Scenario: Backdrop separates the dialog
    Given a modal is open
    Then the backdrop is visible
    And no backdrop-filter blur is required

  @integration
  Scenario: Dialog surface is solid
    Given a modal is open
    Then the surface uses the surface token
    And it has a 1px strong border
    And it has no glow or glass effect

  @integration
  Scenario: Dialog focus ring
    Given a modal field has focus
    Then a 2px accent focus ring is visible

  @integration
  Scenario: Reduced motion
    Given prefers-reduced-motion is reduce
    When a modal opens or closes
    Then no scale or fade animation plays
