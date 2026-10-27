@web @product/web-infrastructure
Feature: Web Infrastructure

  Rule: Type safety

    @contract
    Scenario: Web sources are type-checked
      When running bun run typecheck
      Then web/src and web/test are checked

    @contract
    Scenario: Typecheck fails on a web type error
      Given a deliberate type error in web/src
      When running bun run typecheck
      Then the command fails

  Rule: Local assets

    @contract
    Scenario: Markdown renderer is local
      Given the page loads
      Then marked is loaded from /assets/vendor/
      And no CDN request is made

    @contract
    Scenario: All web assets exist
      Then every referenced local asset exists
      And no referenced asset returns 404

  Rule: API errors

    @contract
    Scenario: Unknown API route returns JSON 404
      When requesting /api/unknown
      Then the response status is 404
      And the body is JSON

    @contract
    Scenario: Memory detail excludes internal fields
      When requesting a memory detail
      Then the response does not include embedding, fts_id or space_id
      And it includes the fields the UI needs

  Rule: Docker

    @manual
    Scenario: Docker image serves the web app
      When building and running the image
      Then the app responds on the configured port
      And the API is reachable

  Rule: No regressions

    @contract
    Scenario: Full web suite passes
      When running bun test test/ web/test
      Then all tests pass
