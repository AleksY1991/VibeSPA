# VibeSPA application

This application was created by `create-vibespa`. It owns its code and
configuration; the framework arrives as pinned package archives in `vendor/`.

```sh
pnpm install
pnpm dev            # http://127.0.0.1:8081
pnpm check          # lint, strict TypeScript, tests
pnpm build          # production build in dist/
```

## Layout

```text
src/
  contracts/                  neutral presentation capabilities
  modules/<name>/
    contract.ts               inputs and exported behavior
    definition.ts             inert identity and lazy factory
    internal/runtime.ts       private implementation
  composition/                explicit dependency and lifetime wiring
  ui/                         rendering, CSS, browser elements
test-support/solid-diagnostics.ts   fails tests on Solid ownership diagnostics
vendor/                       pinned @vibespa package archives (do not edit)
```

Business code imports another module's public contract, never its `internal`
files. Definitions are inert: importing one must not start work. JSX, CSS and
browser elements stay in `ui/`. `eslint.config.js` enforces these boundaries
with `@vibespa/eslint-plugin`.

## Mandatory UI rule: Haku design system

All VibeSPA UI MUST use components from the Haku design-system repository,
[`AleksY1991/design_system`](https://github.com/AleksY1991/design_system), through
its public `@ui-kit/core` exports. This mandatory rule applies to the application,
debug tooling, the System inspector, generated UI and all future UI, and binds
every contributor and agent. Its pinned archive is included in `vendor/`; there
is no sibling checkout dependency. Use shared controls, `List` with explicit `keyBy`, Lucide
icons, theme and typography tokens. Construct live observables with
`constructItem`, and pass explicit `surface` and `hotkeys` to each control.
Do not recreate native buttons, fields, selects, links or disclosures, copy SVG
icons, redefine the shared theme, or target control implementation selectors.
Do not use another component library directly. If a required component or variant
is missing, add it to the Haku design-system repo and consume its public export;
do not implement an application-only replacement.
Local CSS owns only application layout, graph placement and semantic text roles.
UI lint enforces these boundaries. The owned UI runtime prepares the shared
implementation and supplies its surface platform before mounting the app.

## Modules

Start modules with `system.start(definition, inputs)`. Bind every input with
`from(handle, 'key')` or `from(handle)` for a capability exported by a module
already started in the same system, or `external(value)` for configuration and
values no module provides. The system records dependency edges from `from()`.

Expose reactive reads as Solid `Accessor<T>`. Convert a neutral `Readable` with
`moduleAccessor(scope, readable)` from `@vibespa/solid/module`. Declare public
commands once with `scope.commands({ ... })` and export the returned group:
each call is owned, joined during shutdown, refused after cancellation and
recorded by its key in the system inspector. Command implementations return
promises.

Solid's reactive store owns all client-side domain records. The intentions Data module
keeps `createSolidDomain` from `@vibespa/solid/domain` private and exports only
readonly reactive views and named commands. Cached deep readonly wrappers
forward to those same records without cloning whole read collections; setters
and writable RxDB handles never reach consumers. Optional thin custom adapters
use `@vibespa/solid/domain-rest` or `@vibespa/local-first/solid-adapter` through
the same restricted incoming port. Native RxDB `$$` bindings remain a legacy
RxDB-owned read path, not two-way Solid persistence.

Data modules use `FeatureModule<FeatureType.Data>` and declare their public ports
in `data.provides`. Consumers such as Focus declare `data.requires` against the
same canonical `defineDataContract<API>` reference, imported from the provider's
public contract. `dataPort(reference, capabilities)` types the port; capabilities
describe behavior, not automatic method filtering or backend authorization.
Expose separate named contracts for narrower APIs.

Pass selected definitions as `modules: applicationModules` when constructing the
Solid system. Construction throws for conflicting definitions, ambiguous or
missing providers, missing relation targets and insufficient capabilities before
any loader runs. Start providers explicitly, then bind declared Data inputs with
`from(provider, 'export')`. These inputs cannot use `external` or whole-object
bindings. The inspector publishes definition/port metadata, never record values.
The sample promises `local-apply`; disk and remote acceptance remain delivery
status. Schema metadata never runs migrations or constructs a backend for you.

The same API and UI run with IndexedDB by default (`vibespa-focus-solid`, leaving
the old `vibespa-focus` database untouched), memory only at `?backend=memory`,
or a controlled fake REST server at `?backend=rest`. Commands apply locally
before disk/network acknowledgement; delivery status reports save failures
without discarding accepted edits. Delivery is FIFO; partial failures block the
remaining queue and explicit retry preserves command identity. Provider-owned
`keepLocal()` recovery rebases whole-row local intent under new identities and
can overwrite concurrent remote fields. Incoming versions and session generations
guard stale changes; normalization cannot replace a newer local edit. Undo/redo
are revision-guarded, and history is bounded. The delivery queue is in memory,
so local admission is not crash durability before backend acceptance. Shutdown
reports undelivered accepted gestures as an error.

The module's Solid owner is current only in the synchronous part of the factory,
of a registered command or traced operation, and inside `scope.run` and
`scope.task`. After an `await`, in timers, promise callbacks or non-Solid
subscriptions, create reactive work inside `scope.run`, or use
`createModuleEffect`, `onModuleCleanup` and `moduleAccessor`. Use `scope.task`
for background work and `scope.acquire` or `scope.defer` for resources. A timer,
listener or subscription still needs its own release, for example passed to
`scope.defer`.

In production module code, lint refuses raw Solid effects, roots and cleanup in
favor of those helpers, and refuses floating promises (`void` alone is not
handling). Tests load `test-support/solid-diagnostics.ts`, which fails a test on
ownership findings such as `NO_OWNER_EFFECT`; a test that provokes one on purpose
asserts it with `takeSolidDiagnostics()`.

## Updating the framework

The `@vibespa/*` packages are pinned to the archives in `vendor/` and never
update on their own. To update them from a VibeSPA checkout:

1. In the checkout, run `pnpm build:packages`, then
   `node scripts/export-adapters.mjs --application-packages --destination <this app>/vendor-next`.
2. Replace only the `@vibespa` archives in `vendor/` with the new archives (file
   names carry each archive's SHA-256). Retain the `ui-kit-core` archive and its
   existing pin when updating the framework.
3. Update every `file:./vendor/...` entry in `package.json` and the matching
   `overrides` in `pnpm-workspace.yaml` to the new file names. The overrides keep
   one instance of each `@vibespa` package across the dependency graph.
4. Align `solid-js`, `@solidjs/web`, `rxdb` and `rxjs` with the versions the new
   packages require.
5. Run `pnpm install`, then `pnpm check` and `pnpm build`, and review the changes.
