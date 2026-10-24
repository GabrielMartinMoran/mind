@web @product/tier-emphasis
Feature: Tier Section Emphasis

  Tier sections use color plus text, not ambient glow.

  @integration
  Scenario: Tier sections show labels
    Given memories in T1, T2 and T3
    When the list renders
    Then each section shows T1, T2 or T3 text
    And the tier color is paired with the text

  @integration
  Scenario: Active tier section uses a quiet accent
    Given a tier section is active
    Then it shows an accent edge or label emphasis
    And no pulse animation plays

  @integration
  Scenario: Tier badge is readable
    Given a tier badge renders
    Then it has text and a border
    And its contrast meets the design-system thresholds
