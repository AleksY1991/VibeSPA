# VibeSPA

**Good vibes. Clear boundaries.**

VibeSPA is a micro-modular SPA framework extracted from Haku's architecture.
Its unit of composition is a small module: a policy, command owner, read model,
storage adapter, interaction surface, or view. A product feature is one possible
composition of those units.

Inspectable applications compose typed `FeatureModule<X>` declarations, where
`X` is a member of the finite `FeatureType` enum: policy, store, feature,
service, or view. The module kind selects its inspector presentation. Small
modules remain useful on their own through `defineModule` and `startModule`.

The core is plain TypeScript. Solid, RxDB, Supabase, settings persistence, and
browser input are optional adapters with explicit entry points. None of them
is required to use the core module, source, registry, or lifetime primitives.

## Start

Use Node 22.12 or newer and PNPM. The Solid adapter deliberately matches Haku's
Solid 2.0.0-rc.14 APIs; it is an optional prerelease renderer dependency.

```sh
pnpm install
pnpm dev
```

The example app runs at `http://127.0.0.1:8081`. It saves intentions in IndexedDB
and supports add, toggle, remove, complete all, undo, and redo without a server.
Its always-visible System inspector link opens live module contracts,
dependencies, lifecycle states, errors, and recorded command activity. The
inspector mounts before application startup and stays available after failure.

```sh
pnpm check          # architecture lint, strict TypeScript, behavioral tests
pnpm build          # checks, library JS/types, example build, embedded CLI template
pnpm preview        # serve the built example on port 8081
```

In the framework checkout, create an independent application or a small module:

```sh
pnpm create:app ../my-app --name my-app
pnpm create:module reminders --cwd apps/playground
```

The application generator copies the framework packages and build configuration
into a standalone PNPM workspace. It keeps no path dependency on this checkout.
The module generator creates a contract, inert definition, and private runtime;
the application composition explicitly decides when to start it.

`create-vibespa` can also be packed locally after building. Nothing is published
by these commands.

## Core values

| Value | Practical win |
| --- | --- |
| Small, coherent modules | A change needs less surrounding context. |
| Explicit contracts | Reads and commands show what each consumer can do. |
| Private implementations | Callers cannot depend on another module's internals. |
| Composition at every scale | Policies, services, features, and applications use the same building blocks. |
| One owner per responsibility | Durable data, transient state, rendering, and input have clear authorities. |
| Narrow reactive reads | Consumers observe the values they need instead of mirroring a global state tree. |
| Owned resource lifetimes | Cancellation and cleanup travel with the module that acquired the resource. |
| Local durability | Commands finish after local persistence; optional replication handles the network. |
| Semantic gestures | Multi-row actions retain one identity through history and replay. |
| Executable boundaries | Lint and behavioral tests protect the architecture as code changes. |

## Packages

| Package | Responsibility |
| --- | --- |
| `@vibespa/contracts` | `Readable<T>`, equality, cleanup, scope, enumerable feature kinds, and neutral diagnostic contracts; no runtime dependencies. |
| `@vibespa/core` | Privately writable sources, narrow derivations, scopes, typed lazy features, inspectable systems, registries, session replacement. |
| `@vibespa/solid` | Consume neutral reads, own scopes, and configure native RxDB/Solid bindings through optional subpaths. |
| `@vibespa/local-first` | RxDB/Dexie persistence, account-session ownership, one explicit batch write gate, journal, guarded undo and redo. |
| `@vibespa/supabase` | Stock Supabase replication under an authenticated account lifetime. |
| `@vibespa/settings` | Typed settings with injected persistence, validated loading, serialized saves and flush. |
| `@vibespa/interaction` | Live surface arbitration and default-deny action dispatch. Browser input is a separate subpath. |
| `@vibespa/eslint-plugin` | Configurable privacy, UI/domain, and inert-definition rules. |
| `create-vibespa` | Independent application and module scaffolding. |

Core primitives also have small subpath exports such as `@vibespa/core/scope`,
`@vibespa/core/module`, `@vibespa/core/readable`, and `@vibespa/core/session`.
Imports in workspace development resolve source. Ordinary package consumers
resolve compiled ESM and declarations in `dist`.

