/**
 * Ownership of the RxDB session that belongs to the current Auth login.
 * When that login changes, stop the outgoing session, then open
 * the incoming one — never interleaved, because a second `createRxDatabase`
 * with the same name throws (RxDB DB8) and a Realtime topic still joined by
 * the outgoing session would be reused by the incoming one.
 *
 * The scope source and the session factory are structural adapters so the
 * controller stays framework-neutral and testable.
 */

export interface RxDbSyncScope {
  readonly accountId: string;
  /** Opaque Auth session generation; token refresh keeps this identity stable. */
  readonly sessionKey?: string;
  /** Optional application metadata; it does not participate in session identity. */
  readonly workspaceId?: string;
}

export type RxDbSyncScopeValue =
  | {
      readonly accountId: string | null | undefined;
      readonly sessionKey?: string;
      readonly workspaceId?: string | null | undefined;
    }
  | null
  | undefined;

export interface RxDbSyncScopeSource {
  /** Read the account and Auth session identity in one snapshot. */
  read(): RxDbSyncScopeValue;
  /** Notify after either identity field may have changed. */
  subscribe(listener: () => void): () => void;
}

export interface RxDbSyncSession<TDatabase> {
  readonly database: TDatabase;
  /**
   * Stops replication and closes the database. It must not remove its durable
   * storage: logout and account switching are lifecycle events, not deletes.
   */
  stop(): void | Promise<void>;
}

export interface OpenRxDbSyncSessionContext {
  /** Aborted when the scope moves on while the session is still opening. */
  readonly signal: AbortSignal;
}

export type OpenRxDbSyncSession<TDatabase> = (
  scope: RxDbSyncScope,
  context: OpenRxDbSyncSessionContext,
) => Promise<RxDbSyncSession<TDatabase>>;

export type RxDbSyncPhase = 'idle' | 'opening' | 'ready' | 'error';

export interface RxDbSyncSnapshot<TDatabase> {
  readonly phase: RxDbSyncPhase;
  readonly scope: RxDbSyncScope | null;
  readonly database: TDatabase | null;
  readonly error: unknown | null;
}

export interface RxDbSyncController<TDatabase> {
  /** Subscribe first and then seed from the current scope. Idempotent. */
  initialize(): void;
  /** Stop watching and close the live session without deleting its database. */
  dispose(): Promise<void>;
  subscribe(listener: (snapshot: RxDbSyncSnapshot<TDatabase>) => void): () => void;
  getSnapshot(): RxDbSyncSnapshot<TDatabase>;
  /** Wait until all transitions requested so far (including superseding ones) settle. */
  whenSettled(): Promise<void>;
}

export interface CreateRxDbSyncControllerOptions<TDatabase> {
  readonly scopeSource: RxDbSyncScopeSource;
  readonly openSession: OpenRxDbSyncSession<TDatabase>;
  /** Map a normalized account/login identity to application session metadata. */
  readonly mapScope?: (scope: RxDbSyncScope) => RxDbSyncScope;
}

interface OwnedSession<TDatabase> {
  readonly generation: number;
  readonly session: RxDbSyncSession<TDatabase>;
}

const INITIAL_SNAPSHOT: RxDbSyncSnapshot<unknown> = {
  phase: 'idle',
  scope: null,
  database: null,
  error: null,
};

function normalizeScope(value: RxDbSyncScopeValue): RxDbSyncScope | null {
  if (
    !value
    || typeof value.accountId !== 'string'
    || value.accountId.length === 0
  ) {
    return null;
  }

  return Object.freeze({
    accountId: value.accountId,
    ...(value.sessionKey === undefined ? {} : { sessionKey: value.sessionKey }),
  });
}

function sameScope(left: RxDbSyncScope | null, right: RxDbSyncScope | null): boolean {
  return left === null
    ? right === null
    : right !== null
      && left.accountId === right.accountId
      && left.sessionKey === right.sessionKey;
}

