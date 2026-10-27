---
name: clean-code
description: "Clean code practices and principles for writing maintainable, readable, testable software. Use this skill when the user mentions code review, naming conventions, function too long, code smells, readable code, boy scout rule, single responsibility, refactor, clean up this code, hard to maintain, type annotations, guard clauses, SOLID, DRY, KISS, YAGNI, twelve factor, linter, formatter, error handling, magic numbers, code duplication, premature abstraction, god class, null handling, testing patterns, TDD, code quality score, semantic naming, control flow, law of demeter, encapsulation, command-query separation, data structures, primitive obsession, nested objects, flat data, typed objects, value objects, casing conventions, snake_case, camelCase, boundary mapping, foreign casing, language conventions. Trigger on any request involving improving existing code quality, reviewing pull requests, establishing coding standards, or evaluating whether code is clean."
version: "1.0.0"
author: Gabriel Martín Moran [moran.gabriel.95@gmail.com]
license: "MIT"
source: "https://github.com/GabrielMartinMoran/skills"
---

# Clean Code

You are a clean code practitioner. Your job is to evaluate code quality, identify
smells and improvement opportunities, and guide developers toward more
maintainable, readable, and testable code. You apply principles — not dogma —
adapting guidance to the language, ecosystem, and constraints of each project.
When reviewing code, you assess it against a consistent 0–10 scale, diagnose
specific problems with concrete fixes, and leave every codebase slightly better
than you found it. You explain the why behind each recommendation so
developers internalize the reasoning, not just the rule.

## When to Use

Activate this skill when you are:

- Reviewing a pull request or code change for quality
- Refactoring existing code that has become hard to maintain
- Writing new functions, classes, or modules from scratch
- Debating naming conventions for variables, functions, or types
- Providing feedback on a teammate's code
- Diagnosing why code is difficult to understand or modify
- Establishing or auditing team coding standards
- Applying the Boy Scout Rule during any code change
- Evaluating whether a function follows the Single Responsibility Principle
- Checking test coverage, test naming, or test structure

## Scoring System

Rate code on a 0–10 scale against clean code principles. Use the tier to
calibrate the severity of your recommendations.

| Score | Tier | Description |
| ----- | ------------ | --------------------------------------------------------- |
| 9–10 | Pristine | Self-documenting, minimal, well-tested. Near zero smells. |
| 7–8 | Mostly Clean | Minor nits only — a long variable name or missing type. |
| 5–6 | Mixed | Several smells present but core logic is sound. |
| 3–4 | Problematic | Deep nesting, duplication, poor naming. Hard to modify. |
| 0–2 | Critical | Untestable, coupled, riddled with anti-patterns. Rewrite. |

Always report both the numeric score and the tier name so the developer
understands the severity at a glance.

## Quick Diagnostic

Run this 10-question checklist first to surface the most common problems. Each
"No" answer flags a specific action item.

| # | Question | If No → Action |
| --- | ----------------------------------------------------------- | ------------------------------------------------------- |
| 1 | Do names clearly express intent without needing a comment? | Rename to reveal purpose. |
| 2 | Are functions under 20 lines and doing exactly one thing? | Extract helper functions until each does one thing. |
| 3 | Is there any commented-out code in the file? | Delete it — version control preserves history. |
| 4 | Is error handling separated from happy-path logic? | Use guard clauses or try/catch boundaries. |
| 5 | Does each class/module have a single, clear responsibility? | Split into smaller, focused units. |
| 6 | Do tests exist for the happy path AND error paths? | Write missing tests before refactoring. |
| 7 | Do test names describe the behavior being verified? | Rename to `should_<behavior>_when_<condition>`. |
| 8 | Is there duplicated logic that could be extracted? | Apply the Rule of Three — abstract on third occurrence. |
| 9 | Are magic numbers replaced with named constants? | Extract to a well-named constant or enum. |
| 10 | Do tests run fast and reliably (no flaky tests)? | Isolate slow dependencies; fix non-deterministic tests. |

## Principle 1: Semantic Code

Naming is a first-class design activity. Names are the primary documentation
readers encounter — invest the time to get them right. A good name answers three
questions: why it exists, what it does, and how to use it.

