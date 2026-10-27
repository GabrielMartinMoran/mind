# Backend testing strategy

Choose the narrowest test boundary that proves the behavior. Use integration
tests where framework, database, broker, or serialization behavior is part of
the risk. Do not replace all real boundaries with mocks merely to make tests
fast.

## Test boundary matrix

Use this matrix to match each risk to the smallest test boundary that can prove
the behavior.

| Target | Test with | Proves |
| --- | --- | --- |
| Entity or value object | Real domain objects | Invariants and state transitions |
| Use case | Fakes or focused test doubles for ports | Application behavior and error decisions |
| Mapper | Fixed input and output values | Boundary translation and round trips |
| Inbound adapter | Real parser/router and injected test use case | Parsing, auth, serialization, and error mapping |
| Repository adapter | Real or test database | Queries, constraints, transactions, and migrations |
| Message adapter | Test broker or contract harness | Envelope handling, acknowledgment, and retry policy |
| External gateway | Contract test or controlled sandbox | Vendor protocol assumptions |
| Full workflow | Deployed or near-production stack | Wiring and critical user journeys |

## Unit tests

Test domain rules without infrastructure. Test use cases with deterministic
fakes that implement ports. Assert observable behavior:

- Returned result or raised error.
- Domain state transition.
- Calls to required ports.
- No calls made after a guard failure.
- Idempotency and authorization decisions.

Use mocks only when interaction itself is the behavior under test. A small fake
often communicates a repository contract more clearly than a large mock setup.

## Integration and contract tests

Test repository implementations against the database behavior they rely on,
including constraints, transaction boundaries, and migrations. Test infrastructure handlers through their real parser and serializer when those details can reject
or corrupt input.

Use contract tests for HTTP clients, message schemas, and third-party gateways.
They protect assumptions between independently deployed systems without making
every test a full end-to-end test.

## Determinism

Inject clocks, ID generators, random sources, and retry schedulers when they
affect behavior. Use fixed values in tests unless randomness is the explicit
subject of the test. Keep tests independent, repeatable, and self-validating.

Factories and builders must provide valid defaults and allow focused
overrides. Do not hide the important precondition of a test behind a factory
that silently creates an unrelated state.

## Risk-based coverage

Do not use arbitrary line or test counts as a quality metric. Cover the risks:

- Every domain invariant and invalid state transition.
- Authentication, authorization, and tenant isolation.
- Validation and error translation at each external boundary.
- Transaction rollback and concurrency behavior where relevant.
- Retry and idempotency behavior for repeatable operations.
- Regression tests for every fixed bug.

Write tests before structural refactors when existing behavior is not already
protected. Use the project's test runner and naming conventions rather than
forcing a universal framework or test-name format.
