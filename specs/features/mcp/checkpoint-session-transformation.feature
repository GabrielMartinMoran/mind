Feature: checkpoint-session-transformation

  Scenario: checkpoint_done creates same-space session memory in projects/<repo> and deletes checkpoint
    Given a space "projects/mind" with an active checkpoint
    And the checkpoint has goal "Complete API refactor"
    And the checkpoint has no pending work
    And the checkpoint has linked_memories ["memory-1", "memory-2"]
    When I call checkpoint_done(space="projects/mind", name="current")
    Then a new memory is created in "projects/mind"
    And the memory has tags ["type:session", "cat:summary"]
    And the memory defaults to tier 3
    And the memory content includes "Complete API refactor"
    And the memory has linked references to "memory-1" and "memory-2"
    And the original checkpoint is deleted from "projects/mind"

  Scenario: checkpoint_done does not depend on creating a legacy session-summary space
    Given a space "projects/mind" with an active checkpoint
    And no legacy sessions space exists for the repo
    When I call checkpoint_done(space="projects/mind", name="current")
    Then the same-space session memory is created successfully
    And no legacy sessions space is created

  Scenario: calling checkpoint_done twice returns error on second call (checkpoint already deleted)
    Given a space "projects/mind" with an active checkpoint
    When I call checkpoint_done(space="projects/mind")
    And the checkpoint is transformed and deleted
    And I call checkpoint_done(space="projects/mind") again
    Then I receive an error "No active checkpoint found"
    And no duplicate session memory is created