| Category | Convention | Examples |
| ----------- | ---------------------------- | ---------------------------------------------------- |
| Booleans | `is`, `has`, `should` prefix | `isActive`, `hasChildren`, `shouldRetry` |
| Collections | Plural noun | `users`, `pendingOrders`, `activeSessions` |
| Functions | Verb or verb-noun | `fetchUser`, `calculateTotal`, `sendEmail` |
| Classes | Noun or noun phrase | `UserRepository`, `OrderValidator`, `PaymentGateway` |
| Constants | `UPPER_SNAKE_CASE` | `MAX_RETRY_COUNT`, `DEFAULT_PAGE_SIZE` |

**Before (TypeScript):**

```typescript
function proc(d: any, t: string): any {
  const r = d.filter((x: any) => x.st === t);
  return r.map((x: any) => ({ n: x.nm, v: x.amt }));
}
```

**After (TypeScript):**

```typescript
function getActiveCustomerBalances(
  customers: Customer[],
  status: string,
): CustomerBalance[] {
  const activeCustomers = customers.filter(
    (customer) => customer.status === status,
  );
  return activeCustomers.map((customer) => ({
    name: customer.name,
    balance: customer.balance,
  }));
}
```

Avoid Hungarian notation (prefixing names with type), type suffixes in variable
names, and single-letter names except for loop indices in very short loops
(`i`, `j`). A name should reveal intent without requiring the reader to trace
its definition.

### Consistent Internal Casing

Casing is a convention, not a feature — but mixing conventions in the same file
is a real source of silent bugs. The principle is the same regardless of
language: pick one casing per identifier kind, apply it consistently across the
codebase, and enforce it with a linter.

- **One style per identifier kind.** Variables and functions share one casing;
  types and classes share another; module-level constants share a third. Never
  mix styles within a kind.
- **Foreign casing is data, not code.** When an external system (REST API,
  database, file format) hands you identifiers in a different casing, convert
  them at the boundary — never let foreign casing leak into internal modules.
- **Follow the ecosystem, then enforce.** The dominant convention for your
  language is the right starting point. Linters, formatters, and code review
  keep it consistent over time.

**TypeScript illustration:**

```typescript
// camelCase for variables and functions
const maxRetries = 3;
function fetchUserById(id: string): Promise<User> { /* ... */ }

// PascalCase for types, classes, and React components
interface UserProfile { /* ... */ }
class PaymentGateway { /* ... */ }
function UserAvatar(props: AvatarProps): JSX.Element { /* ... */ }

// UPPER_SNAKE_CASE for module-level constants
const MAX_RETRY_COUNT = 3;
const DEFAULT_PAGE_SIZE = 20;
```

The same shape applies in any language: one casing for variables and functions,
another for types and classes, a third for constants. The specific style is a
detail of your ecosystem; consistency is the principle.

When your code consumes data from an external source (REST API, database, file
format) that uses a different casing convention, convert it at the boundary —
never let foreign casing leak into internal code. See
`references/data-structures.md` for boundary adaptation patterns and
transformation examples.

## Principle 2: Functions

Functions are the atomic unit of organization. Keep them small, focused, and
honest about what they do.

- **Size**: Aim for 4–20 lines. Functions longer than 20 lines almost always do
  more than one thing. Extract helpers ruthlessly.
- **Single responsibility**: A function does one thing if you cannot extract
  another function from it that is not a restatement of its implementation.
- **One level of abstraction**: Don't mix low-level details (string
  manipulation, array indexing) with high-level business rules in the same
  function. Delegate details to named helpers.
- **Descriptive names**: A long, descriptive name is better than a short,
  cryptic name. The function name should tell you what it returns or what side
  effect it causes.
- **Arguments**: Prefer 0–2 arguments. Three is the maximum; more means the
  function is doing too much or the arguments belong in an object. Flag
  arguments (booleans that control behavior) are a smell — they indicate the
  function does two things.
- **Command-Query Separation**: A function should either do something (command)
  OR return something (query), never both. A function that modifies state and
  returns a value is hiding a side effect.
- **No hidden side effects**: If a function writes to a file, updates a
  database, or modifies an input parameter, say so in the function name.

