import type { DataNodeSnapshot, DataPortSnapshot } from '@vibespa/contracts';

export type { DataNodeSnapshot, DataPortSnapshot } from '@vibespa/contracts';
export type DataBindingSnapshot = DataPortSnapshot;

/** A canonical, inert public data contract. It contains no database or values. */
export interface DataContractReference {
  readonly id: string;
  readonly version: number;
  readonly schema?: Readonly<object>;
  readonly relations?: readonly DataContractReference[];
}

declare const dataValue: unique symbol;

export interface DataContract<Value> extends DataContractReference {
  readonly [dataValue]: (value: Value) => Value;
}

export interface DataPortReference {
  readonly contract: DataContractReference;
  readonly capabilities: readonly string[];
}

export interface DataPort<Value> extends DataPortReference {
  readonly contract: DataContract<Value>;
}

export type DataPorts<Shape extends object> = {
  readonly [Key in keyof Shape]?: DataPort<Shape[Key]>;
};

export interface ModuleDataDeclarations<Inputs extends object, Exports extends object> {
  readonly provides?: DataPorts<Exports>;
  readonly requires?: DataPorts<Inputs>;
}

/** Runtime shape shared by typed module declarations and constructor validation. */
export interface DataDeclarations {
  readonly provides?: Readonly<Record<string, DataPortReference | undefined>>;
  readonly requires?: Readonly<Record<string, DataPortReference | undefined>>;
}

// Authentication only: these sets cannot resolve a contract or an application value.
const contracts = new WeakSet<object>();
const ports = new WeakSet<object>();

function requireContract(value: DataContractReference): void {
  if (!value || !contracts.has(value)) throw new TypeError('Use a canonical contract from defineDataContract().');
}

function requirePort(value: unknown, label: string): asserts value is DataPortReference {
  if (!value || typeof value !== 'object' || !ports.has(value)) throw new TypeError(`${label} must use dataPort().`);
}

function freezeSchema<Value>(value: Value, ancestors = new WeakSet<object>()): Value {
  if (value && typeof value === 'object') {
    if (ancestors.has(value)) throw new TypeError('Data contract schema must be acyclic JSON data.');
    const prototype: unknown = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Data contract schema must contain only JSON data.');
    }
    ancestors.add(value);
    for (const child of Object.values(value)) freezeSchema(child, ancestors);
    ancestors.delete(value);
    Object.freeze(value);
  } else if (value !== null && typeof value !== 'string' && typeof value !== 'boolean'
    && !(typeof value === 'number' && Number.isFinite(value))) {
    throw new TypeError('Data contract schema must contain only JSON data.');
  }
  return value;
}

export function defineDataContract<Value>(definition: DataContractReference): DataContract<Value> {
  if (typeof definition.id !== 'string' || definition.id.trim().length === 0) throw new Error('Data contract id must not be empty.');
  if (!Number.isSafeInteger(definition.version) || definition.version < 0) throw new Error('Data contract version must be a non-negative safe integer.');
  if (definition.schema !== undefined && (definition.schema === null || typeof definition.schema !== 'object' || Array.isArray(definition.schema))) {
    throw new TypeError('Data contract schema must be an object.');
  }
  const relations = [...(definition.relations ?? [])];
  for (const relation of relations) requireContract(relation);
  const contract = Object.freeze({
    id: definition.id,
    version: definition.version,
    ...(definition.schema === undefined ? {} : { schema: freezeSchema(structuredClone(definition.schema)) }),
    relations: Object.freeze(relations),
  });
  contracts.add(contract);
  return contract as DataContract<Value>;
}

/** The declaration context decides whether these capabilities are offered or required. */
export function dataPort<Value>(contract: DataContract<Value>, capabilities: readonly string[]): DataPort<Value> {
  requireContract(contract);
  if (!Array.isArray(capabilities) || capabilities.some(capability => typeof capability !== 'string' || capability.trim().length === 0)) {
    throw new TypeError('Data capabilities must be non-empty strings.');
  }
  const port = Object.freeze({ contract, capabilities: Object.freeze([...new Set(capabilities)]) });
  ports.add(port);
  return port;
}

function requireRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) throw new TypeError(`${label} names must be strings.`);
}

/** Snapshot only authenticated declarations; application factories are never evaluated. */
export function snapshotDataDeclarations(value: unknown): DataDeclarations {
  requireRecord(value, 'Module data declarations');
  const entries: [string, Readonly<Record<string, DataPortReference>>][] = [];
  for (const name of Object.getOwnPropertyNames(value)) {
    if (name !== 'provides' && name !== 'requires') throw new Error(`Unknown data declaration ${name}.`);
    const map = value[name];
    if (map === undefined) continue;
    requireRecord(map, `Data ${name}`);
    const declarations: [string, DataPortReference][] = [];
    for (const key of Object.getOwnPropertyNames(map)) {
      const port = map[key];
      if (port === undefined) continue;
      requirePort(port, `Data ${name}.${key}`);
      declarations.push([key, port]);
    }
    entries.push([name, Object.freeze(Object.fromEntries(declarations))]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

/** Validate selected modules before any loader, database or service is started. */
export function validateDataGraph(modules: readonly { readonly id: string; readonly data?: DataDeclarations }[]): readonly DataNodeSnapshot[] {
  const definitions = new Map<string, DataContractReference>();
  const providers = new Map<string, DataBindingSnapshot>();
  const consumers = new Map<string, DataBindingSnapshot[]>();
  const moduleIds = new Set<string>();
  const register = (contract: DataContractReference): void => {
    requireContract(contract);
    const previous = definitions.get(contract.id);
    if (previous && previous !== contract) throw new Error(`Conflicting data contract ${contract.id}; reuse its canonical definition (versions ${previous.version} and ${contract.version}).`);
    if (previous) return;
    definitions.set(contract.id, contract);
    for (const relation of contract.relations ?? []) register(relation);
  };
  for (const module of modules) {
    if (moduleIds.has(module.id)) throw new Error(`Duplicate module ${module.id} in the data graph.`);
    moduleIds.add(module.id);
    const data = module.data === undefined ? undefined : snapshotDataDeclarations(module.data);
    for (const kind of ['provides', 'requires'] as const) {
      for (const [port, declaration] of Object.entries(data?.[kind] ?? {})) {
        if (declaration === undefined) continue;
        register(declaration.contract);
        const id = declaration.contract.id;
        const binding = Object.freeze({ definitionId: module.id, port, capabilities: declaration.capabilities });
        if (kind === 'provides') {
          const previous = providers.get(id);
          if (previous) throw new Error(`Multiple providers for data ${id}: ${previous.definitionId}.${previous.port} and ${module.id}.${port}.`);
          providers.set(id, binding);
        } else {
          const list = consumers.get(id) ?? [];
          list.push(binding);
          consumers.set(id, list);
        }
      }
    }
  }
  return Object.freeze([...definitions.values()].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0).map(contract => {
    const provider = providers.get(contract.id);
    if (!provider) throw new Error(`Missing provider for data ${contract.id}.`);
    const requiredBy = consumers.get(contract.id) ?? [];
    for (const consumer of requiredBy) {
      const missing = consumer.capabilities.filter(capability => !provider.capabilities.includes(capability));
      if (missing.length) throw new Error(`Data ${contract.id} provider ${provider.definitionId}.${provider.port} lacks ${missing.join(', ')} required by ${consumer.definitionId}.${consumer.port}.`);
    }
    return Object.freeze({ id: contract.id, version: contract.version, provider,
      consumers: Object.freeze(requiredBy), relations: Object.freeze((contract.relations ?? []).map(relation => relation.id)) });
  }));
}
