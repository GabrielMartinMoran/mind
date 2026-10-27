@mcp @product/spaces
Feature: MCP Spaces Tools

  MCP tools for space management.

  Background:
    Given the MCP server is running
    And the mind store is initialized

  Rule: space.create tool

    Scenario: space.create requires tags
      When calling space_create with name "projects/test" and description "Test"
      Then an error "tags required" is returned

    Scenario: space.create creates a space
      When calling space_create with name "projects/test" description "Test" tags ["type:project"]
      Then the space is created
      And the response includes the space name

    Scenario: space.create with duplicate name throws
      Given a space "projects/test" exists
      When calling space_create with name "projects/test" tags ["type:project"]
      Then an error "space already exists" is returned

  Rule: space.list tool

    Scenario: space.list returns all spaces
      Given spaces "space1" and "space2" exist
      When calling space_list
      Then both spaces are in the response

    Scenario: space.list with tag filter
      Given space "proj1" with tag "type:project" and space "user1" with tag "type:user"
      When calling space_list with tag "type:project"
      Then only "proj1" is returned

  Rule: space.get tool

    Scenario: space.get returns space details
      Given a space "projects/test" with description "Test project"
      When calling space_get with name "projects/test"
      Then the response includes description
      And the response includes tags

    Scenario: space.get returns an orientation summary
      Given a space with memories in tiers 1, 2, and 3
      And the space has an active checkpoint
      When calling space_get with name "test"
      Then the response includes overview counts
      And the response includes trending_memories grouped into tier_1, tier_2, and tier_3
      And each trending tier block includes total_count returned_count coverage and memories
      And the response includes plural active_checkpoints
      And the response includes a references block with total returned_count coverage and memories
      And the references block excludes checkpoint-tagged memories

    @integration
    Scenario: space.get surfaces living references
      Given a space with a memory tagged "type:reference" and "status:living"
      And a memory tagged only "type:reference"
      And a memory tagged only "status:living"
      When calling space_get with name "test"
      Then the references block includes only the living reference memory
      And each reference summary exposes name tier pinned tags and changed_at
      And each reference summary does not expose content or id

    @integration
    Scenario: space.get bounds tier previews and orders pinned memories first
      Given a space with twelve tier 3 memories
      And a tier with pinned and unpinned memories
      When calling space_get with name "test"
      Then the tier 3 block reports total_count 12
      And the tier 3 block returns at most 5 memories
      And pinned memories appear before unpinned memories in that tier preview

    Scenario: space.get for non-existent space throws
      When calling space_get with name "nonexistent"
      Then an error "space not found" is returned

  Rule: space.update tool

    Scenario: space.update changes description
      Given a space "test" exists
      When calling space_update with name "test" description "new description"
      Then the space description is updated

    Scenario: space.update with tags replaces tags
      Given a space "test" with tags "type:project"
      When calling space_update with name "test" tags ["type:user"]
      Then the space tags are replaced

    Scenario: space.update can hide a space
      Given a space "test" is visible
      When calling space_update with name "test" hidden true
      Then the space is hidden

    Scenario: space.create, space.get, and space.update expose normalized space payloads
      Given a space "test" has memories in tiers 1 and 2
      When calling space_create with name "projects/normalized" description "Normalized" tags ["type:project"]
      Then the response space exposes changed_at
      And the response space does not expose created_at
      And the response space does not expose updated_at
      When calling space_get with name "test"
      Then the response space exposes changed_at
      And the response space does not expose created_at
      And the response space does not expose updated_at
      And each trending_memories item does not expose id
      And each trending_memories item exposes changed_at
      And each trending_memories item does not expose access_count
      And each trending_memories item does not expose last_accessed_at
      And each trending_memories item does not expose updated_at
      And each trending tier block includes coverage
      And active_checkpoints is returned as a plural collection
      And each references item exposes changed_at
      And each references item does not expose id
      And each references item does not expose content
      When calling space_update with name "test" description "normalized description"
      Then the response space exposes changed_at
      And the response space does not expose created_at
      And the response space does not expose updated_at

  Rule: space.delete tool

    Scenario: space.delete removes the space
      Given a space "to-delete" exists
      When calling space_delete with name "to-delete"
      Then the space no longer exists
      And all its memories are deleted

    Scenario: space.delete non-existent throws
      When calling space_delete with name "nonexistent"
      Then an error "space not found" is returned
