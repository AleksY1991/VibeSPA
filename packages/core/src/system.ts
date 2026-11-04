import type {
  FeatureContractSnapshot, ModuleRegistrationSnapshot, ModuleSnapshot, ModuleState,
  Readable, SystemEvent, SystemSnapshot, SystemState,
} from '@vibespa/contracts';
import { FeatureType } from '@vibespa/contracts';
import { startModule } from './module.js';
import { snapshotDataDeclarations, validateDataGraph } from './data.js';
import type { DataDeclarations } from './data.js';
import type { FeatureModule, ModuleContext, ModuleRuntime, ModuleRuntimeFactory } from './module.js';
import { createSource } from './readable.js';
import { createScope } from './scope.js';

/** A public capability and its identity in one owning system. */
export interface ModuleHandle<Exports extends object> {
  readonly id: string;
  readonly exports: Exports;
}

export interface SystemStartOptions {
  readonly id?: string;
  /** Dependencies derive exclusively from from() bindings in the input map. */
  readonly dependencies?: never;
}

declare const inputBinding: unique symbol;

/** An inert, privately authenticated input description; factories receive its value. */
export interface InputBinding<Value> {
  readonly [inputBinding]: Value;
}

/** Preserve the definition's required and optional input slots. */
export type InputBindings<Inputs extends object> = {
  readonly [Key in keyof Inputs]: InputBinding<Inputs[Key]>;
};

type BindingRecord =
  | { readonly kind: 'whole'; readonly handle: ModuleHandle<object> }
  | { readonly kind: 'export'; readonly handle: ModuleHandle<object>; readonly key: PropertyKey }
  | { readonly kind: 'external'; readonly value: unknown };

const bindings = new WeakMap<object, BindingRecord>();

function describeInput<Value>(record: BindingRecord): InputBinding<Value> {
  const descriptor = Object.freeze({}) as InputBinding<Value>;
  bindings.set(descriptor, Object.freeze(record));
  return descriptor;
}

/** Borrow the exact whole public exports object, without binding its methods. */
export function from<Exports extends object>(handle: ModuleHandle<Exports>): InputBinding<Exports>;
/** Select one public export at factory entry, retaining ordinary extraction semantics. */
export function from<Exports extends object, Key extends keyof NoInfer<Exports>>(
  handle: ModuleHandle<Exports>, key: Key,
): InputBinding<Exports[Key]>;
export function from(handle: ModuleHandle<object>, key?: PropertyKey): InputBinding<unknown> {
  return describeInput(arguments.length === 1
    ? { kind: 'whole', handle }
    : { kind: 'export', handle, key: typeof key === 'number' ? String(key) : key as PropertyKey });
}

/** Explicitly pass an unchecked external/configuration value, without inspecting it. */
export function external<Value>(value: Value): InputBinding<Value> {
  return describeInput({ kind: 'external', value });
}

export interface SystemOptions {
  readonly id: string;
  readonly eventLimit?: number;
  readonly createRuntime?: ModuleRuntimeFactory;
  /** Inert definitions registered for diagnostics and data-graph validation before startup. */
  readonly modules?: readonly SystemModuleDeclaration[];
}

export interface SystemModuleDeclaration {
  readonly id: string;
  readonly kind: FeatureType;
  readonly title?: string;
  readonly description?: string;
  readonly contract?: {
    readonly inputs: Readonly<Record<string, string>>;
    readonly exports: Readonly<Record<string, string>>;
  };
  readonly data?: DataDeclarations;
}

export interface System {
  readonly snapshot: Readable<SystemSnapshot>;
  /** Start a module in this system. Every input is from(handle[, key]) or
   * external(value); borrowed inputs and dependency edges derive from the same
   * authenticated bindings.
   */
  start<Kind extends FeatureType, Inputs extends object, Exports extends object>(
    definition: FeatureModule<Kind, Inputs, Exports>,
    bindings: InputBindings<NoInfer<Inputs>>,
    options?: SystemStartOptions,
  ): Promise<ModuleHandle<Exports>>;
  /** Records and joins operation boundaries without recording payloads.
   * Owned operations must not await disposal of their own system.
   */
  trace<Result>(handle: ModuleHandle<object>, name: string, run: () => Result | PromiseLike<Result>): Promise<Result>;
  clearEvents(): void;
  dispose(): Promise<void>;
}

