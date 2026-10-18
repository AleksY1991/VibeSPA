import { FeatureType } from '@vibespa/contracts';
import type { ModuleState, Scope } from '@vibespa/contracts';
import { createScope } from './scope.js';

export { FeatureType } from '@vibespa/contracts';

/** Dependencies are ordinary typed inputs, supplied by the composition root. */
export type ModuleFactory<Inputs, Exports> = (
  inputs: Inputs,
  scope: Scope,
) => Exports | Promise<Exports>;

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
export interface FeatureModule<
  X extends FeatureType,
  Inputs extends object = object,
  Exports extends object = object,
> extends ModuleDefinition<Inputs, Exports> {
  readonly kind: X;
  readonly title: string;
  readonly description: string;
  readonly contract: FeatureModuleContract<Inputs, Exports>;
}

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
  return Object.freeze({
    id: definition.id,
    kind: definition.kind,
    title: definition.title,
    description: definition.description,
    contract,
    load: definition.load,
  });
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
): Promise<Exports> {
  const scope = createScope(parent.signal);
  let releaseOwnership: (() => void) | undefined;
  let cleanupStarted = false;
  let terminal = false;
  let cleanup: Promise<void> | undefined;
  const notify = (state: ModuleState, error?: unknown): void => {
    if (state === 'disposed' || state === 'cancelled' || state === 'failed') {
      terminal = true;
      scope.signal.removeEventListener('abort', onAbort);
    }
    try { observer?.(state, error); } catch { /* Observation cannot alter ownership. */ }
  };
  const onAbort = (): void => {
    if (!cleanupStarted && !terminal) notify('cancelling');
  };
  scope.signal.addEventListener('abort', onAbort, { once: true });

  const disposeOwned = (rollback: boolean): Promise<void> => {
    if (cleanup) return cleanup;
    cleanupStarted = true;
    if (!rollback) notify('disposing');
    cleanup = scope.dispose().then(() => {
      if (!rollback) notify('disposed');
    }, (error: unknown) => {
      if (!rollback) notify('failed', error);
      throw error;
    });
    return cleanup;
  };
  let finishStartup!: () => void;
  const startupSettled = new Promise<void>(resolve => { finishStartup = resolve; });
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
      notify('starting');
      scope.signal.throwIfAborted();
      const exports = await factory(inputs, scope);
      scope.signal.throwIfAborted();
      notify('ready');
      scope.signal.throwIfAborted();
      return exports;
    } finally {
      finishStartup();
    }
  } catch (error: unknown) {
    releaseOwnership?.();
    const cancelled = scope.signal.aborted;
    notify('rolling-back', error);
    try { await disposeOwned(true); }
    catch (cleanupError: unknown) {
      const failure = new AggregateError([error, cleanupError], `Module ${definition.id} startup and rollback failed`, { cause: cleanupError });
      notify('failed', failure);
      throw failure;
    }
    notify(cancelled ? 'cancelled' : 'failed', error);
    throw error;
  }
}
