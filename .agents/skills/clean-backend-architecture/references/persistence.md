# Persistence and external state

Treat databases, caches, queues, file systems, and third-party APIs as replaceable
resources behind ports. Persistence is an implementation detail until the
business explicitly depends on a consistency or durability guarantee.

## Repository ports

Define repository contracts using domain or application concepts, not rows or
driver types.

```typescript
export interface ProfileRepository {
  findById(id: ProfileId): Promise<Profile | null>;
  save(profile: Profile): Promise<void>;
}
```

Typed query objects, pagination, specifications, transaction contexts, and
cancellation signals are acceptable when they express a real application need.
Do not pass an HTTP request, ORM model, SQL row, or SDK response across the
port.

Implementations belong in `infrastructure/repositories/<context>/`. Keep query
construction, driver calls, and persistence mapping there.

## Mappers

Use pure mappers to translate between persistence records, domain objects, and
results. Keep foreign casing and storage-specific types at the persistence
boundary.

Do not use binary floating point for money unless the business explicitly accepts
its error characteristics. Convert minor units or decimal values with a named
policy. Treat timestamps and time zones as explicit data, not incidental local
machine behavior.

## Transactions

The application layer decides the business transaction boundary. Infrastructure
provides the mechanism. A use case that must atomically update multiple records
must express that requirement through a transaction port, unit of work, or
repository operation rather than opening a driver transaction directly.

Do not hold a database transaction across network calls unless the system has a
deliberate distributed transaction design. Prefer an outbox or compensating
workflow when durable state and message publication must coordinate.

## Concurrency and idempotency

Design for retries and concurrent writers:

- Use optimistic version checks when lost updates are unacceptable.
- Use unique constraints for identity and natural idempotency keys.
- Make repeated commands safe when delivery can be repeated.
- Store an idempotency result when the caller needs the same response on retry.
- Keep retryable and non-retryable failures distinct.

Idempotency is a business and boundary concern. A repository can enforce a
unique key, but the application still decides what a duplicate means.

## Migrations and lifecycle

Version schema changes explicitly, review them as code, and run them as an
administrative process. Do not silently mutate production schemas at application
startup unless the deployment model intentionally requires it.

Create clients and pools in the entrypoint. Reuse safe process-scoped
clients and pools. Scope mutable request, job, or transaction state to that
operation. Close resources during graceful shutdown.