## Module shape

```text
apps/playground/src/
  contracts/                    neutral presentation capabilities
  modules/
    title-policy/
      contract.ts               inputs and exported behavior
      definition.ts             inert identity and lazy factory
      internal/runtime.ts       private implementation
    focus/
      contract.ts
      definition.ts
      internal/runtime.ts
  composition/                  explicit dependency and lifetime wiring
  ui/                           rendering, CSS, browser elements
```

There is no ambient container or global service locator. Factories receive
ordinary typed inputs. A registry collects inert contributions without starting
their runtime. The consumer chooses which declarations to load and instantiate.

```ts
import { defineModule } from '@vibespa/core/module';
import type { TitlePolicyInputs, TitlePolicy } from './contract.js';

export const titlePolicy = defineModule<TitlePolicyInputs, TitlePolicy>({
  id: 'title-policy',
  load: () => import('./internal/runtime.js').then(module => module.createTitlePolicy),
});
```

A composition root starts instances and owns their lifetime:

```ts
import { createScope, startModule } from '@vibespa/core';
import { titlePolicy } from './modules/title-policy/definition.js';

const application = createScope();
const titles = await startModule(titlePolicy, { maximumLength: 140 }, application);
// Supply titles explicitly to the next module's factory.
await application.dispose();
```

`startModule` gives each instance a child scope, rolls back failed construction,
and refuses exports that finish after cancellation. Register cleanup when a
resource is acquired, including resources acquired after an await.

## Feature contracts and the system constructor

`defineFeatureModule` adds an enumerable kind and documented public boundary to
the same inert module primitive. Every input and export key, including optional
keys, requires a description checked against the factory's types. Metadata is
copied and frozen; constructing a declaration does not invoke its loader.

```ts
import { FeatureType } from '@vibespa/contracts';
import { createSystem, defineFeatureModule } from '@vibespa/core';
import type { TitlePolicyInputs, TitlePolicy } from './contract.js';

const titlesModule = defineFeatureModule<FeatureType.Policy, TitlePolicyInputs, TitlePolicy>({
  id: 'title-policy',
  kind: FeatureType.Policy,
  title: 'Title policy',
  description: 'Normalizes and validates intention titles.',
  contract: {
    inputs: { maximumLength: 'The maximum normalized title length.' },
    exports: { validate: 'Validate a title without changing storage.' },
  },
  load: () => import('./internal/runtime.js').then(module => module.createTitlePolicy),
});

const system = createSystem({ id: 'application', eventLimit: 200 });
const titles = await system.start(titlesModule, { maximumLength: 140 });
// Supply titles.exports as a typed input to another module, and declare
// { dependencies: [titles] } alongside that wiring in system.start's third argument.
console.log(system.snapshot.read());
await system.dispose();
```

The system owns its modules' lifetimes and returns handles with `id` and typed
`exports`. An instance ID defaults to the definition ID; pass `{ id }` when
starting the same declaration more than once. IDs cannot be reused within one
system. Dependencies must be ready handles from that same system. This ensures
declared edges point to previously started instances, and reverse startup
teardown releases dependents before dependencies. There is no ambient lookup.

`system.snapshot` is an immutable `Readable<SystemSnapshot>`. It includes module
identities, kinds, contract descriptions, declared edges, lifecycle states, and
a bounded ordered event journal. Loading, construction, cancellation, rollback,
disposal, and failures remain visible. Inspector subscriber exceptions cannot
fail application construction or cleanup. `clearEvents()` clears only history;
sequence numbers continue increasing. `droppedEvents` counts evicted events
since the last clear.

At composition boundaries, `system.trace(handle, 'commandName', operation)`
records the start, completion, or rejection of an explicitly selected operation
and preserves its result or rejection. Completion means the call resolved;
domain validation may still return a negative result. Input values, returned
values, and private state are never traversed or recorded. Error messages are
recorded. The system does not intercept untraced commands or readable changes.

Renderers consume the neutral diagnostic contract from `@vibespa/contracts`.
An exhaustive `Record<FeatureType, Presentation>` makes adding an enum member
require updating the inspector mapping. JSX, CSS and browser behavior remain
in the UI adapter; feature definitions contain no rendering implementation.