interface Instance {
  readonly metadata: Omit<ModuleSnapshot, 'state' | 'error'>;
  state: ModuleState;
  error?: string;
  runtime?: ModuleRuntime;
  readonly operations: Set<Promise<void>>;
  readonly data?: DataDeclarations;
}

interface Provider {
  readonly handle: ModuleHandle<object>;
  readonly input?: string;
}

interface Registration {
  readonly metadata: Omit<ModuleRegistrationSnapshot, 'instanceIds'>;
  readonly missingTitle: boolean;
  readonly missingDescription: boolean;
  readonly missingContract: boolean;
}

function snapshotContract(contract: SystemModuleDeclaration['contract']): FeatureContractSnapshot {
  const ports = (items: Readonly<Record<string, string>>) => Object.freeze(
    Object.entries(items).map(([name, description]) => Object.freeze({ name, description })),
  );
  return Object.freeze({
    inputs: ports(contract?.inputs ?? {}),
    exports: ports(contract?.exports ?? {}),
  });
}

function snapshotRegistration(
  definition: SystemModuleDeclaration, selected: boolean,
): Registration {
  return {
    metadata: Object.freeze({
      id: definition.id,
      kind: definition.kind,
      title: definition.title ?? definition.id,
      description: definition.description ?? '',
      contract: snapshotContract(definition.contract),
      selected,
    }),
    missingTitle: definition.title === undefined,
    missingDescription: definition.description === undefined,
    missingContract: definition.contract === undefined,
  };
}

function sameContract(left: FeatureContractSnapshot, right: FeatureContractSnapshot): boolean {
  const samePorts = (a: FeatureContractSnapshot['inputs'], b: FeatureContractSnapshot['inputs']) =>
    a.length === b.length && a.every(port => b.some(other =>
      port.name === other.name && port.description === other.description));
  return samePorts(left.inputs, right.inputs) && samePorts(left.exports, right.exports);
}

function mergeRegistration(current: Registration, definition: SystemModuleDeclaration): Registration {
  const incoming = snapshotRegistration(definition, false);
  const metadata = current.metadata;
  const next = incoming.metadata;
  const conflict = metadata.hasConflictingDefinitions === true || metadata.kind !== next.kind
    || (!current.missingTitle && metadata.title !== next.title)
    || (!current.missingDescription && metadata.description !== next.description)
    || (!current.missingContract && !sameContract(metadata.contract, next.contract));
  return {
    ...incoming,
    metadata: Object.freeze({
      ...metadata,
      title: current.missingTitle ? next.title : metadata.title,
      description: current.missingDescription ? next.description : metadata.description,
      contract: current.missingContract ? next.contract : metadata.contract,
      ...(conflict ? { hasConflictingDefinitions: true } : {}),
    }),
  };
}

function errorMessage(error: unknown, seen = new Set<unknown>()): string {
  if (seen.has(error)) return 'Repeated error';
  seen.add(error);
  try {
    if (error instanceof AggregateError) {
      const causes = Array.from(error.errors as Iterable<unknown>, cause => errorMessage(cause, seen));
      return `${error.message}${causes.length > 0 ? `: ${causes.join('; ')}` : ''}`;
    }
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'Unknown error';
  }
}

/** Explicit module composition with an owned lifetime and neutral diagnostics.
 * Bound inputs and their edges share one source; external inputs remain unchecked.
 */
