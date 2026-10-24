@web @product/accessibility
Feature: Web Accessibility

  Background:
    Given the web application is loaded

  Rule: Keyboard

    @integration
    Scenario: Core journey is keyboard-only
      Given the user only uses the keyboard
      Then they can reach search, open a result, close the panel, switch views and open logs
      And focus is always visible

    @integration
    Scenario: Focus returns after closing overlays
      Given a dialog or drawer is open
      When the user closes it
      Then focus returns to the control that opened it

  Rule: Dynamic announcements

    @integration
    Scenario: Result and filter changes are announced
      Given a live region is present
      When results or filters change
      Then the change is announced politely
      And focus is not stolen

    @manual
    Scenario: Screen reader identifies dialogs
      Given a screen reader is active
      When the memory panel opens
      Then its name and modal state are announced

  Rule: Zoom and reflow

    @manual
    Scenario: 200% zoom has no horizontal scroll
      Given the browser is at 200% zoom
      When viewing the home, search, space and map views
      Then content reflows without horizontal scrolling

    @manual
    Scenario: Touch targets are usable
      Given a touch device
      Then primary controls are at least 24px and preferably 44px
      And no control is reachable only by hover

  Rule: Contrast

    @contract
    Scenario: Tokens meet AA
      Then text tokens meet 4.5:1
      And UI and focus tokens meet 3:1
