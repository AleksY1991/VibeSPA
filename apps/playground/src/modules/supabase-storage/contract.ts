import type { SupabaseClient } from '@supabase/supabase-js';
import type { RxStorage } from 'rxdb';
import type { DomainAdapter } from '@vibespa/solid/domain';
import type { SyncView } from '../../contracts/account';
import type { Intention } from '../../contracts/focus';

export interface SupabaseStorageInputs {
  readonly client: SupabaseClient;
  readonly accountId: string;
  readonly databaseName: string;
  readonly maximumTitleLength: number;
  readonly multiInstance: boolean;
  readonly storage?: RxStorage<unknown, unknown>;
}

export interface SupabaseStorage {
  readonly adapter: DomainAdapter<Intention>;
  readonly sync: SyncView;
}
