import type { SupabaseClient } from '@supabase/supabase-js';
import type { Scope } from '@vibespa/contracts';
import { replicateSupabase } from 'rxdb/plugins/replication-supabase';
import type { RxSupabaseReplicationState } from 'rxdb/plugins/replication-supabase';
import type { RxCollection, WithDeleted } from 'rxdb';
import type {
  CollectionKey, SupabaseAuthentication, SupabaseConflict, SupabaseSync, SupabaseSyncError, SupabaseSyncStatus, SupabaseTable,
} from './types.js';

export type ReplicationTable<Rows> = SupabaseTable<Rows> & {
  /** Server-only columns, removed from pulled, realtime and conflict rows. */
  readonly serverColumns?: readonly string[];
};

export interface ReplicationOptions<Rows extends { [K in keyof Rows]: object }> {
  readonly scope: Scope;
  readonly accountId: string;
  readonly client: SupabaseClient;
  readonly authentication?: SupabaseAuthentication;
  readonly tables: readonly ReplicationTable<Rows>[];
  readonly namespace?: string;
  readonly batchSize?: number;
  readonly retryTime?: number;
  readonly resolveCollection: (name: CollectionKey<Rows>) => RxCollection<Rows[CollectionKey<Rows>]>;
  readonly onConflict?: (conflict: SupabaseConflict) => void;
}

type Row = Record<string, unknown>;
const RESERVED = ['_deleted', '_rev', '_meta', '_attachments'];
const business = (row: Readonly<Row>): Row =>
  Object.fromEntries(Object.entries(row).filter(([key]) => !RESERVED.includes(key) || key === '_deleted'));
const sameContent = (left: Readonly<Row>, right: Readonly<Row>): boolean =>
  JSON.stringify(sorted(business(left))) === JSON.stringify(sorted(business(right)));
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted((value as Row)[key])]));
}

/** Stock RxDB Supabase replication under an authenticated account scope. */
export async function startSupabaseReplication<Rows extends { [K in keyof Rows]: object }>(
  options: ReplicationOptions<Rows>,
): Promise<SupabaseSync> {
  const { scope } = options;
  if (scope.signal.aborted) throw abortError();
  if (!options.accountId.trim()) throw new Error('Supabase replication requires an accountId.');
  const authentication = options.authentication ?? 'session';
  if (authentication !== 'session' && authentication !== 'access-token') {
    throw new Error(`Supabase authentication must be 'session' or 'access-token', not ${JSON.stringify(authentication)}.`);
  }
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
    const collection = options.resolveCollection(table.collection);
    const modifiedField = table.modifiedField ?? '_modified';
    for (const column of table.serverColumns ?? []) {
      if (!column.trim() || [...RESERVED, modifiedField, collection.schema.primaryPath].includes(column)) {
        throw new Error(`Supabase serverColumns cannot include ${JSON.stringify(column)}.`);
      }
      if (Object.hasOwn(collection.schema.jsonSchema.properties, column)) {
        throw new Error(`Supabase server column ${column} is also a local field of ${table.collection}.`);
      }
    }
    return { table, collection, modifiedField };
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
    // An access-token client has no Supabase Auth session: supabase-js makes
    // every `client.auth` member throw, so only the account scope ends sync.
    if (authentication === 'session') {
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
    }
    if (stopped) throw abortError();
    for (const { table, collection, modifiedField } of configured) {
      type Doc = Rows[CollectionKey<Rows>];
      const serverColumns = table.serverColumns ?? [];
      const strip = (row: Readonly<Row>): Row => {
        const copy = { ...row };
        for (const column of serverColumns) delete copy[column];
        return copy;
      };
      const state = replicateSupabase<Doc>({
        collection,
        client: options.client,
        tableName: table.tableName,
        replicationIdentifier: `vibespa:${[
          options.namespace ?? 'default', options.accountId, table.collection, table.tableName,
        ].map(encodeURIComponent).join(':')}`,
        modifiedField,
        deletedField: '_deleted',
        live: true,
        autoStart: false,
        waitForLeadership: false,
        retryTime: options.retryTime ?? 5_000,
        pull: {
          batchSize: options.batchSize ?? 100,
          ...(serverColumns.length ? { modifier: (row: Row) => strip(row) as WithDeleted<Doc> } : {}),
        },
        push: { batchSize: options.batchSize ?? 100 },
      });
      states.push(state);
      if (table.encodeRequest && state.push) {
        const encodeRequest = table.encodeRequest;
        const stockPush = state.push.handler;
        const encode = (document: WithDeleted<Doc>): WithDeleted<Doc> => {
          const encoded = encodeRequest(structuredClone(document));
          // This cast is deliberately confined to the stock HTTP/CAS seam. RxDB's
          // stored rows, modifiers, and returned conflict rows retain their types.
          return { ...encoded, _deleted: document._deleted } as WithDeleted<Doc>;
        };
        state.push.handler = rows => stockPush(rows.map(row => ({
          ...row,
          newDocumentState: encode(row.newDocumentState),
          assumedMasterState: row.assumedMasterState ? encode(row.assumedMasterState) : undefined,
        })));
      }
      if (serverColumns.length && state.push) {
        // Conflict rows are fetched by id and skip the pull modifier.
        const push = state.push.handler;
        state.push.handler = async rows => (await push(rows)).map(row => strip(row as Row) as WithDeleted<Doc>);
      }
      if (options.onConflict) {
        const onConflict = options.onConflict;
        subscriptions.push(state.conflict$.subscribe(conflict => {
          if (stopped) return;
          const proposed = conflict.input.newDocumentState as unknown as Row;
          const resolved = conflict.output as unknown as Row;
          if (sameContent(proposed, resolved)) return;
          try {
            onConflict({
              collection: table.collection, tableName: table.tableName,
              id: String(proposed[collection.schema.primaryPath]), proposed: business(proposed), resolved: business(resolved),
            });
          } catch (error) { console.error('Supabase conflict observer failed.', error); }
        }));
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
