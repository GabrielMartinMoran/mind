# Application layer and CQRS-lite

The application layer expresses what the system can do. A use case coordinates
domain objects and ports without knowing how a request arrived or how data is
stored.

## DTO categories

Organize application DTOs by intent and output role:

```text
application/dto/
├── commands/<context>/
├── queries/<context>/
└── results/<context>/
```

### Commands

A command requests a state-changing action. It is named with an imperative
verb, such as `CreateAgent`, `InstallSkill`, or `UpdateProfile`.

Commands may carry identifiers, input values, actor context, or an idempotency
key. Do not put an HTTP request, framework context, database row, or SDK object
inside a command.

### Queries

A query requests data without changing business state. It may contain filters,
sorting, pagination, projections, or a consistency preference. A query must not
perform a hidden write such as updating a last-seen timestamp unless that side
effect is an explicit separate use case.

### Results

A result is the output contract of a command or query. It can contain an
identifier, an acknowledgment, a domain-derived view, a page, or a collection
of read models. Do not expose an entity merely because it is convenient. Map to
the smallest stable contract required by the caller.

## Use cases

Put use cases under `application/services/<context>/`. The important rule is
that this directory contains use cases, not command and query definitions.

Each use case:

- Has one business intention.
- Receives one command or one query.
- Returns one explicit result type. Use a named result such as `DeleteAgentResult`
  or `OperationResult` when the caller needs no data beyond successful
  completion; do not omit the result contract.
- Receives dependencies through constructor or function parameters.
- Coordinates domain behavior and ports.
- Does not parse transport data or construct database clients.

```typescript
export class CreateAgentUseCase {
  constructor(private readonly agents: AgentRepository) {}

  async execute(command: CreateAgentCommand): Promise<CreateAgentResult> {
    const agent = Agent.create(command.name);
    await this.agents.save(agent);
    return { agentId: agent.id.value };
  }
}
```

The use case above is a command handler even though the repository directory is
named `services`. Do not put `CreateAgentCommand` or `CreateAgentResult` in the
same module when the single-public-concept rule applies.

## Validation

Parse untrusted transport data at the adapter boundary into a command or query.
Then enforce application authorization, domain invariants, and persistence
constraints at their own boundaries. "Validate once" means do not repeatedly
parse the same transport representation; it does not mean that all later
invariants or security checks disappear.

TypeScript with Zod can separate the runtime schema and inferred type:

```text
dto/commands/agents/create-agent.schema.ts
dto/commands/agents/create-agent.command.ts
```

Python with Pydantic can use one public `CreateAgentCommand(BaseModel)` class
when that class is both the input model and its validation schema. Follow the
language's native model rather than splitting one semantic concept artificially.

## Dependency injection

Declare every external capability in the use-case constructor or function
signature. Inject clocks, ID generators, transaction boundaries, repositories,
publishers, and gateways when the behavior depends on them.

Avoid global state and service locators. A container may assemble the graph at
the edge, but the use case must remain understandable from its signature.

## CQRS-lite versus full CQRS

CQRS-lite is the default when the application benefits from distinct read and
write intent but can share domain models, repositories, and storage.

Use full CQRS only when there is a concrete reason, such as:

- Read and write models have materially different shapes or scaling needs.
- A read projection must be optimized independently.
- Separate teams or deployment lifecycles own reads and writes.
- Eventual consistency and replay are accepted business trade-offs.

Do not add a command bus, query bus, mediator, event sourcing, or a second
database just because the DTO directories are separate.

Likewise, do not split `AgentRepository` into `AgentReader` and `AgentWriter`
until read and write access patterns, consistency, or ownership actually differ.
