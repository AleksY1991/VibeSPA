import type { SupabaseClient } from '@supabase/supabase-js';
import type { Readable, Scope } from '@vibespa/contracts';
import type { LocalStore } from '@vibespa/local-first';
import { getCollection } from '@vibespa/local-first/adapter';
import { replicateSupabase } from 'rxdb/plugins/replication-supabase';
import type { RxSupabaseReplicationState } from 'rxdb/plugins/replication-supabase';
import type { WithDeleted } from 'rxdb';

type CollectionKey<Rows> = Extract<keyof Rows, string>;

export type SupabaseTable<Rows> = {
  [K in CollectionKey<Rows>]: {
    readonly collection: K;
    readonly tableName: string;
    readonly modifiedField?: string;
    /** Encode cloned HTTP request rows only, for example Postgres array literals. */
    readonly encodeRequest?: (document: Readonly<WithDeleted<Rows[K]>>) => Readonly<Record<string, unknown>>;
  };
}[CollectionKey<Rows>];

export interface SupabaseSyncOptions<Rows extends { [K in keyof Rows]: object }> {
  readonly store: LocalStore<Rows>;
  readonly scope: Scope;
  /** Use an account scope and an authenticated client whose RLS grants this account access. */
  readonly accountId: string;
  readonly client: SupabaseClient;
  readonly tables: readonly SupabaseTable<Rows>[];
  /** Stable backend identity when one local store may connect to different backends. */
  readonly namespace?: string;
  readonly batchSize?: number;
  readonly retryTime?: number;
}

export interface SupabaseSyncError {
  readonly collection: string;
  readonly tableName: string;
  readonly error: unknown;
}

export interface SupabaseSyncStatus {
  /** Running describes the replication lifecycle, not network connectivity. */
  readonly phase: 'starting' | 'running' | 'stopped';
  readonly active: boolean;
  readonly initialSyncComplete: boolean;
  /** Latest reported error per table; retained because other traffic does not prove recovery. */
  readonly errors: readonly SupabaseSyncError[];
}

export interface SupabaseSync {
  readonly status: Readable<SupabaseSyncStatus>;
  /** Retries can keep this pending while offline; cancellation rejects with AbortError. */
  awaitInitialSync(): Promise<void>;
  cancel(): Promise<void>;
}

