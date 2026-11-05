import type { Readable } from '@vibespa/contracts';
import type { WithDeleted } from 'rxdb';

export type CollectionKey<Rows> = Extract<keyof Rows, string>;

/**
 * How the Supabase client authenticates.
 * - `'session'` (default): a Supabase Auth session whose user is `accountId`;
 *   sign-out or a different user cancels replication.
 * - `'access-token'`: a client created with supabase-js's `accessToken` option
 *   (custom or third-party JWTs). Its `client.auth` is unavailable, so there is
 *   no session check: `accountId` is the caller's assertion and ending the
 *   account scope is the only cancellation. Row-level security still applies.
 */
export type SupabaseAuthentication = 'session' | 'access-token';

export type SupabaseTable<Rows> = {
  [K in CollectionKey<Rows>]: {
    readonly collection: K;
    readonly tableName: string;
    readonly modifiedField?: string;
    /** Encode cloned HTTP request rows only, for example Postgres array literals. */
    readonly encodeRequest?: (document: Readonly<WithDeleted<Rows[K]>>) => Readonly<Record<string, unknown>>;
  };
}[CollectionKey<Rows>];

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

/** A push the server refused, and the row the stock conflict handler kept. */
export interface SupabaseConflict {
  readonly collection: string;
  readonly tableName: string;
  readonly id: string;
  readonly proposed: Readonly<Record<string, unknown>>;
  readonly resolved: Readonly<Record<string, unknown>>;
}
