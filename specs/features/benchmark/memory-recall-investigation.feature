@benchmark @product/memory-recall
Feature: Memory recall investigation workbench

  Investigation tooling for the memory-recall analysis: an instrumented
  copy of the search pipeline, a replay workbench that reproduces the
  benchmark retrieval exactly, and deterministic experiment drivers for
  query strategies, memory representations, and top-K comparisons.
  All tooling is experiment-only and never ships to production.

  Rule: Replay fidelity

    @integration
    Scenario: Replay reproduces stored benchmark retrieval
      Given the benchmark run database and its recorded probe queries
      When the workbench replays every probe against the search API
      Then retrieved chunk counts equal the stored counts for every probe
      And two consecutive plain replays produce identical results

    @contract
    Scenario: Instrumentation is copy-only and env-gated
      Given the instrumented search copy
      When the debug sink is disabled
      Then pipeline results are byte-identical to the uninstrumented copy
      And production sources contain no instrumentation

  Rule: False-negative classification

    @integration
    Scenario: Evidence items are classified per stage with an explicit K
      Given the per-stage dumps for a probe and its gold evidence identifiers
      When the classifier labels each evidence item
      Then each item receives one stage label at the stated K
      And items whose rank cannot be determined within the dump caps are reported as unknown

  Rule: Query strategies

    @unit
    Scenario: Query strategies are deterministic and respect explicit operators
      Given a natural-language question and a strategy list
      When the focused-query variants are generated twice
      Then both generations are identical
      And explicit AND, OR, NOT, phrases and prefixes are preserved
      And no strategy consults the expected answer

  Rule: Representation variants

    @unit
    Scenario: Representation variants preserve provenance
      Given the same conversation ingested under each representation variant
      When a memory is retrieved in any variant
      Then its dialogue identifier remains recoverable
      And no field is invented beyond the original content

  Rule: Decision reporting

    # @manual: the deliverable is the analysis document itself; its decision
    # table is reviewed by a human (Lead/QA) before closure. There is no
    # automated test for the document, and none is faked.
    @manual
    Scenario: Comparisons distinguish measured from expected impact
      Given experiment results and proposal tables
      When the analysis report is generated
      Then every proposal row states its evidence and whether impact is measured or expected
      And proposals are classified as quick win, promising candidate, strategic change or not recommended
