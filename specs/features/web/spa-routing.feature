@web @product/spa-routing
Feature: SPA Routing

  Client-side URL routing with history support, route restoration and in-space search.

  Background:
    Given the web application is loaded

  Rule: URL contract

    @integration
    Scenario: Home route shows all spaces
      When navigating to "/"
      Then the all-spaces view is displayed

    @integration
    Scenario: All spaces is the first sidebar navigation item
      Given the home page is displayed
      Then "All spaces" is the first item under Spaces
      And it is marked as the current page
      And the topbar does not show an "Atlas / All spaces" breadcrumb
      When opening a space
      Then "All spaces" is no longer current
      When activating "All spaces"
      Then the URL is "/"
      And the all-spaces view is displayed

    @integration
    Scenario: Space route shows memories
      When navigating to "/spaces/projects/test"
      Then the memories for that space are displayed

    @integration
    Scenario: Space with list view param
      When navigating to "/spaces/projects/test?view=list"
      Then the list view is shown

    @integration
    Scenario: Space with map view param
      When navigating to "/spaces/projects/test?view=map"
      Then the neural map is shown

    @integration
    Scenario: Space with memory param opens panel
      When navigating to "/spaces/projects/test?memory=my-memory"
      Then the memory panel opens for "my-memory"

    @integration
    Scenario: Space with a search query shows in-space search
      When navigating to "/spaces/projects/test?q=auth"
      Then the space search view is shown inside the space
      And the header search input contains "auth"
      And the memory list is hidden

    @integration
    Scenario: Space with search filters
      When navigating to "/spaces/projects/test?q=auth&tier=2&tag=cat:decision&confidence=high"
      Then the query "auth" and the filters are active in the space search

    @integration
    Scenario: Space with multiple tier filters
      When navigating to "/spaces/projects/test?tiers=1,3"
      Then T1 and T3 chips are active
      And T2 is not active
      And the list shows only T1 and T3 memories

    @integration
    Scenario: Invalid multi-tier values are canonicalized
      When navigating to "/spaces/projects/test?tiers=1,9,3"
      Then the T9 value is removed
      And the URL is canonicalized to "tiers=1,3"

    @integration
    Scenario: Global search route canonicalizes
      When navigating to "/search?q=auth"
      Then the URL is canonicalized to "/" or the current space
      And no global search page is shown

    @integration
    Scenario: Encoded space names in URL
      When navigating to "/spaces/projects%2Ftest"
      Then the space "projects/test" is shown

    @integration
    Scenario: Encoded memory names in URL
      When navigating to "/spaces/test?memory=my-memory%20name"
      Then the memory "my memory name" panel opens

  Rule: pushState on navigation

    @integration
    Scenario: Clicking a space updates URL with pushState
      Given the home page is displayed
      When clicking on space "projects/test"
      Then the URL changes to "/spaces/projects/test"
      And pushState is used (no page reload)

    @integration
    Scenario: View toggle updates URL
      Given viewing space "test"
      When switching to neural map view
      Then the URL updates to include "?view=map"

    @integration
    Scenario: Selecting memory updates URL
      Given viewing space "test"
      When clicking memory "my-memory"
      Then the URL updates to include "?memory=my-memory"

    @integration
    Scenario: Searching in a space updates URL
      Given viewing space "test"
      When typing "auth" in the space search
      Then the URL updates to include "?q=auth"
      And the space search view stays in context

  Rule: popState on browser back/forward

    @integration
    Scenario: Browser back navigates to previous route
      Given navigated to "/spaces/test"
      When pressing the browser back button
      Then the URL changes to the previous route
      And the UI updates without reload

    @integration
    Scenario: Browser forward navigates forward
      Given navigated back to previous page
      When pressing the browser forward button
      Then the URL changes to the next route

    @integration
    Scenario: popState restores correct view state
      Given navigated to "/spaces/test?view=map"
      When pressing back
      Then the list view is restored
      And the URL is "/spaces/test"

    @integration
    Scenario: Back restores previous space search
      Given the user searched "auth" then "graph" in a space
      When pressing back
      Then the results for "auth" are restored

  Rule: Route restoration on reload

    @integration
    Scenario: Reload restores current route
      Given viewing "/spaces/test?view=map"
      When reloading the page
      Then the same view is restored
      And the map view is shown

    @integration
    Scenario: Reload restores memory panel
      Given viewing "/spaces/test?memory=my-memory"
      When reloading the page
      Then the memory panel is open

    @integration
    Scenario: Reload restores in-space search
      Given viewing "/spaces/test?q=auth&tier=2"
      When reloading the page
      Then the query is "auth"
      And the T2 filter is active
      And the search view is inside the space

    @integration
    Scenario: Invalid route falls back to home
      When navigating to an invalid route
      Then the URL is canonicalized to a valid route
      And the home page is shown

    @integration
    Scenario: Invalid filter values are canonicalized
      When navigating to "/spaces/test?q=auth&tier=9"
      Then the tier filter is removed
      And the URL is canonicalized

  Rule: Deep linking

    @integration
    Scenario: Direct URL to space works
      When opening "/spaces/projects/test" directly
      Then the correct space and view are shown

    @integration
    Scenario: Direct URL with memory param works
      When opening "/spaces/test?memory=my-memory" directly
      Then the memory panel opens

    @integration
    Scenario: Direct URL with in-space search works
      When opening "/spaces/test?q=auth&tier=2" directly
      Then the space search opens with the query and filter
