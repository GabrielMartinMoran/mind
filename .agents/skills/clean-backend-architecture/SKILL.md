---
name: clean-backend-architecture
description: >-
  Framework-agnostic Clean Architecture guidance for backend systems. Use this
  skill whenever you design, implement, refactor, or review APIs, CLI
  applications, workers, jobs, event consumers, repositories, services, domain
  models, dependency injection, CQRS, commands, queries, results, validation,
  persistence, error handling, security, reliability, observability, layered
  project structure, bounded-context folders, or one-public-concept-per-module
  conventions. Apply it to JavaScript, TypeScript, Python, Go, Java, Kotlin, Rust, and
  other backend ecosystems, even when the user does not explicitly mention
  Clean Architecture.
version: "0.1.0"
author: Gabriel Martin Moran [moran.gabriel.95@gmail.com]
license: "MIT"
source: "https://github.com/GabrielMartinMoran/skills"
---

# Clean backend architecture

Use this skill to design backend systems whose business rules remain testable,
portable, and independent from frameworks, transports, databases, and vendors.
Apply principles pragmatically. Preserve useful project conventions when they
do not violate the dependency rule, and do not introduce abstractions without a
concrete change in coupling, testability, or business clarity.

## Scope

This skill covers backend applications exposed through:

- HTTP APIs and webhooks.
- Message brokers and event consumers.
- Background workers and scheduled jobs.
- CLI commands and administrative processes.

It is framework-neutral. Use the project's native mechanisms for routing,
validation, configuration, errors, concurrency, and testing. Read the relevant
reference when the task needs detail.

## Core model

Keep business policy in the core and push technical decisions to boundaries.

```text
entrypoints -> application use cases -> domain core
infrastructure implements domain/application contracts
```

Dependencies point inward during normal execution. Entrypoints are the
intentional exception: they load configuration, import concrete infrastructure
and use cases, wire them together, and start the process. A use case does not
discover its dependencies through globals, service locators, or hidden
containers.

| Area              | Owns                                                                                                       | Must not own                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `config/`         | Typed runtime configuration, validation, environment loading                                               | Business rules, domain logic, dependency wiring               |
| `domain/`         | Entities, value objects, invariants, domain events, domain errors, repository interfaces                   | HTTP, framework APIs, database clients, vendor SDKs           |
| `application/`    | Use cases, commands, queries, results, orchestration                                                       | Transport objects, persistence rows, framework response types |
| `infrastructure/` | HTTP/cli/jobs/messaging handlers, repository implementations, gateway implementations, persistence mappers | Core business decisions, domain policy                        |
| `entrypoints/`    | Process bootstrap, configuration loading, concrete wiring, lifecycle management                            | Business behavior, transport logic                            |

`config/` and `entrypoints/` are support areas, not primary architectural layers.
Config is loaded by entrypoints and passed explicitly; domain and application
never import global config objects.

## Default project shape

Organize files by layer, responsibility, and functional context. Use the
project's real source root, such as `src/api`, `src/cli`, or `src/server`.

```text
<source-root>/
├── config/
├── domain/
│   ├── entities/<context>/
│   ├── value-objects/<context>/
│   ├── repositories/<context>/       # Interfaces (ports) owned by domain
│   ├── errors/<context>/
│   └── helpers/<concern>/
├── application/
│   ├── dto/
│   │   ├── commands/<context>/       # State-changing inputs
│   │   ├── queries/<context>/        # Read-only inputs
│   │   └── results/<context>/        # Output contracts
│   ├── services/<context>/           # Use cases
│   └── helpers/<concern>/
├── infrastructure/
│   ├── http/<context>/               # HTTP handlers, serialization
│   ├── cli/<context>/                # CLI handlers
│   ├── jobs/<context>/               # Job handlers
│   ├── messaging/<context>/          # Message/event handlers
│   ├── repositories/<context>/       # Concrete implementations
│   ├── mappers/<context>/            # Persistence/vendor mapping
│   ├── gateways/<context>/           # External API integrations
│   └── helpers/<concern>/
└── entrypoints/
```

Do not treat `helpers/` as a universal dumping ground. Scope helpers to the
layer and technical or domain concern that owns them. Technical helpers may be
organized by concern, such as `filesystem/` or `process/`, when they support
multiple contexts within that layer. Mirror domain repository ports and
infrastructure implementations by functional context.

## Working rules

Apply these rules in order when designing or reviewing a backend change.

