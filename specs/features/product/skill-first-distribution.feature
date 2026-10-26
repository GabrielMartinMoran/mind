@product/skill-first-distribution
Feature: Skill-first distribution and lifecycle corrections

  Mind keeps one complete cognitive protocol in the `mind-management` skill,
  keeps checkpoints and supersession faithful to the knowledge lifecycle, and
  ships its research benchmark as an independent Bun subproject.

  Background:
    Given a temporary home directory
    And the Mind source tree on the feature branch

  Rule: Checkpoints preserve work state

    @integration
    Scenario: A partial checkpoint update preserves omitted fields
      Given an active checkpoint with goal, pending work, and notes
      When checkpoint_save updates only the notes
      Then the goal and pending work are unchanged
      And the notes are updated
      And the checkpoint name, tags, tier, and creation time are preserved

    @integration
    Scenario: An empty string clears a checkpoint field deliberately
      Given an active checkpoint with pending work
      When checkpoint_save sends an empty pending field
      Then the pending work is cleared
      And the goal and notes are preserved

    @integration
    Scenario: A new checkpoint applies normal defaults
      Given no active checkpoint exists
      When checkpoint_save creates a checkpoint with only a goal
      Then pending work and notes are empty
      And the checkpoint is active at T1
      And the response includes the checkpoint identity

    @integration
    Scenario: A no-op checkpoint save returns the existing checkpoint
      Given an active checkpoint
      When checkpoint_save sends no updatable fields
      Then the checkpoint content is unchanged
      And its modification time is not advanced

    @integration
    Scenario: Linked memories are additive and report failures
      Given an active checkpoint linked to one memory
      When checkpoint_save adds a second valid memory and an invalid reference
      Then both existing and new valid links are preserved
      And the invalid reference is reported in links_failed
      And an empty linked_memories list removes nothing

    @integration
    Scenario: Session end with pending work keeps the checkpoint
      Given an active checkpoint with pending work
      When the session ends
      Then the checkpoint remains active
      And the session summary is written separately
      And checkpoint_done is not called

    @integration
    Scenario: checkpoint_done rejects pending work
      Given an active checkpoint with pending work
      When checkpoint_done is called
      Then the call fails with an actionable error
      And the checkpoint remains active
      And no session summary is created

    @integration
    Scenario: A completed checkpoint becomes a session summary and is removed
      Given an active checkpoint with no pending work
      When checkpoint_done is called with a summary
      Then a T3 session summary tagged type:session and cat:summary is created
      And the summary records what was done
      And the original checkpoint is deleted

    @integration
    Scenario: checkpoint_done rejects a memory that is not a checkpoint
      Given a memory with JSON content but no checkpoint tag
      When checkpoint_done targets that memory
      Then the call fails
      And the memory is not transformed or deleted

    @integration
    Scenario: Checkpoint relations survive completion
      Given an active checkpoint with incoming and outgoing links
      When the completed checkpoint becomes a session summary
      Then both directions and their labels are preserved

    @integration
    Scenario: An active checkpoint is found across tiers
      Given an active checkpoint that has moved to T3
      When checkpoint_save updates it
      Then the existing checkpoint is updated
      And no second active checkpoint is created

  Rule: Supersession preserves history

    @integration
    Scenario: A changed decision preserves the historical memory
      Given a durable decision memory with its original content and tags
      When the decision is replaced
      Then the historical memory keeps its original content
      And it keeps its original category tag and gains status:superseded
      And a new category-tagged memory records the current decision
      And a link from the new memory to the historical memory is labelled contradicts
      And affected living references are reviewed

    @contract
    Scenario: A superseded protocol example never rewrites history
      Given every fenced memory_update example in the canonical protocol
      When an example includes status:superseded in its tags
      Then the example does not include a content field

    @integration
    Scenario: Living references track the new truth
      Given a living reference that summarizes the replaced decision
      When the decision is superseded
      Then the living reference is updated to the current truth
      And it remains linked to its source memories

  Rule: Retrieval and relations are taught accurately

    @contract
    Scenario: Natural-language search is the first strategy
      Given the canonical protocol RECALL section
      When an agent needs knowledge
      Then the first example is a natural, focused query
      And the structured query is presented as an additional tool
      And the protocol does not mandate multiple queries

    @integration
    Scenario: memory_add links_to creates a generic relation
      Given two memories
      When memory_add creates a link through links_to
      Then the stored label is related

    @integration
    Scenario: link_create expresses a specific relation
      Given two memories
      When link_create links them with the label implements
      Then the stored direction and label are preserved
      When link_create repeats the same directed pair with contradicts
      Then the pair has one link labelled contradicts

    @integration
    Scenario: link_delete removes only the requested direction
      Given a link from A to B
      When link_delete removes A to B
      Then the A to B link is gone
      And the reverse direction is unaffected
      And deleting the missing link again succeeds as a no-op

  Rule: One canonical protocol, one complete skill

    @contract
    Scenario: The canonical body is the only normative source
      Given the canonical cognitive protocol body
      When the skill, L2 instructions, and MCP fallback are rendered
      Then the body appears exactly once in the skill and fallback
      And no independent complete copy exists for a client

    @contract
    Scenario: L2 instructions are a brief activation
      Given the rendered L2 instructions for OpenCode, Claude Code, and Codex
      When the agent reads them
      Then they name the mind-management skill
      And they state that system_instructions is the fallback
      And they do not contain the full protocol body

    @contract
    Scenario: MCP initialize instructions are brief
      Given the MCP server configuration
      When a client initializes a session
      Then the server returns a short instruction to load the skill
      And the instruction does not contain the full protocol body

    @contract
    Scenario: system_instructions remains the complete fallback
      Given the mind-management skill is unavailable
      When the agent calls system_instructions
      Then it receives the complete protocol
      And the response version is 2.3.0

    @integration
    Scenario: The MCP handshake exposes activation instructions
      Given the stdio MCP server
      When a client completes initialize
      Then the client receives the same brief activation text

    @integration
    Scenario: The skill installs once at the canonical global path
      Given a temporary home directory
      When setup installs the mind-management skill for several clients
      Then the canonical SKILL.md exists under .agents/skills/mind-management
      And a second setup run leaves it byte-identical
      And no backup is created for an unchanged skill

    @integration
    Scenario: Clients that need a dedicated path use symlink or copy
      Given the canonical skill directory
      When Claude Code and Antigravity are configured
      Then their skill directories point to or mirror the canonical directory
      And a symlink failure falls back to a managed copy
      And the copy is refreshed on later setup runs

    @integration
    Scenario: A foreign skill is never overwritten
      Given a mind-management skill without the Mind ownership marker
      When setup runs
      Then the foreign skill is preserved
      And setup reports a warning

    @integration
    Scenario: Mind-managed shadow copies are migrated
      Given an old Mind-managed copy in a higher-precedence client directory
      When setup runs
      Then the old copy is removed or refreshed without leaving a discoverable backup
      And the client resolves the canonical skill
      And unrelated files in the directory are preserved

  Rule: Agent integrations are honest and current

    @integration
    Scenario: Pi Agent receives the minimal integration
      Given a temporary Pi home directory
      When setup pi runs
      Then it writes the Pi MCP configuration
      And it adds a brief managed pointer to Pi AGENTS.md
      And the shared mind-management skill is available
      And it does not install a Pi-specific plugin

    @contract
    Scenario: The capability matrix records real paths and status
      Given the supported agent matrix
      When it is rendered and documented
      Then Pi Agent is present
      And Windsurf, VS Code Copilot, and Antigravity use their documented paths
      And documented, implemented, validated, and unverified support are distinguished

    @manual
    Scenario: Live client behavior stays explicitly unverified
      Given clients without an available free validation path
      When the implementation is reviewed
      Then their live skill activation and hooks are marked unverified
      And no paid subscription is used to claim otherwise

  Rule: The benchmark is an independent Bun subproject

    @contract
    Scenario: The benchmark owns its dependencies and lockfile
      Given the benchmark subproject
      When its manifest, lockfile, and TypeScript configuration are inspected
      Then it declares @opencode/sdk as its own dependency
      And it has its own lockfile and scripts
      And the root project does not use a workspace that includes it

    @integration
    Scenario: A normal root install excludes benchmark-only dependencies
      Given a clean root install from the frozen lockfile
      When the dependency tree is inspected
      Then @opencode/sdk is absent from the root package and lockfile
      And the benchmark package is not installed by the root

    @integration
    Scenario: The benchmark installs and tests independently
      Given the benchmark subproject
      When it is installed from its frozen lockfile
      Then @opencode/sdk resolves from the subproject
      And its free test and experiment suites pass
      And its TypeScript project typechecks

    @integration
    Scenario: Makefile targets delegate without changing behavior
      Given the repository root
      When the benchmark convenience targets run
      Then they execute inside the subproject
      And clean resolves runs and work directories against the repository root

    @unit
    Scenario: The harness reads the SDK version from its own dependency tree
      Given the benchmark subproject layout
      When version metadata is captured
      Then the SDK version is read from the harness root
      And a missing SDK version is reported as null without crashing

    @manual
    Scenario: The final report separates measured evidence from static verification
      Given the implementation report
      When a reviewer reads it
      Then dependency changes are shown before and after
      And real runs are distinguished from static configuration checks
      And unverified client behavior is listed explicitly