export function createRxDbSyncController<TDatabase>(
  options: CreateRxDbSyncControllerOptions<TDatabase>,
): RxDbSyncController<TDatabase> {
  let snapshot = INITIAL_SNAPSHOT as RxDbSyncSnapshot<TDatabase>;
  let requestedScope: RxDbSyncScope | null = null;
  let ownedSession: OwnedSession<TDatabase> | null = null;
  let generation = 0;
  let transitionAbort: AbortController | null = null;
  let transitionChain: Promise<void> = Promise.resolve();
  let unsubscribeScope: (() => void) | null = null;
  let initialized = false;

  const listeners = new Set<(next: RxDbSyncSnapshot<TDatabase>) => void>();

  const publish = (next: RxDbSyncSnapshot<TDatabase>): void => {
    snapshot = Object.freeze(next);
    for (const listener of [...listeners]) listener(snapshot);
  };

  const runTransition = async (
    transitionGeneration: number,
    scope: RxDbSyncScope | null,
    abortController: AbortController,
  ): Promise<void> => {
    if (transitionGeneration !== generation) return;

    // Stop is awaited before open. Keeping the handle until stop succeeds lets
    // a later transition attempt the close again instead of orphaning it.
    if (ownedSession) {
      const outgoing = ownedSession;
      try {
        await outgoing.session.stop();
      } catch (error) {
        if (transitionGeneration === generation) {
          publish({ phase: 'error', scope, database: null, error });
        }
        return;
      }
      if (ownedSession === outgoing) ownedSession = null;
    }

    if (transitionGeneration !== generation || abortController.signal.aborted || !scope) return;

    let incoming: RxDbSyncSession<TDatabase>;
    try {
      incoming = await options.openSession(scope, { signal: abortController.signal });
    } catch (error) {
      // An aborted/stale open belongs to a scope the app no longer exposes.
      if (transitionGeneration !== generation || abortController.signal.aborted) return;
      publish({ phase: 'error', scope, database: null, error });
      return;
    }

    ownedSession = { generation: transitionGeneration, session: incoming };
    if (transitionGeneration !== generation || abortController.signal.aborted) {
      await incoming.stop();
      if (ownedSession?.session === incoming) ownedSession = null;
      return;
    }
    publish({ phase: 'ready', scope, database: incoming.database, error: null });
  };

  const requestTransition = (scope: RxDbSyncScope | null, force = false): void => {
    // A failed open may be retried by an ordinary same-scope notification.
    // Opening/ready notifications for the same Auth login are noise.
    if (!force && sameScope(requestedScope, scope) && snapshot.phase !== 'error') return;

    requestedScope = scope;
    generation += 1;
    const transitionGeneration = generation;

    transitionAbort?.abort();
    const abortController = new AbortController();
    transitionAbort = abortController;

    // Invalidate synchronously. Consumers can never read the outgoing database
    // under the incoming account identity while async cleanup runs.
    publish({
      phase: scope ? 'opening' : 'idle',
      scope,
      database: null,
      error: null,
    });

    transitionChain = transitionChain
      .then(() => runTransition(transitionGeneration, scope, abortController))
      .catch((error) => {
        // runTransition handles expected factory/stop failures. This final
        // boundary keeps an unforeseen rejection from poisoning every later
        // transition or escaping into application boot.
        if (transitionGeneration === generation) {
          publish({ phase: 'error', scope, database: null, error });
        }
      });
  };

  const reconcileFromSource = (force = false): void => {
    const normalized = normalizeScope(options.scopeSource.read());
    const scope = normalized && options.mapScope
      ? Object.freeze({ ...options.mapScope(normalized) })
      : normalized;
    requestTransition(scope, force);
  };

  const controller: RxDbSyncController<TDatabase> = {
    initialize(): void {
      if (initialized) return;
      initialized = true;
      // Subscribe before seeding so a scope change cannot fall into the gap
      // between the initial read and listener registration.
      unsubscribeScope = options.scopeSource.subscribe(() => reconcileFromSource());
      reconcileFromSource();
    },

    async dispose(): Promise<void> {
      initialized = false;
      unsubscribeScope?.();
      unsubscribeScope = null;
      requestTransition(null, true);
      await controller.whenSettled();
    },

    subscribe(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSnapshot(): RxDbSyncSnapshot<TDatabase> {
      return snapshot;
    },

    async whenSettled(): Promise<void> {
      // A transition may enqueue its successor while the observed link is
      // settling. Loop until the tail itself remains stable.
      while (true) {
        const observedTail = transitionChain;
        await observedTail;
        if (observedTail === transitionChain) return;
      }
    },
  };

  return controller;
}
