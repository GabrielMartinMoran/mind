@cli @product/status @cli @product/tags @cli @product/guide @cli @product/import @cli @product/update @cli @product/serve @cli @product/mcp @cli @product/setup
Feature: CLI Other Commands

  Various CLI commands for status, tags, guide, import, update, serve, mcp, and setup.

  Background:
    Given the CLI is initialized

  Rule: status command

    Scenario: status shows global storage info
      When running "./mind status"
      Then storage information is displayed
      And tier breakdown is shown

    Scenario: status space shows per-space breakdown
      When running "./mind status projects/test"
      Then the space tier breakdown is shown

  Rule: tags command

    Scenario: tags shows all tags
      Given spaces and memories with tags exist
      When running "./mind tags"
      Then all tags are listed

    Scenario: tags --spaces shows space tags only
      When running "./mind tags --spaces"
      Then only space tags are shown

    Scenario: tags --memories shows memory tags only
      When running "./mind tags --memories"
      Then only memory tags are shown

  Rule: guide command

    Scenario: guide shows human guide
      When running "./mind guide"
      Then the human usage guide is displayed

    Scenario: guide human shows human guide
      When running "./mind guide human"
      Then the human usage guide is displayed

    Scenario: guide agent shows agent guide
      When running "./mind guide agent"
      Then the agent protocol guide is displayed

  Rule: import command

    Scenario: import migrates brain.json
      Given a brain.json file exists
      When running "./mind import"
      Then memories are imported from the legacy format
      And spaces are created

  Rule: update command

    Scenario: update --check shows if update available
      When running "./mind update --check"
      Then update status is shown

    Scenario: update --version shows version
      When running "./mind update --version"
      Then the current version is displayed

  Rule: serve command

    Scenario: serve start starts HTTP server
      When running "./mind serve start"
      Then the HTTP server starts on port 3000

    Scenario: serve start --port starts on custom port
      When running "./mind serve start --port 8080"
      Then the server starts on port 8080

    Scenario: serve start --detached starts in background
      When running "./mind serve start --detached"
      Then the server starts in background
      And the process returns

    Scenario: serve stop stops detached server
      Given a detached server is running
      When running "./mind serve stop"
      Then the server stops

  Rule: mcp command

    Scenario: mcp starts MCP server
      When running timeout 1 ./mind mcp
      Then the MCP server starts
      And it listens on stdio

    Scenario: mcp start --http starts HTTP MCP
      When running "./mind mcp start --http"
      Then the MCP server starts on HTTP

    Scenario: mcp start --http --detached starts in background
      When running "./mind mcp start --http --detached"
      Then the MCP HTTP server starts in background

    Scenario: mcp stop stops detached MCP
      Given a detached MCP server is running
      When running "./mind mcp stop"
      Then the MCP server stops

  Rule: setup command

    Scenario: setup without agent configures all supported integrations
      When running "./mind setup"
      Then setup completes for all supported agents

    Scenario: setup compatibility shows the capability matrix
      When running "./mind setup compatibility"
      Then the full capability matrix is displayed
      And per-level status is shown for all adapters

    Scenario: setup claude-code configures Claude Code
      When running "./mind setup claude-code"
      Then Claude Code configuration is created

    Scenario: setup opencode configures OpenCode
      When running "./mind setup opencode"
      Then OpenCode configuration is created

    Scenario: setup cursor configures Cursor
      When running "./mind setup cursor"
      Then Cursor configuration is created

    Scenario: setup codex configures Codex
      When running "./mind setup codex"
      Then Codex configuration is created

    Scenario: setup windsurf configures Windsurf
      When running "./mind setup windsurf"
      Then Windsurf configuration is created

    Scenario: setup gemini-cli configures Gemini CLI
      When running "./mind setup gemini-cli"
      Then Gemini CLI configuration is created
