import { FeatureType } from '@vibespa/contracts';
import type { Cleanup, ModuleState, Scope } from '@vibespa/contracts';
import { createScope } from './scope.js';
import { snapshotDataDeclarations } from './data.js';
import type { DataPorts, ModuleDataDeclarations } from './data.js';

export { FeatureType } from '@vibespa/contracts';

/** Dependencies are ordinary typed inputs, supplied by the composition root. */
export type ModuleFactory<Inputs, Exports> = (
  inputs: Inputs,
  scope: ModuleContext,
) => Exports | Promise<Exports>;

/** An optional reactive runtime owned by one module instance. */
export interface ModuleRuntime {
  run<Result>(operation: () => Result): Result;
  /** Refuse further callbacks immediately, without releasing resources. */
  quiesce(): void;
  /** Returned failures are safe cleanup failures. A thrown failure means the
   * runtime could not finish releasing its children; resources must stay open.
   */
  dispose(): readonly unknown[] | Promise<readonly unknown[]>;
  /** Recheck shared teardown safety before initiating resource release. */
  assertSafeToRelease?(): void;
}

export type ModuleRuntimeFactory = (scope: Scope) => ModuleRuntime;

/** Explicit continuation ownership, cancellation, and async acquisition.
 * run owns only synchronous execution; re-enter it after each await when
 * constructing reactive work. Never await your own disposal from owned work.
 */
/** A public command: any asynchronous function. Arguments and results stay inferred. */
export type Command = (...args: never[]) => PromiseLike<unknown>;

/** An explicitly registered set of named commands. Keys become diagnostic names. */
export type CommandGroup<Group> = { readonly [Name in keyof Group]: Command };

/** A registered command: same receiver and arguments; the result is a native
 * Promise of the awaited value, without extra members of a custom thenable.
 */
export type RegisteredCommand<Declared extends Command> = (
  this: ThisParameterType<Declared>,
  ...args: Parameters<Declared>
) => Promise<Awaited<ReturnType<Declared>>>;

/** The group returned by `ModuleContext.commands`. */
export type RegisteredCommands<Group extends CommandGroup<Group>> = {
  readonly [Name in keyof Group]: RegisteredCommand<Group[Name]>;
};

/** Receives one invocation; observer failures never change the command's outcome. */
export interface CommandObservation {
  completed(): void;
  failed(error: unknown): void;
}

export interface ModuleContext extends Scope {
  run<Result>(operation: () => Result): Result;
  /** Register public commands once. Each call enters this module's runtime,
   * is joined during shutdown (including calls still queued by the module),
   * is refused after cancellation or disposal, and is reported to the owning
   * system by its key. Arguments, results and rejections pass through unchanged.
   */
  commands<Group extends CommandGroup<Group>>(group: Group): RegisteredCommands<Group>;
  task<Result>(operation: (signal: AbortSignal) => Result | PromiseLike<Result>): Promise<Result>;
  acquire<Resource>(
    open: (signal: AbortSignal) => Resource | PromiseLike<Resource>,
    close: (resource: Resource) => void | Promise<void>,
  ): Promise<Resource>;
}

export interface ModuleStartOptions {
  readonly createRuntime?: ModuleRuntimeFactory;
  /** Join work registered by the surrounding system before resource cleanup. */
  readonly settle?: () => Promise<void>;
  /** Throw to refuse a registered command before it starts, e.g. once the owning
   * system has begun shutdown. Checked again on runtime entry. Not swallowed.
   */
  readonly admitCommand?: () => void;
  /** Observe each registered command invocation by name, without its values. */
  readonly observeCommand?: (name: string) => CommandObservation | void;
}

/** An inert declaration: defining or collecting a module never calls load. */
export interface ModuleDefinition<Inputs, Exports> {
  readonly id: string;
  readonly load: () => Promise<ModuleFactory<Inputs, Exports>>;
}

export function defineModule<Inputs, Exports>(
  definition: ModuleDefinition<Inputs, Exports>,
): ModuleDefinition<Inputs, Exports> {
  if (definition.id.trim().length === 0) throw new Error('Module id must not be empty');
  return Object.freeze({ id: definition.id, load: definition.load });
}