/** Automatic stock RxDB replication. All application writes still enter through LocalStore. */
export async function syncSupabase<Rows extends { [K in keyof Rows]: object }>(
  options: SupabaseSyncOptions<Rows>,
): Promise<SupabaseSync> {
  const { scope } = options;
  if (scope.signal.aborted) throw abortError();
  if (!options.accountId.trim()) throw new Error('Supabase replication requires an accountId.');
  if (options.namespace !== undefined && !options.namespace.trim()) throw new Error('Supabase namespace must not be empty.');
  if (options.batchSize !== undefined && (!Number.isInteger(options.batchSize) || options.batchSize < 1)) {
    throw new Error('Supabase batchSize must be a positive integer.');
  }
  if (options.retryTime !== undefined && (!Number.isFinite(options.retryTime) || options.retryTime < 0)) {
    throw new Error('Supabase retryTime must be a nonnegative finite number.');
  }
  const names = new Set<string>();
  const tables = new Set<string>();
  const configured = options.tables.map(table => {
    if (!table.tableName.trim()) throw new Error('Supabase tableName must not be empty.');
    if (names.has(table.collection)) throw new Error(`Supabase collection is configured twice: ${table.collection}.`);
    if (tables.has(table.tableName)) throw new Error(`Supabase table is configured twice: ${table.tableName}.`);
    names.add(table.collection);
    tables.add(table.tableName);
    return { table, collection: getCollection(options.store, table.collection) };
  });

  let status: SupabaseSyncStatus = { phase: 'starting', active: false, initialSyncComplete: false, errors: [] };
  const listeners = new Set<(value: SupabaseSyncStatus) => void>();
  const active = new Set<string>();
  const errors = new Map<string, SupabaseSyncError>();
  const states: RxSupabaseReplicationState<Rows[CollectionKey<Rows>]>[] = [];
  const subscriptions: { unsubscribe(): void }[] = [];
  let stopped = false;
  let cancellation: Promise<void> | undefined;
  let rejectCanceled!: (reason: unknown) => void;
  const canceled = new Promise<never>((_, reject) => { rejectCanceled = reject; });
  // Callers need not observe readiness to use automatic background sync.
  void canceled.catch(() => undefined);

  function publish(patch: Partial<SupabaseSyncStatus>): void {
    status = { ...status, ...patch };
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try { listener(status); }
      catch (error) { console.error('Supabase status subscriber failed.', error); }
    }
  }
  function recordError(collection: string, tableName: string, error: unknown): void {
    if (stopped) return;
    errors.set(collection, { collection, tableName, error });
    publish({ errors: [...errors.values()] });
  }
  function cancel(): Promise<void> {
    if (cancellation) return cancellation;
    stopped = true;
    cancellation = Promise.allSettled(states.map(state => Promise.resolve().then(() => state.cancel()))).then(results => {
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length > 0) throw new AggregateError(failures, 'Supabase replication cancellation failed.');
    });
    // Retain the scope cleanup until asynchronous cancellation has finished, so
    // dispose still waits when an explicit cancel overlaps account replacement.
    void cancellation.then(() => unregister(), () => undefined);
    scope.signal.removeEventListener('abort', onAbort);
    rejectCanceled(abortError());
    for (const subscription of subscriptions) subscription.unsubscribe();
    publish({ phase: 'stopped', active: false });
    listeners.clear();
    return cancellation;
  }
  function onAbort(): void {
    // Scope.dispose awaits this same promise through its registered cleanup.
    void cancel().catch(() => undefined);
  }

  const unregister = scope.defer(cancel);
  scope.signal.addEventListener('abort', onAbort, { once: true });

  const starts: Promise<void>[] = [];
  try {
    const auth = options.client.auth.onAuthStateChange((_event, session) => {
      if (!session || session.user.id !== options.accountId) onAbort();
    });
    subscriptions.push(auth.data.subscription);
    if (stopped) auth.data.subscription.unsubscribe();
    const sessionResult = await Promise.race([options.client.auth.getSession(), canceled]);
    if (sessionResult.error) throw sessionResult.error;
    const session = sessionResult.data.session;
    if (!session) throw new Error('Supabase replication requires an authenticated session.');
    if (session.user.id !== options.accountId) throw new Error('Supabase session does not match replication accountId.');
    if (stopped) throw abortError();
    for (const { table, collection } of configured) {
      const state = replicateSupabase<Rows[CollectionKey<Rows>]>({
        collection,
        client: options.client,
        tableName: table.tableName,
        replicationIdentifier: `vibespa:${[
          options.namespace ?? 'default', options.accountId, table.collection, table.tableName,
        ].map(encodeURIComponent).join(':')}`,
        modifiedField: table.modifiedField ?? '_modified',
        deletedField: '_deleted',
        live: true,
        autoStart: false,
        waitForLeadership: false,
        retryTime: options.retryTime ?? 5_000,
        pull: { batchSize: options.batchSize ?? 100 },
        push: { batchSize: options.batchSize ?? 100 },
      });
      states.push(state);
      if (table.encodeRequest && state.push) {
        const encodeRequest = table.encodeRequest;
        const stockPush = state.push.handler;
        const encode = (document: WithDeleted<Rows[CollectionKey<Rows>]>): WithDeleted<Rows[CollectionKey<Rows>]> => {
          const encoded = encodeRequest(structuredClone(document));
          // This cast is deliberately confined to the stock HTTP/CAS seam. RxDB's
          // stored rows, modifiers, and returned conflict rows retain their types.
          return { ...encoded, _deleted: document._deleted } as WithDeleted<Rows[CollectionKey<Rows>]>;
        };
        state.push.handler = rows => stockPush(rows.map(row => ({
          ...row,
          newDocumentState: encode(row.newDocumentState),
          assumedMasterState: row.assumedMasterState ? encode(row.assumedMasterState) : undefined,
        })));
      }
      subscriptions.push(state.active$.subscribe((value: boolean) => {
        if (stopped) return;
        if (value) active.add(table.collection);
        else active.delete(table.collection);
        publish({ active: active.size > 0 });
      }));
      subscriptions.push(state.error$.subscribe((error: unknown) => recordError(table.collection, table.tableName, error)));
      const leadership = collection.database.multiInstance ? collection.database.waitForLeadership() : Promise.resolve();
      starts.push(leadership.then(async () => {
        if (stopped) return;
        await state.start();
      }).catch((error: unknown) => {
        recordError(table.collection, table.tableName, error);
        throw error;
      }));
    }
  } catch (error) {
    try { await cancel(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Supabase replication setup and cleanup failed.', { cause: cleanupError }); }
    throw error;
  }

  const started = Promise.all(starts).then(() => {
    if (!stopped) publish({ phase: 'running' });
  });
  const initial = Promise.race([
    started.then(() => Promise.all(states.map(state => state.awaitInitialReplication()))).then(() => {
      if (!stopped) publish({ initialSyncComplete: true });
    }),
    canceled,
  ]).then(() => undefined);
  void initial.catch(() => undefined);

  return {
    status: {
      read: () => status,
      subscribe(listener) {
        if (stopped) return () => undefined;
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
    awaitInitialSync: () => initial,
    cancel,
  };
}

function abortError(): DOMException {
  return new DOMException('Supabase replication scope has ended.', 'AbortError');
}
