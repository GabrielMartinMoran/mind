@delta-modified @mcp @product/search
Feature: MCP Search Tools

  MCP tools for memory querying.

  Background:
    Given the MCP server is running
    And spaces "projects/mind" and "projects/other" exist with memories

  Rule: memory.query tool

    Scenario: memory.query requires space
      When calling memory_query with no space
      Then an error "space is required" is returned

    Scenario: memory.query with space="*" returns all memories
      When calling memory_query with space "*"
      Then all memories from all tiers are returned

    Scenario: memory.query with specific space filters
      When calling memory_query with space "projects/mind"
      Then only memories from that space are returned

    Scenario: memory.query includes T3 cold memories
      When calling memory_query with space "projects/mind"
      Then T3 memories are included in results

    Scenario: memory.query supports tag filter
      When calling memory_query with space "projects/mind" tag "cat:decision"
      Then only memories with matching tag are returned

    Scenario: memory.query supports tier filter
      When calling memory_query with space "projects/mind" tier 1
      Then only T1 memories are returned

    Scenario: memory_query treats tier null as all tiers
      Given a space contains memories in tiers 1, 2, and 3
      When calling memory_query with space "projects/mind" and tier null
      Then memories from all tiers are eligible to be returned
      And the result is equivalent to omitting the tier filter

    Scenario: memory_query input schema documents null tier semantics
      When MCP clients list available tools
      Then memory_query inputSchema allows tier values 1, 2, 3, or null
      And the tier field description states that null means all tiers

    Scenario: memory.query supports pagination
      When calling memory_query with space "projects/mind" limit 3 offset 0
      Then 3 memories are returned with pagination metadata

    Scenario: memory.query supports date range
      When calling memory_query with space "projects/mind" from "2024-01-01" to "2024-12-31"
      Then only memories within date range are returned

    Scenario: memory.query result items expose normalized memory payloads
      When calling memory_query with space "projects/mind"
      Then each result item exposes space
      And each result item does not expose space_name
      And each result item does not expose access_count
      And each result item does not expose last_accessed_at
      And each result item does not expose embedding
      And each result item exposes changed_at
      And each result item does not expose created_at
      And each result item does not expose updated_at
      And search_method reflects the unified pipeline's contributing channels