/** Every public input and export has a description, including optional ports. */
export interface FeatureModuleContract<Inputs extends object, Exports extends object> {
  readonly inputs: { readonly [K in keyof Inputs]-?: string };
  readonly exports: { readonly [K in keyof Exports]-?: string };
}

/** An inert module with an enumerable responsibility and an explicit boundary. */
export type FeatureModule<
  X extends FeatureType,
  Inputs extends object = object,
  Exports extends object = object,
> = ModuleDefinition<Inputs, Exports> & {
  readonly kind: X;
  readonly title: string;
  readonly description: string;
  readonly contract: FeatureModuleContract<Inputs, Exports>;
} & (X extends FeatureType.Data
  ? { readonly data: ModuleDataDeclarations<Inputs, Exports> & { readonly provides: DataPorts<Exports> } }
  : { readonly data?: Omit<ModuleDataDeclarations<Inputs, Exports>, 'provides'> });

function requireDescription(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
}

function snapshotDescriptions<Ports extends object>(
  descriptions: { readonly [K in keyof Ports]-?: string },
  label: string,
): { readonly [K in keyof Ports]-?: string } {
  if (descriptions === null || typeof descriptions !== 'object' || Array.isArray(descriptions)) {
    throw new Error(`${label} must be an object of port descriptions`);
  }
  const snapshot = { ...descriptions };
  for (const name of Reflect.ownKeys(snapshot)) {
    if (typeof name !== 'string') throw new Error(`${label} port names must be strings`);
    requireDescription(name, `${label} port name`);
    requireDescription(Reflect.get(snapshot, name), `${label}.${name} description`);
  }
  return Object.freeze(snapshot);
}

/** Infer the boundary from the lazy factory without loading or starting it. */
export function defineFeatureModule<
  X extends FeatureType,
  Inputs extends object,
  Exports extends object,
>(
  definition: Omit<FeatureModule<X, Inputs, Exports>, 'contract'> & {
    readonly contract: FeatureModuleContract<NoInfer<Inputs>, NoInfer<Exports>>;
  },
): FeatureModule<X, Inputs, Exports> {
  requireDescription(definition.id, 'Module id');
  requireDescription(definition.title, 'Module title');
  requireDescription(definition.description, 'Module description');
  if (!Object.values(FeatureType).includes(definition.kind)) {
    throw new Error(`Unknown feature module kind: ${String(definition.kind)}`);
  }
  const contract = Object.freeze({
    inputs: snapshotDescriptions<Inputs>(definition.contract.inputs, 'Module inputs'),
    exports: snapshotDescriptions<Exports>(definition.contract.exports, 'Module exports'),
  });
  const data = definition.data === undefined ? undefined : snapshotDataDeclarations(definition.data);
  if (definition.kind === FeatureType.Data && Object.keys(data?.provides ?? {}).length === 0) {
    throw new Error('A Data module must provide at least one declared data export');
  }
  if (definition.kind !== FeatureType.Data && Object.keys(data?.provides ?? {}).length > 0) {
    throw new Error('Only Data modules can provide data contracts');
  }
  for (const port of Object.keys(data?.provides ?? {})) {
    if (!Object.hasOwn(contract.exports, port)) throw new Error(`Unknown data export: ${port}`);
  }
  for (const port of Object.keys(data?.requires ?? {})) {
    if (!Object.hasOwn(contract.inputs, port)) throw new Error(`Unknown data input: ${port}`);
  }
  return Object.freeze({
    id: definition.id,
    kind: definition.kind,
    title: definition.title,
    description: definition.description,
    contract,
    ...(data === undefined ? {} : { data }),
    load: definition.load,
  }) as unknown as FeatureModule<X, Inputs, Exports>;
}

/** Optional lifecycle diagnostics; observer failures never change module behavior. */
export type ModuleLifecycleObserver = (state: ModuleState, error?: unknown) => void;

/** Start under an owned child lifetime. A failed or canceled start rolls back
 * its resources and can never publish exports from a departed parent scope.
 */
