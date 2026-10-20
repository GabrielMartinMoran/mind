@delta-modified @mcp @product/memories
Feature: MCP Memory Tools

  MCP tools for memory CRUD operations with links support.

  Background:
    Given the MCP server is running
    And a space "test-space" exists with memories "mem1" and "mem2"

  Rule: memory.add tool

    Scenario: memory.add requires tags
      When calling memory_add with space "test-space" name "new" content "content"
      Then an error "tags required" is returned

    Scenario: memory.add creates a memory without exposing an internal numeric id
      When calling memory_add with space "test-space" name "new" content "content" tags ["cat:decision"]
      Then the memory is created
      And the response does not expose an internal numeric id

    Scenario: memory.add with tier parameter
      When calling memory_add with space "test-space" name "cold" content "c" tags ["cat:discovery"] tier 3
      Then the memory is created in tier 3

    Scenario: memory.add with pinned=true
      When calling memory_add with space "test-space" name "pinned" content "c" tags ["cat:preference"] pinned true
      Then the memory is pinned

    Scenario: memory.add with links_to creates links
      When calling memory_add with space "test-space" name "new" content "c" tags ["cat:decision"] links_to ["mem1"]
      Then the memory is created
      And a link exists from "new" to "mem1"

    Scenario: memory.add reports invalid links_to without failing the memory creation
      When calling memory_add with space "test-space" name "new" content "c" tags ["cat:decision"] links_to ["nonexistent"]
      Then the memory is still created
      And the response includes that reference in links_failed
      And no tool error is thrown solely because the link target is missing

  Rule: memory.read tool

    Scenario: memory.read returns memory content
      Given a memory "mem1" with content "test content"
      When calling memory_read with space "test-space" name "mem1"
      Then the response includes the content

    Scenario: memory.read records access and promotes
      Given a memory "mem1" in tier 2
      When calling memory_read with space "test-space" name "mem1"
      Then the memory tier becomes 1
      And access_count is incremented
      And the response does not expose access_count
      And the response does not expose last_accessed_at

    Scenario: memory.read with noPromote=true
      Given a memory "mem1" in tier 2
      When calling memory_read with space "test-space" name "mem1" noPromote true
      Then the memory stays in tier 2
      And access_count is not incremented
      And the response does not expose access_count
      And the response does not expose last_accessed_at

    Scenario: memory.read returns links_to and linked_by
      Given a link from "mem1" to "mem2"
      When calling memory_read with space "test-space" name "mem1"
      Then the response includes links_to with "mem2"
      And the response includes linked_by

    Scenario: memory.read for non-existent throws
      When calling memory_read with space "test-space" name "nonexistent"
      Then an error "memory not found" is returned

  Rule: memory.update tool

    Scenario: memory.update changes content
      When calling memory_update with space "test-space" name "mem1" content "new content"
      Then the memory content is updated

    Scenario: memory.update can rename
      When calling memory_update with space "test-space" name "mem1" newName "renamed"
      Then the memory is found by "renamed"
      And "mem1" no longer exists

    Scenario: memory.update with tags replaces tags
      When calling memory_update with space "test-space" name "mem1" tags ["cat:bugfix"]
      Then the memory tags are replaced

    @integration
    Scenario: memory.update pins and unpins a memory
      When calling memory_update with space "test-space" name "mem1" pinned true
      Then the memory is pinned in its current tier
      When calling memory_update with space "test-space" name "mem1" pinned false
      Then the memory is unpinned in its current tier

    @integration
    Scenario: memory.update promotes and demotes a memory
      Given a memory "mem1" in tier 2
      When calling memory_update with space "test-space" name "mem1" tierTransition "promote"
      Then the memory moves to tier 1
      When calling memory_update with space "test-space" name "mem1" tierTransition "demote"
      Then the memory moves to tier 2

    @integration
    Scenario: memory.update keeps an explicit tier transition atomic
      Given a full tier 1 where every memory is pinned
      And a memory "mem1" in tier 2
      When calling memory_update with space "test-space" name "mem1" content "new content" tierTransition "promote"
      Then the update fails with a capacity error
      And the memory content is unchanged
      And the memory remains in tier 2

    @integration
    Scenario: memory.update moves a pinned memory when the transition is explicit
      Given a pinned memory "mem1" in tier 2
      When calling memory_update with space "test-space" name "mem1" tierTransition "promote"
      Then the memory moves to tier 1
      And the memory remains pinned

    Scenario: memory.add, memory.read, and memory.update expose normalized memory payloads
      When calling memory_add with space "test-space" name "normalized" content "content" tags ["cat:decision"]
      Then the response exposes space "test-space"
      And the response does not expose space_name
      And the response does not expose access_count
      And the response does not expose last_accessed_at
      And the response does not expose embedding
      And the response exposes changed_at
      And the response does not expose created_at
      And the response does not expose updated_at
      When calling memory_read with space "test-space" name "normalized"
      Then the response exposes space "test-space"
      And the response does not expose space_name
      And the response does not expose access_count
      And the response does not expose last_accessed_at
      And the response does not expose embedding
      And the response exposes changed_at
      And the response does not expose created_at
      And the response does not expose updated_at
      When calling memory_update with space "test-space" name "normalized" content "updated content"
      Then the response exposes space "test-space"
      And the response does not expose space_name
      And the response does not expose access_count
      And the response does not expose last_accessed_at
      And the response does not expose embedding
      And the response exposes changed_at
      And the response does not expose created_at
      And the response does not expose updated_at

  Rule: memory.delete tool

    Scenario: memory.delete removes the memory
      When calling memory_delete with space "test-space" name "mem1"
      Then the memory no longer exists
      And all links to/from it are removed

    Scenario: memory.delete non-existent throws
      When calling memory_delete with space "test-space" name "nonexistent"
      Then an error "memory not found" is returned
