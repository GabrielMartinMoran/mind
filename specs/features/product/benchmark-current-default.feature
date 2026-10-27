@product/benchmark-current-default
Feature: Current-checkout benchmark default and durable documentation

  Mind's agent-memory benchmark evaluates the invoking checkout by default.
  Historical comparisons remain explicit, B11 is limited to the current
  skill-first engine, and versioned documentation explains the product rather
  than implementation sessions.

  Background:
    Given the feature branch and isolated temporary state

  Rule: The benchmark evaluates the current checkout by default

    @unit
    Scenario: The default condition is the current checkout
      Given the benchmark configuration
      When default conditions are resolved
      Then the only condition is mind-current
      And no historical condition is selected by default

    @unit
    Scenario: A current condition resolves to the invoking checkout
      Given the benchmark is invoked from a repository checkout
      When mind-current is prepared
      Then the engine uses the checkout mind binary
      And the engine identity is current
      And no historical worktree is created

    @integration
    Scenario: A default LoCoMo run uses current without worktrees
      Given default benchmark conditions
      When LoCoMo A1 runs with fake data and an injected runner
      Then it ingests into the current condition
      And no pinned worktree is prepared

    @integration
    Scenario: A2 answers from the prepared current database
      Given a current A1 database and default conditions
      When LoCoMo A2 runs with an injected executor
      Then it copies the current database into the isolated question workspace
      And it writes current answers without reading a real user database

    @integration
    Scenario: Scenarios B and full runs support current
      Given default benchmark conditions
      When scenarios B and a free full run execute with stubs
      Then both use the current engine
      And no pinned worktree is prepared
      And paid stages remain budget-gated

    @integration
    Scenario: Historical conditions remain explicit
      Given the conditions no-memory, mind-v9, mind-v10, and mind-current
      When historical conditions are selected explicitly
      Then their pinned worktrees are prepared
      And current still uses the checkout

    @contract
    Scenario: A current run records reproducible provenance
      Given a current run
      When run metadata is written
      Then it records branch, HEAD SHA, dirty state, package version, schema version, and mind binary
      And it records only the conditions that actually ran
      And historical runs record their actual pinned SHAs

  Rule: B11 proves current skill-first ordering only

    @unit
    Scenario: B11 eligibility is current-only
      Given B11 and the four benchmark conditions
      When eligibility is evaluated
      Then no-memory is not_run
      And mind-v9 is not_run
      And mind-v10 is not_run
      And mind-current is eligible
      And gated conditions execute zero sessions and cost nothing

    @integration
    Scenario: B11 does not prepare historical worktrees
      Given only B11 is selected with a historical condition
      When the scenarios command prepares worktrees
      Then no historical worktree is created
      And B11 is reported not_run

    @unit
    Scenario: B11 preserves per-session ordered evidence
      Given skill and Mind events in two sessions
      When B11 analyzes the transcripts
      Then each session must load mind-management before its first Mind call
      And each session must have its own activation evidence
      And system_instructions after the skill is rejected
      And missing or out-of-order evidence fails explicitly

    @unit
    Scenario: B11 preserves checkpoint continuity
      Given a B11 transcript with a pending checkpoint and a resume artifact
      When the assertion is evaluated
      Then the checkpoint still carries the pending work
      And the next session recovers the expected work
      And a missing artifact fails explicitly

    @manual
    Scenario: A real paid B11 remains human-authorized
      Given an OpenCode model budget and explicit confirmation
      When a maintainer runs B11 with mind-current
      Then the artifact contains per-session activation evidence and checkpoint continuity
      And the run is not part of free CI

  Rule: Reports reflect only measured conditions

    @integration
    Scenario: A single-condition run reports absolute results
      Given a run with only mind-current artifacts
      When the report is generated
      Then current metrics appear in the A1, A2, and B tables
      And no historical baseline or improvement percentage is invented
      And the report does not claim that A1 was not run
      And current cost and provenance are shown

    @integration
    Scenario: A multi-condition run compares measured conditions
      Given a run with no-memory, mind-v9, mind-v10, and mind-current artifacts
      When the report is generated
      Then baseline deltas and pairwise comparisons include only measured conditions
      And the legacy v9-to-v10 comparison remains available
      And deterministic ordering is preserved

    @integration
    Scenario: A run with no result artifacts is rejected
      Given a run directory without result artifacts
      When report generation is requested
      Then it fails with an actionable error
      And it does not emit a misleading all-not-available report

  Rule: Versioned documentation explains the product

    @contract
    Scenario: Only durable historical evidence remains versioned
      Given the docs tree after cleanup
      When historical evidence is enumerated
      Then retained reports record durable experiments or measurements
      And execution, merge, and validation reports are not versioned in docs
      And docs/history is not treated as an automatic archive

    @contract
    Scenario: The documentation index lists living pages and retained evidence
      Given docs/README.md
      When links are checked
      Then every living page is indexed
      And every retained historical report is listed separately
      And no link points to a removed report

    @integration
    Scenario: Documentation tests enforce invariants, not a fixed report list
      Given the docs tree and root documentation
      When the documentation tests run
      Then they validate index coverage, relative links, banners, non-empty files, and absence of temporal docs
      And they do not require specific implementation reports

    @contract
    Scenario: The documentation policy makes living docs the default
      Given AGENTS.md
      When the documentation policy is read
      Then it says to update the existing living page before creating a page
      And it sends execution and merge reports to .pas
      And it does not require every feature to produce a permanent report
      And it says docs/history is not an automatic archive

    @contract
    Scenario: The benchmark README documents both modes
      Given the benchmark README
      When a maintainer reads the execution section
      Then the default mode evaluates the current checkout
      And explicit historical comparisons are optional
      And B11 is documented as current-only
      And commands, scenario count, worktrees, LoCoMo stages, and single-condition reports match the CLI

  Rule: Security gates remain explicit

    @contract
    Scenario: Critical and high advisories remain blocked
      Given the root and benchmark lockfiles
      When frozen installs and high-severity audits run
      Then neither project has a critical or high advisory
      And CI keeps both audits blocking without suppression

    @manual
    Scenario: Residual lower-severity advisories are reported
      Given the benchmark audit after the change
      When no compatible update exists
      Then the residual advisory, scope, and limitation are documented
      And the team does not claim the dependency graph is vulnerability-free
