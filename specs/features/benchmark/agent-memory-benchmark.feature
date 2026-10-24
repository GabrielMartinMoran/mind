@benchmark @product/agent-memory
Feature: Agent memory benchmark harness
  Benchmark harness that compares OpenCode with and without Mind memory
  ("v9" = main pinned commit, "v10" = develop pinned commit) over a
  deterministic LoCoMo subset (benchmark A) and real agent scenarios
  (benchmark B), with fail-closed environment isolation and budget guards.

  Rule: OpenCode isolation

    @integration
    Scenario: Isolated run uses only its own temporary directories
      Given a condition run is prepared with isolated HOME and XDG directories
      When the effective OpenCode paths are inspected
      Then every resolved path (config, data, state, cache, database) is inside the run directory

    @integration
    Scenario: Contaminated environment rejects the run without paid prompts
      Given a prepared run whose effective config lists an unauthorized MCP server, skill, agent, command or plugin
      When the isolation verification runs
      Then the run is marked contaminated
      And no prompt is sent to the model
      And the verification evidence is stored with the run

    @contract
    Scenario: Condition config enables only the authorized model and memory server
      Given the three benchmark conditions are prepared
      When each condition's generated OpenCode config is inspected
      Then the config pins exactly the authorized provider and model
      And the "no memory" condition defines no MCP server
      And each Mind condition defines exactly one local MCP server named "mind"

    @integration
    Scenario: Embedded SDK hosts share the unit database after the owner closes
      Given a benchmark unit with one isolated OpenCode database path
      When one embedded SDK host creates a session there and is closed
      Then a fresh SDK host bound to that same path can read the session
      And it can read the imported messages without a model request

  Rule: Mind and SQLite isolation

    @contract
    Scenario: Pinned worktrees run their own engine
      Given pinned worktrees for v9 and v10 exist
      When each version initializes a fresh database
      Then the v9 database reports schema version 8
      And the v10 database reports schema version 10

    @integration
    Scenario: Each condition and scenario uses its own database
      Given a run prepares its conditions and scenarios
      When a mind command is executed for a condition
      Then the effective database path is the condition's own file
      And the user's live database is never opened for writing

    @integration
    Scenario: Each answering unit uses its own database copy
      Given a prepared Mind condition with an ingested database
      When an answering question is executed for a repetition
      Then the OpenCode child environment and the Mind MCP environment point at that unit's own database copy
      And the shared condition database is not mutated by the answering session

  Rule: Deterministic ingestion

    @unit
    Scenario: Subset selection is deterministic and category balanced
      Given the LoCoMo dataset and a seed
      When the subset is selected twice
      Then both selections are identical
      And the pilot subset contains exactly one question per dataset category

    @unit
    Scenario: Dataset category names follow the dataset ordering
      When a question's category integer is mapped to its name
      Then 1 maps to "multi-hop", 2 to "temporal", 3 to "open-domain", 4 to "single-hop" and 5 to "adversarial"

    @integration
    Scenario: Ingestion is lossless and identical for both engines
      Given the selected conversation
      When it is ingested into fresh v9 and v10 databases
      Then each database contains exactly one memory per dialogue turn named by its dia_id
      And no memory was evicted, deleted or summarized

  Rule: Retrieval measurement (A1)

    @unit
    Scenario: Retrieval metrics are computed correctly
      Given ranked results with known evidence positions
      When recall at 5 and 10, MRR, precision and context token estimates are computed
      Then each metric matches the expected value

    @integration
    Scenario: A1 runs through each version's API with normalized scores
      Given an ingested conversation for a version
      When the retrieval runner queries the version's search API
      Then results are ranked and normalized to a common result shape
      And version-specific score fields do not break the metrics

  Rule: Answering measurement (A2)

    @unit
    Scenario: Adversarial answers are scored as correct abstention or hallucination
      Given an adversarial question with a canonical abstention phrase
      When the deterministic scorer evaluates an abstention answer
      Then the answer is scored as a correct abstention
      When the scorer evaluates a confident invented answer
      Then it is scored as a hallucination

    @contract
    Scenario: Blind judging does not reveal the engine
      Given candidate answers from the three conditions
      When judge payloads are built
      Then candidates are anonymized and order-randomized per question
      And the mapping back to conditions is kept out of the judge payload

    @contract
    Scenario: Repetitions are measured and aggregated independently
      Given a question executed with three repetitions
      When the answering stage completes
      Then each repetition has an independent session and unit directory
      And results carry a repetition index and per-condition means

    @unit
    Scenario: Baseline deltas compare Mind against no memory
      Given aggregated results for a Mind condition and the no-memory baseline
      When deltas are computed
      Then absolute deltas are always reported
      And relative deltas are reported only when the baseline is non-zero
      And missing baselines are reported as not applicable

    @unit
    Scenario: An idle wait without a successful outcome is not a completed answer
      Given a session whose wait returned idle without a successful idle outcome
      When the answering result is classified
      Then the result is incomplete rather than correct or incorrect
      And its empty content is not sent to the blind judge

    @unit
    Scenario: A non-adversarial abstention stays distinct from a partial answer
      Given a non-adversarial question
      When the answer is the canonical no-information phrase
      Then the result is classified as an abstention
      And it is not counted as a partial answer because a reference happens to share a token

    @unit
    Scenario: A successful empty answer is visible but never correct
      Given a session completed with a successful idle outcome and empty final text
      When the answering result is classified
      Then it is recorded as an empty answer
      And it is excluded from correct and partial answer counts
      And it does not receive a positive blind-judge score

  Rule: Scenario benchmark (B)

    @unit
    Scenario: Scenario assertions distinguish pass and fail workspace states
      Given passing and failing workspace fixtures for a scenario
      When the scenario assertion runs on each fixture
      Then the passing fixture reports success and the failing fixture reports failure

    @integration
    Scenario: Scenario runner isolates state and captures child sessions
      Given a scenario with a preparation phase and a utilization phase
      When the runner executes both phases for a condition
      Then the scenario uses a fresh database and workspace
      And child sessions spawned by the agent are captured and linked to their parent session

    @unit
    Scenario: Unavailable child evidence is not reported as no child behavior
      Given a scenario recorded a subagent tool call
      And its child-session evidence capture failed
      When the B4 assertion evaluates the result
      Then the result is a harness error, not a behavior failure
      And only a successful capture that returns no children may fail as no child

    @unit
    Scenario: Incomplete B11 evidence is not a skill-order failure
      Given B11 captured no usable transcript or ordered skill events
      When its assertion evaluates the result
      Then the result is a harness error, not a model failure
      And a captured skill event after a Mind call is the behavior failure

    @e2e
    Scenario: Durable writing survives into a later session
      Given a project fixture with a constrained persistence decision
      When the agent completes the decision task and a later session applies it
      Then the unit database contains a project memory tagged cat:decision or cat:pattern
      And that memory's content contains the decision's key terms
      And no project memory name is stored twice
      And the later session's artifact reflects the decision

    @e2e
    Scenario: A stale relationship is relinked and reused
      Given two seeded memories connected by a stale related link
      When the agent corrects the relationship and a later session uses it
      Then the stored link points from the implementation to the strategy with the label implements
      And the old related label is absent
      And the later session's answer artifact names the related strategy memory

    @e2e
    Scenario: A changed decision supersedes the old one and is reused
      Given a project fixture with an existing durable decision memory in a project space
      When the agent records the replacement decision and a later session applies it
      Then the historical decision memory still exists with its category tag, original content, and status:superseded
      And a new category-tagged memory records the replacement decision
      And a link from the new memory to the historical memory is labelled contradicts
      And no project memory name is stored twice
      And the later session's artifact names the new decision

    @e2e
    Scenario: Session summaries preserve continuity across three sessions
      Given a project fixture that does not contain the project fact
      When the agent establishes the fact and closes two sessions with summaries and a third session uses the fact
      Then at least one session summary is tagged type:session and cat:summary and contains the fact
      And no session summary name is stored twice
      And the third session's artifact contains the fact

    @e2e
    Scenario: Tier maintenance separates active knowledge from reference material
      Given two T2 project memories: a release checklist and background notes
      When the agent pins and promotes the checklist and a later session uses it
      Then the release checklist is at T1 and pinned
      And the background notes remain at T2 and are not pinned
      And no project memory name is stored twice
      And the later session's artifact names the release checklist

    @e2e
    Scenario: Paraphrase-only recall retrieves a semantically related memory
      Given a project fixture that does not contain the target fact
      And a project space is seeded with an embedded target fact and a plausible distractor fact
      And RAG is enabled with an available embedding provider credential
      When the agent answers a natural paraphrase question whose content words do not appear in the target memory
      Then the target memory exists and has a stored embedding
      And the answer artifact contains the target fact (24 hours)
      And the answer artifact does not contain the distractor fact
      And no project memory name is stored twice

    @unit
    Scenario: B10 requires recorded semantic provenance for the target result
      Given a recorded target memory query result with known methods
      When the B10 assertion evaluates the result without a semantic-method target match
      Then the scenario does not pass on embedding presence and answer text alone
      And it passes only when the target result records the semantic provenance

    @unit
    Scenario: Semantic recall is gated on RAG and a Mind condition
      Given a scenario that requires semantic recall and enables RAG
      When the embedding credential or a Mind memory condition is unavailable
      Then the scenario is recorded as not_run with a clear reason
      And no session is executed
      And the run is not counted as failed

  Rule: Budget and artifacts

    @unit
    Scenario: Budget guard aborts when the cap is exceeded
      Given a run configured with a maximum cost cap
      When the accumulated cost exceeds the cap
      Then execution stops with an aborted status
      And no further prompts are sent

    @contract
    Scenario: Run metadata records everything needed to reproduce
      Given a completed run
      When the run metadata is read
      Then it records both source SHAs, OpenCode and SDK versions, Bun version, provider and model, dataset hash, subset seed, limits, budget and per-stage status

    @unit
    Scenario: Report generation does not leak secrets
      Given stored run results
      When the report is generated from those results
      Then it is produced only from result artifacts
      And it contains no credential values or provider keys

    @unit
    Scenario: Curated results export is sanitized and committable
      Given a completed run whose metadata contains absolute artifact paths
      When curated results are exported
      Then paths are sanitized before the secret scan
      And the export is written outside the ignored runs directory

  Rule: Cross-harness integration (agent-memory-bench)

    @contract
    Scenario: RAG-on runs verify the embedding index before grading
      Given a Mind run with embeddings enabled
      When ingestion completes
      Then the adapter verifies that the indexed embedding count equals the total memory count
      And the run aborts before grading if any embedding is missing

  Rule: Paid pilot execution
    # @manual: the paid pilot needs the real provider, real OpenCode and a real
    # budget; it cannot run in CI. Procedure documented in the harness README;
    # the maintainer executes it via the bench-agent-memory make targets and QA
    # verifies result integrity afterwards.

    @manual
    Scenario: The pilot runs all three conditions within the approved budget
      Given the harness is implemented and its isolation probes pass
      When the maintainer executes the pilot command with the approved budget cap
      Then the three conditions complete their A and B measurements
      And actual costs and per-item results are recorded for the final report