Isolation consists of private imports enforced by lint, typed capabilities,
and owned cancellation/cleanup. Declared dependency metadata describes the
wiring supplied by composition; it cannot discover hidden dependencies inside
closures. These boundaries are not a JavaScript sandbox, do not prevent global
access, and do not automatically revoke references to exported capabilities.
The trace boundary refuses new operations after system disposal begins.

## Read and write ownership

`Readable<T>` has only `read()` and `subscribe(listener)`. Read returns the
current value; subscribe reports subsequent changes and returns a release.
Subscriptions do not emit an initial value by contract.

```ts
import { createSource, mapReadable } from '@vibespa/core/readable';

const owner = createSource(0);
const isPositive = mapReadable(owner.source, value => value > 0);
// Export owner.source or isPositive. Keep owner.set/update private.
owner.update(value => value + 1);
```

Use these sources for transient state and small derived values. RxDB owns
durable domain rows; do not copy whole collections into application-owned cells.
The Solid adapter's `consumeReadable` owns one exact source subscription under
the current rendering owner. Solid updates settle in a microtask.

For applications that expose native RxDB query/document capabilities, the optional
`@vibespa/solid/rxdb` module supplies `SolidRxReactivityFactory`,
`createSolidRxReactivityFactory({ name, equals })`, and `bindRxValue`,
`bindRxDocument`, and `bindRxField`. Pass the factory as `reactivity` when opening
an RxDB database; its `SolidRxReactivityLambda` types native `$$` getters as Solid
accessors. Bind inside the consuming Solid owner: subscriptions end with that
owner, and emitted document references are retained without conversion. The
default factory publishes every emission (`equals: false`); equality and signal
names are configuration supplied by the application's composition.

```ts
import { createRxDatabase } from 'rxdb';
import { createSolidRxReactivityFactory } from '@vibespa/solid/rxdb';

const database = await createRxDatabase({
  name: accountDatabaseName,
  storage,
  reactivity: createSolidRxReactivityFactory({ name: 'application.rxdb' }),
});
```

Commands persist through the application's write gate; local writes and incoming
replication publish through these same bindings. For compound commands,
`beginRxBatch(database)` from `@vibespa/solid/rxdb-batch` holds the latest emission
per binding until its returned release runs in `finally`. Nested batches share
the database's publication lifetime; `waitForRxBatches(database)` observes that
lifetime. This coordinates UI publication; persistence still requires explicit
collection batches. Both the factory and command gate must use the shared batch
module, whose state is keyed by database identity. Haku and CSM consume these
same subpaths through re-export facades; application schemas, command policy,
account lifetimes, and replication configuration stay in their compositions.

Build package declarations with `pnpm build:packages` after changing a public API.
`pnpm export:adapters` produces content-addressed package archives in
`artifacts/adapters`, including their neutral workspace contracts. Haku and CSM
install these archives from their own `vendor` directory; production installs
need no sibling framework checkout. Refresh both consumers from the same export
after a shared change. Consumers must deduplicate Solid to the application's
runtime, including when testing installed packages.

The example's command flow is:

```text
View -> named command -> policy + domain logic -> one batch -> RxDB
View <- narrow read capability <- native query result
RxDB <-> optional automatic replication <-> authoritative server
```

## Lifetimes

`createScope(parentSignal?)` supplies `signal`, `defer(cleanup)`, and awaited
`dispose()`. Disposal aborts first, drains cleanup in reverse registration order,
and reports failures after attempting every cleanup. Repeated disposal shares
the same promise. Calling a defer release unregisters that cleanup; it does not
run it.

A parent signal cancels work. Explicit scope disposal owns resource release.
`startModule` wires both cancellation and child disposal so dependents release
before their dependencies. A factory that ignores cancellation can delay awaited
disposal until its startup settles.

`createSessionHost` observes a nullable identity, cancels stale opens, closes the
outgoing scope before opening the next, and refuses replacement after a failed
close. Workspace/view filters should be ordinary module inputs; they do not
change an account identity or restart account replication.

