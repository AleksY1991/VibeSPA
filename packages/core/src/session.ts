import type { Equality, Readable, Scope } from '@vibespa/contracts';
import { createSource } from './readable.js';
import { createScope } from './scope.js';

export type SessionState<Identity, Value> =
  | { readonly phase: 'idle'; readonly identity: null; readonly value: null; readonly error: null }
  | { readonly phase: 'opening'; readonly identity: Identity; readonly value: null; readonly error: null }
  | { readonly phase: 'ready'; readonly identity: Identity; readonly value: Value; readonly error: null }
  | { readonly phase: 'error'; readonly identity: Identity | null; readonly value: null; readonly error: unknown };

export interface SessionHost<Identity, Value> {
  readonly state: Readable<SessionState<Identity, Value>>;
  /** Includes replacements requested while an earlier transition is settling. */
  whenSettled(): Promise<void>;
  /** Releases resources; cleanup and state-observer errors aggregate here. */
  dispose(): Promise<void>;
}

export interface SessionHostOptions<Identity, Value> {
  readonly identity: Readable<Identity | null>;
  /** Register teardown as each resource is acquired; check signal after awaits. */
  readonly open: (identity: Identity, scope: Scope) => Value | Promise<Value>;
  readonly scope: Scope;
  readonly equals?: Equality<Identity>;
}

interface OwnedSession {
  readonly abort: AbortController;
  readonly scope: Scope;
}

/**
 * Serial account/session ownership, independent of the database or UI framework.
 * Cancellation is immediate; resource disposal waits for an opening factory to
 * settle, so even a late acquisition is released before its replacement opens.
 */
export function createSessionHost<Identity, Value>(
  options: SessionHostOptions<Identity, Value>,
): SessionHost<Identity, Value> {
  const state = createSource<SessionState<Identity, Value>>(
    Object.freeze({ phase: 'idle', identity: null, value: null, error: null }),
  );
  const equals = options.equals ?? Object.is;
  let requestedIdentity: Identity | null = null;
  let active: OwnedSession | null = null;
  let generation = 0;
  let transitions: Promise<void> = Promise.resolve();
  let unsubscribe: (() => void) | undefined;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const disposalErrors: unknown[] = [];
  let notificationFailure: { readonly error: unknown } | undefined;

  const publish = (next: SessionState<Identity, Value>): void => {
    try {
      state.set(Object.freeze(next));
    } catch (error: unknown) {
      // Source already delivered all observers. Keep their first failure for
      // disposal to report, without misclassifying it as an acquisition error
      // or allowing an observer to poison the serialized transition queue.
      notificationFailure ??= { error };
    }
  };

  const retireActive = async (): Promise<void> => {
    const outgoing = active;
    if (!outgoing) return;
    outgoing.abort.abort();
    // A failed close remains owned and blocks replacement. Retrying the same
    // disposal promise cannot accidentally reopen a database or realtime topic.
    await outgoing.scope.dispose();
    if (active === outgoing) active = null;
  };

  const runTransition = async (version: number, identity: Identity | null): Promise<void> => {
    if (version !== generation) return;
    await retireActive();
    if (version !== generation || disposed || identity === null) return;

    const abort = new AbortController();
    const incoming: OwnedSession = { abort, scope: createScope(abort.signal) };
    active = incoming;
    let value: Value;
    try {
      value = await options.open(identity, incoming.scope);
    } catch (error: unknown) {
      // A superseding transition owns cleanup of this canceled acquisition.
      if (version !== generation || abort.signal.aborted) return;
      let failure = error;
      try {
        await retireActive();
      } catch (cleanupError: unknown) {
        failure = new AggregateError([error, cleanupError], 'Session opening and cleanup failed');
      }
      if (version === generation && !disposed) {
        publish({ phase: 'error', identity, value: null, error: failure });
      }
      return;
    }

    if (version !== generation || abort.signal.aborted || disposed) return;
    publish({ phase: 'ready', identity, value, error: null });
  };

  const request = (identity: Identity | null): void => {
    if (disposed) return;
    const same = requestedIdentity === null
      ? identity === null
      : identity !== null && equals(requestedIdentity, identity);
    if (same && state.source.read().phase !== 'error') return;
    requestedIdentity = identity;
    generation += 1;
    const version = generation;

    // Queue before aborting/notifying: either listener may request again.
    const run = (): Promise<void> => runTransition(version, identity);
    transitions = transitions.then(run, run).catch((error: unknown) => {
      if (disposed) {
        disposalErrors.push(error);
      } else if (version === generation) {
        publish({ phase: 'error', identity, value: null, error });
      }
    });
    active?.abort.abort();
    if (version === generation) {
      publish(identity === null
        ? { phase: 'idle', identity: null, value: null, error: null }
        : { phase: 'opening', identity, value: null, error: null });
    }
  };

  const whenSettled = async (): Promise<void> => {
    while (true) {
      const observed = transitions;
      await observed;
      if (observed === transitions) return;
    }
  };

  const cancel = (): void => {
    if (disposed) return;
    disposed = true;
    const stop = unsubscribe;
    unsubscribe = undefined;
    options.scope.signal.removeEventListener('abort', onOwnerAbort);
    generation += 1;
    requestedIdentity = null;
    try { stop?.(); }
    catch (error: unknown) { disposalErrors.push(error); }
    active?.abort.abort();
    publish({ phase: 'idle', identity: null, value: null, error: null });
  };

  const onOwnerAbort = (): void => {
    // Cancellation is immediate; the parent's deferred cleanup owns teardown
    // order and awaits dispose after its later-acquired dependents are closed.
    try { cancel(); }
    catch (error: unknown) { disposalErrors.push(error); }
  };

  function dispose(): Promise<void> {
    if (disposal) return disposal;
    let resolveDisposal!: () => void;
    let rejectDisposal!: (error: unknown) => void;
    // Assign before canceling: an abort listener may reenter dispose().
    disposal = new Promise<void>((resolve, reject) => {
      resolveDisposal = resolve;
      rejectDisposal = reject;
    });
    try { cancel(); }
    catch (error: unknown) { disposalErrors.push(error); }
    transitions = transitions.then(retireActive, retireActive).catch((error: unknown) => {
      disposalErrors.push(error);
    });
    const drain = async (): Promise<void> => {
      try {
        await whenSettled();
        const errors = notificationFailure
          ? [...disposalErrors, notificationFailure.error]
          : disposalErrors;
        if (errors.length > 0) {
          throw new AggregateError(errors, 'Session disposal failed');
        }
      } finally {
        unregisterOwner();
      }
    };
    void drain().then(resolveDisposal, rejectDisposal);
    return disposal;
  }

  const unregisterOwner = options.scope.defer(dispose);
  options.scope.signal.addEventListener('abort', onOwnerAbort, { once: true });
  if (options.scope.signal.aborted) {
    onOwnerAbort();
  } else {
    try {
      // The first read happens only after observation is installed.
      const stop = options.identity.subscribe(() => request(options.identity.read()));
      if (disposed) {
        // A source may synchronously trigger owner cancellation while its
        // subscription is being installed, before we possess its cleanup.
        stop();
      } else {
        unsubscribe = stop;
        request(options.identity.read());
      }
    } catch (error: unknown) {
      void dispose().catch(() => {});
      throw error;
    }
  }

  return Object.freeze({ state: state.source, whenSettled, dispose });
}