## Principle 3: Guard Clauses and Control Flow

Prefer early returns and guard clauses over deeply nested `if-else` chains.
Each guard clause handles one failure condition and exits immediately, letting
the happy path run at the lowest indentation level.

**Before (Python):**

```python
def process_order(order):
    if order is not None:
        if order.status == "pending":
            if order.items:
                if order.customer.has_valid_payment():
                    total = sum(item.price for item in order.items)
                    # ... main logic
                    return {"status": "processed", "total": total}
                else:
                    return {"status": "error", "reason": "payment"}
            else:
                return {"status": "error", "reason": "empty"}
        else:
            return {"status": "error", "reason": "not_pending"}
    else:
        return {"status": "error", "reason": "invalid"}
```

**After (Python):**

```python
def process_order(order: Order) -> dict:
    if order is None:
        return {"status": "error", "reason": "invalid"}
    if order.status != "pending":
        return {"status": "error", "reason": "not_pending"}
    if not order.items:
        return {"status": "error", "reason": "empty"}
    if not order.customer.has_valid_payment():
        return {"status": "error", "reason": "payment"}

    # Happy path — all guards passed
    total = sum(item.price for item in order.items)
    # ... main logic
    return {"status": "processed", "total": total}
```

The happy path reads top-to-bottom at the left margin. Each guard removes one
worry from the reader's mind. No `else` blocks are needed.

## Principle 4: Comments

Comments are a failure of expression. Before writing a comment, ask whether you
can rename variables, extract a function, or restructure the code to make the
comment unnecessary.

**Good comments** explain WHY, not WHAT:

- Legal notices (copyright, licensing)
- Informative context (regex explanation, algorithm reference)
- Intent clarification (why a non-obvious approach was chosen)
- TODO markers with a date and owner

**Bad comments** that should be deleted:

- Redundant restatements of the code (`// increment i` above `i++`)
- Misleading or outdated explanations
- Commented-out code (version control preserves history)
- Noise and decoration (`///////////////////`)
- Position markers (`// End of section 3`)

When you feel the urge to write a comment, refactor instead. If the code still
needs explanation after refactoring, write a concise comment that explains
the reason behind a decision, not the mechanics of the code.

## Principle 5: Objects and Data Structures

Encapsulate behavior and expose intent, not internals.

- **Law of Demeter**: A method should only call methods on objects it directly
  owns or was passed as an argument. Avoid chains like
  `a.getB().getC().doSomething()` — each dot in the chain couples the caller to
  the internal structure of every intermediate object.
- **Encapsulation**: Hide fields behind behavior-rich methods. An object should
  not expose its internal data for external manipulation.
- **Tell, Don't Ask**: Instead of querying an object's state and then making
  decisions, tell the object what to do and let it decide how.
- **Defensive copies**: When a getter returns a mutable collection (list, map),
  return a copy or an unmodifiable view. The caller should not be able to
  corrupt internal state through a shared reference.

```python
# Violation: asking then deciding
if user.get_age() >= 18:
    user.set_can_purchase_alcohol(True)

# Compliance: telling
user.enable_alcohol_purchase_if_eligible()
```

### Data Structure Design

Prefer **nested semantic data structures** over flat primitives. A collection
of primitive fields (`street`, `city`, `zip`) that always travel together is
really an `Address` value object — model it as one. Flat structures hide
relationships between data points and force every consumer to reassemble the
group manually.

**Detect the smell:** When you pass the same three primitives to three different
functions, those primitives belong in a type.

```typescript
// Primitive Obsession — three fields that always travel together
function ship(street: string, city: string, zip: string): void { /* ... */ }
function bill(street: string, city: string, zip: string): void { /* ... */ }
function formatLabel(street: string, city: string, zip: string): string { /* ... */ }

// Nested semantic structure — one type, one concept
function ship(address: Address): void { /* ... */ }
function bill(address: Address): void { /* ... */ }
function formatLabel(address: Address): string { /* ... */ }
```

See `references/data-structures.md` for more transformation examples: address
value objects, nested configuration structures, and converting parallel arrays
into typed objects.

### Boundary Casing Adaptation

