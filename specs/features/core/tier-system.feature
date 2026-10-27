@core @product/tier-system
Feature: Tier System

  The tier system provides CPU-cache-style memory organization with three tiers:
  T1 (hot, limited), T2 (warm, limited), and T3 (cold, unlimited).

  Background:
    Given a mind store is initialized
    And a space "test-space" exists

  Rule: Tier limits are enforced

    Scenario: T1 has a limit of 25 memories per space
      Given a space with 25 T1 memories (at capacity)
      When adding a new T1 memory
      Then an error "T1 is full" is thrown

    Scenario: T2 has a limit of 50 memories per space
      Given a space with 50 T2 memories (at capacity)
      When adding a new T2 memory
      Then an error "T2 is full" is thrown

    Scenario: T3 is unlimited
      Given a space with 150 T3 memories
      When adding a new T3 memory
      Then the memory is added successfully

  Rule: Promotion moves memories up one tier

    Scenario: promote T2 to T1 succeeds
      Given a memory in tier 2
      When promoting the memory
      Then the memory moves to tier 1
      And promotion succeeds

    Scenario: promote T3 to T2 succeeds
      Given a memory in tier 3
      When promoting the memory
      Then the memory moves to tier 2
      And promotion succeeds

    Scenario: promote T1 throws already at highest tier
      Given a memory in tier 1
      When promoting the memory
      Then an error "already at highest tier" is thrown
      And the memory remains in tier 1

    Scenario: automatic promotion is skipped for pinned memories
      Given a pinned memory in tier 2
      When recording an access on the memory
      Then the memory remains in tier 2
      And no error is thrown

  Rule: Demotion moves memories down one tier

    Scenario: demote T1 to T2 succeeds
      Given a memory in tier 1
      When demoting the memory
      Then the memory moves to tier 2
      And demotion succeeds

    Scenario: demote T2 to T3 succeeds
      Given a memory in tier 2
      When demoting the memory
      Then the memory moves to tier 3
      And demotion succeeds

    Scenario: demote T3 throws already at lowest tier
      Given a memory in tier 3
      When demoting the memory
      Then an error "already at lowest tier" is thrown
      And the memory remains in tier 3

  Rule: Pinned memories are immune to automatic operations

    Scenario: pinned memories cannot be evicted
      Given a space at T1 capacity with all memories pinned
      When adding a new memory to T1
      Then an error "T1 is full" is thrown

    Scenario: pinned memories are not auto-promoted
      Given a pinned memory in tier 3
      When recording an access on the memory
      Then the memory remains in tier 3

  Rule: LRU eviction when tier is full

    Scenario: T1 full eviction moves LRU to T2
      Given a space with 25 T1 memories (full)
      And one memory has lowest access_count (LRU)
      When adding a new T1 memory
      Then the LRU memory is demoted to T2
      And the new memory is added to T1
      And the operation is atomic

    Scenario: T2 full eviction moves LRU to T3
      Given a space with 50 T2 memories (full)
      And one memory has lowest access_count (LRU)
      When adding a new T2 memory
      Then the LRU memory is demoted to T3
      And the new memory is added to T2
      And the operation is atomic

    Scenario: T3 does not evict (unlimited)
      Given a space with unlimited T3 memories
      When adding a new T3 memory
      Then the memory is added directly
      And no eviction occurs

  Rule: Auto-promotion on read

    Scenario: reading a T3 memory promotes it to T2
      Given a memory in tier 3
      When reading the memory
      Then the memory promotes to tier 2
      And access_count is incremented
      And lastAccessedAt is updated

    Scenario: reading a T2 memory promotes it to T1
      Given a memory in tier 2
      When reading the memory
      Then the memory promotes to tier 1
      And access_count is incremented

    Scenario: reading a T1 memory only updates access
      Given a memory in tier 1
      When reading the memory
      Then the memory stays in tier 1
      And access_count is incremented
      And lastAccessedAt is updated
