# The Twelve-Factor App

A methodology for building software-as-a-service applications that are
portable, scalable, and resilient. Published by Heroku engineers, the twelve
factors describe practices that keep applications clean at the system level —
complementing code-level clean code principles.

## I. Codebase

**One codebase tracked in version control, many deploys.**

A single application maps to a single repository. Multiple apps sharing the
same codebase violate this factor — split them into separate repositories.

- **Clean code relevance:** A clear ownership boundary prevents code from
  bleeding across concerns. When every line of code belongs to exactly one
  application, refactoring is safer and responsibilities are unambiguous.
- **Violation:** Multiple applications in one repo, sharing utilities and
  config through relative imports.
- **Compliance:** One repo per app. Shared libraries are versioned dependencies.

## II. Dependencies

**Explicitly declare and isolate dependencies.**

Never rely on implicit system-level packages. Use a dependency manifest
(`package.json`, `requirements.txt`, `go.mod`) and a dependency isolation
tool (lock file, virtual environment, vendoring).

- **Clean code relevance:** Implicit dependencies create "works on my machine"
  bugs. Explicit declaration makes the environment reproducible and the code's
  assumptions visible.
- **Violation:** `import requests` without listing it in `requirements.txt`.
- **Compliance:** Every dependency listed in a manifest with a pinned version.

## III. Config

**Store configuration in the environment.**

Configuration that varies between deploys (database URLs, API keys, feature
flags) must not live in the codebase. Use environment variables — they are
language-agnostic, OS-agnostic, and impossible to accidentally commit.

- **Clean code relevance:** Hard-coded config couples code to a specific
  environment and creates secrets-in-code risks. Environment variables make the
  boundary between code and deployment explicit.
- **Violation:** `const DB_URL = "postgres://prod:secret@db.internal:5432/app"`
  committed to source.
- **Compliance:** `const DB_URL = process.env.DATABASE_URL` with validation at
  startup.

## IV. Backing Services

**Treat backing services as attached resources.**

Databases, message queues, caches, and third-party APIs are resources attached
to the application via configuration. Swapping a local Postgres for a managed
cloud instance should require only a config change — no code changes.

- **Clean code relevance:** Loose coupling to infrastructure makes the
  application portable and the infrastructure replaceable. Code that treats a
  database URL as just another config value is cleaner than code that hard-codes
  a specific vendor's SDK.
- **Violation:** Code imports a vendor-specific database client directly.
- **Compliance:** Code depends on a repository interface; the concrete
  implementation is wired via config.

## V. Build, Release, Run

**Strictly separate the build, release, and run stages.**

Build compiles the code and bundles assets. Release combines the build with
the deployment's config. Run executes the release in the runtime environment.
Never modify code or config at runtime — every change goes through the pipeline.

- **Clean code relevance:** Immutable releases eliminate configuration drift
  and runtime patching. What runs in production is exactly what was tested,
  making debugging deterministic.
- **Violation:** SSH-ing into a production server to edit a config file.
- **Compliance:** Every change flows through build → test → release → deploy.

## VI. Processes

**Execute the app as stateless processes.**

Application processes should be stateless and share-nothing. Any data that
must persist belongs in a stateful backing service (database, cache). Sticky
sessions and in-memory state violate this factor.

- **Clean code relevance:** Stateless processes are inherently testable — you
  can reproduce any state by feeding the same inputs. Stateful processes require
  complex setup and teardown, making tests slow and flaky.
- **Violation:** Storing user session data in a global variable or file system.
- **Compliance:** Sessions stored in Redis or a database, accessible by any
  process.

## VII. Port Binding

**Export services via port binding.**

The application is self-contained and listens on a port. It does not rely on
an external web server like Apache or IIS injected at runtime. This makes the
app fully self-describing.

- **Clean code relevance:** Self-contained apps have clear, documented
  interfaces. You can run and test the app locally without a complex
  infrastructure stack.
- **Violation:** App requires Tomcat or IIS to be pre-installed and configured.
- **Compliance:** App starts with `npm start` and listens on `$PORT`.

## VIII. Concurrency

**Scale out via the process model.**

Handle workload growth by running more processes, not by making individual
processes larger. Use the operating system's process model (or a platform's
container model) for parallelism. Never daemonize or rely on PID files.

- **Clean code relevance:** Single-responsibility processes are easier to
  understand and debug. A process that handles HTTP requests, background jobs,
  and cron tasks simultaneously is a god process — the same anti-pattern as a
  god class.
- **Violation:** One process that serves web traffic, processes queues, and
  runs scheduled jobs.
- **Compliance:** Separate processes for web workers, queue workers, and
  scheduled tasks.

## IX. Disposability

**Maximize robustness with fast startup and graceful shutdown.**

Processes should start in seconds and shut down gracefully when they receive a
`SIGTERM`. Quick startup enables rapid scaling; graceful shutdown prevents
data corruption.

- **Clean code relevance:** Fast startup means fast test execution. Graceful
  shutdown means clean-up logic is explicit and testable rather than relying on
  process termination.
- **Violation:** Process takes 60 seconds to start and ignores shutdown signals.
- **Compliance:** Startup completes in under 5 seconds. Shutdown handler drains
  in-flight requests and closes connections.

## X. Dev/Prod Parity

**Keep development, staging, and production as similar as possible.**

The gaps between environments — in time (code age), personnel (who deploys),
and tools (stack differences) — should be as small as possible. Continuous
deployment minimizes the time gap; developers who deploy minimize the personnel
gap; using the same backing services minimizes the tools gap.

- **Clean code relevance:** Environment-specific bugs are among the hardest to
  diagnose. When dev and prod use the same database engine, message queue, and
  OS, bugs reproduce reliably and fixes are validated before they ship.
- **Violation:** Development uses SQLite, production uses Postgres.
- **Compliance:** All environments use Postgres. Differences are limited to
  configuration values.

## XI. Logs

**Treat logs as event streams.**

The application writes logs to `stdout` as an unbuffered event stream. It does
not concern itself with log routing, storage, or aggregation — the execution
environment handles those concerns.

- **Clean code relevance:** Logging to `stdout` is the simplest possible
  interface. It removes logging infrastructure from application code, keeping
  the application focused on its business logic rather than log file rotation,
  archiving, or transport protocols.
- **Violation:** App writes to `/var/log/myapp.log` with custom rotation logic.
- **Compliance:** App writes structured logs to `stdout`. The platform
  (Docker, systemd, cloud provider) captures and routes them.

## XII. Admin Processes

**Run admin and maintenance tasks as one-off processes.**

Database migrations, console sessions, and one-time scripts should run in an
identical environment to the application's regular processes. They use the
same codebase, same dependencies, and same configuration.

- **Clean code relevance:** Admin tasks that depend on a different code path
  than the regular application create a second, untested execution surface.
  Running migrations through the same release ensures the schema matches the
  code.
- **Violation:** Running database migrations from a developer's laptop with a
  different version of the code.
- **Compliance:** Migrations run as a one-off process using the same release
  artifact, in the same environment.