export async function startModule<Inputs, Exports>(
  definition: ModuleDefinition<Inputs, Exports>,
  inputs: Inputs,
  parent: Scope,
  observer?: ModuleLifecycleObserver,
  options: ModuleStartOptions = {},
): Promise<Exports> {
  const createRuntime = options.createRuntime;
  const settle = options.settle;
  const cancellation = new AbortController();
  const scope = createScope(cancellation.signal);
  const forwardAbort = (): void => { cancellation.abort(parent.signal.reason); };
  if (parent.signal.aborted) forwardAbort();
  else parent.signal.addEventListener('abort', forwardAbort, { once: true });
  let releaseOwnership: (() => void) | undefined;
  let cleanupStarted = false;
  let terminal = false;
  let lastState: ModuleState = 'loading';
  let cleanup: Promise<void> | undefined;
  let runtime: ModuleRuntime | undefined;
  let quiesced = false;
  const lifecycleErrors: unknown[] = [];
  const tasks = new Set<Promise<void>>();
  let finishStartup!: () => void;
  const startupSettled = new Promise<void>(resolve => { finishStartup = resolve; });
  const quiesce = (): void => {
    if (!runtime || quiesced) return;
    quiesced = true;
    // Abort dispatch must not throw before other modules receive cancellation.
    try { runtime.quiesce(); } catch (error: unknown) { lifecycleErrors.push(error); }
  };
  const notify = (state: ModuleState, error?: unknown): void => {
    lastState = state;
    if (state === 'disposed' || state === 'cancelled' || state === 'failed') {
      terminal = true;
      scope.signal.removeEventListener('abort', onAbort);
      parent.signal.removeEventListener('abort', forwardAbort);
    }
    try { observer?.(state, error); } catch { /* Observation cannot alter ownership. */ }
  };
  const onAbort = (): void => {
    quiesce();
    if (!cleanupStarted && !terminal) notify('cancelling');
  };
  scope.signal.addEventListener('abort', onAbort, { once: true });

  const disposeOwned = (rollback: boolean): Promise<void> => {
    if (cleanup) return cleanup;
    cleanupStarted = true;
    let resolveCleanup!: () => void;
    let rejectCleanup!: (error: unknown) => void;
    // Install the shared promise before cancellation or observers can reenter.
    cleanup = new Promise<void>((resolve, reject) => {
      resolveCleanup = resolve;
      rejectCleanup = reject;
    });
    if (!rollback) notify('disposing');
    cancellation.abort();
    quiesce();
    const drain = async (): Promise<void> => {
      // A canceled factory/task may still acquire a resource. Keep defer open
      // until acquisition settles, including when disposal was requested inside it.
      await startupSettled;
      const errors = [...lifecycleErrors];
      let unsafe = false;
      try { errors.push(...(await runtime?.dispose() ?? [])); }
      catch (error: unknown) { unsafe = true; errors.push(error); }
      try { await settle?.(); } catch (error: unknown) { errors.push(error); }
      while (tasks.size > 0) await Promise.all([...tasks]);
      if (!unsafe) {
        try { runtime?.assertSafeToRelease?.(); }
        catch (error: unknown) { unsafe = true; errors.push(error); }
      }
      // An interrupted owner traversal can leave reactive children alive.
      // Closing their resources would make the partial failure more dangerous.
      if (!unsafe) {
        try { await scope.dispose(); } catch (error: unknown) { errors.push(error); }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, `Module ${definition.id} cleanup failed`);
      }
    };
    void drain().then(() => {
      if (!rollback) notify('disposed');
      resolveCleanup();
    }, (error: unknown) => {
      if (!rollback) notify('failed', error);
      rejectCleanup(error);
    });
    return cleanup;
  };
  const refusal = (): Error => new Error(`Module ${definition.id} is ${
    terminal ? lastState : cleanupStarted ? 'disposing' : 'cancelled'}`);
  const observe = (name: string): CommandObservation | void => {
    try { return options.observeCommand?.(name); } catch { return undefined; }
  };
  const report = (callback: () => void): void => {
    try { callback(); } catch { /* Observation cannot alter a command result. */ }
  };
  const invoke = (name: string, command: Command, receiver: unknown, args: readonly unknown[]): Promise<unknown> => {
    if (cleanupStarted || scope.signal.aborted) return Promise.reject(refusal());
    try { options.admitCommand?.(); } catch (error: unknown) { return Promise.reject(error); }
    let finish!: () => void;
    const accounted = new Promise<void>(resolve => { finish = resolve; });
    // Joined by shutdown with other owned tasks until the command settles.
    tasks.add(accounted);
    const observation = observe(name);
    let pending: Promise<unknown>;
    // run() rechecks cancellation and admission, which an observer may have changed.
    try {
      pending = Promise.resolve(context.run(() => {
        options.admitCommand?.();
        return Reflect.apply(command, receiver, args) as PromiseLike<unknown>;
      }));
    }
    catch (error: unknown) { pending = Promise.reject(error); }
    return pending.then(
      value => { report(() => observation?.completed()); return value; },
      (error: unknown) => { report(() => observation?.failed(error)); throw error; },
    ).finally(() => { tasks.delete(accounted); finish(); });
  };
  const context: ModuleContext = Object.freeze({
    signal: scope.signal,
    defer(cleanup: Cleanup) {
      return scope.defer(async () => {
        // Another module can discover an incomplete unwind while an earlier
        // asynchronous cleanup is settling. Recheck before each next release.
        runtime?.assertSafeToRelease?.();
        await cleanup();
      });
    },
    dispose: () => disposeOwned(false),
    run<Result>(operation: () => Result): Result {
      scope.signal.throwIfAborted();
      return runtime ? runtime.run(operation) : operation();
    },
    async task<Result>(operation: (signal: AbortSignal) => Result | PromiseLike<Result>): Promise<Result> {
      let finish!: () => void;
      const settled = new Promise<void>(resolve => { finish = resolve; });
      // Register before running user code, which may synchronously request disposal.
      tasks.add(settled);
      try { return await context.run(() => operation(scope.signal)); }
      finally { tasks.delete(settled); finish(); }
    },
    commands<Group extends CommandGroup<Group>>(group: Group): RegisteredCommands<Group> {
      if (group === null || typeof group !== 'object') throw new TypeError('Commands must be an object of functions');
      const prototype: unknown = Object.getPrototypeOf(group);
      // Only own properties are registered, so inherited (class) methods are refused.
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Commands must be a plain object literal; class instances and inherited methods are not supported');
      }
      const registered: Record<string, (this: unknown, ...args: unknown[]) => Promise<unknown>> = {};
      for (const name of Reflect.ownKeys(group)) {
        if (typeof name !== 'string') throw new TypeError('Command names must be strings');
        const command: unknown = Reflect.get(group, name);
        if (typeof command !== 'function') throw new TypeError(`Command ${name} must be a function`);
        registered[name] = function (this: unknown, ...args: unknown[]) {
          return invoke(name, command as Command, this, args);
        };
      }
      return Object.freeze(registered) as unknown as RegisteredCommands<Group>;
    },
    acquire<Resource>(
      open: (signal: AbortSignal) => Resource | PromiseLike<Resource>,
      close: (resource: Resource) => void | Promise<void>,
    ): Promise<Resource> {
      return context.task(async signal => {
        const resource = await open(signal);
        context.defer(() => close(resource));
        signal.throwIfAborted();
        return resource;
      });
    },
  });
  try {
    try {
      parent.signal.throwIfAborted();
      releaseOwnership = parent.defer(async () => {
        // A canceled factory may still acquire a resource before it observes
        // cancellation. Keep its registration window open until it settles.
        await startupSettled;
        await disposeOwned(false);
      });
      notify('loading');
      scope.signal.throwIfAborted();
      const factory = await definition.load();
      scope.signal.throwIfAborted();
      runtime = createRuntime?.(context);
      if (scope.signal.aborted) quiesce();
      scope.signal.throwIfAborted();
      notify('starting');
      scope.signal.throwIfAborted();
      const exports = await context.run(() => factory(inputs, context));
      scope.signal.throwIfAborted();
      notify('ready');
      scope.signal.throwIfAborted();
      return exports;
    } finally {
      finishStartup();
    }
  } catch (error: unknown) {
    const cancelled = scope.signal.aborted;
    notify('rolling-back', error);
    try { await disposeOwned(true); }
    catch (cleanupError: unknown) {
      // Any failed rollback may still own live resources. Retain its failed
      // cleanup promise so the parent cannot report successful release and
      // permit replacement after a resource close rejected.
      const failure = new AggregateError([error, cleanupError], `Module ${definition.id} startup and rollback failed`, { cause: cleanupError });
      notify('failed', failure);
      throw failure;
    }
    releaseOwnership?.();
    notify(cancelled ? 'cancelled' : 'failed', error);
    throw error;
  }
}
