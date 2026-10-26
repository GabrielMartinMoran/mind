Feature: search-parameter

  @integration
  Scenario: memory_query with search parameter returns pipeline results
    Given a space "projects/mind" with memory "auth-jwt" with content about JWT authentication
    When I call memory_query with space="projects/mind", search="JWT"
    Then I receive memories containing "JWT" in name or content
    And each result includes its confidence bucket
    And the compact response omits search_method, score, and methods

  @integration
  Scenario: memory_query without search uses SQL filters only
    Given a space "projects/mind" with memories with different tags
    When I call memory_query with space="projects/mind", tag="cat:decision"
    Then I receive only memories with tag "cat:decision"
    And no content search is performed

  @contract
  Scenario: memory_query response includes diagnostic search fields when the flag is true
    Given a space "projects/mind" with memory "test-memory" with content "hello world"
    And USE_DEBUGGING_EXPANDED_TOOLS_RESPONSE is "true"
    When I call memory_query with space="projects/mind", search="hello"
    Then each result includes score and methods
    And the response includes search_method
