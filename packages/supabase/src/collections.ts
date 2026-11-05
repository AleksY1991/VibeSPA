import type { SupabaseClient } from '@supabase/supabase-js';
import type { Scope } from '@vibespa/contracts';
import type { RxCollection } from 'rxdb';
import { startSupabaseReplication, type ReplicationTable } from './replication.js';
import type { CollectionKey, SupabaseAuthentication, SupabaseConflict, SupabaseSync } from './types.js';

export type {
  SupabaseAuthentication, SupabaseConflict, SupabaseSync, SupabaseSyncError, SupabaseSyncStatus,
} from './types.js';

/** A table replicated into an application-owned native RxDB collection. */
export type SupabaseCollectionTable<Rows> = ReplicationTable<Rows>;

export interface SupabaseCollectionsSyncOptions<Rows extends { [K in keyof Rows]: object }> {
  /** Open collections owned by the caller's account scope. Replication never closes them. */
  readonly collections: { readonly [K in CollectionKey<Rows>]: RxCollection<Rows[K]> };
  readonly scope: Scope;
  /** Use an account scope and an authenticated client whose RLS grants this account access. */
  readonly accountId: string;
  readonly client: SupabaseClient;
  /** Default `'session'`. Use `'access-token'` for a client built with supabase-js's `accessToken` option. */
  readonly authentication?: SupabaseAuthentication;
  readonly tables: readonly SupabaseCollectionTable<Rows>[];
  /** Stable backend identity when one local database may connect to different backends. */
  readonly namespace?: string;
  readonly batchSize?: number;
  readonly retryTime?: number;
  /** Observer only. The stock conflict handler still keeps the server row. */
  readonly onConflict?: (conflict: SupabaseConflict) => void;
}

/** Automatic stock RxDB replication for native collections, for example the
 * collection a `createRxCollectionDomainAdapter` Solid owner persists through.
 * Register the database's close before calling this in the same scope, so
 * replication cancels before the database closes. */
export function syncSupabaseCollections<Rows extends { [K in keyof Rows]: object }>(
  options: SupabaseCollectionsSyncOptions<Rows>,
): Promise<SupabaseSync> {
  const { collections, ...rest } = options;
  return startSupabaseReplication<Rows>({
    ...rest,
    resolveCollection(name) {
      const collection = Object.hasOwn(collections, name) ? collections[name] : undefined;
      if (!collection) throw new Error(`Supabase collection is not supplied: ${name}.`);
      return collection as RxCollection<Rows[CollectionKey<Rows>]>;
    },
  });
}
