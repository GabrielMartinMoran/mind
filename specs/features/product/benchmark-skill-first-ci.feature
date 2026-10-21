@product/benchmark-skill-first-ci
Feature: Real skill-first benchmark setup and CI on every branch

  Mind's agent-memory benchmark reproduces the normal skill-first OpenCode
  integration for every current-checkout agent run. Historical engines keep
  their original behavior, and GitHub Actions runs for every branch and pull
  request.

  Background:
    Given the feature branch and isolated temporary state

  Rule: Current-checkout agent runs share the real skill-first setup

    @unit
    Scenario: The shared preparation runs the real Mind installer once
      Given an isolated benchmark environment for mind-current
      When the shared preparation runs
      Then it invokes the checkout mind setup opencode
      And it uses the isolated HOME and XDG directories
      And it injects the brief activation instruction into the inline config
      And it runs once per environment

    @unit
    Scenario: Repeated application does not duplicate instructions
      Given a prepared environment with the brief activation
      When the activation is applied again
      Then the instruction path appears exactly once

    @unit
    Scenario: A silent installer no-op fails closed
      Given mind setup opencode exits successfully without writing the skill
      When the shared preparation validates the environment
      Then it fails with the missing artifact
      And no agent session starts

    @integration
    Scenario: A current B unit prepares the agent once before its sessions
      Given a current B scenario with two sessions
      When the isolated unit is prepared
      Then the shared setup runs once before any session
      And the scenario seed and both sessions receive the prepared environment
      And the setup failure path consumes no model tokens

    @integration
    Scenario: B11 uses the shared preparation and keeps its own assertions
      Given B11 with mind-current
      When the unit runs
      Then B11 has no seed-time installer
      And the shared preparation provides the skill and L2 activation
      And each session still proves mind-management loads before its first Mind call

    @integration
    Scenario: LoCoMo A2 prepares each current condition once
      Given A2 with a prepared current database
      When the condition profile is prepared
      Then the shared setup runs once for the condition
      And every question receives the prepared environment
      And a missing prepared database fails before setup

    @integration
    Scenario: A1 does not install an agent skill
      Given a LoCoMo A1 run
      When the current condition is prepared
      Then no mind setup opencode command runs
      And the search path remains unchanged

    @integration
    Scenario: Historical and no-memory conditions remain skill-free
      Given mind-v9, mind-v10, and no-memory
      When their agent environments are prepared
      Then no current skill-first setup runs
      And mind-management is absent
      And the historical engines keep their original integration

    @integration
    Scenario: Isolation requires the exact current skill surface
      Given a mind-current agent environment
      When isolation is verified
      Then mind-management is installed at the canonical path
      And the brief activation file exists
      And OpenCode discovers exactly the builtin skills plus mind-management
      And the MCP server points to the checkout mind binary
      And no user skill or foreign config is present

    @integration
    Scenario: Historical environments reject the current skill surface
      Given a mind-v9, mind-v10, or no-memory environment
      When mind-management or its activation is present
      Then isolation verification fails closed
      And no prompt is sent

    @manual
    Scenario: The free real setup integration can be run when OpenCode is available
      Given an environment with the OpenCode binary
      When the skill setup and discovery integration runs
      Then the canonical skill is installed
      And OpenCode discovers mind-management
      And no paid model call is made

  Rule: CI runs for every branch and pull request

    @contract
    Scenario: Push and pull request triggers have no branch filters
      Given the CI workflow
      When the trigger configuration is parsed
      Then push and pull_request are present without branch or path filters
      And workflow_dispatch is available

    @contract
    Scenario: Branch names with slashes are covered
      Given branch names main, develop, feat/example, fix/example, and refactor/subsystem/change
      When the workflow triggers are evaluated statically
      Then no branch filter can exclude any of them
      And pull requests to any base branch are covered

    @contract
    Scenario: CI keeps the independent validation jobs
      Given the CI workflow
      When its jobs are inspected
      Then root and benchmark jobs remain independent
      And both use frozen installs and high-severity audits
      And the root job runs typecheck, format, lint, and tests
      And the benchmark job runs typecheck, tests, and experiments
      And no paid benchmark stage is present

    @manual
    Scenario: The feature branch has a real hosted CI run
      Given the final commit is pushed to the feature branch
      When GitHub Actions processes the push
      Then a CI run exists for that commit and branch
      And both validation jobs have an observed result
      And the run URL and job conclusions are recorded

    @manual
    Scenario: Missing hosted CI is reported as an external action
      Given no CI run appears for the pushed commit
      When repository Actions permissions and workflow state are inspected
      Then the cause is reported with evidence
      And the required external configuration is named
      And the branch is not declared ready to merge

  Rule: Security and merge readiness remain explicit

    @contract
    Scenario: Critical and high advisories block the merge
      Given the root and benchmark lockfiles
      When frozen installs and high-severity audits run
      Then neither project has a critical or high advisory
      And CI keeps both audits blocking without suppression

    @manual
    Scenario: The final classification reflects the observed evidence
      Given local tests, audits, and hosted CI evidence
      When the final report is written
      Then it distinguishes ready, blocked, and needs-external-action
      And it does not claim a green CI run that was not observed
