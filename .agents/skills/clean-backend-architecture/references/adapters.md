# Infrastructure boundaries

The adapter pattern describes a role within infrastructure, not a top-level
project directory. HTTP, CLI, job, and messaging handlers live under
`infrastructure/http`, `infrastructure/cli`, `infrastructure/jobs`, and
`infrastructure/messaging`. Repositories, mappers, and gateways live under
`infrastructure/repositories`, `infrastructure/mappers`, and
`infrastructure/gateways`. This reference covers the infrastructure boundary
roles that were historically called "adapters."

Infrastructure boundaries translate between external protocols and application
contracts. They are replaceable edges, not places to put business policy.

## Handler flow

An HTTP handler, message consumer, CLI command, or scheduled job under
`infrastructure/` must follow this sequence:

1. Read the external input.
2. Authenticate the actor when required.
3. Authorize the requested capability in the appropriate layer.
4. Parse the input into a command or query.
5. Call one use case.
6. Translate the result into the protocol response.
7. Translate known errors and delegate unexpected errors to a central boundary.

The handler may decide how to report a failure, but it must not decide a domain
rule such as whether a profile can be activated.

## HTTP handlers (`infrastructure/http/`)

Keep request objects, response builders, status codes, headers, cookies, and
serialization inside the HTTP handler. Do not pass them into a use case or
repository.

Map errors explicitly:

```text
ValidationError  ->  400
AuthenticationError -> 401
AuthorizationError  -> 403
NotFoundError       -> 404
ConflictError       -> 409
Unexpected error    -> 500 with a safe reference
```

This mapping is an HTTP policy, not a domain error definition. A CLI handler may
map the same semantic error to an exit code, and a message consumer may retry or
dead-letter it.

## Message and event handlers (`infrastructure/messaging/`)

Treat message payloads as untrusted input even when the producer is an internal
service. Validate the envelope and payload, preserve message identifiers, and
make consumer processing idempotent.

Track delivery semantics explicitly:

- At-most-once: accept possible loss when the business permits it.
- At-least-once: make the handler safe to repeat.
- Exactly-once: treat as a narrowly scoped storage or broker guarantee, not a
  default claim about an entire distributed workflow.

Do not acknowledge a message before the required state transition is durable.

## CLI and job handlers (`infrastructure/cli/`, `infrastructure/jobs/`)

CLI commands and scheduled jobs are infrastructure handlers. Parse arguments and
environment input, construct a command or query, call a use case, and translate
the result to output or an exit status.

Keep one-off migrations, seeds, and administrative operations as separate
processes. They may reuse application use cases, but they must not become
hidden startup side effects of the long-running server.

## Outbound implementations

Repository implementations, gateways, publishers, file systems, and process
runners implement domain or application contracts. They own:

- SDK and driver calls.
- Connection and protocol details.
- External retry policies where appropriate.
- Mapping external data to internal models.
- Mapping internal models to external requests.

They do not own domain decisions. If an external API says a payment failed, the
implementation translates the failure; the application decides what the business
does about it.

## Boundary mapping

Convert casing, field names, dates, monetary representations, and vendor enums
at ingress or egress. Internal code must use one consistent representation.
Keep mappers pure when possible, and test them directly when they perform a
non-trivial transformation.
