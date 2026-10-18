# Domain modeling

Keep business language and invariants in the domain. The domain must remain
usable in a unit test without a web server, database, message broker, or
framework runtime.

## Entities

An entity has identity that remains meaningful when other attributes change. Put
valid state transitions and invariant-preserving behavior on the entity rather
than making every caller inspect and mutate fields.

```typescript
export class Profile {
  constructor(
    private readonly id: ProfileId,
    private displayName: DisplayName,
  ) {}

  rename(displayName: DisplayName): void {
    this.displayName = displayName;
  }
}
```

Keep the public concept in its own module. Unexported parsing or construction
helpers may stay in that module when they are implementation details.

## Value objects

Use value objects when a value has rules, a meaningful vocabulary, or a stable
combination of fields. Keep them immutable from the caller's perspective,
validate their own invariants, and compare by value.

Examples include `EmailAddress`, `AgentId`, `Money`, `DateRange`, and
`Pagination`. Do not represent money with binary floating point when precision
matters. Use integer minor units or a decimal type with an explicit rounding
policy.

## Aggregates and invariants

Use an aggregate to define a consistency boundary. The aggregate root controls
changes to its children and protects invariants that must hold together.

- Keep aggregate boundaries small enough to update reliably.
- Load and save through the aggregate root when consistency requires it.
- Do not make every database table an aggregate automatically.
- Use domain services for rules that need multiple domain concepts but do not
  naturally belong to one entity or value object.

An invariant belongs at the narrowest layer that can guarantee it. Transport
schemas protect input shape. Application authorization protects access. Domain
objects protect business validity. Persistence protects storage constraints.

## Domain events

Use domain events to record a meaningful business fact, not every method call.
Keep event types transport-neutral. Decide at the application or infrastructure
boundary whether to publish them synchronously, asynchronously, or through an
outbox.

Do not use domain events as an excuse to hide a direct use-case dependency. A
simple explicit call is clearer when no decoupling or independent delivery is
required.

## Errors

Define errors by semantic meaning. Domain errors must not contain HTTP status
codes, response objects, framework exceptions, or vendor error classes.

```python
class ProfileNotFoundError(Exception):
    pass


class _ErrorContext:
    def __init__(self, aggregate: str, identifier: str) -> None:
        self.aggregate = aggregate
        self.identifier = identifier
```

The public exception is the only public concept in the module. `_ErrorContext`
is an internal helper by Python convention and may remain in the same file.

Map domain errors to HTTP statuses, message outcomes, CLI exit codes, or job
handling policies at the relevant adapter. Keep user-safe messages separate
from diagnostic details.

## Naming

Use the vocabulary of the domain and make behavior explicit:

- `Profile.activate()` is better than `Profile.setStatus("active")`.
- `Money.add()` is better than exposing raw cents to every caller.
- `AgentRepository` describes a domain interface;
  `AgentSQLiteRepository` or `AgentPostgreSQLRepository` describes an
  infrastructure implementation.

Do not introduce entities, aggregates, events, or value objects solely because
the pattern exists. Add them when they protect a meaningful business rule or
boundary.
