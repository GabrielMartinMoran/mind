@core @product/search
Feature: Search fusion pipeline

  Unified multi-strategy relevance search used by CLI, MCP and API: query
  parsing, a lexical relaxation ladder, substring/typo and semantic channels,
  fused results with per-result confidence, and honest empty results.

  Background:
    Given a mind store with a search fixture corpus seeded

  Rule: Query parsing

    @unit
    Scenario: Quoted phrases are matched as phrases
      When searching for '"exact phrase"'
      Then results matching the exact phrase rank first
      And their provenance includes the "phrase" method

    @unit
    Scenario: OR separates alternatives into a union
      When searching for "alpha OR beta"
      Then memories matching alpha are returned
      And memories matching beta are returned

    @unit
    Scenario: Explicit AND behaves like implicit AND
      When searching for "auth AND jwt"
      Then the result set equals searching for "auth jwt"

    @unit
    Scenario: NOT excludes the following term
      When searching for "auth NOT jwt"
      Then memories matching auth are returned
      And memories containing jwt are excluded

    @unit
    Scenario: A trailing prefix wildcard expands a term
      When searching for "type*"
      Then memories with words starting with "type" are returned

    @unit
    Scenario: Malformed operator usage degrades to literal AND
      When searching for "OR OR auth NOT"
      Then the search completes without error
      And the terms are treated literally

  Rule: Relaxation ladder

    @integration
    Scenario: Phrase rung marks adjacent matches
      When searching for "token color"
      Then a memory containing the adjacent phrase "token color" ranks above memories containing both terms apart
      And its provenance includes the "phrase" method

    @integration
    Scenario: All-terms rung matches when every term is present
      When searching for a two-term query where both terms co-occur in one memory
      Then that memory is returned with provenance "all"

    @integration
    Scenario: Any-term rung recovers partial multi-word queries
      When searching for "foundry token color selector highlight" where only "foundry" and "token" exist
      Then memories matching "foundry" and "token" are returned
      And their provenance includes the "any" method

    @integration
    Scenario: Duplicate hits across rungs deduplicate to one result
      Given a memory matches both the all-terms and any-term rungs
      When searching for its terms
      Then it appears exactly once in the results
      And its provenance includes both "all" and "any"

  Rule: Substring and typo tolerance

    @integration
    Scenario: Trigram channel finds substring matches inside words
      When searching for "abilbo" (a substring of an indexed term)
      Then the memory containing the full term is returned with provenance "trigram"

    @integration
    Scenario: Fuzzy channel tolerates terms within edit distance 2
      When searching for "mohabilboo" (one edit away from an indexed term)
      Then the memory containing the close term is returned with provenance "fuzzy"

    @integration
    Scenario: Terms shorter than three characters skip trigram matching
      When searching for a two-character term
      Then the trigram channel contributes no candidates

    @integration
    Scenario: Fuzzy expansion respects the configured cap
      Given the configured fuzzy expansion cap is 50
      When a fuzzy search matches more than 50 candidate terms
      Then at most 50 expansions are queried

  Rule: Token-set contribution

    @unit
    Scenario: Query coverage boosts partially matching documents
      Given a query with 4 tokens where 3 appear in a document
      When token-set scoring runs
      Then its token-set score equals the fraction of query tokens present

    @unit
    Scenario: Tokenization folds case, accents and identifier separators
      When tokenizing "Configuración-tempHP_2026"
      Then it yields the folded tokens "configuracion", "temp", "hp", "2026"

  Rule: Fusion and ranking

    @unit
    Scenario: Multi-channel agreement outranks single-channel matches
      Given two memories with equal best-channel scores
      And the first is matched by three channels while the second by one
      When fusion runs
      Then the first memory ranks higher

    @unit
    Scenario: Channel scores are normalized per query before fusion
      Given one channel with raw scores far larger than another channel's
      When fusion runs
      Then each channel contributes within its configured weight range

    @unit
    Scenario: Equal-score results order deterministically
      Given two results with identical fused scores
      When the ranking is computed
      Then they are ordered by name then id
      And repeated runs produce the same order

    @integration
    Scenario: Exact strong matches keep their standing under fusion
      When a query exactly matches a memory's name
      Then the memory appears first
      And its confidence is "high"

  Rule: Confidence

    @unit
    Scenario: Exact full matches are high confidence
      Given a memory matches through the "phrase" or "all" method with a strong score
      When its confidence is computed
      Then the bucket is "high"

    @unit
    Scenario: Relaxed or substring-only matches are medium confidence
      Given a memory matches only through "any" or "trigram"
      When its confidence is computed
      Then the bucket is "medium"

    @unit
    Scenario: Typo or weak matches are low confidence
      Given a memory matches only through "fuzzy"
      When its confidence is computed
      Then the bucket is "low"

    @contract
    Scenario: MCP results expose confidence and methods per memory
      When calling memory_query with search for a matching term
      Then each returned memory exposes a confidence bucket
      And each returned memory exposes its methods
      And the response YAML matches the structured payload

    @integration
    Scenario: CLI search displays the confidence bucket
      When running "./mind search \"test\""
      Then each result line shows its confidence bucket

  Rule: Graceful degradation

    @integration
    Scenario: Search works fully with RAG disabled
      Given embeddings are disabled
      When searching for a multi-term query with partial matches
      Then lexical channels return fused results
      And no semantic method appears in provenance

    @integration
    Scenario: Embedding failures degrade to lexical-only without retry storms
      Given the embedding provider fails on every request
      When searching twice in a row
      Then both searches return lexical results promptly
      And the second search does not attempt the embedding provider

  Rule: Limits and pagination

    @integration
    Scenario: Search defaults to 25 results and reports the total
      Given the query matches more than 25 memories
      When searching without an explicit limit
      Then at most 25 memories are returned
      And the response reports the total count

    @unit
    Scenario: Limits are capped at 500
      When searching with limit 10000
      Then the effective limit is 500

  Rule: Cross-surface consistency

    @contract
    Scenario: CLI, MCP and API return the same ranking for the same query
      When the same query runs through CLI, MCP and API
      Then the ordered memory list is identical across surfaces

  Rule: Noise guards

    @integration
    Scenario: Terms absent from the corpus return no results
      When searching for "zzqxv-nonexistent-term"
      Then no memories are returned

    @integration
    Scenario: Near-miss queries do not produce noisy hits
      Given no memory contains the term "mohabilba"
      When searching for "mohabilba"
      Then any fuzzy-only matches appear only with "low" confidence