export function createSystem(options: SystemOptions): System {
  const systemId = options.id;
  const createRuntime = options.createRuntime;
  if (systemId.trim().length === 0) throw new Error('System id must not be empty');
  const eventLimit = options.eventLimit ?? 200;
  if (!Number.isSafeInteger(eventLimit) || eventLimit < 0) {
    throw new Error('System event limit must be a non-negative safe integer');
  }

  // This is a validation plan over module definitions, not another runtime or
  // dependency container. Actual inputs and lifetimes still use start()/from().
  const selected = new Map<SystemModuleDeclaration, DataDeclarations | undefined>();
  const selectedIds = new Set<string>();
  const registrations = new Map<string, Registration>();
  for (const definition of options.modules ?? []) {
    if (selectedIds.has(definition.id)) throw new Error(`Duplicate selected module: ${definition.id}`);
    selectedIds.add(definition.id);
    const data = definition.data === undefined ? undefined : snapshotDataDeclarations(definition.data);
    if (definition.kind === FeatureType.Data && Object.keys(data?.provides ?? {}).length === 0) {
      throw new Error(`Data module ${definition.id} must provide a data contract`);
    }
    if (definition.kind !== FeatureType.Data && Object.keys(data?.provides ?? {}).length > 0) {
      throw new Error(`Only Data modules can provide data contracts: ${definition.id}`);
    }
    selected.set(definition, data);
    registrations.set(definition.id, snapshotRegistration(definition, true));
  }
  const dataGraph = validateDataGraph([...selected].map(([definition, data]) => ({ id: definition.id, data })));

  const owner = createScope();
  const instances = new Map<string, Instance>();
  const handles = new WeakMap<ModuleHandle<object>, Instance>();
  let state: SystemState = 'running';
  let events: readonly SystemEvent[] = Object.freeze([]);
  let droppedEvents = 0;
  let sequence = 0;
  let disposal: Promise<void> | undefined;

  const makeSnapshot = (): SystemSnapshot => Object.freeze({
    id: systemId,
    state,
    modules: Object.freeze([...instances.values()].map(instance => Object.freeze({
      ...instance.metadata,
      state: instance.state,
      ...(instance.error === undefined ? {} : { error: instance.error }),
    }))),
    events,
    droppedEvents,
    registrations: Object.freeze([...registrations.values()].map(registration => Object.freeze({
      ...registration.metadata,
      instanceIds: Object.freeze([...instances.values()]
        .filter(instance => instance.metadata.definitionId === registration.metadata.id)
        .map(instance => instance.metadata.id)),
    }))),
    ...(dataGraph.length === 0 ? {} : { data: dataGraph }),
  });
  const source = createSource(makeSnapshot());

  const publish = (): void => {
    // A broken inspector subscriber must never affect construction or teardown.
    try { source.set(makeSnapshot()); } catch { /* Source already notified every subscriber. */ }
  };

  const record = (event: Omit<SystemEvent, 'sequence' | 'timestamp'>): void => {
    sequence += 1;
    const next = [...events, Object.freeze({ ...event, sequence, timestamp: Date.now() })];
    const excess = Math.max(0, next.length - eventLimit);
    droppedEvents += excess;
    events = Object.freeze(next.slice(excess));
    publish();
  };

  const requireRunning = (): void => {
    if (state !== 'running') throw new Error(`System ${systemId} is ${state}`);
  };

  const requireReady = (handle: ModuleHandle<object>): Instance => {
    const instance = handles.get(handle);
    if (!instance) throw new Error('Module handle does not belong to this system');
    if (instance.state !== 'ready') throw new Error(`Module ${handle.id} is ${instance.state}`);
    return instance;
  };

  const requireProvider = (provider: Provider): Instance => {
    try { return requireReady(provider.handle); }
    catch (cause: unknown) {
      if (provider.input === undefined) throw cause;
      throw new Error(`Input ${provider.input} provider: ${errorMessage(cause)}`, { cause });
    }
  };

  const startInstance = async <Kind extends FeatureType, Inputs extends object, Exports extends object>(
    definition: FeatureModule<Kind, Inputs, Exports>,
    resolveInputs: () => Inputs,
    providers: readonly Provider[],
    id: string,
  ): Promise<ModuleHandle<Exports>> => {
    requireRunning();
    if (id.trim().length === 0) throw new Error('Module instance id must not be empty');
    if (instances.has(id)) throw new Error(`Duplicate module instance: ${id}`);
    const data = selected.get(definition);
    if (data?.provides && [...instances.values()].some(instance => instance.metadata.definitionId === definition.id)) {
      throw new Error(`Data module ${definition.id} already has an instance in this system`);
    }
    const dependencies = providers.map(provider => {
      requireProvider(provider);
      return provider.handle.id;
    });
    if (new Set(dependencies).size !== dependencies.length) {
      throw new Error(`Duplicate dependency for module ${id}`);
    }

    const instance: Instance = {
      metadata: Object.freeze({
        id,
        definitionId: definition.id,
        kind: definition.kind,
        title: definition.title,
        description: definition.description,
        contract: snapshotContract(definition.contract),
        dependencies: Object.freeze(dependencies),
      }),
      state: 'loading',
      operations: new Set(),
      ...(data === undefined ? {} : { data }),
    };
    const registration = registrations.get(definition.id);
    registrations.set(definition.id, registration
      ? mergeRegistration(registration, definition)
      : snapshotRegistration(definition, false));
    instances.set(id, instance);

    const guarded = {
      ...definition,
      load: async () => {
        const factory = await definition.load();
        return (_inputs: undefined, scope: ModuleContext) => {
          // Runtime entry and starting observers may invalidate admission.
          for (const provider of providers) requireProvider(provider);
          const inputs = resolveInputs();
          // A later export getter can invalidate any earlier provider or the
          // consumer itself. No user callbacks or awaits after these checks.
          for (const provider of providers) requireProvider(provider);
          requireRunning();
          scope.signal.throwIfAborted();
          return factory(inputs, scope);
        };
      },
    };
    const exports = await startModule(guarded, undefined, owner, (next, error) => {
      instance.state = next;
      if (error !== undefined) instance.error = errorMessage(error);
      record({ type: next, moduleId: id, ...(error === undefined ? {} : { error: instance.error }) });
    }, {
      ...(createRuntime === undefined ? {} : {
        createRuntime: scope => {
          const runtime = createRuntime(scope);
          instance.runtime = runtime;
          return runtime;
        },
      }),
      settle: async () => {
        while (instance.operations.size > 0) await Promise.all([...instance.operations]);
      },
      // The system refuses commands as soon as shutdown begins, before module
      // scopes are cancelled, so a snapshot subscriber cannot start one.
      admitCommand: requireRunning,
      // Registered commands report under their declared keys. Values are never seen.
      observeCommand: name => {
        record({ type: 'operation-started', moduleId: id, operation: name });
        return {
          completed: () => { record({ type: 'operation-completed', moduleId: id, operation: name }); },
          failed: (error: unknown) => {
            record({ type: 'operation-failed', moduleId: id, operation: name, error: errorMessage(error) });
          },
        };
      },
    });
    // Disposal may run between the startup promise and this continuation.
    owner.signal.throwIfAborted();
    const handle = Object.freeze({ id, exports });
    handles.set(handle, instance);
    return handle;
  };

  const system: System = Object.freeze({
    snapshot: source.source,

    async start<Kind extends FeatureType, Inputs extends object, Exports extends object>(
      definition: FeatureModule<Kind, Inputs, Exports>,
      inputBindings: InputBindings<NoInfer<Inputs>>,
      startOptions: SystemStartOptions = {},
    ): Promise<ModuleHandle<Exports>> {
      requireRunning();
      if ((definition.kind === FeatureType.Data || definition.data !== undefined) && !selected.has(definition)) {
        throw new Error(`Declare module ${definition.id} in createSystem({ modules }) before starting data work`);
      }
      const data = selected.get(definition);
      if ('dependencies' in startOptions) throw new Error('start does not accept a dependencies override; dependencies derive from from() bindings');
      if (inputBindings === null || typeof inputBindings !== 'object' || Array.isArray(inputBindings)) {
        throw new Error('Input bindings must be an object');
      }
      const admitted: { readonly name: string; readonly binding: BindingRecord }[] = [];
      const providers = new Map<ModuleHandle<object>, Provider>();
      for (const name of Reflect.ownKeys(inputBindings)) {
        if (typeof name !== 'string' || !Object.hasOwn(definition.contract.inputs, name)) {
          throw new Error(`Unknown bound input: ${String(name)}`);
        }
        const descriptor: unknown = Reflect.get(inputBindings, name);
        const binding = descriptor !== null && typeof descriptor === 'object' ? bindings.get(descriptor) : undefined;
        if (!binding) throw new Error(`Input ${name} must use from() or external()`);
        const requirements = data?.requires;
        const requirement = requirements && Object.hasOwn(requirements, name) ? requirements[name] : undefined;
        if (requirement) {
          if (binding.kind !== 'export') throw new Error(`Data input ${name} must use from(handle, 'export')`);
          const provider = requireProvider({ handle: binding.handle, input: name });
          const offers = provider.data?.provides;
          const offered = offers && Object.hasOwn(offers, binding.key) ? offers[binding.key as string] : undefined;
          if (!offered || offered.contract !== requirement.contract) {
            throw new Error(`Data input ${name} requires contract ${requirement.contract.id}`);
          }
          for (const capability of requirement.capabilities) {
            if (!offered.capabilities.includes(capability)) {
              throw new Error(`Data input ${name} requires capability ${capability}`);
            }
          }
        }
        if (binding.kind !== 'external') {
          const provider = { handle: binding.handle, input: name };
          const instance = requireProvider(provider);
          if (binding.kind === 'export' && !instance.metadata.contract.exports.some(port => port.name === binding.key)) {
            throw new Error(`Input ${name}: unknown public export ${String(binding.key)} of module ${binding.handle.id}`);
          }
          if (!providers.has(binding.handle)) providers.set(binding.handle, provider);
        }
        admitted.push(Object.freeze({ name, binding }));
      }
      for (const name of Object.keys(data?.requires ?? {})) {
        if (!admitted.some(input => input.name === name)) throw new Error(`Missing data input: ${name}`);
      }
      // Only private immutable descriptor records survive admission; neither the
      // caller's map nor descriptors are read again while the loader is pending.
      Object.freeze(admitted);
      const resolveInputs = (): Inputs => Object.fromEntries(admitted.map(({ name, binding }) => {
        if (binding.kind === 'external') return [name, binding.value];
        if (binding.kind === 'whole') return [name, binding.handle.exports];
        return [name, Reflect.get(binding.handle.exports, binding.key)];
      })) as Inputs;
      return startInstance(definition, resolveInputs, [...providers.values()], startOptions.id ?? definition.id);
    },

    async trace<Result>(
      handle: ModuleHandle<object>, name: string, run: () => Result | PromiseLike<Result>,
    ): Promise<Result> {
      requireRunning();
      const instance = requireReady(handle);
      if (name.trim().length === 0) throw new Error('Operation name must not be empty');
      let finish!: () => void;
      const settled = new Promise<void>(resolve => { finish = resolve; });
      instance.operations.add(settled);
      try {
        record({ type: 'operation-started', moduleId: handle.id, operation: name });
        // An observer can explicitly dispose the system while receiving start.
        requireRunning();
        requireReady(handle);
        const result = await (instance.runtime ? instance.runtime.run(run) : run());
        record({ type: 'operation-completed', moduleId: handle.id, operation: name });
        return result;
      } catch (error: unknown) {
        record({ type: 'operation-failed', moduleId: handle.id, operation: name, error: errorMessage(error) });
        throw error;
      } finally {
        instance.operations.delete(settled);
        finish();
      }
    },

    clearEvents(): void {
      events = Object.freeze([]);
      droppedEvents = 0;
      publish();
    },

    dispose(): Promise<void> {
      if (disposal) return disposal;
      let resolveDisposal!: () => void;
      let rejectDisposal!: (error: unknown) => void;
      // Publish only once reentrant disposal already has its shared promise.
      disposal = new Promise<void>((resolve, reject) => {
        resolveDisposal = resolve;
        rejectDisposal = reject;
      });
      state = 'disposing';
      record({ type: state });
      void owner.dispose().then(() => {
        state = 'disposed';
        record({ type: state });
        resolveDisposal();
      }, (error: unknown) => {
        state = 'failed';
        record({ type: state, error: errorMessage(error) });
        rejectDisposal(error);
      });
      return disposal;
    },
  });

  return system;
}
