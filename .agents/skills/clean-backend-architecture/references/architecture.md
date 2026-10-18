# Architecture and module boundaries

Keep the architecture organized around business capabilities while preserving
clear dependency boundaries. Directory names are useful only when imports and
responsibilities follow the same model.

## Dependency rule

The domain is the most stable part of the system. Application use cases depend
on domain policy. Infrastructure implements contracts from domain and
application. Entrypoints load configuration, import concrete infrastructure and
use cases, wire them together, and start the process. Config is loaded by
entrypoints and passed explicitly; domain and application never import a global
config object.

```text
             entrypoints
            /     |      \
           /      |       \
    config  application  infrastructure
                |            |
              domain  <-------+
```

The diagram describes dependency direction, not a mandatory runtime call graph.
For example, an application service may call a repository interface while the
repository implementation lives in infrastructure.

## Layer responsibilities

Use this table to decide where a module belongs before creating a new directory.

| Layer | May depend on | Main responsibility |
| --- | --- | --- |
| Config | Language standard library, validation libraries | Parse, validate, and provide typed runtime configuration |
| Domain | Domain modules and language standard library | Business meaning and invariants |
| Application | Domain and application-owned abstractions | Use-case orchestration and application policy |
| Infrastructure | Domain or application contracts, frameworks, SDKs, drivers | Translate and execute external operations |
| Entrypoints | Config, application, infrastructure | Wire dependencies, configuration, and process lifecycle |

Config and entrypoints are support areas, not primary architectural layers.
Config must not be imported directly by domain or application modules.

Do not use a simplified arrow such as `routes -> web -> infrastructure ->
application -> domain` as the architecture. An infrastructure handler must not
depend on an arbitrary infrastructure implementation it was not given. It
receives a wired use case or application context from the entrypoint.

## Directory grammar

Prefer this hierarchy:

```text
source root -> architectural layer -> responsibility -> functional context
```

For example:

```text
src/cli/
├── config/
├── domain/
│   ├── entities/agents/
│   ├── value-objects/agents/
│   ├── repositories/agents/
│   ├── errors/agents/
│   └── helpers/validation/
├── application/
│   ├── dto/commands/agents/
│   ├── dto/queries/agents/
│   ├── dto/results/agents/
│   ├── services/agents/
│   └── helpers/formatting/
├── infrastructure/
│   ├── cli/agents/
│   ├── repositories/agents/
│   ├── mappers/agents/
│   └── helpers/filesystem/
└── entrypoints/
```

Use the functional context to make related changes discoverable. A context can
be an aggregate, bounded context, product capability, or use-case family. The
`helpers/` directories are the deliberate exception: technical helpers may be
grouped by concern when they serve multiple contexts in the same layer. Do not
create directories only to satisfy a template when a project is small.

## Ports and ownership

Place an abstraction in the innermost layer that needs it. A domain policy that
needs to load an aggregate may own a repository interface in
`domain/repositories`. An application use case that needs an email sender may
co-locate that contract with the use case under `application/services`, or
define it as a focused interface beside the use case. The important rule is
that the port does not expose a transport, database, or vendor type.

Do not create a generic `application/ports/` directory as a dumping ground for
every application-owned interface. Only extract an abstraction when a use case
genuinely needs to depend on a contract it does not own.

## Entrypoints

Instantiate concrete dependencies in one visible place under `entrypoints/` or
a process-specific bootstrap module. The entrypoint must:

- Load and validate configuration from `config/`.
- Create clients with deliberate lifetimes.
- Create repository and gateway implementations.
- Create use cases with their dependencies.
- Pass use cases to infrastructure handlers.
- Register shutdown and cleanup handlers.

Do not resolve dependencies from inside a use case. A dependency injection
container can assist at the edge, but `container.resolve()` inside application
or domain code hides the contract and acts as a service locator.

## Imports and package exports

Use direct imports between leaf modules. Use an `index` or package module only
to define a deliberate public boundary. Do not create a barrel at every folder
level or chain barrels across the entire dependency graph.

One public production concept belongs in one leaf module. A package index may
reexport several concepts because its purpose is explicitly to assemble a
package API. Keep the leaf rule and package rule distinct, and apply the rule
across all production layers unless an explicit adapter, registry,
configuration, function-package, or package-index exception applies.