Existing RxDB applications can use `createRxDbSyncController` from
`@vibespa/local-first/session`. This shared controller accepts a neutral
`scopeSource` and an application-supplied `openSession`, serializes account
replacement, cancels stale opens, and exposes lifecycle snapshots. Session
identity is the account and optional authentication generation; workspace filters
do not restart it. An optional `mapScope` adapts normalized scope metadata for
legacy consumers. Haku uses it for its account-as-workspace compatibility field;
CSM uses the default. Both import the same controller implementation and supply
their own schema, migration, replication and session-opening configuration.

## Local persistence and replication

`createLocalStore` accepts an application-owned collection schema map and scope.
It defaults to validated durable IndexedDB storage and accepts an injected RxDB
storage engine for other hosts. Database names must include account identity in
an account-based application.

`store.query` and `store.document` return neutral capabilities backed by native
RxDB queries. An optional third scope argument lets a view own a shorter query
lifetime. Only infrastructure imports `@vibespa/local-first/adapter`; that seam
exists for replication, not business mutations.

Prepare a complete write set, then call `store.batch` once with a gesture ID.
The gate coalesces repeated changes to a row and makes an explicit bulk write
per collection. A resolved command has refreshed its active native queries.
Successful writes publish immutable before/after journal entries.

History is bounded and session-local. Undo/redo preserve gesture identity and
refuse to overwrite a value that changed after the recorded action. A batch
across collections is not one atomic transaction; `BatchWriteError.applied`
describes successful rows when a storage failure follows partial application.
No automatic schema migration, destructive reset, or server setup is performed.

`await syncSupabase({ store, scope, accountId, client, tables })` binds optional
automatic live replication. Supply a standard authenticated Supabase client
whose session user matches `accountId`; signout or replacement cancels sync.
Register the store before replication in the same account scope so replication
cancels before the database closes. Keep workspace selection out of that scope.

Remote tables need matching columns, primary keys, `_deleted` soft deletion,
an `_modified` timestamp (or configured `modifiedField`), appropriate timestamp
maintenance, Realtime configuration and row-level security. Configure the server
using RxDB's stock Supabase replication requirements. The adapter creates no
tables, credentials, policies, or application-specific SQL.

An optional per-table `encodeRequest` adapts cloned outgoing HTTP/CAS rows,
including assumed server values. Local arrays and conflict inputs retain their
native types. Every local edit still enters through the local write gate.
Conflicts use server state mechanically; synchronization never waits for a
person. `awaitInitialSync()` can stay pending while offline and rejects when
canceled. The adapter is tested with controlled stock-replication bindings;
a live Supabase project is not part of the local test suite.

## Settings and interaction

`createSettings` keeps its owner private and exposes `values: Readable<T>`.
It returns defaults immediately, validates saved data with the supplied parser,
preserves edits made during loading, serializes saves, and flushes during owned
disposal. Inject storage; the package does not select a browser or server store.

`createInteraction(scope)` mounts ordered surfaces. Use each surface's same
`active: Readable<boolean>` to decide visibility. An active opaque surface stops
unmatched actions; resolved commands recheck the live stack before invocation.
`attachKeyboard` from `@vibespa/interaction/browser` attaches one owned dispatcher
per event target and respects editable controls and composition by default.

## Contributor rules

- Keep modules small around responsibilities, not arbitrary line counts.
- Add only the capabilities a consumer actually needs to a public contract.
- Business code imports public contracts, never another module's `internal` files.
- Keep JSX, CSS, DOM types and browser elements in presentation/adapters.
- Definitions describe modules; importing a definition must not start work.
- Register resource cleanup at acquisition. Use `scope.signal` across awaits.
- Use explicit collection batches; a gesture ID alone does not batch writes.
- Do not commit or publish automatically. Preserve existing user work.
- Keep architecture prose here; enforce boundaries in lint messages and tests.
- Run focused tests while implementing, then `pnpm check` and `pnpm build` for integration.

The ESLint plugin is deliberately configurable. Its rules cover private imports,
UI/domain separation, and inert definitions. It does not claim to prove every
behavioral property, such as local transaction semantics or async cancellation;
those are covered by the corresponding behavioral tests.