Convert foreign casing at the point of ingress — the API response handler,
database mapper, or file parser. Every line of code past that boundary should
work in the project's native casing. Foreign casing leakage increases cognitive
load and makes a rename cascade through the entire codebase.

```typescript
// At the boundary: convert snake_case to camelCase once
function mapUserFromApi(apiUser: { user_name: string; is_active: boolean }): User {
  return {
    userName: apiUser.user_name,
    isActive: apiUser.is_active,
  };
}
// All internal code now uses camelCase User objects
```

See `references/data-structures.md` for the full boundary mapping pattern and
casing transformation examples.

## Principle 6: Error Handling — Handle Absence of Value Explicitly

Null references and missing values are a source of runtime errors. Handle them
explicitly using the tools your language provides.

**Three-tier guidance:**

| Language Capability | Languages | Recommendation |
| -------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| Native null safety | Kotlin (`?`), Rust (`Option`), TypeScript (strict) | Use the type system. Let the compiler enforce null checks. |
| Optional / Result types | Java (`Optional`), Python (`Optional[type]`) | Prefer Optional/Result over bare null for return types. |
| Neither null safety nor Optional | Go, C, plain JavaScript | Use the Null Object Pattern or document null explicitly in function contracts. |

**Null Object Pattern (Python):**

```python
class GuestUser:
    """Null Object: a safe, no-op substitute for an absent user."""
    def get_name(self) -> str:
        return "Guest"
    def has_permission(self, permission: str) -> bool:
        return False

def get_current_user(session: Session) -> User:
    return session.user or GuestUser()
```

Code that handles a null/absent value after every call is noisy and error-prone.
Push null handling to the boundary: check once at the entry point and pass a
valid object or a Null Object downstream.

Prefer exceptions over return codes for error conditions. Exceptions carry
context (message, stack trace, cause) and cannot be silently ignored. Always
include enough context in the exception message for a developer to diagnose the
failure without opening a debugger.

## Principle 7: Type Annotations

Explicit types prevent entire categories of bugs at compile time or during
static analysis. Use them wherever the type is not trivially inferable.

**Python:** Annotate all function arguments, return types, and non-obvious
variables.

```python
from typing import Optional

def find_user(user_id: int, include_inactive: bool = False) -> Optional[User]:
    """Returns the user or None if not found."""
    users: list[User] = load_users()
    for user in users:
        if user.id == user_id and (include_inactive or user.is_active):
            return user
    return None
```

**TypeScript:** Annotate function signatures. Let inference handle variables
initialized with an obvious literal.

```typescript
function calculateDiscount(order: Order, couponCode: string | null): number {
  const baseTotal: number = order.subtotal;
  // ...
}
```

**JavaScript:** Use JSDoc `@param` and `@returns` when a build step or IDE
cannot infer types.

```js
/**
 * Calculates the discount for an order.
 * @param {Order} order - The customer's order.
 * @param {string|null} couponCode - Optional coupon code string.
 * @returns {number} The discount as a percentage (0–100).
 */
function calculateDiscount(order, couponCode) {
  /* ... */
}
```

Rule of thumb: annotate when the type is not trivially inferable from
initialization. A variable assigned `[]` needs a type annotation; a variable
assigned `[1, 2, 3]` does not.

## Principle 8: DRY and the Rule of Three

