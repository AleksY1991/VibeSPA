import type {
  ModuleSnapshot, ModuleState, Readable, SystemEvent, SystemSnapshot, SystemState,
} from '@vibespa/contracts';
import { startModule } from './module.js';
import type { FeatureModule, FeatureType } from './module.js';
import { createSource } from './readable.js';
import { createScope } from './scope.js';

/** A public capability and its identity in one owning system. */
export interface ModuleHandle<Exports extends object> {
  readonly id: string;
  readonly exports: Exports;
}

export interface SystemStartOptions {
  readonly id?: string;
  /** Declared wiring for inspection, supplied alongside the actual typed inputs. */
  readonly dependencies?: readonly ModuleHandle<object>[];
}

export interface SystemOptions {
  readonly id: string;
  readonly eventLimit?: number;
}

export interface System {
  readonly snapshot: Readable<SystemSnapshot>;
  start<Kind extends FeatureType, Inputs extends object, Exports extends object>(
    definition: FeatureModule<Kind, Inputs, Exports>,
    inputs: Inputs,
    options?: SystemStartOptions,
  ): Promise<ModuleHandle<Exports>>;
  /** Records operation boundaries without recording arguments or returned values. */
  trace<Result>(handle: ModuleHandle<object>, name: string, run: () => Result | PromiseLike<Result>): Promise<Result>;
  clearEvents(): void;
  dispose(): Promise<void>;
}

interface Instance {
  readonly metadata: Omit<ModuleSnapshot, 'state' | 'error'>;
  state: ModuleState;
  error?: string;
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
 * Dependency edges describe declared wiring; they do not inspect or sandbox inputs.
 */
export function createSystem(options: SystemOptions): System {
  const systemId = options.id;
  if (systemId.trim().length === 0) throw new Error('System id must not be empty');
  const eventLimit = options.eventLimit ?? 200;
  if (!Number.isSafeInteger(eventLimit) || eventLimit < 0) {
    throw new Error('System event limit must be a non-negative safe integer');
  }

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

  const system: System = Object.freeze({
    snapshot: source.source,

    async start<Kind extends FeatureType, Inputs extends object, Exports extends object>(
      definition: FeatureModule<Kind, Inputs, Exports>,
      inputs: Inputs,
      startOptions: SystemStartOptions = {},
    ): Promise<ModuleHandle<Exports>> {
      requireRunning();
      const id = startOptions.id ?? definition.id;
      if (id.trim().length === 0) throw new Error('Module instance id must not be empty');
      if (instances.has(id)) throw new Error(`Duplicate module instance: ${id}`);
      const dependencies = (startOptions.dependencies ?? []).map(handle => {
        requireReady(handle);
        return handle.id;
      });
      if (new Set(dependencies).size !== dependencies.length) {
        throw new Error(`Duplicate dependency for module ${id}`);
      }

      const ports = (items: Readonly<Record<string, string>>) => Object.freeze(
        Object.entries(items).map(([name, description]) => Object.freeze({ name, description })),
      );
      const instance: Instance = {
        metadata: Object.freeze({
          id,
          definitionId: definition.id,
          kind: definition.kind,
          title: definition.title,
          description: definition.description,
          contract: Object.freeze({
            inputs: ports(definition.contract.inputs),
            exports: ports(definition.contract.exports),
          }),
          dependencies: Object.freeze(dependencies),
        }),
        state: 'loading',
      };
      instances.set(id, instance);

      const exports = await startModule(definition, inputs, owner, (next, error) => {
        instance.state = next;
        if (error !== undefined) instance.error = errorMessage(error);
        record({ type: next, moduleId: id, ...(error === undefined ? {} : { error: instance.error }) });
      });
      // Disposal may run between the startup promise and this continuation.
      owner.signal.throwIfAborted();
      const handle = Object.freeze({ id, exports });
      handles.set(handle, instance);
      return handle;
    },

    async trace<Result>(
      handle: ModuleHandle<object>, name: string, run: () => Result | PromiseLike<Result>,
    ): Promise<Result> {
      requireRunning();
      requireReady(handle);
      if (name.trim().length === 0) throw new Error('Operation name must not be empty');
      record({ type: 'operation-started', moduleId: handle.id, operation: name });
      try {
        // An observer can explicitly dispose the system while receiving start.
        requireRunning();
        requireReady(handle);
        const result = await run();
        record({ type: 'operation-completed', moduleId: handle.id, operation: name });
        return result;
      } catch (error: unknown) {
        record({ type: 'operation-failed', moduleId: handle.id, operation: name, error: errorMessage(error) });
        throw error;
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
