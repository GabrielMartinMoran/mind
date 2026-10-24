@web @product/memory-panel
Feature: Memory Panel

  The memory panel is a modal dialog with safe content, keyboard focus and all memory actions.

  Background:
    Given the web application is loaded
    And a space "test" with a memory "test-memory" exists

  Rule: Dialog behavior

    @integration
    Scenario: Panel opens as a modal dialog
      When clicking memory "test-memory"
      Then the panel has role dialog and aria-modal true
      And it is labelled by the memory name

    @integration
    Scenario: Focus moves into the panel
      Given the panel is open
      Then focus is inside the panel
      And the background is inert

    @integration
    Scenario: Escape closes the panel
      Given the panel is open
      When the user presses Escape
      Then the panel closes
      And focus returns to the card that opened it

    @integration
    Scenario: Click outside closes the panel
      Given the panel is open
      When the user clicks the backdrop
      Then the panel closes

    @integration
    Scenario: Rapid selection does not race
      Given memory A is loading
      When memory B is opened
      Then A's response is ignored
      And B is shown

  Rule: Content

    @integration
    Scenario: Panel shows name, tier, tags and content
      Given a memory "my-memory" in tier 2 with tags "cat:decision"
      When the panel opens
      Then the name, T2 badge, tags and content are shown

    @integration
    Scenario: JSON content is prettified
      Given a memory whose content is a valid JSON object
      When the panel renders
      Then the JSON is shown with 2-space indentation
      And keys and value types are visually distinct
      And the raw JSON remains copyable as text

    @unit
    Scenario: Invalid JSON falls back to text
      Given content starts with "{" but is not valid JSON
      When the panel renders
      Then it falls back to the normal text/markdown renderer

    @integration
    Scenario: Markdown renders safely
      Given content with headings, lists and code
      When the panel renders
      Then the formatted markup is shown

    @unit
    Scenario: Raw HTML is sanitized
      Given content with a script tag
      When the panel renders
      Then the script is not executed
      And only allowlisted markup remains

    @unit
    Scenario: Unsafe link schemes are removed
      Given content with a javascript: link
      When the panel renders
      Then the link has no href

    @integration
    Scenario: Long JSON wraps instead of scrolling horizontally
      Given a JSON memory with a long string value
      When the panel renders at 320px and 1280px
      Then the JSON wraps inside the panel width
      And there is no horizontal scrollbar
      And the 2-space indentation is preserved

    @integration
    Scenario: Long content scrolls within the panel
      Given a very long memory
      When the panel renders
      Then the panel body scrolls
      And the header actions remain reachable

  Rule: Actions

    @integration
    Scenario: Edit and save
      Given the panel is open
      When the user edits and saves
      Then PATCH is called
      And the panel shows the updated content

    @integration
    Scenario: Cancel edit restores content
      Given the panel is in edit mode
      When the user cancels
      Then the original content is shown

    @integration
    Scenario: Pin toggles pinned state
      Given a memory is not pinned
      When the user pins it
      Then the memory becomes pinned
      And the indicator updates

    @integration
    Scenario: Promote and demote update the tier
      Given a memory in tier 2
      When the user promotes it
      Then the memory moves to tier 1
      And the badge updates

    @integration
    Scenario: Add and remove tags
      Given the panel is open
      When the user adds a tag and later removes it
      Then both changes are persisted

    @integration
    Scenario: Delete requires confirmation
      Given a memory exists
      When the user deletes it
      Then a confirmation dialog appears
      And confirming removes the memory and closes the panel

  Rule: Async states

    @integration
    Scenario: Loading state preserves layout
      Given the memory is loading
      Then the panel shows a skeleton
      And it is aria-busy

    @integration
    Scenario: Error state can be retried
      Given the memory request fails
      Then an error message is shown
      And a retry action is available

  Rule: Responsive and motion

    @integration
    Scenario: Mobile panel is full-screen
      Given the viewport is 375px wide
      When the panel opens
      Then it covers the viewport
      And it has a visible close button

    @integration
    Scenario: Reduced motion opens instantly
      Given prefers-reduced-motion is reduce
      When the panel opens or closes
      Then no animation plays
