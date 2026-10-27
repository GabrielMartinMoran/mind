@product/skill-load-contract
Feature: Mind skill is the single source of truth

  Agents that can use Mind must load the canonical mind-management skill
  unconditionally before using Mind. Any other mention of the protocol is a
  pointer or a fallback copy, not the source of truth.

  Background:
    Given the Mind MCP server is configured for an agent

  Rule: The skill is the single source of truth

    @contract
    Scenario: The skill description declares unconditional load
      Given the installed mind-management skill frontmatter
      When the description is read before skill selection
      Then it says the skill is the single source of truth for Mind
      And it says to load the skill unconditionally at session start and after compaction before any Mind use
      And it says not to call a Mind MCP tool until the skill is loaded
      And it says protocol mentions in AGENTS.md, L2, MCP initialize, tool descriptions, and docs are pointers only
      And it names the system_instructions fallback

    @contract
    Scenario: The skill load note repeats the source-of-truth contract
      Given the rendered mind-management skill
      When its load note is read
      Then it says the skill is the single source of truth
      And it says to load it unconditionally before any Mind use
      And it names the system_instructions fallback when the skill is not listed or cannot be loaded

    @contract
    Scenario: The canonical RECALL guidance teaches search syntax and recovery
      Given the canonical mind-cognitive-protocol body
      When its RECALL section is read
      Then it says only uppercase AND, OR, and NOT are boolean operators
      And it says lowercase spellings are ordinary terms
      And it says omitting search lists memories by metadata
      And it says a supplied search with no informative term returns a validation error and must be reformulated with a specific term

  Rule: L2 and Codex AGENTS.md are pointers, not protocol copies

    @contract
    Scenario: The Codex managed block is an activation pointer
      Given a temporary Codex home
      When mind setup codex writes its managed block
      Then the block is titled Mind activation pointer
      And it says the source of truth is the mind-management skill, not this file
      And it says to load the skill unconditionally before any Mind use
      And it names the system_instructions fallback
      And it contains no ORIENT section, trigger heading, tool examples, or canonical protocol body

    @contract
    Scenario: Other clients render the same pointer contract
      Given the OpenCode, Claude Code, and Pi setup paths
      When their L2 instructions are rendered
      Then each says the source of truth is the mind-management skill
      And each says to load it unconditionally before any Mind use
      And none contains the canonical protocol body

    @contract
    Scenario: The MCP initialize instructions carry the contract in the first 512 characters
      Given an MCP initialize response
      When its instructions are read
      Then the first 512 characters name the mind-management skill as the source of truth
      And they say to load it unconditionally before any Mind use
      And they name the system_instructions fallback

  Rule: The fallback is complete but secondary

    @integration
    Scenario: The system_instructions fallback is complete and labeled
      Given the mind-management skill is not listed or cannot be loaded
      When system_instructions is called
      Then it returns the complete canonical protocol once
      And its intro says it is the fallback copy used when the skill is unavailable
      And its intro says the skill is the primary source of truth
      And its instructions_version is 2.3.0

    @contract
    Scenario: One canonical protocol body remains the only full source
      Given the skill, L2 instructions, MCP initialize, and system_instructions
      When the canonical body is counted
      Then it appears exactly once in the skill and once in the system fallback
      And no L2 or AGENTS.md pointer contains the body

  Rule: Project-level files do not silently override the contract

    @contract
    Scenario: Project AGENTS.md precedence is documented
      Given a project AGENTS.md can appear after the global Codex instructions
      When the skill-first documentation is read
      Then it warns that project files must not restate the Mind protocol
      And it says project files must point to the mind-management skill and the system_instructions fallback

    @manual
    Scenario: A live Codex session loads the skill before using Mind
      Given a Codex session with the Mind MCP configured
      When the agent starts a task that uses Mind
      Then it loads mind-management unconditionally before any Mind tool
      And if the skill is unavailable it calls system_instructions first
      And the session evidence records which path was used

  Rule: Existing installation behavior is preserved

    @integration
    Scenario: Skill installation still succeeds without protocol duplication
      Given a temporary home with an existing or missing mind-management skill
      When setup installs the skill
      Then the canonical skill is present once
      And no full protocol copy is written to AGENTS.md
      And configuration backups remain separate from skill content
