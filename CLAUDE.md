# VibeSPA

**Good vibes. Clear boundaries.**

VibeSPA is a micro-modular SPA framework extracted from Haku's architecture.
Its unit of composition is a small module: a policy, command owner, read model,
storage adapter, interaction surface, or view. A product feature is one possible
composition of those units.

Inspectable applications compose typed `FeatureModule<X>` declarations, where
`X` is a member of the finite `FeatureType` enum: policy, data, store, feature,
service, or view. The module kind selects its inspector presentation.
Applications start modules with `system.start`. The lower-level `defineModule`
and `startModule` primitives remain for standalone modules and unit tests that
need an owned lifetime without a system.

The core is plain TypeScript. Solid, RxDB, Supabase, settings persistence, and
browser input are optional adapters with explicit entry points. None of them
is required to use the core module, source, registry, or lifetime primitives.
The sample composes its modules with `createSolidSystem`, giving each instance
a private Solid owner alongside its awaited resource scope. Its application
modules expose reactive reads to other modules and views as tracked Solid
accessors; the neutral `Readable` contract remains the core and adapter boundary.

## Mandatory UI rule: Haku design system

All VibeSPA UI MUST use components from the Haku design-system repository,
[`AleksY1991/design_system`](https://github.com/AleksY1991/design_system), through
its public `@ui-kit/core` exports. This requirement applies to every UI surface,
including the playground, debug tooling, the System inspector, scaffolding,
generated applications and any future VibeSPA UI. It is mandatory for all
contributors and agents.

Use the shared controls, keyed `List`, Lucide icons, theme, typography and surface
contracts. Do not copy implementations, create local replacement controls, use
another component library directly, or override shared control internals. If a
required component or variant is missing, add it to the Haku design-system repo
and consume its public export here; do not implement a VibeSPA-only substitute.
Application code may compose semantic content and own page placement and
diagnostic graph geometry; text uses shared role tokens.

The playground and generated applications MUST consume the same SHA-256-pinned
`@ui-kit/core` archive in `vendor/`. `vendor/design-system.json` records its source
snapshot. Preserve the shared-component lint rules and include this mandatory
rule in generated applications' `CLAUDE.md` so generation cannot bypass it.

## Start

Use Node 22.12 or newer and PNPM. The Solid adapter deliberately matches Haku's
Solid 2.0.0-rc.14 APIs; it is an optional prerelease renderer dependency.

```sh
pnpm install
pnpm dev
```

The example app runs at `http://127.0.0.1:8081`. The same Focus API and UI run
with IndexedDB by default, no persistence at `?backend=memory`, or a controlled
fake REST server at `?backend=rest`. IndexedDB uses `vibespa-focus-solid`; the
previous `vibespa-focus` database is left untouched. `?backend=supabase` signs
in with an email magic link and syncs the same intentions with a Supabase
project through a native RxDB collection (see "Solid over a replicated native
collection" below). It needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
in `apps/playground/.env.local` and the table, row-level security and auth
settings in `apps/playground/src/modules/supabase-storage/SUPABASE_SETUP.md`,
which you apply to your own project; nothing here executes that SQL. Add, toggle, remove,
complete all, undo, and redo apply to private Solid state before backend
acknowledgement. Its always-visible System inspector link opens live module contracts,
dependencies, lifecycle states, errors, and recorded command activity. The
inspector mounts before application startup and stays available after failure.
Its Features view lists registered definitions, including ones not yet started,
and links them to runtime instances. Data graph shows provider → contract →
consumer edges, capabilities and explicit contract relations. Surfaces shows
live interaction priority, activity, transparency and opaque blockers. Activity
retains the bounded operation and lifecycle journal.

```sh
pnpm check          # architecture lint, strict TypeScript, behavioral tests
pnpm build          # checks, library JS/types, example build, CLI template, generated-app checks
pnpm preview        # serve the built example on port 8081
```

In the framework checkout, after `pnpm build`, create an independent application
or a small module:

```sh
pnpm create:app ../my-app --name my-app
pnpm create:module reminders --cwd apps/playground
```

The module generator creates a contract, inert definition, and private runtime
that exports a tracked accessor; the application composition explicitly decides
when to start it. Generated runtimes receive `ModuleContext` for owned tasks,
commands, acquisitions, and cleanup.

## Generated applications

A generated application is one package: the playground's application code,
its configuration (`package.json`, `pnpm-workspace.yaml`, lockfile, TypeScript,
Vite, Vitest and ESLint), the Solid diagnostics test setup, `CLAUDE.md`, and one
pinned archive per framework package in `vendor/`. It contains no editable
framework sources, framework tests or framework build scripts, and needs neither
a registry publication nor a sibling checkout.

- `pnpm build` composes the template (`scripts/prepare-template.mjs`) from
  `apps/playground`, the configuration sources in `packages/create-vibespa/app`,
  and archives made by `exportApplicationPackages` in
  `scripts/export-adapters.mjs`. `create-vibespa` always generates from that
  embedded template, from the checkout or packed.
- Application archives (`@vibespa/contracts`, `core`, `solid`, `local-first`,
  `supabase`, `interaction`, `eslint-plugin`) are not bundled: workspace dependencies become exact
  versions, and `pnpm-workspace.yaml` overrides every `@vibespa` package to its
  archive, so the installed graph has one instance of each and one Solid. Their
  manifests drop the workspace-only `development` condition and ship only the
  files their exports resolve to: `dist` for TypeScript packages, `src` for the
  JavaScript ESLint plugin.
- The application's `eslint.config.js` imports `createArchitectureConfig` and
  `createApplicationModulePolicy` from `@vibespa/eslint-plugin`; this checkout
  uses the same policy factory.
- `packages/create-vibespa/checks/generated-apps.mjs` (last step of `pnpm build`)
  generates with the checkout CLI and with a packed CLI outside the checkout,
  installs from the vendor archives, runs lint, typecheck, tests and a
  production build, and checks a generated module, the lint policy, the active
  diagnostics setup, single package instances and destination protection.
  Installing needs the package registry or a warm pnpm store.

The template also includes the pinned `@ui-kit/core` archive from this checkout's
`vendor/`, verified against the SHA-256 in its filename. Generated apps need no
sibling design-system checkout. UI lint rejects native replacement controls,
private control styling and copied icons. `prepareApplicationUi` prepares the
shared implementation before the owned renderer roots mount; the host supplies
surface authority while the controls own their keyboard and form behavior.

Pinned archives never update on their own. To update an application, run
`pnpm build:packages` and
`node scripts/export-adapters.mjs --application-packages --destination <dir>`
here, replace the application's `@vibespa` archives in `vendor/` while retaining
the `@ui-kit/core` archive, update the
`file:./vendor/...` entries in its `package.json` and the `@vibespa` overrides
in its `pnpm-workspace.yaml`, align `solid-js`, `@solidjs/web`, `rxdb`, `rxjs`
and `@supabase/supabase-js`, then run `pnpm install`, `pnpm check` and `pnpm build` there. The
generated application's `CLAUDE.md` repeats these steps.

`create-vibespa` can also be packed locally after building. Nothing is published
by these commands.

## Core values

| Value | Practical win |
| --- | --- |
| Small, coherent modules | A change needs less surrounding context. |
| Explicit contracts | Reads and commands show what each consumer can do. |
| Private implementations | Callers cannot depend on another module's internals. |
| Composition at every scale | Policies, services, features, and applications use the same building blocks. |
| One owner per responsibility | Solid owns client domain records; the feature API alone admits mutations, including incoming adapter changes. |
| Narrow reactive reads | Consumers observe the values they need instead of mirroring a global state tree. |
| Owned resource lifetimes | Cancellation and cleanup travel with the module that acquired the resource. |
| Explicit delivery guarantees | Local application is immediate; persistence and remote acknowledgement have separate observable status. |
| Semantic gestures | Multi-row actions retain gesture identity through history and replay. |
| Executable boundaries | Lint and behavioral tests protect the architecture as code changes. |

## Packages

| Package | Responsibility |
| --- | --- |
| `@vibespa/contracts` | `Readable<T>`, equality, cleanup, scope, enumerable feature kinds, and neutral diagnostic contracts; no runtime dependencies. |
| `@vibespa/core` | Sources, scopes, typed modules and contribution registries, Settings and AI consumers, inspectable systems and session replacement. |
| `@vibespa/solid` | Owned module runtimes, private Solid domain owners and readonly reactive views, optional REST transport, neutral read bindings, and legacy native RxDB read bindings through explicit subpaths. |
| `@vibespa/local-first` | Optional RxDB persistence adapters for Solid domain owners (a private envelope database, or an application-owned native collection that replication can sync); legacy RxDB-owned store, durable batch gate, journal, history, and session controller. |
| `@vibespa/supabase` | Stock Supabase replication under an authenticated account lifetime, for native collections or the legacy store. |
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

Outside a system, for example in a module unit test, `startModule` starts an
instance under a scope you own:

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
import { createSystem, defineFeatureModule, external } from '@vibespa/core';
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
const titles = await system.start(titlesModule, { maximumLength: external(140) });
// Supply this handle to consumers with from(titles).
console.log(system.snapshot.read());
await system.dispose();
```

The system owns its modules' lifetimes and returns handles with `id` and typed
`exports`. An instance ID defaults to the definition ID; pass `{ id }` when
starting the same declaration more than once. IDs cannot be reused within one
system. Dependencies must be authentic ready handles from that same system.
Reverse startup teardown releases dependents before dependencies. There is no
ambient lookup or automatic provider activation.

`system.start` is the only way to start a module in a system. Every input is a
binding: `from(handle, key)` or `from(handle)` for a capability provided by
another module, and `external(value)` for configuration and other values that no
module provides. A raw value is a type error and is rejected at runtime. The
playground's Focus composition supplies each input and its dependency edge from
the same authenticated binding:

```ts
import { external, from } from '@vibespa/core';

// storage and titles are ready handles started by this system.
const intentions = await system.start(intentionsDataModule, {
  adapter: from(storage, 'adapter'),
  generation: external(crypto.randomUUID()),
  titles: from(titles),
});
const focus = await system.start(focusModule, {
  data: from(intentions, 'data'),
  titles: from(titles),
  createId: external(() => `${Date.now()}-${crypto.randomUUID()}`),
});
```

`from(handle, key)` selects a public export; `from(handle)` supplies the whole
exports object. The factory still receives ordinary typed inputs. Bindings are
privately authenticated and immutable, and the caller's map is snapshotted at
admission. Repeated bindings to one instance produce one dependency edge.
Dependency edges come from `from()` and typed contribution `system.collect()`
bindings: `start` rejects a separate
`dependencies` option at compile time, including in a non-literal options object,
and again at runtime.

`start` validates providers before loading and immediately before original
factory entry, after runtime entry and `starting` observers. It resolves
each binding's selected reference once at entry, then rechecks all providers,
system admission and consumer cancellation. This closes disposal during lazy
startup; it does not promise atomic or continuing stability of exports.

Bindings preserve exact native objects, documents, accessors and functions. They
do not invoke functions, clone or proxy values, subscribe, auto-bind methods, or
own borrowed resources. Whole-object method calls retain their receiver;
extracting a method keeps ordinary JavaScript extraction semantics.
`external(value)` is explicitly unchecked, even for an old repository.

`system.snapshot` is an immutable `Readable<SystemSnapshot>`. Its `registrations`
list includes selected inert definitions before startup and definitions admitted
by `start`, with public contract metadata and runtime `instanceIds`. Registration
does not load a module. It also includes module
identities, kinds, contract descriptions, dependency edges, lifecycle states, and
a bounded ordered event journal. Loading, construction, cancellation, rollback,
disposal, and failures remain visible. Inspector subscriber exceptions cannot
fail application construction or cleanup. `clearEvents()` clears only history;
sequence numbers continue increasing. `droppedEvents` counts evicted events
since the last clear.

### Typed contributions and consumers

Contribution channels describe what a module offers to a host. They are
independent of the module's `FeatureType` responsibility: one Feature module can
provide Settings, AI tools, and an application-specific contribution through
separate named public exports. A Service module can consume any of those channels.
There is no Settings or AI responsibility kind and no ambient service locator.

Publish one canonical `defineContributionContract<Value>({ id, version })` reference
from a public contract file. A contract can additionally supply a synchronous
`validate(value: unknown): boolean` admission check. Providers and consumers import
the same reference; independently recreating the same ID, including a different
version, is rejected. The value parameter is invariant, so an unrelated payload
cannot satisfy a typed port.

Declare providers on named exports and consumers on registry-valued inputs:

```ts
import { contributionPort } from '@vibespa/core/contributions';
import { settingsContributionContract } from '@vibespa/core/settings';
import { aiContributionContract } from '@vibespa/core/ai';

// A feature's exports have types SettingsSection and AiContribution respectively.
contributions: { provides: {
  settings: contributionPort(settingsContributionContract, { order: 10 }),
  tool: contributionPort(aiContributionContract),
} },

// A host's ordinary input has type ContributionRegistry<SettingsSection>.
contributions: { requires: {
  settings: contributionPort(settingsContributionContract),
} },
```

Select declarations in `createSystem({ modules })`. Unlike Data contracts,
contribution contracts admit many providers. `system.contributions(contract)`
returns a readonly typed registry with two neutral readables: `definitions` lists
inert provider declarations before startup, and `items` lists exact public values
from ready provider instances. Each item identifies its definition, instance,
export and order. Registry order is deterministic by declared order and identity;
discovery never calls a loader. Cancellation removes runtime values while inert
definitions remain discoverable. Registry observation cannot fail provider startup
or cancellation.

Use `system.collect(contract)` to bind a consuming module's declared registry
input. Start all selected providers before the consumer:

```ts
const account = await system.start(accountSettingsModule, { session: from(session) });
const localization = await system.start(localizationModule, { storage: external(storage) });
const settings = await system.start(settingsHostModule, {
  registry: system.collect(settingsContributionContract),
});
```

The authenticated collection binding records a dependency on every contributing
provider, preserves reverse dependency teardown, and refuses `external(registry)`,
a registry from another system, or a different canonical contract. Its provider
plan seals while a consumer is active: adding another matching provider would
change its dependencies, so compose the complete provider set before consuming.
Collecting and publishing contributions create no additional runtime or lifetime;
module commands, cancellation and cleanup retain their ordinary ownership rules.

The built-in Settings channel is exported from `@vibespa/core/settings`.
`SettingsSection` contains a reactive title and optional description, stable ID,
optional order, and entries discriminated as `action`, `select`, or `value`.
Labels, disabled state, options and values use neutral `Readable` contracts.
`createSettingsConsumer(moduleScope, registry)` exposes reactive `sections` and
`error`, plus owned `activate(sectionId, entryId)` and
`select(sectionId, entryId, value)` commands. It validates current availability,
disabled state and choices before dispatching to the provider. Invalid or
ambiguous contributions are withheld and reported through `error`. Rendering
adapters choose controls by entry kind; they do not import individual features.
The existing `@vibespa/settings` package remains an injected persistence primitive.
Language catalogs, locale detection, language persistence and translated product
copy belong to an application's Localization feature, which contributes a select
entry through this same Settings contract.

The built-in AI channel is exported from `@vibespa/core/ai` and represents callable
tools rather than a chosen model provider. `defineAiTool<Input, Output>` accepts
metadata, an input schema, `parseInput`, `parseOutput`, and `execute`. Both the typed
local `run(input, signal)` call and its unknown-input `invoke` boundary validate
inputs and outputs and check cancellation. For example:

```ts
const tool = defineAiTool({
  id: 'text-length', title: 'Text length', description: 'Count characters in text.',
  inputSchema: { type: 'string' },
  parseInput(value: unknown): string {
    if (typeof value !== 'string') throw new Error('Expected text.');
    return value;
  },
  parseOutput(value: unknown): number {
    if (typeof value !== 'number') throw new Error('Expected a count.');
    return value;
  },
  execute: commands.countCharacters, // A provider-owned registered command.
});
```

`createAiConsumer(moduleScope, registry)` exposes public tool metadata through
`tools`, catalog failures through `error`, and an owned `invoke(toolId, input)`
command. It resolves the currently ready tool for each invocation and forwards
the consumer's cancellation signal. Model adapters can use the metadata and
invocation capability without receiving arbitrary module internals. The framework
selects no model, sends no request and supplies no credential or authorization
policy. Those remain explicit application choices.

### Data contracts and graph validation

`FeatureModule<FeatureType.Data>` owns a private data implementation and declares
its named public ports with `data.provides`. Consumers use `data.requires` on
their ordinary typed inputs. Publish one canonical `defineDataContract<API>`
reference from the provider's public `contract.ts`; consumers import that same
reference rather than recreating a definition with the same ID.

```ts
// Public contract: a typed capability, independent of its storage adapter.
import { defineDataContract } from '@vibespa/core/data';
export const intentionsData = defineDataContract<IntentionsData>({
  id: 'intentions', version: 0,
});

// Data definition: provides a port whose value implements IntentionsData.
data: { provides: {
  data: dataPort(intentionsData, ['read', 'write', 'live', 'local-apply']),
} },

// Focus definition: its ordinary data input consumes that canonical port.
data: { requires: {
  data: dataPort(intentionsData, ['read', 'write', 'live', 'local-apply']),
} },
```

Select definitions in `createSolidSystem({ id, modules: applicationModules })`.
Construction validates the complete static Data plan before invoking loaders or
opening resources. It throws for conflicting same-ID contracts (including
different versions or independently recreated references), ambiguous providers,
missing providers or relation targets, and insufficient advertised capabilities.
Optional JSON schema metadata is copied and deeply frozen; it does not generate
storage schemas or migrations. Relations are explicit canonical contract
references, not a query language.

Startup still uses `system.start` and existing owned lifetimes. Declared Data
inputs must use `from(provider, 'export')`; `external(...)`, whole-export bindings,
and a structurally identical value from another contract are refused. Each
selected Data definition has at most one runtime instance per system. A static
plan does not activate modules automatically; start providers before consumers.
The inspector's Data graph describes selected **definition IDs** and declared
capabilities. Module dependency edges describe the actual runtime instance IDs.
Neither includes application record values.

The contract's value type checks the API shape. Capability names describe
behavioral promises; they neither remove methods nor prove implementation or
backend authorization. Expose separate named contracts when a consumer needs a
narrower API, and validate incoming payloads inside the provider. RxDB and REST
can implement one API only when they meet the same advertised delivery promises.
If both are needed, compose their responsibilities into one provider explicitly.

The playground's `intentions-data` module owns `createSolidDomain`, readonly
views, history and delivery commands. Focus consumes its Data port and applies
feature policy. Its `local-apply` capability promises immediate memory changes;
backend acknowledgement remains separately observable through delivery status.
Backend selection does not change the Data contract. No new registry, reactive
engine, query DSL or lifecycle mechanism is involved.

Modules declare public commands once with `scope.commands({ ... })` in their
factory and export the returned group. The Data provider keeps its mutable
domain owner private:

```ts
import { createSolidDomain } from '@vibespa/solid/domain';
import type { IntentionsDataCommands } from './contract';

const owner = createSolidDomain<Intention>(scope, {
  generation: inputs.generation,
  adapter: inputs.adapter,
  validate: validateIntention, // The provider's private row validator.
});
const commands = scope.commands({
  async commit(gesture: Parameters<IntentionsDataCommands['commit']>[0]) { return owner.commit(gesture); },
  async undo() { return owner.undo(); },
});
// Export commands and readonly view reads; keep owner private.
```

Registration is explicit; the system never scans exports for functions. Each
registered call enters the module's runtime for its synchronous part, is joined
by shutdown until it settles (including calls still queued inside the module),
and is refused with a rejection, before the implementation runs, once the
owning system begins shutdown or the module is cancelling or disposed.
Arguments, rejection reasons and the call's receiver pass through unchanged, and
argument types stay inferred. Commands must return a promise; the registered
command returns a native `Promise` of the awaited result, so extra members of a
custom thenable are not kept. Register a plain object literal: class instances
and objects with inherited methods are refused, because only own methods are
registered. Registered command types are derived per member from its parameters and
result, so an overloaded command keeps only its last overload and a generic
command loses its type parameters (its result becomes `Promise<unknown>`);
declare concrete, non-overloaded signatures for public commands. In a system, each call records one `operation-started` event and one
`operation-completed` or `operation-failed` event named by its key; a resolved
negative domain result is a completed call. Domain code does not use inspector
APIs, and adding a command needs no second name list or composition wrapper.

For an operation that is not a registered command, `system.trace(handle,
'commandName', operation)` at a composition boundary records the start,
completion, or rejection of that explicitly selected operation and preserves its
result or rejection. Completion means the call resolved;
domain validation may still return a negative result. Input values, returned
values, and private state are never traversed or recorded. Error messages are
recorded. The system does not intercept unregistered functions or readable changes.
Shutdown refuses new traces and joins accepted operations before releasing
their module's resources. With a module runtime, each trace enters that module's
owner for its synchronous call.

Renderers consume the neutral diagnostic contract from `@vibespa/contracts`.
An exhaustive `Record<FeatureType, Presentation>` makes adding an enum member
require updating the inspector mapping. JSX, CSS and browser behavior remain
in the UI adapter; feature definitions contain no rendering implementation.

Isolation consists of private imports enforced by lint, typed capabilities,
and owned cancellation/cleanup. Dependency edges identify the provider of each
selected entry-time input. They do not discover hidden closures, validate
external or cross-system data, detect stale objects inside a ready provider, or
revoke escaped references after startup. These boundaries are not a JavaScript
sandbox and do not prevent global access. The trace boundary refuses new operations after system disposal
begins.

## Read and write ownership

Solid's reactive store is the sole owner of client-side domain records. A
provider's public feature API is the sole mutation authority: named commands
validate intent and apply it to that provider's private Solid state. Consumers
receive readonly reactive collections, records, or accessors. Keep Solid setters,
`DomainOwner`, and writable storage capabilities private. Data providers decide
backend policy; consuming modules demand reads and operations through ordinary
typed inputs, connected by composition.

The playground's intentions Data module creates its owner with `createSolidDomain` from
`@vibespa/solid/domain` and exports only reads and `scope.commands(...)`. Its
command API depends on no RxDB document, query, storage engine, or durability
promise. Its adapter input can be absent, a `createRestDomainAdapter` from
`@vibespa/solid/domain-rest`, a `createRxDbDomainAdapter` from
`@vibespa/local-first/solid-adapter`, or a `createRxCollectionDomainAdapter`
from `@vibespa/local-first/collection-adapter` over a replicated collection.
These thin custom connectors admit backend changes into the existing Solid
state; they do not introduce another writable domain collection or an
RxDB-shaped memory database.

```text
UI / consumer -> named feature command -> private Solid-owned domain state
UI / consumer <- readonly reactive views <- the same Solid state
Solid state <-> restricted adapter port <-> optional RxDB persistence OR REST
Solid state <-> collection adapter <-> native RxDB collection <-> replicateSupabase
```

Readonly views are cached forwarding wrappers over the same Solid records and
arrays. They block nested writes and Solid's internal writable-target symbols;
exposing a raw Solid proxy would allow a consumer to obtain another setter.
Reads retain row identity and field tracking, and keyed list selectors retain
the same row wrappers. They do not clone whole collections or freeze Solid's
reactive proxy. Admitted inputs, bounded transport payloads, history entries,
RxDB's persistent representation, and synchronization metadata still allocate
their own data; this is a single domain owner, not a zero-copy claim.

`commit` validates and coalesces the complete gesture before applying one
synchronous local batch. Its `LocalReceipt` identifies local application only.
Registered public commands still return promises for the module command
contract, but their local application does not wait for disk or network.
`view.delivery` separately reports loading, saving, idle, failed, or closed;
`settled()` joins the current delivery attempt and represents failures in that
status rather than waiting indefinitely for recovery. A failed save leaves the
accepted local edit visible.

Delivery is FIFO. Adapters return one receipt per submitted row; accepted rows
are removed from a partially failed head, and the remaining rows block later
gestures until explicit recovery. `retry()` retains the exact command identity
and requires idempotent per-row receipts from the backend. Version conflicts
do not silently replace local intent. `keepLocal()` explicitly reloads backend
versions and rebases pending whole-row local intent under new command
identities. This local-wins policy can overwrite concurrent remote fields;
ordinary retry never performs that rebase. A provider chooses whether and how
to expose these recovery operations as named commands.

Every command carries origin, gesture identity, sequence, and session
generation; writes retain local revisions and backend version baselines.
Adapters receive a restricted incoming admission function, never a Solid setter.
The same owner validates incoming origin, row identity, versions, and generation,
refuses conflicting pending rows, and guards echoes and duplicate delivery.
Incoming changes and acknowledgements create no new outgoing user gesture or
history entry. Server normalization applies only if its receipt still matches
the row's local revision, preserving edits made while an earlier save awaited.
Refused pushes retain only dirty revision metadata. After pending delivery
drains, the owner reloads through the same incoming port; an older receipt
cannot erase a newer foreign update. Missing/stale refresh results remain a
visible retryable failure. Adapters must return versioned tombstones on load.
No reactive effect infers user intent, and no global syncing flag establishes
ownership.

Undo and redo retain gesture provenance and refuse to overwrite rows changed by
later external revisions. History is bounded and session-local. The pending
delivery queue is in memory: local admission is not crash durability before
backend acceptance. Module cancellation refuses new commands and incoming
changes; owned adapter work is joined before resources close. Shutdown reports
undelivered accepted gestures as an error. Replacement sessions use a fresh
generation so old adapters and late responses cannot mutate their state.

### Solid over a replicated native collection

This is Haku's chain: Solid owner ← collection adapter ← native RxDB collection ←
stock `replicateSupabase`. The application owns an open RxDB database whose
collection has flat rows with primary key `id`, exactly the domain fields.
`createRxCollectionDomainAdapter({ collection, onAdopted, onIncomingError })`
connects a Solid owner to it; `syncSupabaseCollections` from
`@vibespa/supabase/collections` replicates the same collection.

- The adapter never closes the collection or database. Register the database
  close before replication in the same account scope, so replication cancels
  first and the database closes last.
- Solid rows are plain business JSON: `_rev`, `_meta`, `_attachments` and
  `_deleted` stay adapter-private, and a deleted row is `document: null`.
- Every durable change, including replication pulls and other tabs, reaches the
  owner through its restricted incoming port. Versions are per adapter session,
  advance with RxDB revision height, and include tombstones. Load pages through
  `getChangedDocumentsSince` and returns one row per id.
- Own writes are echoes only when both the predicted revision and the content
  match: RxDB derives the next revision from the database token, so a
  replication write can produce the same revision.
- A retried command returns its original receipt, including after a write that
  landed before its failure was reported.
- **Conflict policy: adopt.** When the durable row changed after the owner's
  baseline (or the write gets a 409), the adapter returns the durable row with
  `adopted: true` and calls `onAdopted`, instead of refusing the command. Stock
  replication already resolves remote conflicts server-wins after local
  acceptance, so refusing at the local boundary would only catch the short
  window before a save and would block the FIFO queue on a conflict the replica
  has already decided. The owner treats an adopted receipt as an external
  revision: undo and redo of the replaced gesture refuse. Refusal plus
  `keepLocal` remains the default for the envelope and REST adapters.

`syncSupabaseCollections({ collections, scope, accountId, client, tables, onConflict })`
shares `syncSupabase`'s account checks (including `authentication: 'access-token'`),
status and cancellation. A table's
`serverColumns` (for example an RLS owner column defaulted to `auth.uid()`) are
removed from pulled, realtime and conflict rows, so they never reach RxDB or
Solid and are never pushed. `onConflict` reports a push the server refused when
the stock handler kept a different row. Both observers are notification only.

The playground's `?backend=supabase` composes this chain per account: an
`account` Service module (magic link, sign-out), a `supabase-storage` Store module
(database, replication, adapter) and the unchanged intentions Data and Focus
modules. Each account gets its own system and application generation, chained so
the previous account closes before the next opens.

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

Use these neutral sources for transient state and small derived values. Domain
records follow the Solid-owned convention above. The Solid adapter's
`consumeReadable` owns one exact source subscription under the current rendering
owner. Solid updates settle in a microtask.

Solid application modules export readonly reactive records and collections, or
`Accessor<T>` from `solid-js`. Convert a neutral `Readable` at the module
boundary with `moduleAccessor(scope, readable, { name, equals })` from
`@vibespa/solid/module`: it subscribes under the module's own Solid owner, so the
subscription ends when the module is disposed, and it enters that owner itself,
so it is safe after an `await`. Derive values inside a module with Solid
primitives such as `createMemo` created under the module owner; pass `equals`
when a derived object should not notify consumers for an unchanged result.
Views and consuming modules call accessors directly, for example
`props.focus.pending()` in JSX, where the read is tracked automatically. A read
outside a tracking scope returns the current value without subscribing.
`consumeReadable` remains for framework-level neutral reads such as
`system.snapshot`. Tests that construct Solid computations must resolve Solid's
browser build; the workspace runs application tests in a Vitest project with
`browser` conditions.

Legacy applications may still expose native RxDB query/document capabilities.
The optional `@vibespa/solid/rxdb` module supplies `SolidRxReactivityFactory`,
`createSolidRxReactivityFactory({ name, equals })`, and `bindRxValue`,
`bindRxDocument`, and `bindRxField`. Pass the factory as `reactivity` when opening
an RxDB database; its `SolidRxReactivityLambda` types native `$$` getters as Solid
accessors. Bind inside the consuming Solid owner: subscriptions end with that
owner, and emitted document references are retained without conversion. The
default factory publishes every emission (`equals: false`); equality and signal
names are configuration supplied by the application's composition. This is our
small implementation of RxDB's official reactivity-factory extension point. It
converts RxDB/RxJS emissions into read accessors; it is not an official two-way
Solid store synchronization package and does not persist Solid setter calls.
RxDB remains the domain owner on this legacy path.

```ts
import { createRxDatabase } from 'rxdb';
import { createSolidRxReactivityFactory } from '@vibespa/solid/rxdb';

const database = await createRxDatabase({
  name: accountDatabaseName,
  storage,
  reactivity: createSolidRxReactivityFactory({ name: 'application.rxdb' }),
});
```

On that legacy path, commands persist through the application's write gate;
local writes and incoming replication publish through these same bindings. For compound commands,
`beginRxBatch(database)` from `@vibespa/solid/rxdb-batch` holds the latest emission
per binding until its returned release runs in `finally`. Nested batches share
the database's publication lifetime; `waitForRxBatches(database)` observes that
lifetime. This coordinates UI publication; persistence still requires explicit
collection batches. Both the factory and command gate must use the shared batch
module, whose state is keyed by database identity. Haku and CSM consume these
same subpaths through re-export facades; application schemas, command policy,
account lifetimes, and replication configuration stay in their compositions.

Build package declarations with `pnpm build:packages` after changing a public API.
`pnpm export:adapters` produces content-addressed adapter archives in
`artifacts/adapters`, each bundling its neutral workspace contracts. Haku and CSM
install these archives from their own `vendor` directory; production installs
need no sibling framework checkout. Refreshing those external consumers is a
separate, explicitly authorized application task. Consumers must deduplicate
Solid to the application's runtime, including when testing installed packages.

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

Module factories receive `ModuleContext`, which extends `Scope` with four
operations:

- `run(callback)` enters the module runtime synchronously and rejects entry after cancellation. Use it to create reactive work after an `await`, in a detached callback, or anywhere else outside an owned entry point.
- `task(callback)` enters the runtime, supplies the cancellation signal, and joins the returned promise during shutdown. Register detached asynchronous work here.
- `commands(group)` registers public commands: each call is owned, joined during shutdown, refused after cancellation, and traced by its key in a system.
- `acquire(open, close)` tracks an asynchronous acquisition and registers its cleanup before checking cancellation. A resource arriving after cancellation is still released, and cannot escape as a successful result.

`defer` remains the place for awaited resource cleanup. A module must not await
its own disposal from its factory, task, command, trace, or cleanup: disposal joins that
same work. Cancellation cannot force an uncooperative promise to settle.

The sample uses `createSolidSystem` from `@vibespa/solid/module`. Each instance
gets a detached owner; disposing a rendering root cannot dispose a module.
The module owner is current only during owned entry points: the synchronous part
of the factory, the synchronous part of a registered command or traced
operation, and callbacks passed to `scope.run` or `scope.task`. It is not current
after an `await`, in timers, promise continuations, event or non-Solid
subscription callbacks, or in an unregistered exported function invoked directly
by a view, which runs under the caller's owner, if any.
Computations created there either have no owner and outlive the module, or
belong to the caller and end with it. Create reactive work there inside
`scope.run`, or use `moduleAccessor`, `createModuleEffect` and `onModuleCleanup`,
which take the scope and enter the owner themselves. Keep the current
contract/definition/runtime layout and supply dependencies as ordinary typed
inputs.

Use `createModuleEffect(scope, compute, apply)` for module effects and
`onModuleCleanup(scope, cleanup)` for synchronous reactive cleanup, including
registration after an await. These helpers guard against work after cancellation
and contain cleanup exceptions so other reactive children can still release.
Use `scope.defer` for asynchronous resource cleanup. Accidentally returning a
promise from reactive cleanup is joined and reported as a contract failure.

Ownership guardrails:

- Tests: the `app` and `solid` Vitest projects load `test-support/solid-diagnostics.ts`,
  which captures Solid's own dev diagnostics (`OBSERVE.diagnostics.capture()`)
  per test and fails the test at teardown on ownership findings such as
  `NO_OWNER_EFFECT` or `NO_OWNER_CLEANUP`. A test that provokes one on purpose
  asserts it with `takeSolidDiagnostics()`. Setup fails if the diagnostics API is
  unavailable (for example a production Solid build).
- Lint, production application-module code (`apps/*/src/modules`, excluding
  tests): raw `createEffect`, `createRenderEffect`, `createTrackedEffect`,
  `createReaction`, `createRoot` and `onCleanup` imports from `solid-js` or
  `@solidjs/signals` (named, aliased, namespace or re-export) are refused in
  favor of the managed helpers and `scope.run`. This is an authoring policy, not
  a claim that every raw call is unowned. `createSignal` and `createMemo` stay
  native.
- Lint, same files: type-aware `@typescript-eslint/no-floating-promises` with
  `ignoreVoid: false`; a promise must be awaited, returned or given a rejection
  handler. Handling a promise does not make its work owned.

Remaining gaps: an unowned `createMemo` produces no Solid diagnostic; diagnostics
only fire on paths a test executes; lint does not analyze code after an `await`
or detect timers, listeners and subscriptions without a release. Placement inside
`scope.task` or `scope.acquire` does not release such resources: `task` joins
the returned work, `acquire` releases its returned resource through `close`, and
a timer, listener or subscription still needs its own cancellation or release
registered (for example its release passed to `scope.defer`).

Shutdown cancels admission, waits for construction, releases reactive children,
joins registered work, then drains resources. Managed cleanup failures aggregate
after other cleanup runs. An interrupted Solid disposal traversal leaves resource
release unsafe; the system reports failure and retains resources. HMR opens the
next generation only after successful disposal, keeping the previous inspector
visible when cleanup fails.

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

## Legacy RxDB-owned persistence and replication

The APIs in this section retain their existing RxDB-owned behavior for
compatibility. New Solid-owned providers use the optional
`@vibespa/local-first/solid-adapter` connector described above. The legacy
`createLocalStore` facade is not that connector: it writes directly to RxDB and
clones/freezes its memoized read projections. Native `$$` bindings retain
emitted references but also leave ownership in RxDB.

`createLocalStore` accepts an application-owned collection schema map and scope.
It defaults to validated durable IndexedDB storage and accepts an injected RxDB
storage engine for other hosts. Database names must include account identity in
an account-based application.

`store.query` and `store.document` return neutral capabilities backed by native
RxDB queries. An optional third scope argument lets a view own a shorter query
lifetime. Only infrastructure imports `@vibespa/local-first/adapter`; that seam
exists for replication, not business mutations.

Reads follow RxDB's own identity. RxDB's document cache returns one `RxDocument`
per document revision, and a query keeps one result object until its result set
changes. `store.query` and `store.document` memoize one frozen read-only
projection per such RxDB object (projection memoization, not a second writable
entity store): `read()` returns the same value until RxDB reports a changed
result, an unchanged row keeps its object across results, and a changed row gets
a new one. Subscribers are notified only when the published value changes; a
public `read()` never advances that marker. With keyed Solid lists
(`<For keyed={row => row.id}>`), rows whose records did not change do not
recompute. A changed row is replaced as a whole object; field-level precision
would need private documents to supply read-only field accessors, which is not
implemented.

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
automatic live replication to a legacy `LocalStore`. Solid-owned providers use
`syncSupabaseCollections` from `@vibespa/supabase/collections` instead (see "Solid
over a replicated native collection"); both share one implementation. Supply a standard authenticated Supabase client
whose session user matches `accountId`; signout or replacement cancels sync.
A client created with supabase-js's `accessToken` option (custom or third-party
JWTs) has no usable `client.auth`: pass `authentication: 'access-token'`. Then
there is no session check, `accountId` is the caller's assertion (for example a
JWT claim), and ending the account scope is the only cancellation.
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
`interaction.snapshot` is an immutable `Readable<InteractionSnapshot>` ordered
topmost first. It includes inactive surfaces, transparency, reachability,
`blockedBy`, and action IDs, normalized keys and enabled state. Reachability
describes the surface stack; a matching disabled action can still stop a specific
resolution. It never exposes action implementations or application payloads.
Snapshots update on mount/release and active/enabled changes; cancellation stops
observations and marks every surface unreachable, and disposal clears the stack.
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
