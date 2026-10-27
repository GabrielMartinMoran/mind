@mcp @product/links
Feature: MCP Link Tools

  MCP tools for creating and deleting directional links between memories.

  Background:
    Given the MCP server is running
    And a space "test-space" exists with memories "mem1" and "mem2"

  Rule: link.create tool

    Scenario: link.create accepts "space:name" format
      When calling link_create with sourceRef "test-space:mem1" targetRef "test-space:mem2"
      Then the link is created from "mem1" to "mem2"

    Scenario: link.create accepts bare "name" format
      When calling link_create with sourceRef "mem1" targetRef "mem2"
      Then the link is created in "test-space"

    Scenario: link.create with default label
      When calling link_create with sourceRef "mem1" targetRef "mem2"
      Then the link label is "related"

    Scenario: link.create with custom label
      When calling link_create with sourceRef "mem1" targetRef "mem2" label "depends_on"
      Then the link label is "depends_on"

    Scenario: link.create with invalid ref format throws
      When calling link_create with sourceRef "invalid-no-colon" targetRef "mem2"
      Then an error "invalid memory reference" is returned

    Scenario: link.create with non-existent memory throws
      When calling link_create with sourceRef "mem1" targetRef "test-space:nonexistent"
      Then an error "memory not found" is returned

    Scenario: link.create self-link throws
      When calling link_create with sourceRef "mem1" targetRef "mem1"
      Then an error "self-links not allowed" is returned

    Scenario: link.create relabels an existing directed pair
      Given a link exists from "mem1" to "mem2" with label "related"
      When calling link_create with sourceRef "mem1" targetRef "mem2" label "implements"
      Then the link has exactly one label "implements"
      And the link still connects "mem1" to "mem2"

  Rule: link.delete tool

    Scenario: link.delete accepts "space:name" format
      Given a link exists from "mem1" to "mem2"
      When calling link_delete with sourceRef "test-space:mem1" targetRef "test-space:mem2"
      Then the link is removed

    Scenario: link.delete accepts bare name format
      Given a link exists from "mem1" to "mem2"
      When calling link_delete with sourceRef "mem1" targetRef "mem2"
      Then the link is removed

    Scenario: link.delete on a missing link is a no-op
      Given two memories with no link between them
      When calling link_delete with sourceRef "mem1" targetRef "mem2"
      Then the call succeeds without error
      And no link is created
