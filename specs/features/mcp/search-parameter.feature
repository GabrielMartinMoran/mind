Feature: search-parameter

  Scenario: memory_query with search parameter returns pipeline results
    Given a space "projects/mind" with memory "auth-jwt" with content about JWT authentication
    When I call memory_query with space="projects/mind", search="JWT"
    Then I receive memories containing "JWT" in name or content
    And the response includes search_method reflecting the contributing channels

  Scenario: memory_query without search uses SQL filters only
    Given a space "projects/mind" with memories with different tags
    When I call memory_query with space="projects/mind", tag="cat:decision"
    Then I receive only memories with tag "cat:decision"
    And no content search is performed

  Scenario: memory_query response includes search_method field when search is used
    Given a space "projects/mind" with memory "test-memory" with content "hello world"
    When I call memory_query with space="projects/mind", search="hello"
    Then the response includes search_method field
