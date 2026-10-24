@web @product/list-view
Feature: Memory List

  A space's memories are shown as tier-grouped cards with filters and accessible navigation.

  Background:
    Given the web application is loaded
    And a space "test" exists with memories

  Rule: Tier sections

    @integration
    Scenario: T1 section displays hot memories
      Given memories in tier 1
      When the list view renders
      Then a "T1 Hot" section exists
      And T1 memories are listed under it

    @integration
    Scenario: T2 section displays warm memories
      Given memories in tier 2
      When the list view renders
      Then a "T2 Warm" section exists
      And T2 memories are listed under it

    @integration
    Scenario: T3 section displays cold memories
      Given memories in tier 3
      When the list view renders
      Then a "T3 Cold" section exists
      And T3 memories are listed under it

    @integration
    Scenario: Empty tier section shows a message
      Given no memories in tier 1
      When the list view renders
      Then the T1 section shows an empty message
      And the other tiers still render

  Rule: Memory cards

    @integration
    Scenario: New memory belongs beside the space identity
      Given a space is open
      Then New memory is beside the space title on wide screens
      And it is not grouped with the List and Neural Map view switch
      And activating it still opens the new memory dialog

    @integration
    Scenario: View modes pair icons with visible labels
      Given the space view switch renders
      Then List has a list icon and the visible label "List"
      And Neural Map has a node icon and the visible label "Neural Map"
      And aria-pressed still identifies the active view

    @integration
    Scenario: Tier marker aligns with the memory name
      Given a memory card on a wide viewport
      Then the tier dot and tier text are vertically centered with the name on their shared row
      And metadata on that row shares its vertical center
      When the card collapses on a narrow viewport
      Then the tier dot and tier text stay centered with the name

    @integration
    Scenario: Tags use available card width without covering the name
      Given a memory card with several short tags and a long name
      When the card has available horizontal space
      Then the tags expand left from the changed date
      And visible tags are not truncated while room remains
      And the tag group never overlaps the memory name
      When the card becomes width-constrained
      Then the name and tags truncate within their own regions
      And the changed date stays at the right edge

    @integration
    Scenario: Memory card is a link
      Given a memory "test-memory" in space "test"
      When the card renders
      Then the card is an anchor to "/spaces/test?memory=test-memory"
      And the whole card is clickable

    @integration
    Scenario: Card shows name, tier and tags
      Given a memory "test-memory" with tags "cat:decision" in tier 2
      When the card renders
      Then the name "test-memory" is shown
      And a "T2" badge is shown
      And the tag is shown

    @integration
    Scenario: Card shows changed date and pinned state
      Given a memory changed today and pinned
      When the card renders
      Then the changed date is shown
      And a pinned indicator is shown

    @integration
    Scenario: Card hierarchy places tier first and metadata at the right
      Given a memory "test-memory" in tier 2 with tags "cat:decision"
      When the card renders
      Then the tier marker is the first item at the left
      And the name follows
      And the tags and changed date are aligned at the right
      And the card does not contain a pin or unpin button

    @integration
    Scenario: Pinned memory shows a passive indicator
      Given a pinned memory
      When the card renders
      Then a non-interactive pinned indicator is shown
      And pinning is available from the memory panel

    @integration
    Scenario: Card is one compact row on wide viewports
      Given the viewport is at least 860px wide
      Then the tier marker, name, tags and changed date share one row
      And the card height is one content line plus padding
      And a long name truncates instead of wrapping
      And the changed date stays at the right edge
      And the card has no pin or unpin button

    @integration
    Scenario: Card collapses on narrow viewports
      Given the viewport is 360px wide
      Then the card groups wrap or stack
      And the name may wrap
      And the page has no horizontal scroll

    @integration
    Scenario: Selected card keeps its state
      Given a memory card is selected
      When the list re-renders
      Then the card has aria-current or the selected state
      And focus is not lost

  Rule: Filters

    @integration
    Scenario: Tier filter narrows the list
      Given a space with T1 and T3 memories
      When the user activates the T1 chip
      Then only T1 memories are shown
      And the URL includes tier=1

    @integration
    Scenario: Multiple tier chips widen the list
      Given a space with T1, T2 and T3 memories
      When T1 and T3 are active
      Then T1 and T3 memories are shown
      And T2 memories are hidden
      And the URL includes tiers=1,3

    @integration
    Scenario: Tag filter narrows the list
      Given memories with tag "cat:decision" and without it
      When the user filters by "cat:decision"
      Then only tagged memories are shown

    @integration
    Scenario: Clear filters restores the list
      Given a tier or tag filter is active
      When the user clears filters
      Then all memories are shown
      And all three tier chips are active

  Rule: Large spaces

    @integration
    Scenario: First page renders incrementally
      Given a space with 250 memories
      Then the first 100 cards are rendered
      And a "Show more" control is available

    @integration
    Scenario: Show more loads the next page
      Given the first page is rendered
      When the user activates "Show more"
      Then the next page is appended
      And Show more keeps its label beside a decorative icon
      And focus stays on the control or moves to the first new card

  Rule: Async states

    @integration
    Scenario: Loading skeleton preserves layout
      Given the memories are loading
      Then skeletons match the card geometry
      And the list region is aria-busy

    @integration
    Scenario: Empty space shows guidance
      Given the space has no memories
      Then an empty state invites creating a memory
      And Add a memory keeps its label beside a decorative icon

    @integration
    Scenario: No filter matches shows guidance
      Given filters match no memories
      Then an empty state explains how to clear filters

    @integration
    Scenario: Load failure can be retried
      Given the memories request fails
      Then an error message is shown
      And a Retry action keeps its label beside a decorative icon

  Rule: Keyboard

    @integration
    Scenario: Tab reaches every card link
      Given the list is rendered
      When the user tabs through the list
      Then every card link receives focus
      And the focus ring is visible

    @integration
    Scenario: Arrow keys move between cards
      Given a card link has focus
      When the user presses ArrowDown
      Then focus moves to the next card link
      And Enter opens it
