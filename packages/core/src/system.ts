import type {
  FeatureContractSnapshot, ModuleRegistrationSnapshot, ModuleSnapshot, ModuleState,
  Readable, SystemEvent, SystemSnapshot, SystemState,
} from '@vibespa/contracts';
import { FeatureType } from '@vibespa/contracts';
import { startModule } from './module.js';
import { snapshotDataDeclarations, validateDataGraph } from './data.js';
import type { DataDeclarations } from './data.js';
import { contributionIdentity, createContributionRegistryOwner, requireContributionContract, snapshotContributionDeclarations } from './contributions.js';
import type {
  ContributionContract, ContributionContractReference, ContributionDeclarations,
  ContributionDefinition, ContributionEntry, ContributionRegistry,
} from './contributions.js';
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
  /** Dependencies derive from from() and collect() bindings in the input map. */
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
  | { readonly kind: 'external'; readonly value: unknown }
  | { readonly kind: 'contributions'; readonly system: object; readonly contract: ContributionContractReference };

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
  readonly contributions?: ContributionDeclarations;
}

export interface System {
  readonly snapshot: Readable<SystemSnapshot>;
  /** Discover inert declarations and ready exports without starting their modules. */
  contributions<Value>(contract: ContributionContract<Value>): ContributionRegistry<Value>;
  /** Bind a typed collection, recording dependencies on every ready provider.
   * Start all selected providers first. Provider admission is sealed while a
   * consumer of this contract is loading or ready, preserving teardown order.
   */
  collect<Value>(contract: ContributionContract<Value>): InputBinding<ContributionRegistry<Value>>;
  /** Start a module in this system. Inputs use from(handle[, key]),
   * external(value), or collect(contract); borrowed inputs and dependency edges derive from the same
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
  readonly contributions?: ContributionDeclarations;
  readonly consumes: readonly ContributionContractReference[];
  entries: readonly ContributionEntry<unknown>[];
  handle?: ModuleHandle<object>;
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
  const contributionContracts = new Map<string, ContributionContractReference>();
  const contributionDefinitions = new Map<string, ContributionDeclarations>();
  const contributionPlans = new Map<SystemModuleDeclaration, ContributionDeclarations | undefined>();
  const registryOwners = new Map<ContributionContractReference, ReturnType<typeof createContributionRegistryOwner>>();
  const systemIdentity = Object.freeze({});

  const registerContract = (contract: ContributionContractReference): void => {
    requireContributionContract(contract);
    const previous = contributionContracts.get(contract.id);
    if (previous && previous !== contract) throw new Error(`Conflicting contribution contract ${contract.id}; reuse its canonical definition (versions ${previous.version} and ${contract.version}).`);
    contributionContracts.set(contract.id, contract);
  };

  const prepareContributions = (definition: SystemModuleDeclaration): ContributionDeclarations | undefined => {
    const declarations = definition.contributions === undefined ? undefined : snapshotContributionDeclarations(definition.contributions);
    const seen = new Map(contributionContracts);
    for (const direction of ['provides', 'requires'] as const) {
      for (const [name, port] of Object.entries(declarations?.[direction] ?? {})) {
        if (!port) continue;
        const boundary = direction === 'provides' ? definition.contract?.exports : definition.contract?.inputs;
        if (!boundary || !Object.hasOwn(boundary, name)) throw new Error(`Unknown contribution ${direction === 'provides' ? 'export' : 'input'}: ${name}`);
        requireContributionContract(port.contract);
        const previous = seen.get(port.contract.id);
        if (previous && previous !== port.contract) throw new Error(`Conflicting contribution contract ${port.contract.id}; reuse its canonical definition.`);
        seen.set(port.contract.id, port.contract);
      }
    }
    const previous = contributionDefinitions.get(definition.id);
    if (previous) {
      for (const direction of ['provides', 'requires'] as const) {
        const before = Object.entries(previous[direction] ?? {}).filter(([, port]) => port !== undefined);
        const after = Object.entries(declarations?.[direction] ?? {}).filter(([, port]) => port !== undefined);
        if (before.length !== after.length || before.some(([name, port]) => {
          const next = declarations?.[direction]?.[name];
          return port?.contract !== next?.contract || port?.order !== next?.order;
        })) throw new Error(`Conflicting contribution declarations for module ${definition.id}.`);
      }
    }
    return declarations;
  };

  const registerContributions = (definition: SystemModuleDeclaration, declarations: ContributionDeclarations | undefined): void => {
    if (declarations) {
      for (const direction of ['provides', 'requires'] as const) {
        for (const port of Object.values(declarations[direction] ?? {})) if (port) registerContract(port.contract);
      }
      contributionDefinitions.set(definition.id, declarations);
    }
    contributionPlans.set(definition, declarations);
  };

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
    registerContributions(definition, prepareContributions(definition));
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

  const refreshContributions = (): void => {
    for (const [contract, registry] of registryOwners) {
      const definitions: ContributionDefinition[] = [];
      for (const [definitionId, declarations] of contributionDefinitions) {
        for (const [name, port] of Object.entries(declarations.provides ?? {})) {
          if (port?.contract === contract) definitions.push(Object.freeze({
            id: contributionIdentity(definitionId, name), definitionId, export: name, order: port.order,
          }));
        }
      }
      registry.definitions(definitions);
      registry.items(state === 'running' ? [...instances.values()]
        .filter(instance => instance.state === 'ready' && instance.handle !== undefined)
        .flatMap(instance => instance.entries.filter(entry => instance.contributions?.provides?.[entry.export]?.contract === contract)) : []);
    }
  };

  const getContributions = <Value>(contract: ContributionContract<Value>): ContributionRegistry<Value> => {
    registerContract(contract);
    let registry = registryOwners.get(contract);
    if (!registry) {
      registry = createContributionRegistryOwner(contract);
      registryOwners.set(contract, registry);
      refreshContributions();
    }
    return registry.registry as unknown as ContributionRegistry<Value>;
  };

  const hasContributionConsumers = (contract: ContributionContractReference): boolean => [...instances.values()].some(instance =>
    (instance.state === 'loading' || instance.state === 'starting' || instance.state === 'ready') && instance.consumes.includes(contract));

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
    refreshContributions();
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
    consumes: readonly ContributionContractReference[],
    contributions: ContributionDeclarations | undefined,
    id: string,
  ): Promise<ModuleHandle<Exports>> => {
    requireRunning();
    if (id.trim().length === 0) throw new Error('Module instance id must not be empty');
    if (instances.has(id)) throw new Error(`Duplicate module instance: ${id}`);
    for (const port of Object.values(contributions?.provides ?? {})) {
      if (port && hasContributionConsumers(port.contract)) throw new Error(`Start contribution provider ${definition.id} before consumers of ${port.contract.id}.`);
    }
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
      consumes: Object.freeze([...consumes]),
      entries: Object.freeze([]),
      ...(data === undefined ? {} : { data }),
      ...(contributions === undefined ? {} : { contributions }),
    };
    registerContributions(definition, contributions);
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
          const result = factory(inputs, scope);
          if (Object.keys(contributions?.provides ?? {}).length === 0) return result;
          return Promise.resolve(result).then(exports => {
            const entries: ContributionEntry<unknown>[] = [];
            for (const [name, port] of Object.entries(contributions?.provides ?? {})) {
              if (!port) continue;
              if (!Object.hasOwn(exports, name)) throw new Error(`Contribution export ${name} is missing from module ${id}.`);
              const value: unknown = Reflect.get(exports, name);
              if (port.contract.validate && !port.contract.validate(value)) throw new Error(`Invalid contribution ${id}.${name} for contract ${port.contract.id}.`);
              entries.push(Object.freeze({ id: contributionIdentity(id, name), definitionId: definition.id, instanceId: id, export: name, order: port.order, value }));
            }
            scope.signal.throwIfAborted();
            instance.entries = Object.freeze(entries);
            return exports;
          });
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
    instance.handle = handle;
    refreshContributions();
    requireRunning();
    owner.signal.throwIfAborted();
    requireReady(handle);
    return handle;
  };

  const system: System = Object.freeze({
    snapshot: source.source,

    contributions: getContributions,

    collect<Value>(contract: ContributionContract<Value>): InputBinding<ContributionRegistry<Value>> {
      requireRunning();
      getContributions(contract);
      return describeInput({ kind: 'contributions', system: systemIdentity, contract });
    },

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
      const contributions = contributionPlans.has(definition)
        ? contributionPlans.get(definition) : prepareContributions(definition);
      if ('dependencies' in startOptions) throw new Error('start does not accept a dependencies override; dependencies derive from from() bindings');
      // Snapshot option getters before collecting providers; a getter must not
      // admit an untracked provider after the collection plan has been checked.
      const instanceId = startOptions.id ?? definition.id;
      if (inputBindings === null || typeof inputBindings !== 'object' || Array.isArray(inputBindings)) {
        throw new Error('Input bindings must be an object');
      }
      const admitted: { readonly name: string; readonly binding: BindingRecord }[] = [];
      const providers = new Map<ModuleHandle<object>, Provider>();
      const consumes = new Set<ContributionContractReference>();
      for (const name of Reflect.ownKeys(inputBindings)) {
        if (typeof name !== 'string' || !Object.hasOwn(definition.contract.inputs, name)) {
          throw new Error(`Unknown bound input: ${String(name)}`);
        }
        const descriptor: unknown = Reflect.get(inputBindings, name);
        const binding = descriptor !== null && typeof descriptor === 'object' ? bindings.get(descriptor) : undefined;
        if (!binding) throw new Error(`Input ${name} must use from() or external(), or collect() for typed collections`);
        const contributionRequirement = contributions?.requires && Object.hasOwn(contributions.requires, name)
          ? contributions.requires[name] : undefined;
        if (contributionRequirement && (binding.kind !== 'contributions' || binding.contract !== contributionRequirement.contract)) {
          throw new Error(`Contribution input ${name} requires collect(${contributionRequirement.contract.id}).`);
        }
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
        if (binding.kind === 'contributions') {
          if (binding.system !== systemIdentity) throw new Error(`Contribution input ${name} belongs to another system.`);
          requireContributionContract(binding.contract);
          for (const [definitionId, declarations] of contributionDefinitions) {
            if (!Object.values(declarations.provides ?? {}).some(port => port?.contract === binding.contract)) continue;
            const ready = [...instances.values()].filter(instance => instance.metadata.definitionId === definitionId
              && instance.state === 'ready' && instance.handle !== undefined);
            if ([...instances.values()].some(instance => instance.metadata.definitionId === definitionId
              && (instance.state === 'loading' || instance.state === 'starting'))) {
              throw new Error(`Contribution provider ${definitionId} is still starting.`);
            }
            if (ready.length === 0) throw new Error(`Start contribution provider ${definitionId} before collecting ${binding.contract.id}.`);
            for (const instance of ready) {
              const handle = instance.handle!;
              if (!providers.has(handle)) providers.set(handle, { handle, input: name });
            }
          }
          consumes.add(binding.contract);
        } else if (binding.kind !== 'external') {
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
      for (const name of Object.keys(contributions?.requires ?? {})) {
        if (!admitted.some(input => input.name === name)) throw new Error(`Missing contribution input: ${name}`);
      }
      for (const contract of consumes) {
        if (Object.values(contributions?.provides ?? {}).some(port => port?.contract === contract)) {
          throw new Error(`Module ${definition.id} cannot collect its own contribution contract ${contract.id}.`);
        }
        // A getter in a later binding may have admitted a new provider after
        // collection was checked. No callbacks run between this check and lock.
        for (const instance of instances.values()) {
          if (Object.values(instance.contributions?.provides ?? {}).some(port => port?.contract === contract)
            && (instance.state === 'loading' || instance.state === 'starting')) {
            throw new Error(`Contribution provider ${instance.metadata.id} is still starting.`);
          }
        }
      }
      // Only private immutable descriptor records survive admission; neither the
      // caller's map nor descriptors are read again while the loader is pending.
      Object.freeze(admitted);
      const resolveInputs = (): Inputs => Object.fromEntries(admitted.map(({ name, binding }) => {
        if (binding.kind === 'external') return [name, binding.value];
        if (binding.kind === 'contributions') return [name, registryOwners.get(binding.contract)!.registry];
        if (binding.kind === 'whole') return [name, binding.handle.exports];
        return [name, Reflect.get(binding.handle.exports, binding.key)];
      })) as Inputs;
      return startInstance(definition, resolveInputs, [...providers.values()], [...consumes], contributions, instanceId);
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
