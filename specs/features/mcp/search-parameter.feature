Feature: search-parameter

  @contract
  Scenario: memory_query with search parameter returns pipeline results
    Given a space "projects/mind" with memory "auth-jwt" with content about JWT authentication
    When I call memory_query with space="projects/mind", search="JWT"
    Then I receive memories containing "JWT" in name or content
    And the response includes search_method reflecting the contributing channels

  @contract
  Scenario: memory_query without search uses SQL filters only
    Given a space "projects/mind" with memories with different tags
    When I call memory_query with space="projects/mind", tag="cat:decision"
    Then I receive only memories with tag "cat:decision"
    And no content search is performed

  @contract
  Scenario: memory_query with explicit stopword-only search returns validation error
    Given a space "projects/mind" with memories available
    When I call memory_query with space="projects/mind", search="the and of"
    Then the tool returns a validation error asking for an informative term
    And the request does not fall back to metadata listing

  @contract
  Scenario: memory_query response includes search_method field when search is used
    Given a space "projects/mind" with memory "test-memory" with content "hello world"
    When I call memory_query with space="projects/mind", search="hello"
    Then the response includes search_method field
