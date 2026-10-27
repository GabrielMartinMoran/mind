@core @product/search
Feature: Search System

  Full-text search using SQLite FTS5 with manual synchronization and fallback chain.

  Background:
    Given a mind store is initialized
    And a space "test-space" exists with memories

  Rule: FTS5 manual synchronization

    Scenario: adding memory inserts into FTS
      When adding a memory with content "typescript async patterns"
      Then the FTS index contains the memory content

    Scenario: updating memory updates FTS
      Given a memory "test" with content "old content"
      When updating the memory content to "new searchable content"
      Then the FTS index reflects the new content

    Scenario: deleting memory removes from FTS
      Given a memory "test" exists
      When deleting the memory
      Then the FTS index no longer contains the memory

    Scenario: FTS uses porter tokenizer
      When searching for "running"
      Then memories with "ran" or "run" are found

  Rule: Unified search pipeline

    @integration
    Scenario: All-terms matches flow through the unified pipeline
      When searching for a term that exists in FTS
      Then memories matching the term are returned
      And search_method derives from the contributing channel groups

    @integration
    Scenario: Partial matches are recovered through pipeline channels
      When searching for a multi-word query where only some terms match
      Then partial matches are returned with relaxed provenance
      And each result exposes a confidence bucket

    @integration
    Scenario: Semantic results are fused with lexical results
      Given RAG is enabled and embeddings exist
      When searching for a semantic query
      Then semantic similarity candidates join the same fusion pipeline
      And search_method reflects the primary contributing channel

  Rule: Search query syntax

    Scenario: search supports quoted phrase for exact match
      When searching for '"exact phrase"'
      Then only exact phrase matches are returned

    Scenario: search supports prefix matching
      When searching for "type*"
      Then all memories with words starting with "type" are returned

    Scenario: search supports AND operator
      When searching for "auth AND jwt"
      Then memories containing both terms are returned

    Scenario: search supports OR operator
      When searching for "auth OR jwt"
      Then memories containing either term are returned

    Scenario: search supports NOT operator
      When searching for "auth NOT jwt"
      Then memories with auth but without jwt are returned

  Rule: queryMemories with filters

    Scenario: queryMemories with tag filter
      When querying memories with tag "cat:decision"
      Then only memories with that tag are returned

    Scenario: queryMemories with tier filter
      When querying memories with tier 1
      Then only T1 memories are returned

    Scenario: queryMemories with date range
      When querying memories from "2024-01-01" to "2024-12-31"
      Then only memories within that range are returned

    Scenario: queryMemories with pagination
      When querying with limit 10 and offset 20
      Then 10 memories are returned starting at position 20

    Scenario: queryMemories returns all tiers including T3
      When querying with tier 3
      Then T3 cold memories are included
