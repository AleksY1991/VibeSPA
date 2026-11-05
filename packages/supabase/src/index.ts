import type { SupabaseClient } from '@supabase/supabase-js';
import type { Scope } from '@vibespa/contracts';
import type { LocalStore } from '@vibespa/local-first';
import { getCollection } from '@vibespa/local-first/adapter';
import { startSupabaseReplication } from './replication.js';
import type { SupabaseSync, SupabaseTable } from './types.js';

export type { SupabaseConflict, SupabaseSync, SupabaseSyncError, SupabaseSyncStatus, SupabaseTable } from './types.js';

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

/** Automatic stock RxDB replication. All application writes still enter through LocalStore. */
export async function syncSupabase<Rows extends { [K in keyof Rows]: object }>(
  options: SupabaseSyncOptions<Rows>,
): Promise<SupabaseSync> {
  const { store, tables, ...rest } = options;
  return startSupabaseReplication<Rows>({
    ...rest,
    // Only the legacy table fields are forwarded; this entry has no server columns.
    tables: tables.map(({ collection, tableName, modifiedField, encodeRequest }) =>
      ({ collection, tableName, modifiedField, encodeRequest }) as SupabaseTable<Rows>),
    resolveCollection: name => getCollection(store, name),
  });
}
