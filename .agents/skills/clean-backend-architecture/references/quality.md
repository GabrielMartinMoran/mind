# Quality and module conventions

Use conventions that make the dependency graph and business intent easy to
read. These are heuristics, not excuses to fragment code mechanically.

## One public concept per module

Keep one public production concept in each leaf module. This applies across all
layers to entities, value objects, errors, interfaces, ports, classes, DTO
types, and enums.

```typescript
// domain/errors/agents/agent-not-found.error.ts
export class AgentNotFoundError extends Error {}
```

```python
# domain/errors/agents/agent_not_found.py
class AgentNotFoundError(Exception):
    pass


class _ErrorDetails:
    pass
```

The Python module has one public class. `_ErrorDetails` is an internal helper by
convention. In TypeScript, unexported helpers may accompany the exported class.

Function packages are an intentional exception:

```typescript
export function mapAgentFromRecord(record: AgentRecord): Agent { /* ... */ }
export function mapAgentToRecord(agent: Agent): AgentRecord { /* ... */ }
```

Keep the functions cohesive and scoped to one boundary. Do not use a function
package exception to store unrelated classes or types.

## Package directories and barrels

Use directories to group concepts by context:

```text
domain/
├── entities/agents/
├── repositories/agents/
└── errors/agents/
```

Use package indexes only at deliberate public boundaries. Direct imports are
preferred inside the package. Avoid a generic `models` file that exports every
entity or an `errors` file that exports every exception.

## Naming

Follow the ecosystem's native naming convention for identifiers and filenames.
Keep the vocabulary stable within each project:

- Boolean values use an intention-revealing prefix such as `is`, `has`, or
  `can` when the language convention supports it.
- Functions use verbs or verb-noun phrases.
- Classes and interfaces use domain nouns or clear roles.
- Commands use imperative names.
- Queries use read-oriented names.
- Results describe the returned contract.
- Implementations identify the technical boundary when useful, such as
  `AgentSQLiteRepository` or `FilesystemSkillStore`.

Do not impose kebab-case, snake_case, or PascalCase across languages. Follow
the dominant ecosystem convention and keep external casing at infrastructure boundaries.

## Functions and control flow

Keep functions cohesive and at one level of abstraction. Prefer guard clauses
when they make failure conditions clear. Treat function length and nesting as
signals to inspect, not automatic refactoring thresholds. A cohesive algorithm
may be longer than an arbitrary line count; a short function may still have
multiple responsibilities.

Comments explain why a non-obvious decision exists. Rename, extract, or
restructure code when a comment merely describes what the code already says.

## Layered quality gates

Run the project's native formatter, linter, type checker, tests, and build checks.
Enforce the checks in CI when possible. Do not mandate ESLint, Prettier, Ruff,
Black, or another tool when the project uses a different ecosystem.

Architecture review must check imports and boundaries, not only formatting:

- No domain-to-framework imports.
- No use-case construction of concrete infrastructure implementations.
- No transport or persistence types in ports.
- No business decisions in mappers or handlers.
- No hidden mutable global state.
- No helpers that conceal a second application layer.
