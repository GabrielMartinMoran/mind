@web @product/prefers-reduced-motion
Feature: Reduced Motion Accessibility

  Background:
    Given the user has prefers-reduced-motion: reduce set in the OS
    And the web application is loaded

  Rule: No ambient motion

    @integration
    Scenario: No pulse, glow or breathing animations
      When the page renders
      Then there are no ambient pulse, glow or breathing animations

    @integration
    Scenario: Node emphasis is static
      When the neural map renders
      Then node selection and highlighting are static

  Rule: Overlays

    @integration
    Scenario: Memory panel appears instantly
      When a memory is selected
      Then the panel appears without animation

    @integration
    Scenario: Drawer appears instantly
      When the mobile navigation opens
      Then the drawer appears without animation

    @integration
    Scenario: Modal appears instantly
      When a modal is triggered
      Then the modal appears at full scale without animation

    @integration
    Scenario: Toast appears instantly
      When a toast is shown
      Then it appears without slide or fade

  Rule: Loading states

    @integration
    Scenario: Skeleton is static
      When a skeleton is displayed
      Then it does not pulse or shimmer

    @integration
    Scenario: Spinner is static
      When a spinner is displayed
      Then it does not rotate

  Rule: Transitions

    @integration
    Scenario: Hover and focus transitions are instant
      When the user hovers or focuses an interactive element
      Then state changes are immediate
      And no transition is perceptible

    @integration
    Scenario: View toggle switches instantly
      When the user switches between list and map
      Then the state changes immediately
      And no sliding indicator animation plays