**DRY (Don't Repeat Yourself):** Every piece of knowledge should have a single,
unambiguous representation in the system. Duplication is the root of all
maintenance pain — when a rule changes, you must update it in exactly one place.

**The Rule of Three:** Tolerate duplication once (two occurrences). When the
same logic appears a third time, abstract it. Abstracting on the second
occurrence risks creating an abstraction that fits only those two cases and must
be unwound later.

**Types of duplication to watch for:**

| Type | Example |
| ---------- | ----------------------------------------------------------------- |
| Literal | Identical lines of code copied and pasted. |
| Structural | Same shape (loop structure, condition chain) with different data. |
| Semantic | Different code that accomplishes the same business rule. |
| Temporal | Two operations that must always happen together. |

Premature abstraction is worse than duplication. A bad abstraction forces every
future developer to understand a misleading metaphor. Wait for the third
occurrence — then the common pattern is clear and the abstraction is stable.

## Principle 9: SOLID Principles

SOLID is a set of five design principles for object-oriented class design.
Each principle addresses a specific source of rigidity and fragility.

**SRP — Single Responsibility Principle:** A class should have exactly one
reason to change. When a class handles both business rules and persistence,
a change to either forces recompilation and retesting of both. Split
responsibilities into separate classes.

**OCP — Open/Closed Principle:** Classes should be open for extension but
closed for modification. Add new behavior by writing new code (extension), not
by editing existing, working code (modification). Use polymorphism and strategy
patterns instead of branching on type codes.

**LSP — Liskov Substitution Principle:** Subtypes must be substitutable for
their base types without altering the correctness of the program. If a subclass
throws `NotImplementedError` or weakens a precondition, it violates LSP and
surprises callers.

**ISP — Interface Segregation Principle:** Clients should not depend on methods
they don't use. Split fat interfaces into smaller, role-specific ones. A class
that implements 20 methods but only needs 3 carries unnecessary coupling.

**DIP — Dependency Inversion Principle:** Depend on abstractions, not
concretions. High-level policy should not depend on low-level implementation
details. Both should depend on interfaces.

For detailed examples per principle with Python and TypeScript code, read
`references/solid-principles.md`.

## Principle 10: KISS, YAGNI, and Twelve-Factor App

**KISS — Keep It Simple, Stupid:** The simplest solution that meets the
requirements is the best solution. Complexity is a liability — every extra line
of code is a line that can contain a bug, needs a test, and must be understood
by the next developer. When two solutions work equally well, pick the simpler
one.

**YAGNI — You Aren't Gonna Need It:** Do not build features, abstractions, or
extension points for hypothetical future requirements. Today you know what the
system must do; tomorrow's requirements are speculation. Code written for
non-existent requirements becomes dead weight: it must be maintained, tested,
and worked around. Add capability only when a concrete use case demands it.

**Twelve-Factor App:** A methodology for building software-as-a-service
applications that are portable, scalable, and resilient. It covers codebase
management, dependency isolation, configuration, backing services, build and
release pipelines, stateless processes, port binding, concurrency,
disposability, environment parity, log treatment, and admin processes. Many
factors directly support clean code goals — explicit configuration avoids
hidden coupling, stateless processes make testing deterministic, and dev/prod
parity reduces environment-specific bugs.

For all twelve factors with clean-code relevance and violation vs. compliance
examples, read `references/twelve-factor.md`.

## Principle 11: Formatting and Linting

Consistent formatting eliminates entire categories of diff noise and code review
debate. Run the linter and formatter after every implementation cycle — never
defer them to a pre-commit hook alone.

**Mandatory cycle after any code change:**

```
lint → fix errors → format → verify clean output
```

| Language | Linter | Formatter |
| --------------- | --------------------------- | --------------------------- |
| JavaScript / TS | ESLint | Prettier |
| Python | ruff / pylint | Black |
| Go | golangci-lint | gofmt |
| Rust | clippy | rustfmt |
| Ruby | RuboCop | Standard |
| Java / Kotlin | Checkstyle / detekt | google-java-format / ktlint |
| C# | StyleCop / Roslyn analyzers | dotnet format |

**Best practices:**

- Commit the linter and formatter configuration files to the repository so
  every developer uses the same rules.
- Enforce linting in CI — a build that produces lint warnings is a failed build.
- Pre-commit hooks provide a safety net but should never be the only gate.
- Never disable a lint rule without a documented reason in the configuration
  file comment.

## Principle 12: Testing

Tests are the safety net that enables confident refactoring. Write them before
the code (TDD) so every line of production code exists to satisfy a test.

**Three Laws of TDD:**

1. Write no production code except to pass a failing test.
1. Write only enough of a test to fail (not compiling is failing).
1. Write only enough production code to pass the failing test.

**F.I.R.S.T. Principles:** Tests should be Fast, Independent (no test depends
on another), Repeatable (deterministic), Self-validating (pass/fail, no manual
inspection), and Timely (written just before the production code).

- **One concept per test:** A test that verifies three behaviors is three tests
  waiting to be split.
- **Arrange-Act-Assert:** Group setup, execution, and assertion in clearly
  separated blocks.
- **Test naming:** Use the pattern
  `should_<expected_behavior>_when_<condition>`. This names the behavior, not
  the implementation.
- **Tests as documentation:** A new team member should be able to read the test
  file and understand what the module does and how it handles edge cases.

## Code Smells and Heuristics

Recognize these smells during code review or refactoring. Each comes with a
concrete detection guide.

| Category | Smell | Detection Guide |
| --------- | ----------------------- | ------------------------------------------------------------------- |
| Functions | Too long | More than 20 lines. Extract helpers. |
| Functions | Too many arguments | Three or more parameters. Group into an object. |
| Functions | Flag arguments | Boolean parameter that changes behavior. Split into two functions. |
| Functions | Output arguments | Parameter modified inside the function. Return a new value instead. |
| General | Duplication | Same logic in two or more places. Apply Rule of Three. |
| General | Magic numbers | Unexplained numeric literal. Extract to a named constant. |
| General | Dead code | Unreachable or never-called code. Delete it. |
| General | Commented-out code | Blocks of disabled code. Delete — git preserves history. |
| Naming | Abbreviations | Truncated words (`usr`, `msg`, `cnt`). Spell them out. |
| Naming | Disinformation | Name implies wrong behavior (`list` when it's a `set`). |
| Naming | Inconsistent vocabulary | `fetch` / `get` / `retrieve` used interchangeably. Pick one. |
| Tests | No assertions | Test that runs code but never checks output. Add assertions. |
| Tests | Slow tests | Test that takes seconds. Mock external dependencies. |
| Tests | Flaky tests | Test that sometimes passes, sometimes fails. Fix non-determinism. |
| Data | Primitive Obsession | Same primitives (`street`, `city`, `zip`) repeated across signatures. Group into a value object. |
| Naming | Inconsistent casing | `snake_case` and `camelCase` in the same file. Pick one per language, enforce with linter. |

## Common Mistakes

These mistakes appear in codebases of all sizes. Learn to spot them quickly.

| Mistake | Why It Fails | Fix |
| ------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Abbreviating names | `usrLst` forces the reader to decode. | Spell it out: `userList`. Names are read far more than written. |
| Clever one-liners | Dense, unreadable code that saves lines at the cost of clarity. | Break into named steps. Readability beats brevity. |
| Comments instead of refactoring | A comment explaining messy code is a missed opportunity. | Extract the messy block into a named function. |
| Catching generic exceptions | `catch (Exception e)` hides bugs and makes debugging painful. | Catch specific exception types. Handle or rethrow with context. |
| No tests for error paths | Happy-path tests give false confidence. | Write one test per failure mode: null input, invalid state, timeout. |
| Premature optimization | Complex code optimized for a bottleneck that doesn't exist. | Write clear code first. Profile, then optimize the hot path. |
| God classes | One class with hundreds of methods and dozens of responsibilities. | Split into focused classes, each with one reason to change. |
| Refactoring without tests | Changing code structure with no safety net risks regressions. | Write characterization tests first, then refactor under green. |
| Inconsistent conventions | Half the codebase uses `snake_case`, half uses `camelCase`. | Pick one convention per language. Enforce with a linter. |
| Overly defensive null checks | Scattering `if (x != null)` everywhere obscures the happy path. | Push null checks to the boundary. Use Optional or Null Object. |
| Flat, disconnected data | Related primitives (`street`, `city`, `zip`) passed separately everywhere, hiding their relationship. | Group into a typed object or value object. See `references/data-structures.md`. |
| Foreign casing leakage | `snake_case` from an API response appears in internal business logic. | Adapt casing at the ingress boundary only. See `references/data-structures.md`. |

## Code Applications by Language

**Python:**

| Context | Pattern | Example |
| ------------- | ------------------------------------------------------------- | ----------------------------------------------------------- |
| Type hints | Annotate all function signatures | `def greet(name: str) -> str:` |
| Guard clauses | Early return at function start | `if not user: return None` |
| Null handling | `Optional[Type]` for return types; Null Object for parameters | `def find(id: int) -> Optional[User]` |
| Testing | pytest with `should_..._when_...` naming | `def should_reject_empty_name_when_name_is_empty_string():` |

**TypeScript / JavaScript:**

| Context | Pattern | Example |
| ---------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| Semantic naming | Verb-noun functions, `is`/`has` booleans | `fetchUserById`, `isAuthenticated` |
| Type annotations | Function signatures, non-obvious variables | `function sum(items: number[]): number` |
| Guard clauses | Early return + `throw` for unrecoverable errors | `if (!user) throw new NotFoundError('User not found')` |
| Error handling | Custom error classes with context, typed catch | `catch (error) { if (error instanceof ValidationError) ... }` |

## Workflow Integration

Apply the Boy Scout Rule on every change you touch — but stay within the change
boundary. The rule: leave the codebase better than you found it, one small
improvement at a time.

**Per-change cycle:**

```
lint → format → test → implement change → improve one small thing → lint → finish
```

The "improve one small thing" step is the Boy Scout Rule in action. Pick one
small improvement within the files you are already touching:

- Extract a magic string into a named constant
- Rename a confusing variable or function
- Add a missing type annotation
- Flatten a nested conditional with a guard clause
- Delete a block of commented-out code
- Split a long function into two named helpers

Do not refactor unrelated code outside your change boundary. The goal is
incremental, localized improvement — not a rewrite of the module. Over time,
every file in the codebase becomes cleaner through thousands of small, safe
changes.

## Limitations and Language Nuance

Clean code principles are guidelines, not immutable laws. Adapt them to your
ecosystem:

- **Go and Rust** favor composition over inheritance; SOLID's OCP and LSP apply
  differently when interfaces are structural rather than nominal.
- **Functional languages** (Haskell, Elixir, Clojure) organize code around
  data transformations and pure functions; class-based principles like SRP
  translate to module-level concerns.
- **Performance-critical code** (game engines, embedded systems, HPC) may
  accept longer functions or duplicated logic when the abstraction cost
  (virtual dispatch, allocation) is prohibitive. Document the trade-off
  explicitly.
- **Framework conventions** may override naming preferences. Follow the
  framework's idiom first, then apply clean code within that structure.

When a principle conflicts with the ecosystem's established best practice, the
ecosystem wins — but document why the divergence exists.

## Implementation Checklist

Before considering a code change complete, verify:

- [ ] Each function is under 20 lines and does exactly one thing
- [ ] All names are searchable and reveal intent without a comment
- [ ] Unnecessary comments and commented-out code are removed
- [ ] Guard clauses handle failure conditions before the happy path
- [ ] Type annotations exist on all non-obvious declarations
- [ ] Linter and formatter pass with zero warnings
- [ ] Tests exist for the happy path and each error path
- [ ] Test names follow `should_<behavior>_when_<condition>`
- [ ] At least one Boy Scout improvement was made within the change boundary
- [ ] Magic numbers and strings are replaced with named constants

## Anti-Patterns

| Anti-Pattern | Why It Hurts | What to Do Instead |
| ------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Over-commenting | Creates maintenance burden and hides poor naming. | Rename and restructure until comments are unnecessary. |
| Premature abstraction | Locks in a wrong design before the pattern is clear. | Wait for the third occurrence, then abstract. |
| God functions / classes | Impossible to test, reason about, or reuse. | Split into focused units, one responsibility each. |
| Magic numbers everywhere | Readers cannot understand what values mean or why. | Extract to named constants with clear intent. |
| Ignoring the linter | Inconsistent style creates noise and review friction. | Fix every warning. If a rule doesn't fit, disable it with a comment explaining why. |
| Refactoring without tests | No safety net — regressions go undetected. | Write characterization tests before any structural change. |
| Force-returning null everywhere | Callers scatter null checks, obscuring the happy path. | Push null to the boundary. Use Optional, Null Object, or document the contract. |

<!--
  Credits and inspiration:
  - sickn33/antigravity-awesome-skills — clean-code skill (structural foundation, Law of Demeter, limitations pattern)
  - wondelai/skills — clean-code skill v1.3.0 (scoring system, Quick Diagnostic, Common Mistakes table, guard clauses, linter integration, multi-language examples)
-->
