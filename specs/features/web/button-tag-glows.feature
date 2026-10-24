@web @product/button-tag-emphasis
Feature: Button and Tag Emphasis

  Buttons and tags use the refined surface/accent system.

  @integration
  Scenario: Primary button is readable
    Given a primary button renders
    Then it uses the accent background with accent-ink text
    And the text contrast is at least 4.5:1

  @integration
  Scenario: Secondary button uses a boundary
    Given a secondary button renders
    Then its boundary uses the strong line token
    And no glow or gradient is applied

  @integration
  Scenario: Tag chip is readable
    Given a tag chip renders
    Then it shows text with an accessible contrast
    And it does not rely on glow to show state

  @integration
  Scenario: Removable tags expose a named remove action
    Given a removable space or memory tag renders
    Then the tag text remains visible
    And its remove control is a button with a descriptive accessible name
    And the remove icon is hidden from assistive technology

  @integration
  Scenario: Focus ring is visible
    Given a button or tag has keyboard focus
    Then a 2px accent focus ring is visible
    And the focus indicator is not removed

  @integration
  Scenario: Disabled state is clear
    Given a button is disabled
    Then it has a disabled attribute
    And it does not look interactive

  @integration
  Scenario: Logs is visible beside the quieter New space action
    Given the top bar is rendered
    Then Logs has a visible secondary surface and icon
    And New space is a quieter outlined action

  @integration
  Scenario: Destructive triggers do not compete with primary actions
    Given a space header and delete dialog render
    Then Delete space is outlined in the danger color
    And only the final delete confirmation uses a filled danger surface

  @contract
  Scenario: Delete space keeps its label beside the decorative trash icon
    Given the space header renders
    Then Delete space uses the local trash-2 icon
    And the icon is hidden from assistive technology
    And the visible label remains "Delete space"
    And the trigger remains outlined in the danger color
