import type { Readable } from '@vibespa/contracts';
import { createSource } from './readable.js';

/** One canonical contract is shared by its providers and consumers. */
export interface ContributionContractReference {
  readonly id: string;
  readonly version: number;
  /** Optional runtime admission check. It must not start resources or mutate its value. */
  readonly validate?: (value: unknown) => boolean;
}

declare const contributionValue: unique symbol;

/** The invariant value parameter prevents structurally incompatible ports mixing. */
export interface ContributionContract<Value> extends ContributionContractReference {
  readonly [contributionValue]: (value: Value) => Value;
}

export interface ContributionPortReference {
  readonly contract: ContributionContractReference;
  readonly order: number;
}

export interface ContributionPort<Value> extends ContributionPortReference {
  readonly contract: ContributionContract<Value>;
}

export type ContributionPorts<Exports extends object> = {
  readonly [Key in keyof Exports]?: ContributionPort<Exports[Key]>;
};

export type ContributionRequirements<Inputs extends object> = {
  readonly [Key in keyof Inputs]?: Inputs[Key] extends ContributionRegistry<infer Value>
    ? ContributionPort<Value> : never;
};

export interface ModuleContributionDeclarations<Inputs extends object, Exports extends object> {
  readonly provides?: ContributionPorts<Exports>;
  readonly requires?: ContributionRequirements<Inputs>;
}

/** Erased declarations used for static planning; no application values or factories. */
export interface ContributionDeclarations {
  readonly provides?: Readonly<Record<string, ContributionPortReference | undefined>>;
  readonly requires?: Readonly<Record<string, ContributionPortReference | undefined>>;
}

export interface ContributionDefinition {
  /** Opaque, stable identity combining the definition (or instance) and export. */
  readonly id: string;
  readonly definitionId: string;
  readonly export: string;
  readonly order: number;
}

export interface ContributionEntry<Value> extends ContributionDefinition {
  readonly instanceId: string;
  /** The exact public capability, borrowed from its ready provider. */
  readonly value: Value;
}

/** Readonly discovery of inert definitions and ready contributions for one type. */
export interface ContributionRegistry<Value> {
  readonly contract: ContributionContract<Value>;
  readonly definitions: Readable<readonly ContributionDefinition[]>;
  readonly items: Readable<readonly ContributionEntry<Value>[]>;
}

const contracts = new WeakSet<object>();
const ports = new WeakSet<object>();

export function requireContributionContract(value: ContributionContractReference): void {
  if (!value || !contracts.has(value)) throw new TypeError('Use a canonical contract from defineContributionContract().');
}

/** @internal Escape separators so distinct module/export pairs cannot collide. */
export function contributionIdentity(moduleId: string, name: string): string {
  const part = (value: string) => encodeURIComponent(value).replaceAll('.', '%2E');
  return `${part(moduleId)}.${part(name)}`;
}

export function defineContributionContract<Value>(definition: ContributionContractReference): ContributionContract<Value> {
  if (typeof definition.id !== 'string' || !definition.id.trim()) throw new Error('Contribution contract id must not be empty.');
  if (!Number.isSafeInteger(definition.version) || definition.version < 0) throw new Error('Contribution contract version must be a non-negative safe integer.');
  if (definition.validate !== undefined && typeof definition.validate !== 'function') throw new TypeError('Contribution validation must be a function.');
  const contract = Object.freeze({
    id: definition.id,
    version: definition.version,
    ...(definition.validate === undefined ? {} : { validate: definition.validate }),
  });
  contracts.add(contract);
  return contract as ContributionContract<Value>;
}

/** Bind a named public export (or a registry input) to its canonical type. */
export function contributionPort<Value>(
  contract: ContributionContract<Value>, options: { readonly order?: number } = {},
): ContributionPort<Value> {
  requireContributionContract(contract);
  const order = options.order ?? 0;
  if (!Number.isFinite(order)) throw new Error('Contribution order must be finite.');
  const port = Object.freeze({ contract, order });
  ports.add(port);
  return port;
}

function record(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) throw new TypeError(`${label} names must be strings.`);
}

/** Copy declaration shells without loading providers or inspecting runtime values. */
export function snapshotContributionDeclarations(value: unknown): ContributionDeclarations {
  record(value, 'Module contributions');
  const result: [string, Readonly<Record<string, ContributionPortReference>>][] = [];
  for (const name of Object.getOwnPropertyNames(value)) {
    if (name !== 'provides' && name !== 'requires') throw new Error(`Unknown contribution declaration ${name}.`);
    const map = value[name];
    if (map === undefined) continue;
    record(map, `Contribution ${name}`);
    const entries: [string, ContributionPortReference][] = [];
    for (const key of Object.getOwnPropertyNames(map)) {
      const port = map[key];
      if (port === undefined) continue;
      if (!key.trim()) throw new Error('Contribution port name must not be empty.');
      if (!port || typeof port !== 'object' || !ports.has(port)) throw new TypeError(`Contribution ${name}.${key} must use contributionPort().`);
      entries.push([key, port as ContributionPortReference]);
    }
    result.push([name, Object.freeze(Object.fromEntries(entries))]);
  }
  return Object.freeze(Object.fromEntries(result));
}

/** @internal One system privately owns all registry publication. */
export function createContributionRegistryOwner(contract: ContributionContractReference) {
  requireContributionContract(contract);
  const definitions = createSource<readonly ContributionDefinition[]>(Object.freeze([]));
  const items = createSource<readonly ContributionEntry<unknown>[]>(Object.freeze([]));
  const compare = (a: ContributionDefinition, b: ContributionDefinition) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const publish = <Value>(source: { set(value: readonly Value[]): void }, values: readonly Value[]) => {
    // A reader cannot fail startup, cancellation or publication to other readers.
    try { source.set(Object.freeze([...values])); } catch { /* createSource delivered to every subscriber. */ }
  };
  return {
    registry: Object.freeze({
      contract: contract as ContributionContract<unknown>,
      definitions: definitions.source,
      items: items.source,
    }),
    definitions(values: readonly ContributionDefinition[]): void {
      const next = [...values].sort(compare);
      const previous = definitions.source.read();
      if (previous.length === next.length && previous.every((entry, index) => {
        const other = next[index];
        return other && entry.id === other.id && entry.definitionId === other.definitionId
          && entry.export === other.export && entry.order === other.order;
      })) return;
      publish(definitions, next);
    },
    items(values: readonly ContributionEntry<unknown>[]): void {
      const next = [...values].sort(compare);
      const previous = items.source.read();
      if (previous.length === next.length && previous.every((entry, index) => entry === next[index])) return;
      publish(items, next);
    },
  };
}
