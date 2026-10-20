@product/merge-readiness
Feature: Final quality pass and merge readiness

  Mind keeps one official skill named `mind-management`, a single Bun lockfile,
  deterministic CI, and an all-or-nothing checkpoint completion.

  Background:
    Given a temporary home directory
    And the Mind source tree on the feature branch

  Rule: Only mind-management is installed and updated

    @integration
    Scenario: Initial skill installation
      Given no mind-management skill exists
      When setup installs the skill for a client
      Then the canonical SKILL.md exists under .agents/skills/mind-management
      And its content matches the rendered protocol

    @integration
    Scenario: An old copy without the ownership marker is updated
      Given a mind-management SKILL.md without the current marker
      When setup runs
      Then the old content is backed up
      And the file is replaced with the current rendered skill

    @integration
    Scenario: A current copy with the marker is updated when it differs
      Given a mind-management SKILL.md with the marker but old content
      When setup runs
      Then the old content is backed up
      And the file is replaced with the current rendered skill

    @integration
    Scenario: An identical skill is left untouched
      Given the canonical skill already matches the rendered output
      When setup runs twice
      Then the file is byte-identical
      And no backup is created

    @integration
    Scenario: Other skills are never modified
      Given another skill exists beside mind-management
      When setup runs
      Then the other skill is byte-identical
      And only mind-management is updated

    @integration
    Scenario: A foreign symlink is replaced without writing through it
      Given the managed skill path is a symlink to an external directory
      When setup runs
      Then the external directory is unchanged
      And the old link target is recorded in a backup
      And the managed path is replaced safely

    @integration
    Scenario: A broken symlink is repaired
      Given the managed skill path is a symlink to a missing target
      When setup runs
      Then the old target is recorded
      And the skill is installed successfully

    @integration
    Scenario: Auxiliary files are preserved
      Given the managed skill directory contains an unrelated notes file
      When setup updates SKILL.md
      Then the notes file is unchanged
      And only SKILL.md is backed up and replaced

    @integration
    Scenario: A non-directory managed path does not crash setup
      Given the managed skill path is a regular file
      When setup runs
      Then setup reports a warning or repairs the path
      And it does not throw ENOTDIR

    @integration
    Scenario: Symlink failure falls back to a managed copy
      Given directory symlinks are unavailable
      When setup installs a dedicated skill path
      Then a managed copy is written
      And a second setup run remains idempotent

    @integration
    Scenario: The simplification preserves all supported clients
      Given the nine supported clients
      When setup installs or updates mind-management
      Then each client resolves the skill from its documented path
      And no other skill is touched

  Rule: Checkpoint completion is atomic

    @integration
    Scenario: A summary creation failure rolls back completion
      Given an active completed checkpoint with inbound and outbound links
      And summary creation is forced to fail
      When checkpoint_done runs
      Then the call fails clearly
      And the checkpoint still exists
      And no session summary exists
      And the original links are intact

    @integration
    Scenario: A link copy failure rolls back completion
      Given an active completed checkpoint with inbound and outbound links
      And copying a relation is forced to fail
      When checkpoint_done runs
      Then the call fails clearly
      And the checkpoint still exists
      And no partial session summary or copied links exist

    @integration
    Scenario: A checkpoint deletion failure rolls back completion
      Given an active completed checkpoint with inbound and outbound links
      And deleting the checkpoint is forced to fail
      When checkpoint_done runs
      Then the call fails clearly
      And the checkpoint still exists
      And no session summary or copied links exist

    @integration
    Scenario: A failed completion can be retried safely
      Given a checkpoint completion failed and rolled back
      When the failure is removed and checkpoint_done runs again
      Then exactly one session summary is created
      And inbound and outbound labels and directions are preserved
      And the checkpoint is deleted

    @integration
    Scenario: Successful completion preserves relations
      Given an active completed checkpoint with inbound and outbound links
      When checkpoint_done succeeds
      Then the summary is at T3 with type:session and cat:summary
      And every relation keeps its label and direction
      And the checkpoint no longer exists

  Rule: The project has one lockfile and deterministic CI

    @contract
    Scenario: package-lock.json is not part of the project
      Given the repository root
      When dependencies and scripts are inspected
      Then bun.lock is the only root lockfile
      And no script or CI step depends on package-lock.json

    @contract
    Scenario: CI uses the deterministic format check
      Given the CI workflow
      When the format step runs
      Then it uses bun run format:check
      And it does not use a write command

    @contract
    Scenario: CI documents the unresolved dependency audit
      Given the CI workflow
      When the audit configuration is inspected
      Then no audit step runs in CI
      And the workflow documents that bun audit currently fails on pre-existing vulnerabilities
      And dependency upgrades remain a separate follow-up

    @integration
    Scenario: Root and benchmark installs stay isolated
      Given the root and benchmark manifests
      When both frozen installs run
      Then the root has no benchmark-only dependencies
      And the benchmark resolves @opencode/sdk from its own lockfile

  Rule: Skill-first activation is validated without paid inference where possible

    @integration
    Scenario: OpenCode discovers the installed skill without a model run
      Given an isolated OpenCode home with the canonical skill installed
      When OpenCode configuration and skill discovery are queried
      Then mind-management is listed
      And the brief activation instruction is configured
      And the MCP handshake exposes the same activation

    @e2e
    Scenario: A real agent loads the skill before using Mind
      Given an isolated OpenCode session with the installed skill and MCP server
      When the agent is asked to use Mind
      Then the transcript contains a skill load for mind-management
      And the agent uses a Mind memory tool
      And it does not call system_instructions
      And a pending checkpoint survives a later session

    @manual
    Scenario: Unverified live behavior is reported honestly
      Given the implementation report
      When a reviewer reads it
      Then free discovery/config/handshake checks are separated from paid model behavior
      And unverified clients, compaction, and paid scenarios are listed

  Rule: The final review does not change the product architecture

    @manual
    Scenario: The final report records only scoped corrections
      Given the final implementation report
      When a reviewer compares it with the approved scope
      Then it lists corrections, files, tests, limitations, and pending items
      And it does not claim a redesign or new memory features
