@web @product/responsive-navigation
Feature: Responsive Navigation

  Background:
    Given the web application is loaded

  Rule: Landmarks and skip link

    @integration
    Scenario: Skip link moves focus to main
      When the user presses Tab once
      Then a "Skip to content" link is visible
      And activating it focuses the main region

    @integration
    Scenario: Page exposes landmarks
      Then there is a banner, navigation and main landmark
      And the current view has exactly one h1

  Rule: Mobile drawer

    @integration
    Scenario: Menu button is outside the drawer
      Given the viewport is 375px wide
      Then the menu button is visible in the top bar

    @integration
    Scenario: Open navigation
      Given the viewport is 375px wide
      When the user activates the menu button
      Then the navigation drawer opens
      And focus moves into the drawer
      And the page behind is inert

    @integration
    Scenario: Close navigation with Escape
      Given the navigation drawer is open
      When the user presses Escape
      Then the drawer closes
      And focus returns to the menu button

    @integration
    Scenario: Close navigation after choosing a space
      Given the navigation drawer is open
      When the user activates a space link
      Then the drawer closes
      And the space view opens without a page reload

  Rule: Space navigation

    @integration
    Scenario: Space item is a link
      Given the space list is rendered
      Then each space is an anchor with an href
      And the active space has aria-current="page"

    @integration
    Scenario: Space link works with keyboard
      Given a space link has focus
      When the user presses Enter
      Then the space view opens without a page reload

    @integration
    Scenario: Compact topbar actions remain named
      Given the viewport is 320px wide
      Then New space and Logs remain visible icon actions
      And each icon-only action has a descriptive accessible name
      And each icon is hidden from assistive technology

    @integration
    Scenario: Compact New memory action remains named
      Given a space is open at a 320px viewport
      Then New memory remains beside the space title as an icon action
      And the action has a descriptive accessible name
      And its icon is hidden from assistive technology

  Rule: View toggle

    @integration
    Scenario: View toggle exposes state
      Given the space view is displayed
      Then the list and map buttons expose aria-pressed
      And the active view is announced

    @integration
    Scenario: Arrow keys switch views
      Given the list view button has focus
      When the user presses ArrowRight
      Then the map view is activated
      And focus remains on the view toggle
