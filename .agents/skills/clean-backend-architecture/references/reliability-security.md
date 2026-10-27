# Reliability, security, and operations

Backend architecture includes the behavior of the system under invalid input,
partial failure, retries, overload, shutdown, and hostile access. Keep these
concerns at boundaries and make their policies visible.

## Configuration and secrets

Load configuration through the runtime's native mechanism and validate required
values at startup. Keep deployment configuration outside source code.

- Never expose secrets through public configuration or responses.
- Do not log credentials, tokens, complete payment data, or unnecessary personal
  information.
- Fail fast when required configuration is missing or malformed.
- Separate configuration parsing from business logic.

## Authentication and authorization

Authentication identifies an actor. Authorization decides whether that actor may
perform a capability against a resource. Keep the distinction explicit.

- Parse and verify credentials at an inbound boundary.
- Pass a typed actor or authorization context to the use case when needed.
- Enforce resource ownership and business permissions close to the use case or
  domain rule that understands them.
- Apply tenant isolation to every relevant read and write path.
- Do not trust an identifier from a request merely because its syntax is valid.

## Timeouts, retries, and cancellation

Every outbound network call needs an explicit timeout. Retry only operations
that are safe to repeat, and use bounded exponential backoff with jitter.

Do not retry validation failures, authorization failures, or deterministic
business conflicts. Propagate cancellation from the inbound operation to
outbound calls when the language and runtime support it.

Use circuit breakers, bulkheads, rate limits, or queues when one dependency can
exhaust the resources of the whole process. Pick the smallest mechanism that
addresses a measured failure mode.

## Error handling

Distinguish expected failures from unexpected failures:

- Expected failures are mapped to safe, intentional outcomes.
- Unexpected failures are logged with a correlation identifier and handled by a
  central boundary.
- Preserve the original cause for diagnostics without exposing it to callers.
- Avoid logging the same error at every layer.
- Never silently swallow a failure without a documented reason.

Use exceptions, result types, or explicit error returns according to the
language and project conventions. The architectural requirement is deliberate
propagation and translation, not one universal error mechanism.

## Observability

Use structured logs, metrics, and traces where they provide operational value.
Attach request, job, or message correlation identifiers. Record duration,
outcome, retry count, and relevant business or dependency context without
including sensitive data.

Provide health and readiness checks that distinguish process health from
dependency readiness. Do not make a health endpoint perform an expensive or
state-changing business operation.

## Stateless processes and shutdown

Keep long-running processes stateless between operations unless the deployment
model explicitly provides durable shared state. Store sessions, locks, and job
progress in appropriate backing resources.

On shutdown, stop accepting new work, allow bounded in-flight work to finish,
close pools and consumers, flush required telemetry, and exit with a useful
status. Do not rely on process termination to commit business state.

## Background work

Workers and scheduled jobs need the same boundaries as APIs:

- Validate job payloads.
- Record attempts and ownership.
- Make handlers idempotent.
- Classify retryable failures.
- Use dead-letter or quarantine handling for poison messages.
- Make timeouts and cancellation visible.

Use an outbox when a database state change and an emitted message must not drift
apart. Use an inbox or processed-message record when duplicate delivery matters.
