@mcp @product/agent-attribution
Feature: MCP Agent Attribution

  Every MCP tool call records which agent or client made it, so the logs can
  show where activity came from. Identity comes from the setup-injected
  `MIND_AGENT` environment variable or the MCP initialize `clientInfo`.

  Background:
    Given the MCP server is running
    And the mind store is initialized

  Rule: Caller identity resolution

    @integration
    Scenario: MIND_AGENT identifies a stdio client
      Given the MCP server was started with MIND_AGENT "opencode"
      When an MCP tool call is logged
      Then caller_info.agent is "opencode"
      And caller_info.agentSource is "env"
      And caller_info.transport is "stdio"

    @integration
    Scenario: initialize clientInfo identifies the agent
      Given the MCP client sends clientInfo name "claude-code" and version "2.0.0"
      And MIND_AGENT is not set
      When an MCP tool call is logged
      Then caller_info.agent is "claude-code"
      And caller_info.agentSource is "client"
      And caller_info.clientVersion is "2.0.0"

    @integration
    Scenario: HTTP clientInfo takes precedence over an inherited environment
      Given the MCP server was started with MIND_AGENT "codex"
      And an HTTP client sends clientInfo name "opencode"
      When an MCP tool call is logged
      Then caller_info.agent is "opencode"
      And caller_info.agentSource is "client"
      And caller_info.transport is "http"

    @unit
    Scenario: Agent names are normalized
      When the resolver receives known aliases
      Then "Claude Code" resolves to "claude-code"
      And "github-copilot" resolves to "vscode"
      And "windsurf" resolves to "windsurf"

    @unit
    Scenario: Unknown identity stays unknown
      When neither MIND_AGENT nor clientInfo provides a name
      Then caller_info.agent is "unknown"
      And caller_info.agentSource is "unknown"

  Rule: Setup identity

    @integration
    Scenario Outline: Setup writes the agent identity into the MCP config
      Given setup configures <agent>
      Then the mind MCP entry sets MIND_AGENT to "<identity>"
      And existing environment entries are preserved

      Examples:
        | agent          | identity     |
        | opencode       | opencode     |
        | claude-code    | claude-code  |
        | codex          | codex        |
        | cursor         | cursor       |
        | windsurf       | windsurf     |
        | gemini-cli     | gemini-cli   |
        | vscode         | vscode       |
        | antigravity    | antigravity  |
        | pi             | pi           |

  Rule: Logs

    @integration
    Scenario: MCP tool calls expose the agent in the logs
      Given an MCP tool call was logged with caller_info.agent "opencode"
      When querying the logs API
      Then the log entry caller_info contains "opencode"

    @integration
    Scenario: Logs table shows the calling agent
      Given the logs API returns a row with caller_info.agent "codex"
      Then the logs table shows an Agent column with "codex"
      And a row without agent information shows "—"
