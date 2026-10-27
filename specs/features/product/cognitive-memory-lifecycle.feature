@product/cognitive-memory-lifecycle
Feature: Cognitive memory lifecycle and associative recall

  Mind maintains durable knowledge for agents: it admits meaning as well as
  words, keeps memory importance current, preserves the meaning of relations,
  and teaches one coherent protocol for orienting, recalling, learning,
  relating, maintaining, and handing off knowledge.

  Background:
    Given a mind store with temporary isolated databases
    And RAG is disabled unless a scenario explicitly enables it

  Rule: Semantic admission is independent from lexical admission

    @integration
    Scenario: A paraphrase-only memory survives alongside lexical results
      Given a memory that matches the query lexically
      And a memory that is semantically relevant but shares no query terms
      And RAG is enabled with a deterministic semantic score of 0.72 for the paraphrase
      When searching for the query
      Then the lexical memory is returned
      And the paraphrase-only memory is returned with the "semantic" method

    @unit
    Scenario: Weak semantic candidates are not admitted
      Given semantic candidates with cosine scores 0.40 and 0.60
      When selecting semantic admissions with the configured floor
      Then only the 0.60 candidate is admitted

    @integration
    Scenario: Semantic candidates respect filters and exclusions
      Given semantic candidates in another space, another tier, and with another tag
      And a semantic candidate excluded by NOT
      When searching with space, tier, tag, and NOT constraints
      Then no out-of-scope candidate is admitted
      And the excluded candidate is absent

    @integration
    Scenario: Explicit query operators keep lexical admission
      Given a paraphrase-only semantic candidate
      When searching with a quoted phrase, a prefix, OR, or NOT
      Then the paraphrase-only candidate is not admitted by the semantic bypass

    @integration
    Scenario: RAG off preserves the previous result set
      Given the same corpus and query that produced a committed RAG-off baseline
      When searching with RAG disabled
      Then the result identifiers, order, scores, confidence, and methods are unchanged

    @integration
    Scenario: A memory found by both channels appears once
      Given a memory that matches lexically and also has a semantic score
      When searching with RAG enabled
      Then the memory appears exactly once
      And its methods include both the lexical and semantic channels

  Rule: Memory maintenance is atomic and explicit

    @integration
    Scenario: memory_update pins and unpins a memory
      When calling memory_update with pinned true
      Then the response reports the memory as pinned
      When calling memory_update with pinned false
      Then the response reports the memory as unpinned

    @integration
    Scenario: memory_update promotes and demotes a memory
      Given a memory in tier 2
      When calling memory_update with tierTransition "promote"
      Then the response reports tier 1
      When calling memory_update with tierTransition "demote"
      Then the response reports tier 2

    @integration
    Scenario: Combined updates roll back on failure
      Given a full tier 1 where every memory is pinned
      And a memory in tier 2
      When calling memory_update with new content and tierTransition "promote"
      Then the tool returns a capacity error
      And the memory content is unchanged
      And the memory remains in tier 2

    @integration
    Scenario: Existing memory_update calls remain compatible
      When calling memory_update with only content, newName, or tags
      Then the previous update behavior is preserved
      And tags still replace the previous tag set

    @integration
    Scenario: Explicit tier transitions move pinned memories
      Given a pinned memory in tier 2
      When calling memory_update with tierTransition "promote"
      Then the memory moves to tier 1
      And it remains pinned

  Rule: Links preserve direction, label, and meaning

    @integration
    Scenario: memory_read exposes the stored label and direction
      Given a link from "decision-a" to "bugfix-b" with label "caused_by"
      When calling memory_read for "decision-a"
      Then the outgoing link summary includes label "caused_by"
      And the direction is "outgoing"
      When calling memory_read for "bugfix-b"
      Then the incoming link summary includes label "caused_by"
      And the direction is "incoming"

    @integration
    Scenario: Bidirectional links remain distinguishable
      Given a link from "a" to "b" with label "implements"
      And a link from "b" to "a" with label "contradicts"
      When calling memory_read for "a"
      Then both relations are returned with their own labels and directions

    @integration
    Scenario: Checkpoint recovery does not include itself
      Given a checkpoint linked from another memory
      When loading the checkpoint
      Then the checkpoint does not appear in its own linked memories
      And its outgoing linked memories are still returned

    @integration
    Scenario: An existing link can be relabeled
      Given a link from "a" to "b" with label "related"
      When calling link_create for the same direction with label "implements"
      Then the link has exactly one label "implements"
      And the link still connects "a" to "b"

    @integration
    Scenario: Deleting a missing link is idempotent
      Given two memories with no link between them
      When calling link_delete for that pair
      Then the call succeeds without error
      And no link is created

  Rule: Space orientation is bounded and current

    @integration
    Scenario: space_get surfaces living references
      Given a space with a memory tagged "type:reference" and "status:living"
      When calling space_get
      Then the response includes a references block
      And the living reference appears in that block
      And checkpoints are excluded from trending memories

    @integration
    Scenario: Tier 3 availability does not load every memory
      Given a space with many tier 3 memories
      When calling space_get
      Then the tier 3 block reports the total count
      And it returns at most five preview memories

    @integration
    Scenario: Pinned memories are ordered first
      Given a tier with pinned and unpinned memories
      When calling space_get
      Then pinned memories appear before unpinned memories in that tier preview

  Rule: The cognitive protocol has one canonical source

    @contract
    Scenario: All protocol outputs share one canonical body
      Given the canonical cognitive protocol body
      When rendering the agent protocol, MCP system instructions, and skill
      Then each output contains the canonical body
      And no normative paragraph is duplicated across the three outputs

    @contract
    Scenario: Protocol examples use the real tool surface
      Given every fenced tool example in the protocol
      When validating it against the MCP schemas
      Then required parameters such as space are present
      And no removed tool or unavailable parameter appears

    @unit
    Scenario: Protocol rendering rejects unresolved tokens
      Given a protocol template with an unresolved placeholder or conditional
      When rendering it
      Then rendering fails with a clear error

    @manual
    Scenario: A reviewer validates cognitive load and absence of rituals
      Given the final protocol and the lifecycle document
      When a human reviewer reads both
      Then the six responsibilities are clear and actionable
      And no mandatory call, quota, or calendar ritual is prescribed
      And every example can be executed with the documented tools

  Rule: Real agents can sustain the lifecycle

    # E2E: adherence to the protocol and real tool use cannot be established by
    # unit or integration tests; these scenarios run OpenCode in isolation and
    # assert on the resulting SQLite database and workspace artifacts.
    @e2e
    Scenario: Agent writes durable knowledge instead of ephemeral detail
      Given an isolated OpenCode session with the mind MCP server
      When the agent completes a task that establishes a stable decision
      Then the project space contains an atomic durable memory with a category tag
      And no duplicate memory with the same name exists

    # E2E: the agent must discover and register a new relation between
    # existing memories; only a real agent run exercises that decision.
    @e2e
    Scenario: Agent relinks existing memories
      Given two existing memories with a stale relation
      When the agent discovers the correct relation during its task
      Then the stored link has the intended direction and label
      And a later session can recover that relation

    # E2E: supersession requires judgment about what changed and what history
    # must be preserved; database mechanics alone cannot prove it.
    @e2e
    Scenario: Agent supersedes a changed decision
      Given an existing durable decision memory
      When a later task replaces that decision
      Then the current knowledge is updated or recreated
      And the historical decision is preserved with a superseded status
      And the new decision links to the historical one

    # E2E: intentional tier maintenance depends on distinguishing inspection
    # from active use, which only a real agent session can demonstrate.
    @e2e
    Scenario: Agent maintains tiers intentionally
      Given a memory that becomes operationally important
      When the agent inspects it without promoting and later works with it
      Then the memory tier and pinned state reflect the intended use
      And the agent does not promote memories it only inspected

    # E2E: continuity across sessions and subagents cannot be simulated by a
    # single-process test because context is discarded between sessions.
    @e2e
    Scenario: A later session recovers prior knowledge
      Given a completed session that produced durable knowledge
      When a new isolated session starts on the same project
      Then it recovers the relevant memory or session summary
      And it uses that knowledge to complete its task

    # E2E: semantic recall with RAG on depends on a real embedding provider and
    # an agent choosing a paraphrase query; it is the only way to validate the
    # independent semantic admission end to end.
    @e2e
    Scenario: Semantic recall finds a paraphrase-only memory
      Given an isolated mind database with RAG enabled and embedded memories
      When the agent asks for knowledge using words absent from the target memory
      Then the target memory is admitted and used
      And unrelated memories are not admitted as noise
