@delta-modified @mcp @product/search
Feature: MCP Search Tools

  MCP tools for memory querying.

  Background:
    Given the MCP server is running
    And spaces "projects/mind" and "projects/other" exist with memories

  Rule: memory.query tool

    @contract
    Scenario: memory.query requires space
      When calling memory_query with no space
      Then an error "space is required" is returned

    @integration
    Scenario: memory.query with space="*" returns all memories
      When calling memory_query with space "*"
      Then all memories from all tiers are returned

    @integration
    Scenario: memory.query with specific space filters
      When calling memory_query with space "projects/mind"
      Then only memories from that space are returned

    @integration
    Scenario: memory.query includes T3 cold memories
      When calling memory_query with space "projects/mind"
      Then T3 memories are included in results

    @integration
    Scenario: memory.query supports tag filter
      When calling memory_query with space "projects/mind" tag "cat:decision"
      Then only memories with matching tag are returned

    @integration
    Scenario: memory.query supports tier filter
      When calling memory_query with space "projects/mind" tier 1
      Then only T1 memories are returned

    @integration
    Scenario: memory_query treats tier null as all tiers
      Given a space contains memories in tiers 1, 2, and 3
      When calling memory_query with space "projects/mind" and tier null
      Then memories from all tiers are eligible to be returned
      And the result is equivalent to omitting the tier filter

    @contract
    Scenario: memory_query input schema documents null tier semantics
      When MCP clients list available tools
      Then memory_query inputSchema allows tier values 1, 2, 3, or null
      And the tier field description states that null means all tiers

    @integration
    Scenario: memory.query supports pagination
      When calling memory_query with space "projects/mind" limit 3 offset 0
      Then 3 memories are returned with pagination metadata

    @integration
    Scenario: memory.query supports date range
      When calling memory_query with space "projects/mind" from "2024-01-01" to "2024-12-31"
      Then only memories within date range are returned

    @contract
    Scenario: memory.query search results expose normalized compact memory payloads
      Given USE_DEBUGGING_EXPANDED_TOOLS_RESPONSE is unset
      When calling memory_query with space "projects/mind" and a matching search
      Then each result item exposes space
      And each result item does not expose space_name
      And each result item does not expose access_count
      And each result item does not expose last_accessed_at
      And each result item does not expose embedding
      And each result item exposes changed_at
      And each result item does not expose created_at
      And each result item does not expose updated_at
      And each result item exposes confidence
      And each result item omits score and methods
      And the response omits search_method
      And the response retains total, limit, and offset
      And the YAML payload matches structuredContent

    @contract
    Scenario: memory.query expands diagnostic metadata only when the flag is exactly true
      Given USE_DEBUGGING_EXPANDED_TOOLS_RESPONSE is "true"
      When calling memory_query with space "projects/mind" and a matching search
      Then each result item exposes score, confidence, and methods
      And search_method reflects the unified pipeline's contributing channels
      And the YAML payload matches structuredContent

    @contract
    Scenario: memory.query uses compact metadata when the flag is unset
      Given USE_DEBUGGING_EXPANDED_TOOLS_RESPONSE is unset
      When calling memory_query with space "projects/mind" and a matching search
      Then each result item omits score and methods
      And the response omits search_method

    @contract
    Scenario Outline: memory.query uses compact metadata for non-true flag values
      Given USE_DEBUGGING_EXPANDED_TOOLS_RESPONSE is "<value>"
      When calling memory_query with space "projects/mind" and a matching search
      Then each result item omits score and methods
      And the response omits search_method

      Examples:
        | value   |
        | false   |
        | 1       |
        | TRUE    |
        | enabled |

    @contract
    Scenario: memory.query listing remains free of search diagnostics when the flag is true
      Given USE_DEBUGGING_EXPANDED_TOOLS_RESPONSE is "true"
      When calling memory_query with space "projects/mind" without search
      Then the response omits search_method
      And each result item omits score and methods

    @contract
    Scenario: MCP compacting does not remove diagnostic fields from HTTP search
      When the same query is sent to MCP memory_query and HTTP search
      Then the ordered memory names are identical
      And HTTP results still expose score and methods
