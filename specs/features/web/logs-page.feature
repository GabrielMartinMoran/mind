@web @product/logs-page
Feature: Logs Page

  The logs page shows operation audit logs with filters, pagination, details and a bounded live mode.

  Background:
    Given the web application is loaded
    And the logs page is accessible

  Rule: Page layout

    @integration
    Scenario: Clear logs sits inline with the title
      When viewing the logs page
      Then "Clear logs" is on the title row, aligned to the right
      And it keeps its confirmation flow

    @integration
    Scenario: Table scrolls inside the page
      Given the logs page has more rows than the viewport
      Then the table wrapper scrolls vertically
      And the table header stays sticky
      And the page itself does not grow past the main region

  Rule: Log display

    @integration
    Scenario: Logs are listed with operation and timestamp
      When viewing the logs page
      Then each log entry shows the operation and a formatted timestamp

    @integration
    Scenario: Logs show source and level
      When viewing logs
      Then each log shows its source and level as text

    @integration
    Scenario: Logs show input/output data
      When expanding a log entry
      Then input and output data are shown as text
      And error messages are shown when present

    @integration
    Scenario: Details toggle is keyboard accessible
      Given a log entry is collapsed
      When the user activates its Details button
      Then aria-expanded becomes true
      And focus stays on the Details button

  Rule: Filtering

    @integration
    Scenario: Filter by source
      When filtering logs by source "cli"
      Then only cli source logs are requested

    @integration
    Scenario: Filter by operation
      When filtering logs by operation "add_memory"
      Then only matching operations are requested

    @integration
    Scenario: Filter by level
      When filtering logs by level "error"
      Then only error logs are requested

    @integration
    Scenario: Search logs
      When searching logs for "memory_name"
      Then logs containing that term are requested

    @integration
    Scenario: Clear filters
      Given filters are applied
      When clicking clear filters
      Then all logs are requested again
      And the offset resets to 0

    @integration
    Scenario: Filter focus is preserved
      Given a filter control has focus
      When the filter changes and results load
      Then the same filter control keeps focus
      And the status live region keeps its identity

  Rule: Pagination

    @integration
    Scenario: Pagination controls show the range
      When viewing logs with many entries
      Then the range "Showing X–Y of Z logs" is shown
      And Previous/Next are disabled at the edges

    @integration
    Scenario: Navigate to the next page
      Given on page 1
      When clicking next
      Then page 2 is requested with the next offset

  Rule: Live mode

    @integration
    Scenario: Live mode polls only when enabled
      When enabling live mode
      Then logs poll for new entries at the configured interval

    @integration
    Scenario: Live mode pauses while hidden
      Given live mode is enabled
      When the document becomes hidden
      Then no polling requests are made
      And polling resumes when visible

    @integration
    Scenario: Leaving the logs page stops polling
      Given live mode is enabled
      When the user navigates to another view
      Then polling stops

    @integration
    Scenario: Disabling live mode stops polling
      Given live mode is enabled
      When disabling it
      Then no further log requests are made

    @integration
    Scenario: New entries are rendered in live mode
      Given live mode is enabled
      When a poll returns new entries
      Then the list updates without losing filter focus or typed text

  Rule: Bounded DOM

    @integration
    Scenario: Live rows are capped
      Given the logs list exceeds 500 entries
      Then only the newest 500 rows are rendered
      And a notice explains how many older entries are hidden

  Rule: Accessibility

    @integration
    Scenario: Logs table is keyboard scrollable
      Then the table wrapper is focusable and has an accessible name

    @integration
    Scenario: Status changes are announced
      Then load and poll updates use a polite live region
      And the region is not recreated on each update
