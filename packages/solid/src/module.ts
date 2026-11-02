import { createEffect, createRoot, getOwner, onCleanup, runWithOwner } from 'solid-js';
import type { Accessor, Owner } from 'solid-js';
import type { Equality, Readable, Scope } from '@vibespa/contracts';
import { createSystem } from '@vibespa/core/system';
import type { ModuleRuntime } from '@vibespa/core/module';
import type { System, SystemOptions } from '@vibespa/core/system';
import { consumeReadable } from './readable.js';

interface OwnedRuntime {
  active: boolean;
  readonly owner: Owner;
  readonly errors: unknown[];
  readonly pendingCleanup: Set<Promise<void>>;
  readonly runtime: ModuleRuntime;
}

const owners = new WeakMap<Scope, OwnedRuntime>();

function requireOwner(scope: Scope): OwnedRuntime {
  const state = owners.get(scope);
  if (!state) throw new Error('This module was not started by a Solid module runtime.');
  scope.signal.throwIfAborted();
  if (!state.active) throw new Error('The module is stopping; reactive work is closed.');
  return state;
}

/** Never let a user cleanup exception interrupt Solid's disposal traversal. */
function protectCleanup(state: OwnedRuntime, cleanup: () => unknown): () => void {
  return () => {
    try {
      const result = cleanup();
      if (result !== null && (typeof result === 'object' || typeof result === 'function')
        && typeof Reflect.get(result, 'then') === 'function') {
        state.errors.push(new Error('Reactive cleanup must be synchronous; use scope.defer for asynchronous resources.'));
        const settled = Promise.resolve(result).then(() => {}, (error: unknown) => { state.errors.push(error); });
        state.pendingCleanup.add(settled);
        void settled.then(() => { state.pendingCleanup.delete(settled); });
      }
    } catch (error: unknown) {
      state.errors.push(error);
    }
  };
}

/** A private detached owner for one module; asynchronous resources stay in Scope. */
export function createSolidModuleRuntime(scope: Scope, onIncomplete?: (error: unknown) => void): ModuleRuntime {
  if (owners.has(scope)) throw new Error('A module scope already has a Solid owner.');
  scope.signal.throwIfAborted();
  let release!: () => void;
  const owner = runWithOwner(null, () => createRoot(dispose => {
    release = dispose;
    return getOwner();
  }));
  if (!owner) throw new Error('Unable to create a Solid module owner.');
  let closing: Promise<readonly unknown[]> | undefined;
  const state: OwnedRuntime = {
    active: true,
    owner,
    errors: [],
    pendingCleanup: new Set(),
    runtime: {
      run<Result>(operation: () => Result): Result {
        requireOwner(scope);
        return runWithOwner(owner, operation);
      },
      quiesce(): void { state.active = false; },
      dispose(): Promise<readonly unknown[]> {
        if (closing) return closing;
        state.active = false;
        let resolve!: (errors: readonly unknown[]) => void;
        let reject!: (error: unknown) => void;
        closing = new Promise<readonly unknown[]>((accept, fail) => { resolve = accept; reject = fail; });
        let incomplete = false;
        let traversalError: unknown;
        try { release(); }
        catch (error: unknown) {
          incomplete = true;
          traversalError = error;
          // Publish the barrier before yielding: a cleanup may have reentered
          // another module's disposal before interrupting this traversal.
          try { onIncomplete?.(error); } catch (observerError: unknown) { state.errors.push(observerError); }
        }
        const finish = async (): Promise<readonly unknown[]> => {
          while (state.pendingCleanup.size > 0) await Promise.all([...state.pendingCleanup]);
          if (incomplete) {
            throw new AggregateError([traversalError, ...state.errors],
              'Solid module cleanup was incomplete; resources must remain open.');
          }
          return Object.freeze([...state.errors]);
        };
        void finish().then(resolve, reject);
        return closing;
      },
    },
  };
  owners.set(scope, state);
  return state.runtime;
}

/** Register synchronous reactive cleanup under this module, including after await. */
export function onModuleCleanup(scope: Scope, cleanup: () => unknown): void {
  const state = requireOwner(scope);
  state.runtime.run(() => { onCleanup(protectCleanup(state, cleanup)); });
}

/** Expose a neutral Readable as a tracked Solid accessor owned by this module.
 * It enters the module's owner itself, so it is safe after an await or inside a
 * detached callback. The subscription is released when the module is disposed.
 */
export function moduleAccessor<T>(scope: Scope, source: Readable<T>, options?: {
  readonly name?: string;
  readonly equals?: Equality<T>;
}): Accessor<T> {
  const state = requireOwner(scope);
  return state.runtime.run(() => consumeReadable(source, options));
}

/** Managed effects stop executing at cancellation and release before resources. */
export function createModuleEffect<Value>(
  scope: Scope,
  compute: () => Value,
  apply: (value: Value) => void | (() => unknown),
): void {
  const state = requireOwner(scope);
  const stopped = Symbol('stopped module effect');
  state.runtime.run(() => {
    createEffect<Value | typeof stopped>(
      () => state.active ? compute() : stopped,
      value => {
        if (!state.active || value === stopped) return;
        const cleanup = apply(value);
        return typeof cleanup === 'function' ? protectCleanup(state, cleanup) : undefined;
      },
    );
  });
}

/** The sample's module constructor: one private owner per instance, with awaited
 * resource teardown. An incomplete Solid unwind conservatively retains all
 * remaining module resources; successful close is required before replacement.
 */
export function createSolidSystem(options: Omit<SystemOptions, 'createRuntime'>): System {
  let blocked = false;
  let failure: unknown;
  const assertSafeToRelease = (): void => {
    if (blocked) throw new Error('Module resources retained after incomplete Solid cleanup.', { cause: failure });
  };
  return createSystem({
    ...options,
    createRuntime(scope) {
      if (blocked) throw new Error('The Solid system has incomplete cleanup; reload before starting modules.', { cause: failure });
      const runtime = createSolidModuleRuntime(scope, error => { blocked = true; failure = error; });
      return {
        ...runtime,
        assertSafeToRelease,
        async dispose() {
          assertSafeToRelease();
          try {
            const errors = await runtime.dispose();
            assertSafeToRelease();
            return errors;
          }
          catch (error: unknown) {
            blocked = true;
            failure = error;
            throw error;
          }
        },
      };
    },
  });
}
