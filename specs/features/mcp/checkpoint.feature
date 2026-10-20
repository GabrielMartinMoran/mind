@delta-modified @mcp @product/checkpoint
Feature: MCP Checkpoint Tools

  MCP tools for session checkpoint management.

  Background:
    Given the MCP server is running
    And a space "projects/test" exists

  Rule: checkpoint.save tool

    Scenario: checkpoint.save creates or updates checkpoint
      When calling checkpoint_save with space "projects/test" goal "Implement login" pending "Add OAuth"
      Then a checkpoint exists with the goal
      And the checkpoint has pending items

    Scenario: checkpoint.save with linked_memories links memories
      Given memories "mem1" and "mem2" exist in "projects/test"
      When calling checkpoint_save with space "projects/test" goal "Test" pending "QUnit" linked_memories ["mem1", "mem2"]
      Then the checkpoint is linked to those memories

  Rule: checkpoint.done tool

    Scenario: checkpoint.done transforms checkpoint into session memory and deletes checkpoint
      Given an active checkpoint in "projects/test" with goal "Complete API refactor" and no pending work
      And memories "mem1" and "mem2" exist in "projects/test"
      And the checkpoint has linked_memories ["mem1", "mem2"]
      When calling checkpoint_done with space "projects/test" checkpointName "current" summary "Completed login"
      Then a new memory is created in "projects/test"
      And the memory has tags ["type:session", "cat:summary"]
      And the memory defaults to tier 3
      And the memory content includes "Complete API refactor"
      And the memory has linked references to "mem1" and "mem2"
      And the original checkpoint is deleted from "projects/test"

    @integration
    Scenario: checkpoint.done rejects pending work and keeps the checkpoint
      Given an active checkpoint in "projects/test" with goal "Complete API refactor" and pending "Write tests"
      When calling checkpoint_done with space "projects/test" checkpointName "current" summary "Partial"
      Then the call fails with an actionable error
      And the checkpoint remains active in "projects/test"
      And no session memory is created

  Rule: checkpoint.load tool

    Scenario: checkpoint.load requires checkpointName
      Given an active checkpoint with goal "Login feature"
      When calling checkpoint_load with space "projects/test" checkpointName "current"
      Then the response includes goal "Login feature"
      And the response includes pending items

    Scenario: checkpoint_load returns full checkpoint content fields
      Given a checkpoint has long goal, pending, and notes text
      When calling checkpoint_load with the saved checkpoint name
      Then the response returns the full goal text
      And the response returns the full pending text
      And the response returns the full notes text

    Scenario: checkpoint_load does not cap linked memories at five
      Given a checkpoint has more than five linked memories
      When calling checkpoint_load with the saved checkpoint name
      Then all linked memories are returned in the response

  Rule: checkpoint.query tool

    Scenario: checkpoint.query returns all checkpoints
      Given an active checkpoint exists in "projects/test"
      When calling checkpoint_query with space "projects/test"
      Then the active checkpoint is returned

    Scenario: checkpoint_query returns full pending text
      Given an active checkpoint has pending text longer than 50 characters
      When calling checkpoint_query with its project space
      Then the returned pending field contains the full saved text
      And no ellipsis is appended
      And the YAML content matches the structured payload

    Scenario: checkpoint.query with limit and offset
      Given multiple checkpoints exist in "projects/test"
      When calling checkpoint_query with space "projects/test" limit 1 offset 0
      Then paginated checkpoints are returned with total count
