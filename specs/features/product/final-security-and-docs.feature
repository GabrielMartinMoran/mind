@product/final-security-and-docs
Feature: Final security, documentation, and merge readiness

  Mind proves its skill-first behavior per session, ships with remediated
  dependencies, and keeps living documentation separate from historical reports.

  Background:
    Given the feature branch and isolated temporary state

  Rule: B11 verifies skill loading before Mind use

    @unit
    Scenario: A session loads mind-management before its first Mind call
      Given a transcript where the skill tool loads mind-management first
      When the first Mind tool call appears later
      Then the session is ordered correctly

    @unit
    Scenario: Using Mind before loading the skill fails
      Given a transcript where a Mind tool is called before the skill
      When the session is analyzed
      Then the session is not ordered
      And the failure names the session and the ordering violation

    @unit
    Scenario: A skill load in one session does not cover another session
      Given session 1 loads mind-management and session 2 only calls Mind
      When both sessions are analyzed
      Then session 2 has no skill evidence
      And the scenario fails without inferring a load

    @unit
    Scenario: A skill message is accepted as evidence
      Given a session message of type skill with id mind-management
      When the session is analyzed
      Then the skill load is recognized before Mind

    @unit
    Scenario: An unavailable skill argument is not treated as success
      Given a skill tool call without usable arguments
      When the transcript is analyzed
      Then the scenario reports missing evidence
      And it does not pass

    @unit
    Scenario: Every session must use Mind
      Given a two-session transcript where one session makes no Mind call
      When the scenario is asserted
      Then the scenario fails with a per-session reason

    @unit
    Scenario: system_instructions after the skill is redundant and rejected
      Given a session loads the skill and then calls system_instructions
      When the session is analyzed
      Then the scenario fails for that session

    @integration
    Scenario: The prepared B11 remains gated and is not run in free CI
      Given the benchmark registry
      When scenarios run without a Mind database or paid budget
      Then B11 is not_run or skipped
      And no model provider is called

  Rule: Known critical and high vulnerabilities are remediated

    @contract
    Scenario: Root critical and high advisories are cleared
      Given the root bun.lock after remediation
      When bun audit runs at high severity
      Then it exits successfully
      And no critical or high advisory remains

    @contract
    Scenario: Benchmark critical and high advisories are cleared
      Given the benchmark bun.lock after remediation
      When bun audit runs at high severity
      Then it exits successfully
      And no critical or high advisory remains

    @integration
    Scenario: Dependency upgrades preserve behavior
      Given the updated root and benchmark dependencies
      When frozen installs and all free suites run
      Then MCP stdio and HTTP behavior is unchanged
      And skill installation, checkpoints, and benchmark scenarios still pass

    @contract
    Scenario: CI audits the real dependency graph
      Given the CI workflow
      When the security step runs
      Then it uses bun audit at high severity for both projects
      And it does not suppress failures

  Rule: Documentation is living and navigable

    @contract
    Scenario: The documentation index lists every living document
      Given docs/README.md
      When the living documents are enumerated
      Then every living document is linked from the index
      And no historical report is presented as current behavior

    @integration
    Scenario: Relative documentation links resolve
      Given the living docs, history, README, AGENTS, and benchmark report
      When relative links are checked
      Then every target exists

    @contract
    Scenario: Historical reports are frozen and separated
      Given a historical report moved to docs/history
      When its header is read
      Then it states that it is historical and frozen
      And it points to the current behavior

    @contract
    Scenario: No temporal report remains in the living docs root
      Given the docs root
      When implementation, audit, and merge reports are listed
      Then they live under docs/history
      And release notes remain in docs/release-notes

    @contract
    Scenario: The documentation policy is present in AGENTS.md
      Given AGENTS.md
      When the documentation section is read
      Then it explains living vs temporal documentation
      And it defines the status vocabulary and update-before-create rule
      And it names the canonical protocol and index

    @manual
    Scenario: The final report is delivered outside living docs
      Given the implementation report for this review
      When the change is closed
      Then it is delivered as the session response or under .pas
      And it is not added as a new permanent docs report
