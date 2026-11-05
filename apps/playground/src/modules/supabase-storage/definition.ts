import { FeatureType } from '@vibespa/contracts';
import { defineFeatureModule } from '@vibespa/core';
import type { SupabaseStorage, SupabaseStorageInputs } from './contract';

export const supabaseStorageModule = defineFeatureModule<FeatureType.Store, SupabaseStorageInputs, SupabaseStorage>({
  id: 'supabase-storage',
  kind: FeatureType.Store,
  title: 'Supabase storage',
  description: 'Persists intentions in a native RxDB collection that stock replication syncs with Supabase.',
  contract: {
    inputs: {
      client: 'An authenticated Supabase client for this account.',
      accountId: 'The signed-in account; replication stops if the session changes.',
      databaseName: 'The local database owned by this account.',
      maximumTitleLength: 'The intention schema title length limit.',
      multiInstance: 'Share the database between tabs; only the leader tab replicates.',
      storage: 'Optional RxDB storage; IndexedDB when omitted.',
    },
    exports: {
      adapter: 'Persistence adapter for the Solid owner; durable and server rows win conflicts.',
      sync: 'Observe replication status and local values replaced by newer rows.',
    },
  },
  load: () => import('./internal/runtime').then(module => module.createSupabaseStorage),
});
