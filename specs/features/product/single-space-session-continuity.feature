@product_single_space @product_tiering @product_recovery @product_automation
Feature: Single-space session continuity

  Scenario: checkpoints close into same-space session summaries
    Given a project continuity space "projects/mind"
    And an active checkpoint exists in that project space
    When the checkpoint is completed
    Then a same-space memory named "session-*" is created in "projects/mind"
    And the summary memory has tags ["type:session", "cat:summary"]

  Scenario: session summaries default to T3
    Given a completed checkpoint in "projects/mind"
    When the session summary is created
    Then the summary memory is stored at tier 3

  Scenario: recovery prefers same-space continuity artifacts
    Given active checkpoints and session summaries live in "projects/mind"
    When continuity is recovered for the project
    Then same-space session summaries are consulted before legacy compatibility paths

  Scenario: OpenCode prudent automation writes same-space summaries
    Given OpenCode prudent automation persists a session-end summary
    When the summary is written
    Then it is stored in "projects/mind"
    And no new write is made to any legacy session-summary space

  Scenario: OpenCode V2 automation keeps one project space per canonical project
    Given OpenCode V2 stream events whose location directory differs from the canonical project path
    When prudent automation resolves the project space for those events
    Then continuity artifacts are stored under "projects/<canonical-project>"
    And no separate space is created for the event directory

  Scenario: OpenCode V2 automation writes plugin state only when session state changes
    Given a burst of OpenCode V2 stream events that do not change session state
    When prudent automation processes the burst
    Then no plugin state file write happens for those events
    And a state write happens after an event that changes session state

  Scenario: OpenCode V2 compaction continuity is injected once per session interval
    Given an active OpenCode V2 session with an empty system context
    When the compaction hook runs for that session
    Then one prudent continuity block is added to the system context
    And a second compaction hook for the same session within the minimum interval adds no block