1. Start by identifying the business capabilities, actors, inputs, outputs,
   invariants, external systems, and failure modes.
2. Place business rules in entities, value objects, or focused domain services.
3. Represent each application action as one focused use case under
   `application/services/<context>/`.
4. Make the use case receive one command or one query and return an explicit
   result. Commands, queries, and results live under `application/dto/`, not
   inside the service directory.
5. Define ports where the policy that needs the abstraction lives. Keep ports
   free from transport and persistence representations. When an application use
   case genuinely needs a contract, co-locate it with the use case or in a
   focused domain repository; do not create a generic `application/ports/`
   directory.
6. Parse untrusted input at every external boundary. Preserve domain invariant
   checks inside the domain even when a transport schema already ran.
7. Translate foreign data shapes, casing, errors, and serialization formats at
   boundaries. Do not leak them into the core.
8. Wire concrete implementations in one entrypoint and make lifetimes
   explicit. Stateless services may be shared; request or job state must not be.
9. Add tests at the narrowest boundary that proves the behavior, then add
   integration or contract coverage where an external boundary can fail.
10. Prefer the smallest architecture that protects real business boundaries.

## CQRS-lite default

Separate application DTOs by intent:

- `commands/` contain state-changing requests.
- `queries/` contain read-only requests.
- `results/` contain output contracts for commands and queries.
- `services/` contains use cases that execute one command or query.

This is CQRS-lite. It does not require separate databases, buses, projections,
or event sourcing. Introduce separate read models, write models, or stores only
when read and write concerns have materially different performance, scaling,
consistency, or ownership requirements. Read `references/application.md` for
the decision rules.

## Single public concept per module

Production leaf modules that define a concept expose one public concept per
file. Apply this to entities, value objects, errors, exceptions, ports,
interfaces, classes, DTO types, and enums across every layer. Private helpers
may stay beside the concept.

Function modules may expose several cohesive functions when the module is a
deliberate function package, such as a mapper or date-calculation package.
Framework entrypoints, configuration modules, registries, and
package-level `index` files are explicit exceptions when their contract
requires multiple public exports.

In Python, treat top-level names that do not start with `_` as public by
convention. A public class may share a file with `_InternalResult` or another
internal helper. The underscore signals intended internal use; it is not access
control.

Use subdirectories to package related concepts by context. Avoid creating a
single `entities.ts`, `errors.py`, or `services.py` file that becomes a hidden
registry for unrelated public types.

## Reference index

Load only the reference that matches the current design or review task.

| Reference                            | Read when you need to...                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `references/architecture.md`         | Choose layers, directories, ports, imports, and entrypoints                       |
| `references/domain.md`               | Model entities, value objects, aggregates, invariants, and domain errors          |
| `references/application.md`          | Design DTOs, use cases, dependency injection, and CQRS-lite                       |
| `references/adapters.md`             | Implement HTTP, messaging, CLI, and job handler boundaries (infrastructure roles) |
| `references/persistence.md`          | Design repositories, mappers, transactions, migrations, and idempotency           |
| `references/reliability-security.md` | Handle auth, secrets, retries, timeouts, logs, metrics, and shutdown              |
| `references/testing.md`              | Select unit, integration, contract, and end-to-end test boundaries                |
| `references/quality.md`              | Review module granularity, naming, helpers, imports, and quality gates            |

## Architecture review checklist

Use this checklist after tracing dependencies and identifying the external
boundaries of the change.

- [ ] The domain has no framework, transport, database, or vendor imports.
- [ ] Dependencies point inward except from entrypoints.
- [ ] Every application action is represented by one focused use case.
- [ ] Use cases receive one command or query and return an explicit result.
- [ ] Commands, queries, and results are separate DTO categories.
- [ ] CQRS complexity is justified by actual read/write divergence.
- [ ] Ports do not expose request objects, response objects, rows, or SDK types.
- [ ] Infrastructure handlers parse, authenticate, authorize, delegate, and translate.
- [ ] Infrastructure implementations implement ports and contain technical mapping only.
- [ ] Domain and application concepts use one public concept per module.
- [ ] Helpers are scoped and do not hide business logic.
- [ ] Foreign casing and data shapes are converted at boundaries.
- [ ] Configuration and secrets are validated at startup and kept out of code.
- [ ] Expected and unexpected errors have deliberate handling and logging.
- [ ] Tests cover domain rules, use cases, infrastructure boundaries, and persistence risks.
- [ ] Linting, formatting, type checks, tests, and builds use the project toolchain.
